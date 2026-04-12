/**
 * OpenAI tool definitions for the FUT Evolution AI agent.
 *
 * Each tool maps to a database query or computed result in tool-executor.ts.
 * The schemas follow OpenAI's tool-use format:
 *   { type: "function", function: { name, description, parameters (JSON Schema) } }
 */
import type OpenAI from 'openai';

export const agentTools: OpenAI.ChatCompletionTool[] = [
  // ── 1. Search Players ─────────────────────────────────────────────────────
  {
    type: 'function',
    function: {
      name: 'search_players',
      description:
        'Search for players by name, position, or rating range. Returns top matches with name, position, rating, prices, card images, face stats (PAC/SHO/PAS/DRI/DEF/PHY), skill moves, weak foot, meta tier, and accelerate type. This is usually enough to answer most questions — only call get_player_detail if you need detailed sub-stats or playstyles.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description:
              'Player name to search for — do NOT include card type like "TOTY", "ICON", or "Hero". Use just the surname. Example: "Mbappé", "Ronaldo", "Vinícius". Leave empty when browsing by position.',
          },
          position: {
            type: 'string',
            description:
              'Filter by position. Example: "ST", "CB", "GK", "CAM", "CDM". Use this for position-based searches.',
          },
          minRating: {
            type: 'number',
            description: 'Minimum overall rating. Example: 85.',
          },
          maxPrice: {
            type: 'number',
            description:
              'Maximum price in coins (PS platform). Example: 500000.',
          },
        },
        required: [],
      },
    },
  },

  // ── 2. Get Player Detail ───────────────────────────────────────────────────
  {
    type: 'function',
    function: {
      name: 'get_player_detail',
      description:
        'Get full details for a specific player including all stats, prices, traits, work rates, and card image.',
      parameters: {
        type: 'object',
        properties: {
          eaId: {
            type: 'number',
            description: 'The EA ID of the player to look up.',
          },
        },
        required: ['eaId'],
      },
    },
  },

  // ── 3. Get Better Alternatives ─────────────────────────────────────────────
  {
    type: 'function',
    function: {
      name: 'get_better_alternatives',
      description:
        'Find better alternative players for a given position and budget. Returns similar players ranked by improvement potential (higher meta score, similar price range).',
      parameters: {
        type: 'object',
        properties: {
          eaId: {
            type: 'number',
            description: 'EA ID of the player to find alternatives for.',
          },
          limit: {
            type: 'number',
            description:
              'Number of alternatives to return (default 3, max 5).',
          },
        },
        required: ['eaId'],
      },
    },
  },

  // ── 4. Get Chemistry Links ─────────────────────────────────────────────────
  {
    type: 'function',
    function: {
      name: 'get_chemistry_links',
      description:
        'Get chemistry link partners for a player (same club, league, or nation). Useful for building chemistry in squads.',
      parameters: {
        type: 'object',
        properties: {
          eaId: {
            type: 'number',
            description:
              'EA ID of the player to find chemistry links for.',
          },
        },
        required: ['eaId'],
      },
    },
  },

  // ── 5. Get Meta Tier List ──────────────────────────────────────────────────
  {
    type: 'function',
    function: {
      name: 'get_meta_tier_list',
      description:
        'Get the current meta tier list for a position. Returns S/A/B/C ranked players with meta scores.',
      parameters: {
        type: 'object',
        properties: {
          position: {
            type: 'string',
            description:
              'Position to get the meta tier list for. Example: "ST", "CB", "CDM", "CAM", "GK".',
          },
        },
        required: ['position'],
      },
    },
  },

  // ── 6. Get Formations ──────────────────────────────────────────────────────
  {
    type: 'function',
    function: {
      name: 'get_formations',
      description:
        'Get all available formations and their position layouts. Use to advise on formation changes.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },

  // ── 7. Get Price History ───────────────────────────────────────────────────
  {
    type: 'function',
    function: {
      name: 'get_price_history',
      description:
        'Get price history for a player. Returns price points over time with min/max/avg stats. Useful for investment advice.',
      parameters: {
        type: 'object',
        properties: {
          eaId: {
            type: 'number',
            description:
              'EA ID of the player to get price history for.',
          },
          timeRange: {
            type: 'string',
            description:
              'Time range for history. Options: "24h", "7d", "30d", "all". Default: "7d".',
          },
        },
        required: ['eaId'],
      },
    },
  },

  // ── 8. Get Chem Style Guide ───────────────────────────────────────────────
  {
    type: 'function',
    function: {
      name: 'get_chem_style_guide',
      description: 'Get chemistry style recommendations and boost data. Returns all chem styles with their stat boosts at different chemistry levels. Can optionally filter by position or recommend for a specific player.',
      parameters: {
        type: 'object',
        properties: {
          position: { type: 'string', description: 'Filter chem styles by best position. Example: "ST", "CB", "CAM".' },
          playerEaId: { type: 'number', description: 'EA ID of a player to get personalized chem style recommendation.' },
        },
        required: [],
      },
    },
  },

  // ── 9. Get Custom Tactics ─────────────────────────────────────────────────
  {
    type: 'function',
    function: {
      name: 'get_custom_tactics',
      description: 'Get recommended FC 26 tactics for a formation. Returns Roles + Focus for each position, build-up play, and defensive approach. FC 26 uses Roles (not player instructions) and has no depth/width sliders.',
      parameters: {
        type: 'object',
        properties: {
          formation: { type: 'string', description: 'Formation to get tactics for. Example: "4-2-3-1", "4-3-3", "4-4-2".' },
          style: { type: 'string', description: 'Tactical style preference. Options: "defensive", "balanced", "attacking", "counter".' },
        },
        required: ['formation'],
      },
    },
  },

  // ── 10. Get Skill Moves ───────────────────────────────────────────────────
  {
    type: 'function',
    function: {
      name: 'get_skill_moves',
      description: 'Get skill move tutorials with controller inputs, star requirements, and usage tips. Can filter by star rating or get a specific move.',
      parameters: {
        type: 'object',
        properties: {
          stars: { type: 'number', description: 'Filter by star requirement (1-5).' },
          name: { type: 'string', description: 'Name of a specific skill move to look up.' },
        },
        required: [],
      },
    },
  },

  // ── 11. Get Community Insights ────────────────────────────────────────────
  {
    type: 'function',
    function: {
      name: 'get_community_insights',
      description:
        'Get community opinions and tips about a player from Reddit, YouTube, and forums. Returns what the FUT community thinks about the player — reviews, hidden gems, warnings, and meta tips.',
      parameters: {
        type: 'object',
        properties: {
          playerName: {
            type: 'string',
            description: 'Player name to look up community opinions for.',
          },
          eaId: {
            type: 'number',
            description: 'EA ID of the player (preferred for exact match).',
          },
        },
        required: ['playerName'],
      },
    },
  },
];
