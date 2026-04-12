/**
 * DynUI Validator/Repair — validates and auto-repairs UI blocks emitted by the LLM.
 */

import { DYNUI_SCHEMA, DYNUI_TYPES } from './dynui-schema';

const MAX_DEPTH = 4;

// Build set of all known prop names across all block types (for flat-key detection)
const ALL_KNOWN_PROPS = new Set<string>();
for (const schema of Object.values(DYNUI_SCHEMA)) {
  for (const p of schema.requiredProps) ALL_KNOWN_PROPS.add(p);
  for (const p of schema.optionalProps) ALL_KNOWN_PROPS.add(p);
}

/**
 * Validate and repair a JSON string representing one or more UI blocks.
 * Returns the repaired JSON string, or null if the input is invalid.
 */
export function validateAndRepairUIBlock(jsonStr: string): string | null {
  let parsed: any;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    // AI sometimes concatenates multiple JSON objects: {...}{...}
    // Try splitting them with balanced-brace extraction
    const parts = splitConcatenatedJSON(jsonStr.trim());
    if (parts.length > 1) {
      const repaired = parts
        .map(p => { try { return repairBlock(JSON.parse(p), 0); } catch { return null; } })
        .filter(Boolean);
      if (repaired.length === 0) return null;
      return JSON.stringify(repaired.length === 1 ? repaired[0] : repaired);
    }
    return null;
  }

  if (Array.isArray(parsed)) {
    const repaired = parsed.map(b => repairBlock(b, 0)).filter(Boolean);
    if (repaired.length === 0) return null;
    return JSON.stringify(repaired.length === 1 ? repaired[0] : repaired);
  }

  if (typeof parsed === 'object' && parsed !== null) {
    const repaired = repairBlock(parsed, 0);
    return repaired ? JSON.stringify(repaired) : null;
  }

  return null;
}

/** Split concatenated JSON objects like `{...}{...}` into individual strings. */
function splitConcatenatedJSON(raw: string): string[] {
  const results: string[] = [];
  let i = 0;
  while (i < raw.length) {
    if (raw[i] === '{' || raw[i] === '[') {
      const opener = raw[i];
      const closer = opener === '{' ? '}' : ']';
      let depth = 0;
      let inStr = false;
      let esc = false;
      let found = false;
      for (let j = i; j < raw.length; j++) {
        const c = raw[j];
        if (esc) { esc = false; continue; }
        if (inStr) {
          if (c === '\\') esc = true;
          else if (c === '"') inStr = false;
          continue;
        }
        if (c === '"') { inStr = true; continue; }
        if (c === opener) depth++;
        else if (c === closer) {
          depth--;
          if (depth === 0) {
            results.push(raw.substring(i, j + 1));
            i = j + 1;
            found = true;
            break;
          }
        }
      }
      if (!found) break;
    } else {
      i++;
    }
  }
  return results;
}

function repairBlock(block: any, depth: number): any | null {
  if (depth > MAX_DEPTH) return null;
  if (!block || typeof block !== 'object' || !block.type) return null;

  const typeName = block.type as string;
  if (!DYNUI_TYPES.has(typeName)) return null;

  const schema = DYNUI_SCHEMA[typeName];

  // Normalize flat props: lift known prop keys into props:{} if missing
  if (!block.props) {
    const liftedProps: Record<string, any> = {};
    let hasLifted = false;
    for (const key of Object.keys(block)) {
      if (key === 'type' || key === 'children' || key === 'action') continue;
      if (ALL_KNOWN_PROPS.has(key) || schema.requiredProps.includes(key) || schema.optionalProps.includes(key)) {
        liftedProps[key] = block[key];
        hasLifted = true;
      }
    }
    if (hasLifted) {
      block.props = liftedProps;
      // Clean lifted keys from top level
      for (const key of Object.keys(liftedProps)) {
        delete block[key];
      }
    }
  }

  // Ensure props object exists
  if (!block.props) block.props = {};

  // Fix grid + bars: if grid contains comparison_bar or stat_bar, force columns=1
  if (typeName === 'grid' && Array.isArray(block.children)) {
    const hasBars = block.children.some(
      (c: any) => c?.type === 'comparison_bar' || c?.type === 'stat_bar'
    );
    if (hasBars) {
      block.props.columns = 1;
    }
  }

  // Auto-inject openPlayer action on glass_card if it has a child player_image with eaId
  if (typeName === 'glass_card' && !block.action && Array.isArray(block.children)) {
    const playerImg = findPlayerImage(block.children);
    if (playerImg?.props?.eaId) {
      block.action = {
        type: 'openPlayer',
        eaId: playerImg.props.eaId,
        name: playerImg.props.name || '',
        imageUrl: playerImg.props.url || '',
      };
    }
  }

  // Recursively repair children
  if (Array.isArray(block.children)) {
    block.children = block.children
      .map((child: any) => repairBlock(child, depth + 1))
      .filter(Boolean);
    if (block.children.length === 0) delete block.children;
  }

  // Build clean output
  const result: any = { type: typeName, props: block.props };
  if (block.children) result.children = block.children;
  if (block.action) result.action = block.action;

  return result;
}

/** Recursively find first player_image block with eaId in children tree */
function findPlayerImage(children: any[]): any | null {
  for (const child of children) {
    if (!child || typeof child !== 'object') continue;
    if (child.type === 'player_image' && child.props?.eaId) return child;
    if (Array.isArray(child.children)) {
      const found = findPlayerImage(child.children);
      if (found) return found;
    }
  }
  return null;
}
