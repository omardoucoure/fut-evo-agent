/**
 * FUT Evolution AI Agent — Core runner.
 *
 * Architecture:
 * 1. Classify query → skip tool loop for greetings/simple chat
 * 2. Pre-fetch player data by name before calling the LLM
 * 3. Inject pre-fetched data into the system prompt (eliminates 1-2 tool iterations)
 * 4. Single streaming LLM call → direct to client, no post-processing
 */
import OpenAI from 'openai';
import { agentTools } from './tools';
import { executeTool } from './tool-executor';
import { wrapBareUIBlocks } from './ui-block-utils';
import { generatePromptCatalog } from './dynui-schema';
import { validateAndRepairUIBlock } from './dynui-validator';

// ── Types ────────────────────────────────────────────────────────────────────

export interface AgentContext {
  /** Platform for price display: "ps", "xbox", or "pc" */
  platform: string;
  /** User's available budget in coins (0 = not set) */
  budget: number;
  /** Human-readable squad summary, e.g. "4-3-3: Mbappé (ST/95), Vinícius Jr (LW/94)..." */
  squadSummary: string;
  /** Current formation, e.g. "4-3-3" */
  formation: string;
  /** Optional extra preferences (e.g. preferred league, play style) */
  preferences: Record<string, any>;
}

export interface AgentMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface ToolCallLog {
  toolName: string;
  input: Record<string, any>;
  output: string;
  durationMs: number;
}

export interface AgentResult {
  response: string;
  toolCalls: ToolCallLog[];
}

type QueryType = 'greeting' | 'comparison' | 'player_info' | 'squad_advice' | 'general';

// ── In-memory cache ───────────────────────────────────────────────────────────

interface CacheEntry {
  response: string;
  toolCalls: ToolCallLog[];
  expiresAt: number;
}

const responseCache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

function getCacheKey(message: string, context: AgentContext): string {
  const normalized = message.trim().toLowerCase();
  return `${normalized}|${context.platform}|${context.budget}|${context.formation}`;
}

function getCached(key: string): CacheEntry | null {
  const entry = responseCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    responseCache.delete(key);
    return null;
  }
  return entry;
}

function setCache(key: string, response: string, toolCalls: ToolCallLog[]): void {
  // Evict if cache grows too large (keep last 100 entries)
  if (responseCache.size >= 100) {
    const firstKey = responseCache.keys().next().value;
    if (firstKey) responseCache.delete(firstKey);
  }
  responseCache.set(key, { response, toolCalls, expiresAt: Date.now() + CACHE_TTL_MS });
}

// ── Constants ────────────────────────────────────────────────────────────────

const USE_LOCAL = !!process.env.OLLAMA_BASE_URL;
const MODEL_NORMAL = USE_LOCAL
  ? 'qwen2.5:14b-instruct'
  : (process.env.FINE_TUNED_MODEL || 'gpt-4.1-mini');
const MODEL_DEEP = USE_LOCAL ? 'qwen2.5:14b-instruct' : 'o4-mini';
const MAX_TOKENS = 2500;
const MAX_ITERATIONS = 4;

// ── Query classifier ─────────────────────────────────────────────────────────

const GREETING_PATTERNS = /^(hi|hey|hello|sup|yo|hola|salut|bonjour|what'?s up|howdy|good (morning|evening|afternoon))[!?.]*$/i;
const COMPARISON_PATTERNS = /\bvs\.?\b|\bversus\b|\bcompare\b|\bbetter\b.*\bor\b|\bor\b.*\bbetter\b/i;
const PLAYER_NAME_REGEX = /\b([A-Z][a-záéíóúüñàèùâêîôûãõçœ'-]{2,}(?:\s+[A-Z][a-záéíóúüñàèùâêîôûãõçœ'-]{2,}){0,3})\b/g;

function classifyQuery(message: string): QueryType {
  const trimmed = message.trim();
  if (GREETING_PATTERNS.test(trimmed)) return 'greeting';
  if (COMPARISON_PATTERNS.test(trimmed)) return 'comparison';
  if (/\b(price|market|sell|buy|invest|sbc|pack)\b/i.test(trimmed)) return 'general';
  if (/\b(squad|formation|team|lineup|chemistry|chem)\b/i.test(trimmed)) return 'squad_advice';
  return 'player_info';
}

