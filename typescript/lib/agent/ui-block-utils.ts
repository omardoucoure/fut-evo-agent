/**
 * Utility functions for handling Dynamic UI blocks in agent responses.
 * Kept separate from agent.ts to allow lightweight imports (e.g. in tests).
 */

import { DYNUI_TYPES } from './dynui-schema';
import { validateAndRepairUIBlock } from './dynui-validator';

export const UI_BLOCK_TYPES = DYNUI_TYPES;

/**
 * Scan text for bare JSON UI blocks (not wrapped in [UI]...[/UI]) and wrap them.
 * The AI sometimes emits raw JSON inline instead of using [UI] tags.
 * This ensures the mobile parsers can always detect and render UI blocks.
 */
export function wrapBareUIBlocks(text: string): string {
  if (!text.includes('"type"')) return text;
  const hasBareType = UI_BLOCK_TYPES.has('glass_card') && (
    text.includes('"type":"glass_card"') || text.includes('"type": "glass_card"') ||
    text.includes('"type":"row"') || text.includes('"type": "row"') ||
    text.includes('"type":"column"') || text.includes('"type": "column"')
  );
  if (!hasBareType) return text;

  const withoutTagged = text.replace(/\[UI\][\s\S]*?\[\/UI\]/g, '');
  const bareHasUI = UI_BLOCK_TYPES.has('glass_card') && (
    withoutTagged.includes('"type":"glass_card"') || withoutTagged.includes('"type": "glass_card"') ||
    withoutTagged.includes('"type":"row"') || withoutTagged.includes('"type": "row"') ||
    withoutTagged.includes('"type":"column"') || withoutTagged.includes('"type": "column"')
  );
  if (!bareHasUI) return text;

  let result = '';
  let i = 0;

  while (i < text.length) {
    if (text.startsWith('[UI]', i)) {
      const closeIdx = text.indexOf('[/UI]', i);
      if (closeIdx !== -1) {
        result += text.substring(i, closeIdx + 5);
        i = closeIdx + 5;
        continue;
      }
    }

    if ((text[i] === '[' || text[i] === '{') && couldBeUIBlock(text, i)) {
      const extracted = extractBalanced(text, i);
      if (extracted) {
        const { json, end } = extracted;
        try {
          const parsed = JSON.parse(json);
          const blocks = Array.isArray(parsed) ? parsed : [parsed];
          if (blocks.length > 0 && blocks.every((b: any) => b.type && UI_BLOCK_TYPES.has(b.type))) {
            const repaired = validateAndRepairUIBlock(json);
            if (repaired) {
              result += `[UI]${repaired}[/UI]`;
            } else {
              result += json;
            }
            i = end;
            continue;
          }
        } catch { /* not valid JSON, skip */ }
      }
    }

    result += text[i];
    i++;
  }

  return result;
}

/** Quick check: does the JSON starting at pos look like it might contain a UI block type? */
function couldBeUIBlock(text: string, pos: number): boolean {
  const lookahead = text.substring(pos, pos + 200);
  return Array.from(UI_BLOCK_TYPES).some(t =>
    lookahead.includes(`"type":"${t}"`) || lookahead.includes(`"type": "${t}"`)
  );
}

/** Extract a balanced JSON string starting at pos. Returns {json, end} or null. */
function extractBalanced(str: string, start: number): { json: string; end: number } | null {
  const opener = str[start];
  const closer = opener === '[' ? ']' : '}';
  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = start; i < str.length; i++) {
    const c = str[i];
    if (escape) { escape = false; continue; }
    if (inString) {
      if (c === '\\') escape = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; continue; }
    if (c === opener) depth++;
    else if (c === closer) {
      depth--;
      if (depth === 0) return { json: str.substring(start, i + 1), end: i + 1 };
    }
  }
  return null;
}
