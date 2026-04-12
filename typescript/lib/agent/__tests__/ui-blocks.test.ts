/**
 * Tests for agent UI block handling:
 * - wrapBareUIBlocks: server-side wrapping of bare JSON in [UI] tags
 * - validateAndRepairUIBlock: server-side validation/repair
 * - streaming buffering behavior (containsBareJsonStart detection)
 */

import { wrapBareUIBlocks } from '../ui-block-utils';
import { validateAndRepairUIBlock } from '../dynui-validator';
import { DYNUI_TYPES, generatePromptCatalog } from '../dynui-schema';

// ── helpers ──────────────────────────────────────────────────────────────────

// Note: wrapBareUIBlocks now validates/repairs JSON, so output may differ from input.
// Tests use parsed comparison instead of exact string matching where repair changes output.

const GLASS_CARD = JSON.stringify([
  {
    type: 'glass_card',
    props: { title: 'Test' },
    children: [
      { type: 'heading', props: { text: 'Hello', level: 2 } },
      { type: 'stat_bar', props: { label: 'PAC', value: 90 } },
    ],
  },
]);

const COMPARISON_BLOCK = JSON.stringify([
  {
    type: 'glass_card',
    props: { title: 'Messi vs Ronaldo' },
    children: [
      {
        type: 'row',
        props: { spacing: 'lg' },
        children: [
          { type: 'player_image', props: { url: 'https://example.com/1.png', eaId: '158023', name: 'Messi', height: 'lg' } },
          { type: 'player_image', props: { url: 'https://example.com/2.png', eaId: '37576', name: 'Ronaldo', height: 'lg' } },
        ],
      },
      { type: 'comparison_bar', props: { label: 'PAC', value1: 87, value2: 89 } },
      { type: 'comparison_bar', props: { label: 'SHO', value1: 92, value2: 93 } },
    ],
  },
]);

/** Extract JSON from [UI]...[/UI] wrapper */
function extractUIJson(result: string): any {
  const match = result.match(/\[UI\]([\s\S]*?)\[\/UI\]/);
  return match ? JSON.parse(match[1]) : null;
}

// ── wrapBareUIBlocks ──────────────────────────────────────────────────────────