// ── Player name extraction & pre-fetch ───────────────────────────────────────

/**
 * Extract likely player names from the user message and pre-fetch their data.
 * Returns a map of eaId → player data for injection into the system prompt.
 */
async function preFetchPlayers(
  message: string,
  queryType: QueryType
): Promise<{ prefetched: Map<string, any>; summary: string }> {
  const prefetched = new Map<string, any>();

  // Only pre-fetch for player-centric query types
  if (queryType === 'greeting' || queryType === 'general') {
    return { prefetched, summary: '' };
  }

  // Extract capitalized word groups (likely player names)
  const candidates: string[] = [];
  let match;
  const regex = new RegExp(PLAYER_NAME_REGEX.source, 'g');
  while ((match = regex.exec(message)) !== null) {
    const name = match[1].trim();
    // Skip common FUT words
    if (/^(PS|PC|Xbox|CDM|CAM|LW|RW|ST|CB|GK|LB|RB|SBC|FUT|FC|FIFA|EA|Best|Why|What|Who|How|Tell|Can|Should|Would|Is|Are|Do|Did|Has|Have|Will|The|My|His|Her|Your)$/i.test(name)) continue;
    if (name.length < 4) continue;
    candidates.push(name);
  }

  if (candidates.length === 0) return { prefetched, summary: '' };

  // Fetch up to 3 unique names in parallel (covers most comparison queries)
  const toFetch = [...new Set(candidates)].slice(0, 3);
  const results = await Promise.allSettled(
    toFetch.map(async (name) => {
      const result = await executeTool('search_players', { query: name });
      const data = JSON.parse(result);
      const players = data.players || [];
      if (players.length === 0) return null;
      // Take best match (highest overall)
      const best = players[0];
      // For comparisons, also fetch full detail
      if (queryType === 'comparison') {
        const detail = await executeTool('get_player_detail', { eaId: best.eaId });
        return { name, data: JSON.parse(detail) };
      }
      return { name, data: best };
    })
  );

  const lines: string[] = [];
  for (const r of results) {
    if (r.status === 'fulfilled' && r.value) {
      const { name, data } = r.value;
      prefetched.set(String(data.eaId), data);
      const stats = data.faceStats || {};
      const prices = data.prices || { ps: data.psPrice };
      lines.push(
        `${data.name} (${data.position}, OVR ${data.overall}, Tier ${data.meta?.tier || data.metaTier || '?'}, ` +
        `PAC ${stats.pace} SHO ${stats.shooting} PAS ${stats.passing} DRI ${stats.dribbling} DEF ${stats.defending} PHY ${stats.physicality}, ` +
        `Price: ${(prices.ps || data.psPrice || 0).toLocaleString()} coins, ` +
        `SM: ${data.skillMoves}★ WF: ${data.weakFoot}★, ` +
        (data.workRates ? `WR: ${data.workRates.attacking}/${data.workRates.defensive}, ` : '') +
        `AccelType: ${data.accelerateType || '?'}, CardImg: ${data.cardImageUrl || ''})`
      );
    }
  }

  return { prefetched, summary: lines.join('\n') };
}

// ── System prompt builder ────────────────────────────────────────────────────

