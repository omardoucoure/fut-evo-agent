/**
 * Live E2E tests for the AI Coach agent — 100 real prompts.
 * Sends diverse messages to production and validates DynUI block quality.
 *
 * Run:  npx jest --testPathPatterns="live-agent-e2e" --testTimeout=600000
 */

import https from 'https';

const API_URL = 'https://www.futevolution.com/api/agent/chat/stream';
const CONCURRENCY = 5; // parallel requests per batch

// ── Helpers ──────────────────────────────────────────────────────────────────

interface ChatResult {
  text: string;
  uiBlocks: any[];
  rawUIStrings: string[];
  toolsUsed: string[];
  error: string | null;
}

function httpPost(url: string, body: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = https.request(
      { hostname: parsed.hostname, path: parsed.pathname, method: 'POST', headers: { 'Content-Type': 'application/json' }, timeout: 90_000 },
      (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
        res.on('end', () => resolve(data));
      }
    );
    req.on('timeout', () => { req.destroy(); reject(new Error('HTTP timeout')); });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function splitConcatenatedJSON(raw: string): string[] {
  const results: string[] = [];
  let i = 0;
  while (i < raw.length) {
    if (raw[i] === '{' || raw[i] === '[') {
      const opener = raw[i];
      const closer = opener === '{' ? '}' : ']';
      let depth = 0; let inStr = false; let esc = false; let found = false;
      for (let j = i; j < raw.length; j++) {
        const c = raw[j];
        if (esc) { esc = false; continue; }
        if (inStr) { if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
        if (c === '"') { inStr = true; continue; }
        if (c === opener) depth++;
        else if (c === closer) { depth--; if (depth === 0) { results.push(raw.substring(i, j + 1)); i = j + 1; found = true; break; } }
      }
      if (!found) break;
    } else { i++; }
  }
  return results.length > 0 ? results : [raw];
}

async function chat(
  message: string,
  context: Record<string, any> = {},
  history: { role: string; content: string }[] = []
): Promise<ChatResult> {
  const body = await httpPost(API_URL, JSON.stringify({
    message,
    conversationHistory: history,
    context: { platform: 'ps', budget: 200000, formation: '4-3-3', ...context },
  }));

  const lines = body.split('\n').filter(l => l.startsWith('data: '));
  let text = ''; let toolsUsed: string[] = []; let error: string | null = null;

  for (const line of lines) {
    try {
      const evt = JSON.parse(line.slice(6));
      if (evt.type === 'chunk') text += evt.content;
      if (evt.type === 'done') toolsUsed = evt.toolsUsed || [];
      if (evt.type === 'error') error = evt.message;
    } catch { /* skip */ }
  }

  const rawUIStrings: string[] = [];
  const uiBlocks: any[] = [];
  const uiRegex = /\[UI\]([\s\S]*?)\[\/UI\]/g;
  let match;
  while ((match = uiRegex.exec(text)) !== null) {
    const raw = match[1].trim();
    for (const j of splitConcatenatedJSON(raw)) {
      rawUIStrings.push(j);
      try { uiBlocks.push(JSON.parse(j)); }
      catch { uiBlocks.push({ __parseError: true, raw: j }); }
    }
  }

  return { text, uiBlocks, rawUIStrings, toolsUsed, error };
}

// ── Validator ────────────────────────────────────────────────────────────────

const KNOWN_TYPES = new Set([
  'glass_card', 'row', 'column', 'grid', 'divider', 'spacer', 'section',
  'heading', 'text', 'badge', 'markdown',
  'stat_bar', 'comparison_bar', 'star_rating', 'sparkline', 'price',
  'player_image', 'formation_field', 'radar_chart', 'list_item',
]);

function validateBlock(block: any, path = 'root', depth = 0): string[] {
  const errors: string[] = [];
  if (Array.isArray(block)) {
    block.forEach((child: any, i: number) => errors.push(...validateBlock(child, `${path}[${i}]`, depth)));
    return errors;
  }
  if (!block || typeof block !== 'object') return [`${path}: not an object`];
  if (block.__parseError) return [`${path}: JSON parse error`];
  if (!block.type) return [`${path}: missing "type"`];
  if (!KNOWN_TYPES.has(block.type)) errors.push(`${path}: unknown type "${block.type}"`);
  const flat = Object.keys(block).filter(k => !['type','props','children','action'].includes(k));
  if (flat.length > 0) errors.push(`${path}: flat keys [${flat.join(',')}]`);
  if (depth > 4) errors.push(`${path}: depth > 4`);
  if (block.type === 'grid' && Array.isArray(block.children)) {
    for (const c of block.children) {
      if (c?.type === 'comparison_bar' || c?.type === 'stat_bar')
        errors.push(`${path}: bar directly in grid`);
    }
  }
  if (Array.isArray(block.children)) {
    block.children.forEach((c: any, i: number) => {
      if (c && typeof c === 'object' && c.type) errors.push(...validateBlock(c, `${path}>${block.type}[${i}]`, depth + 1));
    });
  }
  if (block.action) {
    if (!block.action.type) errors.push(`${path}: action missing type`);
    if (block.action.type === 'openPlayer' && !block.action.eaId) errors.push(`${path}: openPlayer missing eaId`);
    if (block.action.type === 'swapPlayer' && (!block.action.eaId || !block.action.name)) errors.push(`${path}: swapPlayer incomplete`);
  }
  return errors;
}

// ── 100 Test Prompts ─────────────────────────────────────────────────────────

interface TestCase {
  id: number;
  message: string;
  context?: Record<string, any>;
  expect: {
    minTextLen?: number;       // minimum response text length
    hasUI?: boolean;           // expect at least 1 UI block
    uiContains?: string[];     // raw UI should contain these type strings
    textMatches?: RegExp;      // response text must match this regex
  };
}

const TESTS: TestCase[] = [
  // ── Greetings & Small Talk (1-10) ──────────────────────────────────────────
  { id: 1, message: 'Hey!', expect: { minTextLen: 10 } },
  { id: 2, message: 'Hello coach, I just started playing FC 26', expect: { minTextLen: 20 } },
  { id: 3, message: 'Yo what can you do?', expect: { minTextLen: 20 } },
  { id: 4, message: 'Bonjour', expect: { minTextLen: 10 } },
  { id: 5, message: 'Thanks for the help!', expect: { minTextLen: 5 } },
  { id: 6, message: 'Who are you?', expect: { minTextLen: 15 } },
  { id: 7, message: 'Is this app free?', expect: { minTextLen: 10 } },
  { id: 8, message: 'Good morning', expect: { minTextLen: 10 } },
  { id: 9, message: 'I need help with my squad', expect: { minTextLen: 15 } },
  { id: 10, message: 'What features do you have?', expect: { minTextLen: 20 } },

  // ── Player Comparisons (11-25) ─────────────────────────────────────────────
  { id: 11, message: 'Compare Mbappe and Haaland for ST', expect: { hasUI: true, uiContains: ['comparison_bar'] } },
  { id: 12, message: 'Messi vs Neymar for CAM', expect: { hasUI: true } },
  { id: 13, message: 'Salah or Dembele for RW?', expect: { hasUI: true } },
  { id: 14, message: 'Who is better Virgil van Dijk or Marquinhos?', expect: { hasUI: true } },
  { id: 15, message: 'Compare Kante and Vieira for CDM position', expect: { hasUI: true, uiContains: ['comparison_bar'] } },
  { id: 16, message: 'Courtois vs Donnarumma', expect: { hasUI: true } },
  { id: 17, message: 'Hakimi vs Alexander-Arnold for RB', expect: { hasUI: true } },
  { id: 18, message: 'Which is better Ronaldo or Lewandowski?', expect: { hasUI: true } },
  { id: 19, message: 'Compare Bruno Fernandes and De Bruyne for CM', expect: { hasUI: true } },
  { id: 20, message: 'Theo Hernandez or Robertson for LB?', expect: { hasUI: true } },
  { id: 21, message: 'Bellingham vs Modric who should I pick?', expect: { hasUI: true } },
  { id: 22, message: 'Show me Gullit vs Zidane stats side by side', expect: { hasUI: true } },
  { id: 23, message: 'Best between Mbappe TOTY and Mbappe gold?', expect: { hasUI: true } },
  { id: 24, message: 'Compare the top 2 CB in the game right now', expect: { hasUI: true } },
  { id: 25, message: 'Garrincha or Best for RW icon?', expect: { hasUI: true } },

  // ── Budget & Upgrade Requests (26-40) ──────────────────────────────────────
  { id: 26, message: 'Best cheap beast ST under 20k', context: { budget: 20000 }, expect: { hasUI: true, uiContains: ['player_image'] } },
  { id: 27, message: 'I need a good CB under 50k coins', context: { budget: 50000 }, expect: { hasUI: true } },
  { id: 28, message: 'Show me affordable CDMs under 100k', context: { budget: 100000 }, expect: { hasUI: true } },
  { id: 29, message: 'Best RW under 30k for my 4-3-3', context: { budget: 30000 }, expect: { hasUI: true } },
  { id: 30, message: 'Who is the best GK for under 15k?', context: { budget: 15000 }, expect: { hasUI: true } },
  { id: 31, message: 'I have 500k to spend, who should I buy?', context: { budget: 500000 }, expect: { hasUI: true } },
  { id: 32, message: 'Upgrade my LB, budget is 80k', context: { budget: 80000 }, expect: { hasUI: true } },
  { id: 33, message: 'Best value for money CAM under 200k', context: { budget: 200000 }, expect: { hasUI: true } },
  { id: 34, message: 'Find me a CM with high passing under 40k', context: { budget: 40000 }, expect: { hasUI: true } },
  { id: 35, message: 'Best La Liga CB duo under 60k total', context: { budget: 60000 }, expect: { hasUI: true } },
  { id: 36, message: 'Suggest a Premier League RB under 25k', context: { budget: 25000 }, expect: { hasUI: true } },
  { id: 37, message: 'I need a super sub ST under 10k', context: { budget: 10000 }, expect: { hasUI: true } },
  { id: 38, message: 'Best Ligue 1 midfielders under 75k', context: { budget: 75000 }, expect: { hasUI: true } },
  { id: 39, message: 'Cheap beast Serie A defenders', context: { budget: 30000 }, expect: { hasUI: true } },
  { id: 40, message: 'Show me budget wingers with 90+ pace', context: { budget: 50000 }, expect: { hasUI: true } },

  // ── Star Rating & Reviews (41-50) ──────────────────────────────────────────
  { id: 41, message: 'Rate Mbappe out of 5 stars', expect: { hasUI: true, uiContains: ['star_rating'] } },
  { id: 42, message: 'Rate Haaland and Lewandowski out of 5', expect: { hasUI: true, uiContains: ['star_rating'] } },
  { id: 43, message: 'Give me a review of Vieira icon card with star ratings', expect: { hasUI: true, uiContains: ['star_rating'] } },
  { id: 44, message: 'Rate the top 3 GKs out of 5 stars each', expect: { hasUI: true, uiContains: ['star_rating'] } },
  { id: 45, message: 'Is Ronaldo worth his price? Rate him', expect: { hasUI: true } },
  { id: 46, message: 'Score Neymar out of 5 as a CAM', expect: { hasUI: true, uiContains: ['star_rating'] } },
  { id: 47, message: 'Rate my midfield: Bellingham, KDB, and Modric', expect: { hasUI: true } },
  { id: 48, message: 'How many stars would you give Salah this year?', expect: { hasUI: true } },
  { id: 49, message: 'Rate Messi as a RW on a scale of 5 stars', expect: { hasUI: true, uiContains: ['star_rating'] } },
  { id: 50, message: 'Give Dembele a star rating for pace and dribbling', expect: { hasUI: true } },

  // ── Formation & Tactics (51-60) ────────────────────────────────────────────
  { id: 51, message: 'What is the best formation in FC 26?', expect: { minTextLen: 50, textMatches: /\d-\d-\d/ } },
  { id: 52, message: 'Is 4-2-3-1 good for counter attacking?', expect: { minTextLen: 30, textMatches: /4-2-3-1/i } },
  { id: 53, message: 'Best formation for possession play?', expect: { minTextLen: 40 } },
  { id: 54, message: 'How to set up 4-3-3 attacking?', expect: { minTextLen: 30 } },
  { id: 55, message: 'Should I use 3-5-2 or 4-4-2?', expect: { minTextLen: 30 } },
  { id: 56, message: 'What custom tactics should I use for 4-2-3-1?', expect: { minTextLen: 40 } },
  { id: 57, message: 'Best defensive formation against sweaty players?', expect: { minTextLen: 30 } },
  { id: 58, message: 'Is 5 at the back viable in FC 26?', expect: { minTextLen: 20 } },
  { id: 59, message: 'What formation has the best wing play?', expect: { minTextLen: 30 } },
  { id: 60, message: 'Explain the difference between 4-3-3 and 4-3-2-1', expect: { minTextLen: 40 } },

  // ── Meta & Tier List (61-70) ───────────────────────────────────────────────
  { id: 61, message: 'Who are the top 3 meta strikers?', expect: { hasUI: true, uiContains: ['player_image'] } },
  { id: 62, message: 'Best meta CDM in the game?', expect: { hasUI: true } },
  { id: 63, message: 'Show me the S-tier wingers', expect: { hasUI: true } },
  { id: 64, message: 'Most overpowered players in FC 26', expect: { hasUI: true } },
  { id: 65, message: 'What are the meta defenders right now?', expect: { hasUI: true } },
  { id: 66, message: 'Who is the best goalkeeper in the meta?', expect: { hasUI: true } },
  { id: 67, message: 'Top 5 fullbacks in the current meta', expect: { hasUI: true } },
  { id: 68, message: 'Best CAM in the game right now?', expect: { hasUI: true } },
  { id: 69, message: 'Who are the most broken players this week?', expect: { hasUI: true } },
  { id: 70, message: 'Show me the meta midfield options', expect: { hasUI: true } },

  // ── Market & Prices (71-80) ────────────────────────────────────────────────
  { id: 71, message: 'Is Mbappe price going up or down?', expect: { minTextLen: 30 } },
  { id: 72, message: 'When is the best time to buy players?', expect: { minTextLen: 30 } },
  { id: 73, message: 'Should I sell my team before TOTS?', expect: { minTextLen: 20 } },
  { id: 74, message: 'How much is Haaland worth right now?', expect: { hasUI: true } },
  { id: 75, message: 'Is the market crashing?', expect: { minTextLen: 20 } },
  { id: 76, message: 'Best time to sell Messi?', expect: { minTextLen: 20 } },
  { id: 77, message: 'Will prices go up during Weekend League?', expect: { minTextLen: 20 } },
  { id: 78, message: 'Show me Vinicius price history', expect: { hasUI: true } },
  { id: 79, message: 'How to make coins fast in FC 26?', expect: { minTextLen: 30 } },
  { id: 80, message: 'Is investing in icons worth it?', expect: { minTextLen: 20 } },

  // ── Chemistry & Links (81-85) ──────────────────────────────────────────────
  { id: 81, message: 'How does chemistry work in FC 26?', expect: { minTextLen: 50, textMatches: /chem/i } },
  { id: 82, message: 'How to get full chemistry on Mbappe?', expect: { minTextLen: 30 } },
  { id: 83, message: 'Best nation links for Premier League squad', expect: { minTextLen: 30 } },
  { id: 84, message: 'Can I use La Liga and Serie A players together?', expect: { minTextLen: 20 } },
  { id: 85, message: 'What chemistry style should I put on my striker?', expect: { minTextLen: 20 } },

  // ── Specific Player Queries (86-95) ────────────────────────────────────────
  { id: 86, message: 'Show me Mbappe stats', expect: { hasUI: true, uiContains: ['player_image'] } },
  { id: 87, message: 'How good is Ronaldinho icon card?', expect: { hasUI: true } },
  { id: 88, message: 'Is Zidane worth the coins?', expect: { hasUI: true } },
  { id: 89, message: 'Show me everything about Bellingham', expect: { hasUI: true } },
  { id: 90, message: 'What are Virgil van Dijk key stats?', expect: { hasUI: true } },
  { id: 91, message: 'How fast is Adama Traore?', expect: { hasUI: true } },
  { id: 92, message: 'Does Messi have 5 star skills?', expect: { minTextLen: 15 } },
  { id: 93, message: 'What playstyle does Haaland have?', expect: { hasUI: true } },
  { id: 94, message: 'Is Kante good at defending?', expect: { hasUI: true } },
  { id: 95, message: 'Show me Maradona icon card', expect: { hasUI: true } },

  // ── Edge Cases & Fun (96-100) ──────────────────────────────────────────────
  { id: 96, message: 'Build me the best possible team for 1 million coins', context: { budget: 1000000 }, expect: { hasUI: true } },
  { id: 97, message: 'lol', expect: { minTextLen: 5 } },
  { id: 98, message: 'Who would win: a team of all icons vs all TOTY?', expect: { minTextLen: 30 } },
  { id: 99, message: 'Give me a fun squad with only 5 star skillers', expect: { hasUI: true } },
  { id: 100, message: 'What is the most expensive player in the game?', expect: { hasUI: true } },
];

// ── Test Runner ──────────────────────────────────────────────────────────────

describe('Live Agent E2E — 100 prompts', () => {
  jest.setTimeout(600_000); // 10 min total

  // Accumulate results for final summary
  const results: { id: number; pass: boolean; errors: string[]; uiBlocks: number; ms: number; textLen: number }[] = [];

  // Run in sequential batches of CONCURRENCY
  const batches: TestCase[][] = [];
  for (let i = 0; i < TESTS.length; i += CONCURRENCY) {
    batches.push(TESTS.slice(i, i + CONCURRENCY));
  }

  for (const batch of batches) {
    // Each test in the batch runs as its own Jest test (parallel within batch via Promise.all)
    it(`batch ${batch[0].id}-${batch[batch.length - 1].id}`, async () => {
      const batchResults = await Promise.all(batch.map(async (tc) => {
        const t0 = Date.now();
        let pass = true;
        const errors: string[] = [];
        let uiBlockCount = 0;
        let textLen = 0;

        try {
          const r = await chat(tc.message, tc.context || {});
          textLen = r.text.length;
          uiBlockCount = r.uiBlocks.length;

          // Check for API error
          if (r.error) {
            errors.push(`API error: ${r.error}`);
            pass = false;
          }

          // Validate all UI blocks
          for (const block of r.uiBlocks) {
            const blockErrors = validateBlock(block);
            errors.push(...blockErrors);
          }

          // Check expectations
          if (tc.expect.minTextLen && r.text.length < tc.expect.minTextLen) {
            errors.push(`text too short: ${r.text.length} < ${tc.expect.minTextLen}`);
          }
          if (tc.expect.hasUI && r.uiBlocks.length === 0) {
            errors.push('expected UI blocks but got none');
          }
          if (tc.expect.uiContains) {
            for (const typeStr of tc.expect.uiContains) {
              if (!r.rawUIStrings.some(s => s.includes(`"${typeStr}"`))) {
                errors.push(`expected UI to contain "${typeStr}"`);
              }
            }
          }
          if (tc.expect.textMatches && !tc.expect.textMatches.test(r.text)) {
            errors.push(`text doesn't match ${tc.expect.textMatches}`);
          }

          if (errors.length > 0) pass = false;
        } catch (e: any) {
          errors.push(`EXCEPTION: ${e.message}`);
          pass = false;
        }

        const ms = Date.now() - t0;
        return { id: tc.id, pass, errors, uiBlocks: uiBlockCount, ms, textLen };
      }));

      results.push(...batchResults);

      // Log batch results
      for (const r of batchResults) {
        const status = r.pass ? 'PASS' : 'FAIL';
        const tc = TESTS.find(t => t.id === r.id)!;
        const msg = tc.message.substring(0, 50);
        console.log(`  [${String(r.id).padStart(3)}] ${status} | ${r.ms}ms | UI:${r.uiBlocks} | len:${r.textLen} | ${msg}`);
        if (!r.pass) console.log(`        ERRORS: ${r.errors.join('; ')}`);
      }

      // Assert all in batch passed
      const failures = batchResults.filter(r => !r.pass);
      if (failures.length > 0) {
        // Don't hard-fail the batch — collect for summary. Use soft assertion.
      }
    });
  }

  // Final summary
  afterAll(() => {
    const passed = results.filter(r => r.pass).length;
    const failed = results.filter(r => !r.pass).length;
    const totalMs = results.reduce((sum, r) => sum + r.ms, 0);
    const avgMs = Math.round(totalMs / results.length);
    const totalUI = results.reduce((sum, r) => sum + r.uiBlocks, 0);

    // Separate structural errors from content expectation misses
    const structuralErrors = results
      .flatMap(r => r.errors)
      .filter(e =>
        !e.startsWith('expected') && !e.startsWith('text ') && !e.startsWith('API error') &&
        !e.includes('JSON parse error') && !e.includes('EXCEPTION')
      );
    const parseErrors = results
      .flatMap(r => r.errors)
      .filter(e => e.includes('JSON parse error'));

    console.log('\n══════════════════════════════════════════════════');
    console.log(`  RESULTS: ${passed}/${results.length} passed (${failed} failed)`);
    console.log(`  Total time: ${Math.round(totalMs / 1000)}s | Avg: ${avgMs}ms/prompt`);
    console.log(`  Total UI blocks generated: ${totalUI}`);
    console.log(`  JSON parse errors: ${parseErrors.length} (AI truncation — tolerated up to 3)`);
    if (structuralErrors.length > 0) {
      console.log(`  STRUCTURAL ERRORS (${structuralErrors.length}):`);
      const unique = [...new Set(structuralErrors)];
      unique.forEach(e => console.log(`    - ${e}`));
    } else {
      console.log('  STRUCTURAL ERRORS: 0 — all valid UI blocks are well-formed');
    }
    console.log('══════════════════════════════════════════════════\n');

    // Hard assertions:
    // 1. No structural errors (flat keys, unknown types, bars in grid, depth, bad actions)
    expect(structuralErrors).toEqual([]);
    // 2. JSON parse errors tolerated up to 3 (AI occasionally truncates blocks)
    expect(parseErrors.length).toBeLessThanOrEqual(3);
    // 3. At least 90% pass rate for content expectations (AI is non-deterministic)
    expect(passed).toBeGreaterThanOrEqual(90);
  });
});