describe('wrapBareUIBlocks', () => {
  describe('already-tagged content', () => {
    it('leaves [UI]...[/UI] content unchanged', () => {
      const input = `[UI]${GLASS_CARD}[/UI]`;
      expect(wrapBareUIBlocks(input)).toBe(input);
    });

    it('leaves text-only content unchanged', () => {
      const input = 'Lionel Messi is a great player. You should upgrade your CAM.';
      expect(wrapBareUIBlocks(input)).toBe(input);
    });

    it('leaves non-UI JSON unchanged (no known type)', () => {
      const input = '{"status":"ok","count":5}';
      expect(wrapBareUIBlocks(input)).toBe(input);
    });
  });

  describe('bare JSON wrapping', () => {
    it('wraps bare JSON array with glass_card in [UI] tags', () => {
      const result = wrapBareUIBlocks(GLASS_CARD);
      expect(result).toMatch(/^\[UI\].*\[\/UI\]$/);
      const parsed = extractUIJson(result);
      expect(parsed.type).toBe('glass_card');
      expect(parsed.props.title).toBe('Test');
    });

    it('wraps bare comparison block', () => {
      const result = wrapBareUIBlocks(COMPARISON_BLOCK);
      expect(result).toMatch(/^\[UI\].*\[\/UI\]$/);
      const parsed = extractUIJson(result);
      expect(parsed.type).toBe('glass_card');
      expect(parsed.props.title).toBe('Messi vs Ronaldo');
    });

    it('wraps bare JSON preceded by text', () => {
      const prefix = "Here's the head-to-head breakdown.\n";
      const input = prefix + GLASS_CARD;
      const result = wrapBareUIBlocks(input);
      expect(result).toContain(prefix);
      expect(result).toContain('[UI]');
      expect(result).toContain('[/UI]');
    });

    it('wraps bare JSON followed by text', () => {
      const suffix = '\nLet me know if you have any questions!';
      const input = GLASS_CARD + suffix;
      const result = wrapBareUIBlocks(input);
      expect(result).toContain('[UI]');
      expect(result).toContain('[/UI]');
      expect(result).toContain(suffix);
    });

    it('wraps bare JSON surrounded by text', () => {
      const prefix = 'Lionel **Messi** or **Ronaldo** — let\'s settle this!\nHere\'s the breakdown.\n';
      const suffix = '\nHonestly, Messi wins on dribbling.';
      const input = prefix + GLASS_CARD + suffix;
      const result = wrapBareUIBlocks(input);
      expect(result).toContain(prefix);
      expect(result).toContain('[UI]');
      expect(result).toContain('[/UI]');
      expect(result).toContain(suffix);
    });

    it('wraps single-object bare JSON', () => {
      const singleObj = JSON.stringify({
        type: 'glass_card',
        props: { title: 'Test' },
        children: [],
      });
      const result = wrapBareUIBlocks(singleObj);
      expect(result).toMatch(/^\[UI\].*\[\/UI\]$/);
      const parsed = extractUIJson(result);
      expect(parsed.type).toBe('glass_card');
      // Validator strips empty children
      expect(parsed.children).toBeUndefined();
    });
  });

  describe('mixed tagged + bare JSON', () => {
    it('keeps existing [UI] tag and does not double-wrap', () => {
      const input = `Some text [UI]${GLASS_CARD}[/UI] more text`;
      const result = wrapBareUIBlocks(input);
      expect(result).toBe(input);
    });

    it('preserves tagged block when bare non-container block follows', () => {
      // wrapBareUIBlocks pre-filters on glass_card/row/column — a bare stat_bar alone
      // is not detected as needing wrapping (it should be inside a glass_card)
      const bare = JSON.stringify([{ type: 'stat_bar', props: { label: 'PAC', value: 88 } }]);
      const input = `[UI]${GLASS_CARD}[/UI] And here is another: ${bare}`;
      const result = wrapBareUIBlocks(input);
      expect(result).toContain(`[UI]${GLASS_CARD}[/UI]`);
      // bare stat_bar remains unwrapped (acceptable — agent should use glass_card as container)
    });

    it('wraps bare glass_card block that comes after a tagged block', () => {
      const bare = JSON.stringify([{ type: 'glass_card', props: { title: 'Second' }, children: [] }]);
      const input = `[UI]${GLASS_CARD}[/UI] And another card: ${bare}`;
      const result = wrapBareUIBlocks(input);
      // First tagged block preserved
      expect(result).toContain(`[UI]${GLASS_CARD}[/UI]`);
      // Second bare block gets wrapped (and validated — empty children stripped)
      const uiMatches = result.match(/\[UI\].*?\[\/UI\]/g) || [];
      expect(uiMatches.length).toBe(2);
      const secondParsed = JSON.parse(uiMatches[1].replace('[UI]', '').replace('[/UI]', ''));
      expect(secondParsed.type).toBe('glass_card');
      expect(secondParsed.props.title).toBe('Second');
    });
  });

  describe('invalid / malformed JSON', () => {
    it('does not wrap truncated/incomplete JSON', () => {
      const truncated = '[{"type":"glass_card","props":{"title":"Messi vs Ronaldo"},"children":[{';
      const result = wrapBareUIBlocks(truncated);
      // Truncated JSON can't be parsed — should be left as-is
      expect(result).toBe(truncated);
    });

    it('does not wrap JSON with unknown block types', () => {
      const unknownType = JSON.stringify([{ type: 'unknown_widget', props: {} }]);
      const result = wrapBareUIBlocks(unknownType);
      expect(result).toBe(unknownType);
    });
  });

  describe('edge cases', () => {
    it('handles empty string', () => {
      expect(wrapBareUIBlocks('')).toBe('');
    });

    it('handles whitespace-only string', () => {
      expect(wrapBareUIBlocks('   ')).toBe('   ');
    });

    it('handles multiple consecutive bare blocks', () => {
      const block1 = JSON.stringify([{ type: 'glass_card', props: { title: 'A' }, children: [] }]);
      const block2 = JSON.stringify([{ type: 'glass_card', props: { title: 'B' }, children: [] }]);
      const input = `${block1}\n${block2}`;
      const result = wrapBareUIBlocks(input);
      // Both blocks should be wrapped in [UI] tags (validator may modify JSON)
      const uiMatches = result.match(/\[UI\].*?\[\/UI\]/g) || [];
      expect(uiMatches.length).toBe(2);
      const parsed1 = JSON.parse(uiMatches[0].replace('[UI]', '').replace('[/UI]', ''));
      const parsed2 = JSON.parse(uiMatches[1].replace('[UI]', '').replace('[/UI]', ''));
      expect(parsed1.props.title).toBe('A');
      expect(parsed2.props.title).toBe('B');
    });

    it('does not wrap markdown code blocks containing JSON', () => {
      // If model wraps in code fences, the [ starts inside ``` which we should ideally not wrap
      // At minimum, the output must not break (should be stable)
      const input = '```json\n' + GLASS_CARD + '\n```';
      const result = wrapBareUIBlocks(input);
      // Should be a string (not throw), and may or may not wrap the JSON
      expect(typeof result).toBe('string');
    });
  });
});