function buildSystemPrompt(ctx: AgentContext, prefetchSummary?: string): string {
  const platformLabel =
    ctx.platform === 'xbox' ? 'Xbox' : ctx.platform === 'pc' ? 'PC' : 'PlayStation';

  const squadSection = ctx.squadSummary
    ? `Squad (${ctx.formation}): ${ctx.squadSummary}`
    : 'No squad loaded — ask user to upload a screenshot for personalized advice.';

  const budgetSection = ctx.budget > 0
    ? `${ctx.budget.toLocaleString()} coins`
    : 'Not set';

  const preFetchSection = prefetchSummary
    ? `\nPRE-FETCHED PLAYER DATA (use this — do NOT call search_players or get_player_detail for these players again):\n${prefetchSummary}\n`
    : '';

  return `You are Futties, an FC 26 Ultimate Team coach inside FUT Evolution. You're a knowledgeable friend — opinionated, warm, and direct.

USER CONTEXT:
Platform: ${platformLabel} | Budget: ${budgetSection}
${squadSection}
${preFetchSection}
RESPONSE RULES:
- Greetings: 1-2 sentences max. Ask what they need help with.
- Concise: 3-4 sentences for simple questions.
- Use tools for ANY player data not in Pre-Fetched section above. Never fabricate stats.
- For comparisons: call get_player_detail for both players if not pre-fetched.
- Wrap player names in **double asterisks**.
- Give opinions: "I'd pick...", "Honestly,..."
- SUGGESTED FOLLOW-UP: End EVERY response with [SUGGEST]a short follow-up question the user might ask next[/SUGGEST]. Write it in the SAME LANGUAGE the user is writing in (if they write in French, suggest in French; Spanish → Spanish, etc.). Make it relevant to what you just discussed. Examples: after comparing players → "How about comparing their price trends?", after showing a player → "Want me to find similar but cheaper options?", after squad advice → "Should I check chemistry with this change?". Keep it under 60 chars, natural and conversational.

VISUAL-FIRST RULE (CRITICAL): Your goal is to make every response visual and actionable. When discussing players, ALWAYS show their card image + stats. When comparing, ALWAYS use comparison_bar + radar_chart. When rating/reviewing/scoring players, ALWAYS use star_rating (NEVER comparison_bar for ratings — star_rating is the correct block). When listing budget picks, use stat_bar + price inside glass_cards. When suggesting upgrades, ALWAYS include swapPlayer actions. Plain text alone is a last resort — users want to SEE data, not just read about it.

DYNAMIC UI (mobile renders these natively — ALWAYS use for rich content):
${generatePromptCatalog()}
Block format: {"type":"...","props":{...},"children":[...],"action":{"type":"openPlayer","eaId":"123","name":"...","imageUrl":"..."}}
CONSTRAINTS: comparison_bar/stat_bar MUST be direct children of column or glass_card, NEVER inside grid (labels truncate). Props go inside "props":{}, never flat on the block object. Max nesting: 4.

Examples:
Comparison card: [UI]{"type":"glass_card","props":{"title":"Mbappé vs Haaland"},"children":[{"type":"row","props":{"spacing":"sm"},"children":[{"type":"player_image","props":{"url":"...","eaId":"123","name":"Mbappé","height":"md"}},{"type":"player_image","props":{"url":"...","eaId":"456","name":"Haaland","height":"md"}}]},{"type":"comparison_bar","props":{"label":"Pace","value1":97,"value2":89}},{"type":"comparison_bar","props":{"label":"Shooting","value1":92,"value2":95}}]}[/UI]
Swap suggestion: [UI]{"type":"glass_card","props":{"title":"Upgrade: Ndidi"},"children":[{"type":"player_image","props":{"url":"...","eaId":"50359778","name":"Ndidi","height":"md"}}],"action":{"type":"swapPlayer","slot":"CDM","eaId":"50359778","name":"Ndidi","imageUrl":"...","rating":91}}[/UI]
Player rating: [UI]{"type":"glass_card","props":{"title":"Bellingham Review"},"children":[{"type":"player_image","props":{"url":"...","eaId":"67361235","name":"Bellingham","height":"md"}},{"type":"star_rating","props":{"label":"Overall","value":4.5,"max":5}},{"type":"star_rating","props":{"label":"Value for coins","value":3.5,"max":5}},{"type":"stat_bar","props":{"label":"Pace","value":82,"max":99}},{"type":"stat_bar","props":{"label":"Dribbling","value":92,"max":99}},{"type":"price","props":{"value":450000,"platform":"ps","trend":"stable"}}]}[/UI]
Budget pick list: [UI]{"type":"column","props":{},"children":[{"type":"glass_card","props":{"title":"Koulibaly"},"children":[{"type":"player_image","props":{"url":"...","eaId":"123","name":"Koulibaly","height":"sm"}},{"type":"stat_bar","props":{"label":"Defending","value":89,"max":99}},{"type":"stat_bar","props":{"label":"Pace","value":78,"max":99}},{"type":"price","props":{"value":32000,"platform":"ps","trend":"down"}}]},{"type":"glass_card","props":{"title":"Militão"},"children":[{"type":"player_image","props":{"url":"...","eaId":"456","name":"Militão","height":"sm"}},{"type":"stat_bar","props":{"label":"Defending","value":87,"max":99}},{"type":"stat_bar","props":{"label":"Pace","value":84,"max":99}},{"type":"price","props":{"value":28000,"platform":"ps","trend":"up"}}]}]}[/UI]
Formation display: [UI]{"type":"formation_field","props":{"formation":"4-2-3-1"},"children":[{"type":"text","props":{"slot":"GK","name":"Donnarumma"}},{"type":"text","props":{"slot":"LB","name":"Mendy"}},{"type":"text","props":{"slot":"LCB","name":"Marquinhos"}},{"type":"text","props":{"slot":"RCB","name":"Rüdiger"}},{"type":"text","props":{"slot":"RB","name":"Hakimi"}},{"type":"text","props":{"slot":"LCDM","name":"Tchouaméni"}},{"type":"text","props":{"slot":"RCDM","name":"Kanté"}},{"type":"text","props":{"slot":"LAM","name":"Vinícius"}},{"type":"text","props":{"slot":"CAM","name":"Bellingham"}},{"type":"text","props":{"slot":"RAM","name":"Salah"}},{"type":"text","props":{"slot":"ST","name":"Mbappé"}}]}[/UI]

FORMATION FIELD RULES (CRITICAL):
formation_field children MUST each have "slot" (position like GK,LB,LCB,RCB,RB,LCDM,RCDM,CAM,LAM,RAM,ST,LW,RW,CM,LCM,RCM,CDM,CF,LS,RS,LWB,RWB) and "name" props. Without children, the field will be empty. ALWAYS include all 11 players.

SWAP ACTION (CRITICAL — ALWAYS USE when suggesting a player for the user's squad):
When you recommend a player as a replacement/upgrade for a squad slot, you MUST add a "swapPlayer" action on the glass_card. This shows Accept/Reject buttons so the user can swap directly. Without it, the user cannot act on your suggestion.
Example: {"type":"glass_card","props":{"title":"Ndidi"},"children":[...],"action":{"type":"swapPlayer","slot":"CDM","eaId":"50359778","name":"Ndidi","imageUrl":"url","rating":91}}
Required fields: slot (position in squad), eaId, name, imageUrl (cardImageUrl), rating.
Apply this whenever: user asks "who should I buy", "suggest an upgrade", "compare X vs Y for my team", "find a better CDM", or any squad improvement question.

STAR RATING RULES (CRITICAL — use whenever user asks to "rate", "score", "review", "how many stars", "out of 5", or similar):
1. ALWAYS use star_rating blocks — never comparison_bar for ratings
2. Include at least 2 star_rating dimensions per player: "Overall" + one category (e.g. "Value for coins", "Pace", "Dribbling", "Defending")
3. Values are 0-5 (half stars allowed: 3.5, 4.5 etc.)
4. Show the player card with player_image + star_rating inside a glass_card
5. If rating multiple players, create one glass_card per player each with their own star_rating blocks

GOALKEEPER RULE (CRITICAL):
When showing stats for a GK player, ALWAYS use the gkStats (Diving, Handling, Kicking, Reflexes, Speed, Positioning) — NEVER use outfield face stats (Pace, Shooting, Passing, Dribbling, Defending, Physical) for goalkeepers. GK outfield face stats are meaningless low numbers and will confuse users. Check the player's position field — if it's "GK", use gkStats exclusively.

COMPARISON RULES:
1. Use pre-fetched data if available — skip redundant tool calls
2. For outfield players: show all 6 face stats as comparison_bar. For GKs: show all 6 GK stats (Diving, Handling, Kicking, Reflexes, Speed, Positioning) as comparison_bar
3. Add key sub-stats for the position (e.g. CDM: interceptions, standing_tackle, aggression, composure, stamina)
4. Include skill moves, weak foot, work rates, accelerate type as badges
5. Price comparison + meta tier
6. 3-5 sentences of gameplay analysis

IMAGE DISPLAY: Use player_image primitive with url from pre-fetched cardImageUrl or tool result.`;
}

