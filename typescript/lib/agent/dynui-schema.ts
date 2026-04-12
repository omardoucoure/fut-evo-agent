/**
 * DynUI Schema Catalog — typed definitions for all Dynamic UI primitives.
 * Single source of truth for prompt generation and validation.
 */

export interface DynUIBlockSchema {
  type: string;
  requiredProps: string[];
  optionalProps: string[];
  hasChildren: boolean;
  supportsAction: boolean;
}

export const DYNUI_SCHEMA: Record<string, DynUIBlockSchema> = {
  // Layout
  glass_card:       { type: 'glass_card',       requiredProps: ['title'],               optionalProps: [],                          hasChildren: true,  supportsAction: true  },
  row:              { type: 'row',              requiredProps: [],                      optionalProps: ['spacing', 'align'],        hasChildren: true,  supportsAction: false },
  column:           { type: 'column',           requiredProps: [],                      optionalProps: ['spacing'],                 hasChildren: true,  supportsAction: false },
  grid:             { type: 'grid',             requiredProps: ['columns'],             optionalProps: [],                          hasChildren: true,  supportsAction: false },
  divider:          { type: 'divider',          requiredProps: [],                      optionalProps: [],                          hasChildren: false, supportsAction: false },
  spacer:           { type: 'spacer',           requiredProps: [],                      optionalProps: ['size'],                    hasChildren: false, supportsAction: false },
  section:          { type: 'section',          requiredProps: ['title'],               optionalProps: [],                          hasChildren: true,  supportsAction: false },

  // Text
  heading:          { type: 'heading',          requiredProps: ['text'],                optionalProps: ['level'],                   hasChildren: false, supportsAction: false },
  text:             { type: 'text',             requiredProps: ['text'],                optionalProps: ['color', 'size', 'weight'], hasChildren: false, supportsAction: false },
  badge:            { type: 'badge',            requiredProps: ['text'],                optionalProps: ['color'],                   hasChildren: false, supportsAction: false },
  markdown:         { type: 'markdown',         requiredProps: ['text'],                optionalProps: [],                          hasChildren: false, supportsAction: false },

  // Data
  stat_bar:         { type: 'stat_bar',         requiredProps: ['label', 'value', 'max'], optionalProps: ['color'],                hasChildren: false, supportsAction: false },
  comparison_bar:   { type: 'comparison_bar',   requiredProps: ['label', 'value1', 'value2'], optionalProps: [],                   hasChildren: false, supportsAction: false },
  star_rating:      { type: 'star_rating',      requiredProps: ['value'],               optionalProps: ['max', 'label'],            hasChildren: false, supportsAction: false },
  sparkline:        { type: 'sparkline',        requiredProps: ['points'],              optionalProps: ['trend'],                   hasChildren: false, supportsAction: false },
  price:            { type: 'price',            requiredProps: ['value'],               optionalProps: ['change_percent'],           hasChildren: false, supportsAction: false },

  // Media
  player_image:     { type: 'player_image',     requiredProps: ['url'],                 optionalProps: ['eaId', 'name', 'height'], hasChildren: false, supportsAction: true  },
  formation_field:  { type: 'formation_field',  requiredProps: ['formation'],           optionalProps: ['players'],                 hasChildren: true,  supportsAction: false },
  radar_chart:      { type: 'radar_chart',      requiredProps: ['labels', 'values1'],   optionalProps: ['values2'],                 hasChildren: false, supportsAction: false },
  list_item:        { type: 'list_item',        requiredProps: ['text'],                optionalProps: ['subtitle', 'icon'],        hasChildren: false, supportsAction: false },
};

/** Set of all valid DynUI type names */
export const DYNUI_TYPES = new Set(Object.keys(DYNUI_SCHEMA));

/** Generate a compact prompt catalog (~600 chars) listing all primitives with their props */
export function generatePromptCatalog(): string {
  function fmt(schema: DynUIBlockSchema): string {
    const required = schema.requiredProps;
    const optional = schema.optionalProps.map(p => `${p}?`);
    const allProps = [...required, ...optional];
    const propStr = allProps.length > 0 ? `(${allProps.join(',')})` : '';
    const flags: string[] = [];
    if (schema.hasChildren) flags.push('children');
    if (schema.supportsAction) flags.push('action');
    const flagStr = flags.length > 0 ? ` [${flags.join(',')}]` : '';
    return `${schema.type}${propStr}${flagStr}`;
  }

  const layout = ['glass_card', 'row', 'column', 'grid', 'divider', 'spacer', 'section'].map(t => fmt(DYNUI_SCHEMA[t])).join(', ');
  const text = ['heading', 'text', 'badge', 'markdown'].map(t => fmt(DYNUI_SCHEMA[t])).join(', ');
  const data = ['stat_bar', 'comparison_bar', 'star_rating', 'sparkline', 'price'].map(t => fmt(DYNUI_SCHEMA[t])).join(', ');
  const media = ['player_image', 'formation_field', 'radar_chart', 'list_item'].map(t => fmt(DYNUI_SCHEMA[t])).join(', ');

  return `UI BLOCKS (wrap in [UI]{json}[/UI], props inside "props":{}):
Layout: ${layout}
Text: ${text}
Data: ${data}
Media: ${media}`;
}