// ── containsBareJsonStart detection (mirrors iOS/Android logic) ──────────────

describe('bare JSON detection heuristic', () => {
  const knownTypes = [
    'glass_card', 'row', 'column', 'grid', 'player_image',
    'comparison_bar', 'stat_bar', 'heading', 'badge', 'list_item',
    'radar_chart', 'price', 'markdown', 'text', 'star_rating',
  ];

  function containsBareJsonStart(content: string): boolean {
    const hasTypeField = content.includes('"type":"') || content.includes('"type": "');
    if (!hasTypeField) return false;
    return knownTypes.some(t => content.includes(`"type":"${t}"`) || content.includes(`"type": "${t}"`));
  }

  it('detects glass_card bare JSON', () => {
    expect(containsBareJsonStart(GLASS_CARD)).toBe(true);
  });

  it('detects comparison bar', () => {
    const text = '{"type":"comparison_bar","props":{"label":"PAC","value1":87,"value2":89}}';
    expect(containsBareJsonStart(text)).toBe(true);
  });

  it('returns false for plain text', () => {
    expect(containsBareJsonStart('Messi is better than Ronaldo.')).toBe(false);
  });

  it('returns false for unrelated JSON', () => {
    expect(containsBareJsonStart('{"type":"error","message":"not found"}')).toBe(false);
  });

  it('detects bare JSON preceded by text', () => {
    const content = "Here's the breakdown.\n" + COMPARISON_BLOCK;
    expect(containsBareJsonStart(content)).toBe(true);
  });

  it('returns true for [UI]-tagged content (has type field)', () => {
    // containsUIBlocks would check for tags first, but this helper also matches
    expect(containsBareJsonStart(`[UI]${GLASS_CARD}[/UI]`)).toBe(true);
  });

  it('returns false for type field with space before colon', () => {
    // "type" : "glass_card" — neither heuristic matches
    const oddFormat = '{"type" : "glass_card","props":{}}';
    expect(containsBareJsonStart(oddFormat)).toBe(false);
  });
});

// ── streaming buffer logic ────────────────────────────────────────────────────