// ── Tool status i18n ─────────────────────────────────────────────────────────

const TOOL_STATUS_I18N: Record<string, Record<string, string>> = {
  search_players: { en: 'Searching players...', fr: 'Recherche de joueurs...', es: 'Buscando jugadores...' },
  get_player_detail: { en: 'Fetching player details...', fr: 'Chargement des détails...', es: 'Cargando detalles...' },
  get_meta_tier_list: { en: 'Checking meta rankings...', fr: 'Vérification du classement méta...', es: 'Verificando clasificación meta...' },
  get_price_history: { en: 'Checking market prices...', fr: 'Vérification des prix...', es: 'Verificando precios...' },
  get_similar_players: { en: 'Finding similar players...', fr: 'Recherche de joueurs similaires...', es: 'Buscando jugadores similares...' },
  get_squad_suggestions: { en: 'Analyzing your squad...', fr: 'Analyse de votre effectif...', es: 'Analizando tu plantilla...' },
  get_better_alternatives: { en: 'Finding better options...', fr: 'Recherche de meilleures options...', es: 'Buscando mejores opciones...' },
  get_chemistry_links: { en: 'Checking chemistry links...', fr: 'Vérification des liens chimiques...', es: 'Verificando enlaces de química...' },
};

function getToolStatus(toolName: string, lang: string): string {
  const entry = TOOL_STATUS_I18N[toolName];
  if (!entry) return `Using ${toolName.replace(/_/g, ' ')}...`;
  return entry[lang] || entry.en;
}

// ── Greeting fast path ───────────────────────────────────────────────────────

async function handleGreeting(
  userMessage: string,
  conversationHistory: AgentMessage[],
  context: AgentContext,
  model: string,
  lang: string,
  onChunk?: (chunk: string) => void
): Promise<AgentResult> {
  const client = USE_LOCAL
    ? new OpenAI({ baseURL: process.env.OLLAMA_BASE_URL, apiKey: 'ollama' })
    : new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const platformLabel =
    context.platform === 'xbox' ? 'Xbox' : context.platform === 'pc' ? 'PC' : 'PlayStation';

  const messages: OpenAI.ChatCompletionMessageParam[] = [
    {
      role: 'system',
      content: `You are Futties, an FC 26 Ultimate Team coach. Reply with a SHORT friendly greeting (1-2 sentences max). Ask what they need help with. Platform: ${platformLabel}. ${context.squadSummary ? 'They have a squad loaded.' : 'No squad loaded.'} Language: ${lang}.`,
    },
    ...conversationHistory.map(m => ({ role: m.role, content: m.content } as OpenAI.ChatCompletionMessageParam)),
    { role: 'user', content: userMessage },
  ];

  let fullText = '';

  if (onChunk) {
    const stream = client.chat.completions.stream({ model, max_tokens: 150, messages });
    for await (const chunk of stream) {
      const content = chunk.choices[0]?.delta?.content;
      if (content) {
        fullText += content;
        onChunk(content);
      }
    }
  } else {
    const response = await client.chat.completions.create({ model, max_tokens: 150, messages });
    fullText = response.choices[0]?.message?.content || 'Hey! What can I help you with today?';
  }

  return { response: fullText, toolCalls: [] };
}

// ── Main agent runner ─────────────────────────────────────────────────────────