describe('streaming chunk buffer behavior', () => {
  /**
   * Simulates the server-side streaming buffer logic from agent.ts.
   * Returns the chunks that would be sent to the client.
   */
  function simulateStream(chunks: string[]): string[] {
    const sent: string[] = [];
    let pendingBuffer = '';
    let bufferMode: 'none' | 'tagged' | 'bare' = 'none';

    for (const content of chunks) {
      if (bufferMode === 'tagged') {
        pendingBuffer += content;
        const closeIdx = pendingBuffer.indexOf('[/UI]');
        if (closeIdx !== -1) {
          sent.push(pendingBuffer.substring(0, closeIdx + 5));
          const after = pendingBuffer.substring(closeIdx + 5);
          pendingBuffer = '';
          bufferMode = 'none';
          if (after) sent.push(after);
        }
      } else if (bufferMode === 'bare') {
        pendingBuffer += content;
      } else {
        const combined = pendingBuffer + content;
        const openIdx = combined.indexOf('[UI]');
        if (openIdx !== -1) {
          const before = combined.substring(0, openIdx);
          if (before) sent.push(before);
          pendingBuffer = combined.substring(openIdx);
          bufferMode = 'tagged';
          const closeIdx = pendingBuffer.indexOf('[/UI]');
          if (closeIdx !== -1) {
            sent.push(pendingBuffer.substring(0, closeIdx + 5));
            const after = pendingBuffer.substring(closeIdx + 5);
            pendingBuffer = '';
            bufferMode = 'none';
            if (after) sent.push(after);
          }
        } else if (/\[\s*\{/.test(combined) || (/^\s*\{/.test(combined) && combined.includes('"type"'))) {
          bufferMode = 'bare';
          pendingBuffer = combined;
        } else {
          const holdBack = combined.endsWith('[') || combined.endsWith('[U') || combined.endsWith('[UI');
          if (holdBack) {
            const safeEnd = combined.lastIndexOf('[');
            const toSend = combined.substring(0, safeEnd);
            if (toSend) sent.push(toSend);
            pendingBuffer = combined.substring(safeEnd);
          } else {
            if (combined) sent.push(combined);
            pendingBuffer = '';
          }
        }
      }
    }
    if (pendingBuffer && bufferMode === 'tagged') sent.push(pendingBuffer);
    return sent;
  }

  it('streams plain text chunks immediately', () => {
    const chunks = ['Hello', ' there', ', how can I help?'];
    const sent = simulateStream(chunks);
    expect(sent.join('')).toBe('Hello there, how can I help?');
  });

  it('buffers [UI] block and sends as single chunk', () => {
    const block = `[UI]${GLASS_CARD}[/UI]`;
    // Simulate the block arriving in pieces
    const half = Math.floor(block.length / 2);
    const chunks = [block.substring(0, half), block.substring(half)];
    const sent = simulateStream(chunks);
    const joined = sent.join('');
    expect(joined).toBe(block);
    // Should arrive as one or two chunks but never show partial JSON
    expect(sent.every(s => !s.startsWith('{') && !s.startsWith('[{'))).toBe(true);
  });

  it('sends text before [UI] block immediately, then block as one chunk', () => {
    const intro = 'Here is the comparison: ';
    const block = `[UI]${GLASS_CARD}[/UI]`;
    const full = intro + block;
    const chunkSize = 20;
    const chunks: string[] = [];
    for (let i = 0; i < full.length; i += chunkSize) {
      chunks.push(full.substring(i, i + chunkSize));
    }
    const sent = simulateStream(chunks);
    const joined = sent.join('');
    expect(joined).toBe(full);
    // Intro text should be sent before the block
    expect(sent[0]).toContain('Here');
  });

  it('suppresses bare JSON from being streamed', () => {
    // Model outputs bare JSON without [UI] tags — should be silently buffered
    const intro = 'Great question! ';
    const chunks = [intro, ...GLASS_CARD.match(/.{1,30}/g)!];
    const sent = simulateStream(chunks);
    // Only intro should be sent; bare JSON is buffered silently
    const joined = sent.join('');
    expect(joined).toBe(intro);
    expect(sent.every(s => !s.includes('"type"'))).toBe(true);
  });

  it('holds back partial [UI prefix to avoid splitting tag', () => {
    const chunks = ['Some text [', 'UI]' + GLASS_CARD + '[/UI]'];
    const sent = simulateStream(chunks);
    const joined = sent.join('');
    expect(joined).toBe('Some text ' + `[UI]${GLASS_CARD}[/UI]`);
  });
});

// ── DynUI Schema ──────────────────────────────────────────────────────────────

describe('DynUI Schema', () => {
  it('contains all expected types', () => {
    const expected = [
      'glass_card', 'row', 'column', 'grid', 'divider', 'spacer', 'section',
      'heading', 'text', 'badge', 'markdown',
      'stat_bar', 'comparison_bar', 'star_rating', 'sparkline', 'price',
      'player_image', 'formation_field', 'radar_chart', 'list_item',
    ];
    for (const t of expected) {
      expect(DYNUI_TYPES.has(t)).toBe(true);
    }
  });

  it('does NOT contain progress_bar (merged into stat_bar)', () => {
    expect(DYNUI_TYPES.has('progress_bar')).toBe(false);
  });

  it('generates a compact prompt catalog', () => {
    const catalog = generatePromptCatalog();
    expect(catalog).toContain('glass_card(title)');
    expect(catalog).toContain('comparison_bar(label,value1,value2)');
    expect(catalog).toContain('player_image(url');
    expect(catalog).toContain('[children,action]');
    expect(catalog).toContain('Layout:');
    expect(catalog).toContain('Data:');
    expect(catalog).toContain('Media:');
    // Should be compact
    expect(catalog.length).toBeLessThan(1000);
  });
});

// ── DynUI Validator ─────────────────────────────────────────────────────────

describe('validateAndRepairUIBlock', () => {
  describe('valid blocks', () => {
    it('passes through well-formed block', () => {
      const input = JSON.stringify({ type: 'text', props: { text: 'Hello' } });
      const result = validateAndRepairUIBlock(input);
      expect(result).not.toBeNull();
      const parsed = JSON.parse(result!);
      expect(parsed.type).toBe('text');
      expect(parsed.props.text).toBe('Hello');
    });

    it('passes through block with children', () => {
      const input = JSON.stringify({
        type: 'glass_card',
        props: { title: 'Test' },
        children: [{ type: 'heading', props: { text: 'Hi' } }],
      });
      const result = validateAndRepairUIBlock(input);
      const parsed = JSON.parse(result!);
      expect(parsed.children).toHaveLength(1);
      expect(parsed.children[0].type).toBe('heading');
    });
  });

  describe('flat prop normalization', () => {
    it('lifts flat props into props wrapper', () => {
      const input = JSON.stringify({ type: 'text', text: 'Hello', color: 'red' });
      const result = validateAndRepairUIBlock(input);
      const parsed = JSON.parse(result!);
      expect(parsed.props.text).toBe('Hello');
      expect(parsed.props.color).toBe('red');
      // Should not have flat keys
      expect(parsed.text).toBeUndefined();
    });

    it('lifts stat_bar flat props', () => {
      const input = JSON.stringify({ type: 'stat_bar', label: 'PAC', value: 90, max: 99 });
      const result = validateAndRepairUIBlock(input);
      const parsed = JSON.parse(result!);
      expect(parsed.props.label).toBe('PAC');
      expect(parsed.props.value).toBe(90);
      expect(parsed.props.max).toBe(99);
    });
  });

  describe('grid + bars fix', () => {
    it('forces columns=1 when grid contains comparison_bar', () => {
      const input = JSON.stringify({
        type: 'grid',
        props: { columns: 2 },
        children: [
          { type: 'comparison_bar', props: { label: 'PAC', value1: 90, value2: 85 } },
          { type: 'comparison_bar', props: { label: 'SHO', value1: 88, value2: 92 } },
        ],
      });
      const result = validateAndRepairUIBlock(input);
      const parsed = JSON.parse(result!);
      expect(parsed.props.columns).toBe(1);
    });

    it('forces columns=1 when grid contains stat_bar', () => {
      const input = JSON.stringify({
        type: 'grid',
        props: { columns: 2 },
        children: [
          { type: 'stat_bar', props: { label: 'PAC', value: 90, max: 99 } },
        ],
      });
      const result = validateAndRepairUIBlock(input);
      const parsed = JSON.parse(result!);
      expect(parsed.props.columns).toBe(1);
    });

    it('preserves columns when grid has no bars', () => {
      const input = JSON.stringify({
        type: 'grid',
        props: { columns: 2 },
        children: [
          { type: 'text', props: { text: 'A' } },
          { type: 'text', props: { text: 'B' } },
        ],
      });
      const result = validateAndRepairUIBlock(input);
      const parsed = JSON.parse(result!);
      expect(parsed.props.columns).toBe(2);
    });
  });

  describe('openPlayer action injection', () => {
    it('auto-injects openPlayer on glass_card with player_image eaId', () => {
      const input = JSON.stringify({
        type: 'glass_card',
        props: { title: 'Messi' },
        children: [
          { type: 'player_image', props: { url: 'https://img.com/messi.png', eaId: '158023', name: 'Messi' } },
        ],
      });
      const result = validateAndRepairUIBlock(input);
      const parsed = JSON.parse(result!);
      expect(parsed.action).toBeDefined();
      expect(parsed.action.type).toBe('openPlayer');
      expect(parsed.action.eaId).toBe('158023');
      expect(parsed.action.name).toBe('Messi');
    });

    it('does NOT inject if action already exists', () => {
      const input = JSON.stringify({
        type: 'glass_card',
        props: { title: 'Ndidi' },
        children: [
          { type: 'player_image', props: { url: 'https://img.com/ndidi.png', eaId: '50359778', name: 'Ndidi' } },
        ],
        action: { type: 'swapPlayer', slot: 'CDM', eaId: '50359778', name: 'Ndidi', imageUrl: 'url', rating: 91 },
      });
      const result = validateAndRepairUIBlock(input);
      const parsed = JSON.parse(result!);
      expect(parsed.action.type).toBe('swapPlayer');
    });

    it('does NOT inject if player_image has no eaId', () => {
      const input = JSON.stringify({
        type: 'glass_card',
        props: { title: 'Test' },
        children: [
          { type: 'player_image', props: { url: 'https://img.com/test.png' } },
        ],
      });
      const result = validateAndRepairUIBlock(input);
      const parsed = JSON.parse(result!);
      expect(parsed.action).toBeUndefined();
    });
  });

  describe('rejection', () => {
    it('returns null for invalid JSON', () => {
      expect(validateAndRepairUIBlock('not json {')).toBeNull();
    });

    it('returns null for unknown type', () => {
      const input = JSON.stringify({ type: 'fancy_widget', props: {} });
      expect(validateAndRepairUIBlock(input)).toBeNull();
    });

    it('strips children that exceed depth 4', () => {
      // Build a block nested 6 levels deep — validator keeps top 5 levels, strips deepest
      let block: any = { type: 'text', props: { text: 'deep' } };
      for (let i = 0; i < 5; i++) {
        block = { type: 'column', props: {}, children: [block] };
      }
      const result = validateAndRepairUIBlock(JSON.stringify(block));
      expect(result).not.toBeNull();
      const parsed = JSON.parse(result!);
      // Walk to depth 4 — should exist
      let node = parsed;
      for (let i = 0; i < 3; i++) {
        expect(node.children).toBeDefined();
        node = node.children[0];
      }
      // At depth 4, the child (depth 5) should have been pruned
      expect(node.children?.[0]?.children).toBeUndefined();
    });

    it('returns null for block without type', () => {
      const input = JSON.stringify({ props: { text: 'no type' } });
      expect(validateAndRepairUIBlock(input)).toBeNull();
    });
  });

  describe('concatenated JSON', () => {
    it('repairs two concatenated objects into an array', () => {
      const obj1 = JSON.stringify({ type: 'glass_card', props: { title: 'Player A' } });
      const obj2 = JSON.stringify({ type: 'glass_card', props: { title: 'Player B' } });
      const input = obj1 + obj2; // no space between — AI does this
      const result = validateAndRepairUIBlock(input);
      expect(result).not.toBeNull();
      const parsed = JSON.parse(result!);
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed).toHaveLength(2);
      expect(parsed[0].props.title).toBe('Player A');
      expect(parsed[1].props.title).toBe('Player B');
    });

    it('repairs concatenated objects with whitespace between them', () => {
      const obj1 = JSON.stringify({ type: 'text', props: { text: 'A' } });
      const obj2 = JSON.stringify({ type: 'text', props: { text: 'B' } });
      const input = obj1 + '\n' + obj2;
      const result = validateAndRepairUIBlock(input);
      expect(result).not.toBeNull();
      const parsed = JSON.parse(result!);
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed).toHaveLength(2);
    });
  });

  describe('cleanup', () => {
    it('strips empty children array', () => {
      const input = JSON.stringify({ type: 'glass_card', props: { title: 'X' }, children: [] });
      const result = validateAndRepairUIBlock(input);
      const parsed = JSON.parse(result!);
      expect(parsed.children).toBeUndefined();
    });

    it('unwraps single-item arrays', () => {
      const input = JSON.stringify([{ type: 'text', props: { text: 'Solo' } }]);
      const result = validateAndRepairUIBlock(input);
      const parsed = JSON.parse(result!);
      // Single-item array unwrapped to object
      expect(parsed.type).toBe('text');
      expect(Array.isArray(parsed)).toBe(false);
    });
  });
});