export async function runAgent(
  userMessage: string,
  conversationHistory: AgentMessage[],
  context: AgentContext,
  onChunk?: (chunk: string) => void,
  onStatus?: (message: string) => void
): Promise<AgentResult> {
  const thinkingMode = context.preferences?.thinkingMode || 'normal';
  const lang = (context.preferences?.language as string || 'en').substring(0, 2).toLowerCase();
  const MODEL = thinkingMode === 'deep' ? MODEL_DEEP : MODEL_NORMAL;

  const queryType = classifyQuery(userMessage);
  console.log(`[Agent] Model: ${MODEL}, queryType: ${queryType}, lang: ${lang}, history: ${conversationHistory.length} msgs`);

  // Fast path: greetings skip tool loop entirely
  if (queryType === 'greeting') {
    onStatus?.('...');
    return handleGreeting(userMessage, conversationHistory, context, MODEL, lang, onChunk);
  }

  // Cache lookup (skip for streaming since we can't replay chunks)
  const cacheKey = getCacheKey(userMessage, context);
  if (!onChunk) {
    const cached = getCached(cacheKey);
    if (cached) {
      console.log(`[Agent] Cache hit for: ${userMessage.substring(0, 50)}`);
      return { response: cached.response, toolCalls: cached.toolCalls };
    }
  }

  // Pre-fetch player data to reduce tool iterations
  onStatus?.(lang === 'fr' ? 'Analyse en cours...' : lang === 'es' ? 'Analizando...' : 'Thinking...');

  const toolCallLog: ToolCallLog[] = [];
  let prefetchSummary = '';

  try {
    const { prefetched, summary } = await preFetchPlayers(userMessage, queryType);
    prefetchSummary = summary;

    // Log pre-fetch as tool calls for transparency
    for (const [eaId, data] of prefetched.entries()) {
      toolCallLog.push({
        toolName: data.faceStats && data.detailedStats ? 'get_player_detail' : 'search_players',
        input: { query: data.name },
        output: JSON.stringify(data),
        durationMs: 0,
      });
    }

    if (summary) {
      console.log(`[Agent] Pre-fetched ${prefetched.size} player(s):`, summary.substring(0, 200));
    }
  } catch (err) {
    console.warn('[Agent] Pre-fetch failed, continuing without it:', err);
  }

  const client = USE_LOCAL
    ? new OpenAI({ baseURL: process.env.OLLAMA_BASE_URL, apiKey: 'ollama' })
    : new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const systemPrompt = buildSystemPrompt(context, prefetchSummary);

  const messages: OpenAI.ChatCompletionMessageParam[] = [
    { role: 'system', content: systemPrompt },
    ...conversationHistory.map(m => ({ role: m.role, content: m.content } as OpenAI.ChatCompletionMessageParam)),
    { role: 'user', content: userMessage },
  ];

  const isReasoning = MODEL.startsWith('o');
  const useStreaming = !!onChunk && !isReasoning;

  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
    if (useStreaming) {
      console.log(`[Agent] Iteration ${iteration}: streaming`);

      const stream = client.chat.completions.stream({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        messages,
        tools: agentTools,
        tool_choice: 'auto',
      });

      let accumulatedText = '';
      let pendingBuffer = '';
      let bufferMode: 'none' | 'tagged' = 'none';

      for await (const chunk of stream) {
        const content = chunk.choices[0]?.delta?.content;
        if (!content) continue;
        accumulatedText += content;

        if (bufferMode === 'tagged') {
          pendingBuffer += content;
          const closeIdx = pendingBuffer.indexOf('[/UI]');
          if (closeIdx !== -1) {
            const jsonContent = pendingBuffer.substring(4, closeIdx);
            const repaired = validateAndRepairUIBlock(jsonContent);
            if (repaired) {
              onChunk(`[UI]${repaired}[/UI]`);
            } else {
              onChunk(pendingBuffer.substring(0, closeIdx + 5));
            }
            const after = pendingBuffer.substring(closeIdx + 5);
            pendingBuffer = '';
            bufferMode = 'none';
            if (after) onChunk(after);
          }
        } else {
          const combined = pendingBuffer + content;
          const openIdx = combined.indexOf('[UI]');

          if (openIdx !== -1) {
            const before = combined.substring(0, openIdx);
            if (before) onChunk(before);
            pendingBuffer = combined.substring(openIdx);
            bufferMode = 'tagged';
            const closeIdx = pendingBuffer.indexOf('[/UI]');
            if (closeIdx !== -1) {
              const jsonContent = pendingBuffer.substring(4, closeIdx);
              const repaired = validateAndRepairUIBlock(jsonContent);
              if (repaired) {
                onChunk(`[UI]${repaired}[/UI]`);
              } else {
                onChunk(pendingBuffer.substring(0, closeIdx + 5));
              }
              const after = pendingBuffer.substring(closeIdx + 5);
              pendingBuffer = '';
              bufferMode = 'none';
              if (after) onChunk(after);
            }
          } else {
            // Hold back potential partial "[UI" prefix
            const holdBack = combined.endsWith('[') || combined.endsWith('[U') || combined.endsWith('[UI');
            if (holdBack) {
              const safeEnd = combined.lastIndexOf('[');
              const toSend = combined.substring(0, safeEnd);
              if (toSend) onChunk(toSend);
              pendingBuffer = combined.substring(safeEnd);
            } else {
              if (combined) onChunk(combined);
              pendingBuffer = '';
            }
          }
        }
      }

      if (pendingBuffer && bufferMode === 'tagged') onChunk(pendingBuffer);

      const finalCompletion = await stream.finalChatCompletion();
      const choice = finalCompletion.choices[0];

      if (choice.message.tool_calls?.length) {
        console.log(`[Agent] Iteration ${iteration}: tool_calls, executing...`);
        messages.push(choice.message);

        const toolResults = await Promise.all(
          choice.message.tool_calls
            .filter(tc => tc.type === 'function')
            .map(async (toolCall) => {
              const fnName = toolCall.function.name;
              let fnArgs: Record<string, any> = {};
              try { fnArgs = JSON.parse(toolCall.function.arguments); } catch { fnArgs = {}; }
              onStatus?.(getToolStatus(fnName, lang));
              const startTime = Date.now();
              const result = await executeTool(fnName, fnArgs);
              toolCallLog.push({ toolName: fnName, input: fnArgs, output: result, durationMs: Date.now() - startTime });
              return { toolCall, result };
            })
        );

        for (const { toolCall, result } of toolResults) {
          messages.push({ role: 'tool', tool_call_id: toolCall.id, content: result });
        }
        continue;
      }

      if (accumulatedText) {
        const finalText = wrapBareUIBlocks(accumulatedText);
        return { response: finalText, toolCalls: toolCallLog };
      }

      console.warn(`[Agent] Empty stream on iteration ${iteration}, retrying`);
      messages.push({ role: 'user', content: 'Please give a brief answer based on the data you found.' });
      continue;
    }

    // Non-streaming (reasoning models)
    const response = await client.chat.completions.create({
      model: MODEL,
      ...(isReasoning ? { max_completion_tokens: MAX_TOKENS } : { max_tokens: MAX_TOKENS }),
      messages,
      tools: agentTools,
      ...(isReasoning ? {} : { tool_choice: 'auto' }),
    });

    const choice = response.choices[0];
    const assistantMessage = choice.message;

    console.log(`[Agent] Iteration ${iteration}: finish_reason=${choice.finish_reason}, tool_calls=${assistantMessage.tool_calls?.length || 0}`);

    if (assistantMessage.tool_calls?.length) {
      messages.push(assistantMessage);

      const toolResults = await Promise.all(
        assistantMessage.tool_calls.filter(tc => tc.type === 'function').map(async (toolCall) => {
          const fnName = toolCall.function.name;
          let fnArgs: Record<string, any> = {};
          try { fnArgs = JSON.parse(toolCall.function.arguments); } catch { fnArgs = {}; }
          onStatus?.(getToolStatus(fnName, lang));
          const startTime = Date.now();
          const result = await executeTool(fnName, fnArgs);
          toolCallLog.push({ toolName: fnName, input: fnArgs, output: result, durationMs: Date.now() - startTime });
          return { toolCall, result };
        })
      );

      for (const { toolCall, result } of toolResults) {
        messages.push({ role: 'tool', tool_call_id: toolCall.id, content: result });
      }
      continue;
    }

    let finalText = assistantMessage.content || '';

    if (finalText) {
      finalText = wrapBareUIBlocks(finalText);
      setCache(cacheKey, finalText, toolCallLog);
      return { response: finalText, toolCalls: toolCallLog };
    }

    console.warn(`[Agent] Empty response on iteration ${iteration}`);
    messages.push(assistantMessage);
    messages.push({ role: 'user', content: 'Please give me a brief answer based on the data you found.' });
  }

  console.warn('[Agent] Reached max iterations without final response');
  return {
    response: 'I ran into a complexity limit. Could you try a more specific question?',
    toolCalls: toolCallLog,
  };
}
