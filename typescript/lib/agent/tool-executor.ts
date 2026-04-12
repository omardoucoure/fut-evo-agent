/**
 * Tool executor for the FUT Evolution AI agent.
 *
 * Each function resolves a tool call by querying the PostgreSQL database
 * using the project's fluent query builder (createClient).
 * Results are returned as JSON strings for Anthropic tool_result messages.
 */
import { createClient } from '@/lib/database/client';
import {
  FORMATIONS,
  CHEM_STYLES,
  TACTICAL_PRESETS,
  SKILL_MOVES,
  type ChemStyleData,
  type TacticalPreset,
  type SkillMoveData,
} from '@/lib/agent/static-data';

function getDb() {
  return createClient();
}

const TOOL_TIMEOUT_MS = Number(process.env.AGENT_TOOL_TIMEOUT_MS || 15000);

async function withTimeout<T>(name: string, fn: () => Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      fn(),
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`Tool "${name}" timed out after ${TOOL_TIMEOUT_MS}ms`));
        }, TOOL_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ── Column selections ────────────────────────────────────────────────────────

const SEARCH_COLUMNS = `
  ea_id, name, common_name, position, overall,
  ps_price, xbox_price, pc_price,
  card_image_url, rarity_name,
  club, league, nationality,
  skill_moves, weak_foot,
  face_pace, face_shooting, face_passing, face_dribbling, face_defending, face_physicality,
  meta_score, meta_tier, meta_primary_role, accelerate_type
`;

const DETAIL_COLUMNS = `
  ea_id, name, common_name, first_name, last_name, slug,
  position, overall, club, league, nationality,
  nation_image_url, club_image_url, league_image_url,
  rarity_name, card_image_url, local_card_image, player_image_url,
  ps_price, xbox_price, pc_price,
  skill_moves, weak_foot, height, weight, foot,
  accelerate_type, alternative_positions,
  face_pace, face_shooting, face_passing, face_dribbling, face_defending, face_physicality,
  acceleration, sprint_speed, positioning, finishing, shot_power, long_shots, volleys, penalties,
  vision, crossing, fk_accuracy, short_passing, long_passing, curve,
  agility, balance, reactions, ball_control, dribbling, composure,
  interceptions, heading_accuracy, def_awareness, standing_tackle, sliding_tackle,
  jumping, stamina, strength, aggression,
  gk_diving, gk_handling, gk_kicking, gk_positioning, gk_reflexes, gk_speed,
  playstyles, playstyles_plus,
  attacking_workrate, defensive_workrate,
  meta_score, meta_tier, meta_primary_role, meta_primary_score, meta_primary_tier, meta_best_roles
`;

const ALTERNATIVE_COLUMNS = `
  ea_id, name, common_name, position, overall,
  ps_price, xbox_price, pc_price,
  card_image_url, rarity_name,
  club, league, nationality, nation_image_url,
  skill_moves, weak_foot,
  face_pace, face_shooting, face_passing, face_dribbling, face_defending, face_physicality,
  meta_score, meta_tier, accelerate_type
`;

const CHEMISTRY_COLUMNS = `
  ea_id, name, common_name, position, overall,
  club, league, nationality, nation_image_url,
  rarity_name, card_image_url,
  meta_score, meta_tier
`;

const META_TIER_COLUMNS = `
  ea_id, name, common_name, position, overall,
  ps_price, xbox_price, pc_price,
  card_image_url, rarity_name,
  club, league, nationality,
  meta_score, meta_tier, meta_primary_role, meta_primary_score, meta_primary_tier
`;

// ── Position group helpers ───────────────────────────────────────────────────

function getCompatiblePositions(position: string): string[] {
  const positionGroups: Record<string, string[]> = {
    ST: ['ST', 'CF'],
    CF: ['CF', 'ST', 'CAM'],
    LW: ['LW', 'LM', 'LF'],
    RW: ['RW', 'RM', 'RF'],
    LM: ['LM', 'LW'],
    RM: ['RM', 'RW'],
    LF: ['LF', 'LW', 'LM'],
    RF: ['RF', 'RW', 'RM'],
    CAM: ['CAM', 'CF', 'CM'],
    CM: ['CM', 'CAM', 'CDM'],
    CDM: ['CDM', 'CM'],
    LB: ['LB', 'LWB'],
    RB: ['RB', 'RWB'],
    LWB: ['LWB', 'LB'],
    RWB: ['RWB', 'RB'],
    CB: ['CB'],
    GK: ['GK'],
  };
  return positionGroups[position] || [position];
}

// ── Tool implementations ─────────────────────────────────────────────────────

async function searchPlayers(input: {
  query?: string;
  position?: string;
  minRating?: number;
  maxPrice?: number;
}): Promise<string> {
  const db = getDb();

  // Detect if query is actually a position abbreviation
  const POSITIONS = ['ST', 'CF', 'LW', 'RW', 'LM', 'RM', 'LF', 'RF', 'CAM', 'CM', 'CDM', 'LB', 'RB', 'LWB', 'RWB', 'CB', 'GK'];
  const queryUpper = input.query?.trim().toUpperCase() || '';
  if (queryUpper && POSITIONS.includes(queryUpper) && !input.position) {
    // User passed a position as query — treat it as a position filter
    input.position = queryUpper;
    input.query = undefined;
  }

  let query = db.from('players').select(SEARCH_COLUMNS);

  // Extract card type keywords from query (e.g. "Mbappé TOTY" → name="Mbappé", cardType="TOTY")
  const CARD_TYPE_KEYWORDS: Record<string, string[]> = {
    'TOTY': ['TOTY'], 'TOTS': ['TOTS'], 'ICON': ['Icon'], 'ICONS': ['Icon'],
    'HERO': ['Hero'], 'HEROES': ['Hero'], 'TOTW': ['TOTW', 'Team of the Week'],
    'POTM': ['POTM'], 'SBC': ['SBC'], 'FUTURE STARS': ['Future Stars'],
    'WINTER WILDCARDS': ['Winter Wildcards'], 'CENTURIONS': ['Centurions'],
    'THUNDERSTRUCK': ['Thunderstruck'], 'TRAILBLAZERS': ['Trailblazers'],
  };
  let nameQuery = input.query?.trim() || '';
  let cardTypeFilter: string[] | null = null;
  if (nameQuery) {
    const words = nameQuery.split(/\s+/);
    // Check 2-word then 1-word card type at end of query
    for (const len of [2, 1]) {
      if (words.length > len) {
        const suffix = words.slice(-len).join(' ').toUpperCase();
        if (CARD_TYPE_KEYWORDS[suffix]) {
          cardTypeFilter = CARD_TYPE_KEYWORDS[suffix];
          nameQuery = words.slice(0, -len).join(' ').trim();
          break;
        }
      }
    }
  }

  // Name search (if provided)
  if (nameQuery) {
    query = query.or(`name.ilike.%${nameQuery}%,common_name.ilike.%${nameQuery}%`);
  }

  // Card type filter (extracted from query like "Mbappé TOTY")
  if (cardTypeFilter) {
    if (cardTypeFilter.length === 1) {
      query = query.ilike('rarity_name', `%${cardTypeFilter[0]}%`);
    } else {
      query = query.or(cardTypeFilter.map(ct => `rarity_name.ilike.%${ct}%`).join(','));
    }
  }

  if (input.position) {
    query = query.eq('position', input.position.toUpperCase());
  }
  if (input.minRating) {
    query = query.gte('overall', input.minRating);
  }
  if (input.maxPrice) {
    query = query.lte('ps_price', input.maxPrice);
  }

  // Position-only browse: require a minimum rating to get useful results
  if (!input.query && input.position && !input.minRating) {
    query = query.gte('overall', 85);
  }

  query = query
    .order('overall', { ascending: false })
    .limit(10);

  const { data, error } = await query;

  if (error) {
    return JSON.stringify({ error: error.message });
  }

  return JSON.stringify({
    count: data?.length || 0,
    players: (data || []).map((p: any) => ({
      eaId: p.ea_id,
      name: p.common_name || p.name,
      position: p.position,
      overall: p.overall,
      psPrice: p.ps_price,
      xboxPrice: p.xbox_price,
      pcPrice: p.pc_price,
      cardImageUrl: p.card_image_url,
      rarityName: p.rarity_name,
      club: p.club,
      league: p.league,
      nationality: p.nationality,
      skillMoves: p.skill_moves,
      weakFoot: p.weak_foot,
      faceStats: {
        pace: p.face_pace,
        shooting: p.face_shooting,
        passing: p.face_passing,
        dribbling: p.face_dribbling,
        defending: p.face_defending,
        physicality: p.face_physicality,
      },
      metaScore: p.meta_score,
      metaTier: p.meta_tier,
      metaRole: p.meta_primary_role,
      accelerateType: p.accelerate_type,
    })),
  });
}

async function getPlayerDetail(input: { eaId: number }): Promise<string> {
  const db = getDb();

  const { data, error } = await db
    .from('players')
    .select(DETAIL_COLUMNS)
    .eq('ea_id', input.eaId)
    .single();

  if (error) {
    return JSON.stringify({ error: error.message });
  }
  if (!data) {
    return JSON.stringify({ error: 'Player not found' });
  }

  return JSON.stringify({
    eaId: data.ea_id,
    name: data.common_name || data.name,
    firstName: data.first_name,
    lastName: data.last_name,
    slug: data.slug,
    position: data.position,
    overall: data.overall,
    club: data.club,
    league: data.league,
    nationality: data.nationality,
    rarityName: data.rarity_name,
    cardImageUrl: data.card_image_url,
    prices: {
      ps: data.ps_price,
      xbox: data.xbox_price,
      pc: data.pc_price,
    },
    skillMoves: data.skill_moves,
    weakFoot: data.weak_foot,
    height: data.height,
    weight: data.weight,
    foot: data.foot,
    accelerateType: data.accelerate_type,
    alternativePositions: data.alternative_positions,
    workRates: {
      attacking: data.attacking_workrate,
      defensive: data.defensive_workrate,
    },
    faceStats: {
      pace: data.face_pace,
      shooting: data.face_shooting,
      passing: data.face_passing,
      dribbling: data.face_dribbling,
      defending: data.face_defending,
      physicality: data.face_physicality,
    },
    detailedStats: {
      acceleration: data.acceleration,
      sprintSpeed: data.sprint_speed,
      positioning: data.positioning,
      finishing: data.finishing,
      shotPower: data.shot_power,
      longShots: data.long_shots,
      volleys: data.volleys,
      penalties: data.penalties,
      vision: data.vision,
      crossing: data.crossing,
      freeKickAccuracy: data.fk_accuracy,
      shortPassing: data.short_passing,
      longPassing: data.long_passing,
      curve: data.curve,
      agility: data.agility,
      balance: data.balance,
      reactions: data.reactions,
      ballControl: data.ball_control,
      dribbling: data.dribbling,
      composure: data.composure,
      interceptions: data.interceptions,
      headingAccuracy: data.heading_accuracy,
      defAwareness: data.def_awareness,
      standingTackle: data.standing_tackle,
      slidingTackle: data.sliding_tackle,
      jumping: data.jumping,
      stamina: data.stamina,
      strength: data.strength,
      aggression: data.aggression,
    },
    gkStats: data.position === 'GK' ? {
      diving: data.gk_diving,
      handling: data.gk_handling,
      kicking: data.gk_kicking,
      positioning: data.gk_positioning,
      reflexes: data.gk_reflexes,
      speed: data.gk_speed,
    } : null,
    playstyles: data.playstyles,
    playstylesPlus: data.playstyles_plus,
    meta: {
      score: data.meta_score,
      tier: data.meta_tier,
      primaryRole: data.meta_primary_role,
      primaryScore: data.meta_primary_score,
      primaryTier: data.meta_primary_tier,
      bestRoles: data.meta_best_roles,
    },
  });
}

async function getBetterAlternatives(input: {
  eaId: number;
  limit?: number;
}): Promise<string> {
  const db = getDb();
  const limit = Math.min(input.limit || 3, 5);

  // Get the source player first
  const { data: source, error: sourceErr } = await db
    .from('players')
    .select('ea_id, position, overall, meta_score, ps_price, club, league, nationality')
    .eq('ea_id', input.eaId)
    .single();

  if (sourceErr || !source) {
    return JSON.stringify({ error: sourceErr?.message || 'Player not found' });
  }

  const positions = getCompatiblePositions(source.position);
  const metaScore = (source.meta_score as number) || 0;

  let query = db
    .from('players')
    .select(ALTERNATIVE_COLUMNS)
    .in('position', positions)
    .neq('ea_id', input.eaId)
    .not('meta_score', 'is', null)
    .gt('meta_score', metaScore)
    .order('meta_score', { ascending: false })
    .limit(limit);

  const { data, error } = await query;

  if (error) {
    return JSON.stringify({ error: error.message });
  }

  return JSON.stringify({
    sourcePlayer: {
      eaId: source.ea_id,
      position: source.position,
      overall: source.overall,
      metaScore: source.meta_score,
      psPrice: source.ps_price,
    },
    alternatives: (data || []).map((p: any) => ({
      eaId: p.ea_id,
      name: p.common_name || p.name,
      position: p.position,
      overall: p.overall,
      psPrice: p.ps_price,
      xboxPrice: p.xbox_price,
      pcPrice: p.pc_price,
      cardImageUrl: p.card_image_url,
      rarityName: p.rarity_name,
      metaScore: p.meta_score,
      metaTier: p.meta_tier,
      scoreDifference: (p.meta_score || 0) - metaScore,
      faceStats: {
        pace: p.face_pace,
        shooting: p.face_shooting,
        passing: p.face_passing,
        dribbling: p.face_dribbling,
        defending: p.face_defending,
        physicality: p.face_physicality,
      },
      skillMoves: p.skill_moves,
      weakFoot: p.weak_foot,
      accelerateType: p.accelerate_type,
    })),
  });
}

async function getChemistryLinks(input: { eaId: number }): Promise<string> {
  const db = getDb();

  // Get the source player
  const { data: source, error: sourceErr } = await db
    .from('players')
    .select('ea_id, name, position, club, league, nationality')
    .eq('ea_id', input.eaId)
    .single();

  if (sourceErr || !source) {
    return JSON.stringify({ error: sourceErr?.message || 'Player not found' });
  }

  const sourceClub = typeof source.club === 'string'
    ? source.club
    : (source.club as any)?.name || null;
  const sourceLeague = typeof source.league === 'string'
    ? source.league
    : (source.league as any)?.name || null;
  const sourceNation = source.nationality || null;

  const links: { player: any; linkType: string }[] = [];
  const usedIds = new Set<number>([input.eaId]);

  // Perfect links: same club AND same nation
  if (sourceClub && sourceNation) {
    const { data: perfectData } = await db
      .from('players')
      .select(CHEMISTRY_COLUMNS)
      .neq('ea_id', input.eaId)
      .eq('club', sourceClub)
      .eq('nationality', sourceNation)
      .gte('overall', 75)
      .order('meta_score', { ascending: false, nullsFirst: false })
      .order('overall', { ascending: false })
      .limit(5);

    for (const p of perfectData || []) {
      if (!usedIds.has(p.ea_id)) {
        links.push({ player: p, linkType: 'perfect' });
        usedIds.add(p.ea_id);
      }
    }
  }

  // Strong links: same club
  if (sourceClub) {
    const { data: clubData } = await db
      .from('players')
      .select(CHEMISTRY_COLUMNS)
      .neq('ea_id', input.eaId)
      .eq('club', sourceClub)
      .gte('overall', 75)
      .order('meta_score', { ascending: false, nullsFirst: false })
      .order('overall', { ascending: false })
      .limit(10);

    for (const p of clubData || []) {
      if (!usedIds.has(p.ea_id)) {
        links.push({ player: p, linkType: 'club' });
        usedIds.add(p.ea_id);
      }
    }
  }

  // Strong links: same nation
  if (sourceNation) {
    const { data: nationData } = await db
      .from('players')
      .select(CHEMISTRY_COLUMNS)
      .neq('ea_id', input.eaId)
      .eq('nationality', sourceNation)
      .gte('overall', 80)
      .order('meta_score', { ascending: false, nullsFirst: false })
      .order('overall', { ascending: false })
      .limit(10);

    for (const p of nationData || []) {
      if (!usedIds.has(p.ea_id)) {
        links.push({ player: p, linkType: 'nation' });
        usedIds.add(p.ea_id);
      }
    }
  }

  // Weak links: same league
  if (sourceLeague) {
    const { data: leagueData } = await db
      .from('players')
      .select(CHEMISTRY_COLUMNS)
      .neq('ea_id', input.eaId)
      .eq('league', sourceLeague)
      .gte('overall', 85)
      .order('meta_score', { ascending: false, nullsFirst: false })
      .order('overall', { ascending: false })
      .limit(10);

    for (const p of leagueData || []) {
      if (!usedIds.has(p.ea_id)) {
        links.push({ player: p, linkType: 'league' });
        usedIds.add(p.ea_id);
      }
    }
  }

  return JSON.stringify({
    sourcePlayer: {
      eaId: source.ea_id,
      name: source.name,
      position: source.position,
      club: sourceClub,
      league: sourceLeague,
      nation: sourceNation,
    },
    links: links.slice(0, 15).map(({ player: p, linkType }) => ({
      eaId: p.ea_id,
      name: p.common_name || p.name,
      position: p.position,
      overall: p.overall,
      club: p.club,
      nationality: p.nationality,
      cardImageUrl: p.card_image_url,
      metaScore: p.meta_score,
      metaTier: p.meta_tier,
      linkType,
    })),
  });
}

async function getMetaTierList(input: { position: string }): Promise<string> {
  const db = getDb();

  const positions = getCompatiblePositions(input.position.toUpperCase());

  const { data, error } = await db
    .from('players')
    .select(META_TIER_COLUMNS)
    .in('position', positions)
    .not('meta_primary_score', 'is', null)
    .order('meta_primary_score', { ascending: false })
    .limit(20);

  if (error) {
    return JSON.stringify({ error: error.message });
  }

  // Group by tier
  const tiers: Record<string, any[]> = { S: [], A: [], B: [], C: [] };

  for (const p of data || []) {
    const tier = p.meta_primary_tier || 'C';
    if (!tiers[tier]) tiers[tier] = [];
    tiers[tier].push({
      eaId: p.ea_id,
      name: p.common_name || p.name,
      position: p.position,
      overall: p.overall,
      psPrice: p.ps_price,
      xboxPrice: p.xbox_price,
      pcPrice: p.pc_price,
      cardImageUrl: p.card_image_url,
      rarityName: p.rarity_name,
      metaScore: p.meta_primary_score,
      metaTier: p.meta_primary_tier,
      metaRole: p.meta_primary_role,
    });
  }

  return JSON.stringify({
    position: input.position.toUpperCase(),
    totalPlayers: data?.length || 0,
    tiers,
  });
}

function getFormations(): string {
  return JSON.stringify({
    count: FORMATIONS.length,
    formations: FORMATIONS,
  });
}

async function getPriceHistory(input: {
  eaId: number;
  timeRange?: string;
}): Promise<string> {
  const db = getDb();
  const timeRange = input.timeRange || '7d';

  // Calculate cutoff
  const now = new Date();
  const cutoff = new Date();
  switch (timeRange) {
    case '24h':
      cutoff.setHours(now.getHours() - 24);
      break;
    case '7d':
      cutoff.setDate(now.getDate() - 7);
      break;
    case '30d':
      cutoff.setDate(now.getDate() - 30);
      break;
    case 'all':
      cutoff.setFullYear(2020);
      break;
    default:
      cutoff.setDate(now.getDate() - 7);
  }

  const { data: history, error: historyErr } = await db
    .from('price_history')
    .select('recorded_at, ps_price')
    .eq('ea_id', input.eaId)
    .gte('recorded_at', cutoff.toISOString())
    .order('recorded_at', { ascending: true });

  if (historyErr) {
    return JSON.stringify({ error: historyErr.message });
  }

  const prices = (history || [])
    .map((h: any) => h.ps_price as number)
    .filter((p: number) => p > 0);

  const stats = prices.length > 0
    ? {
        min: Math.min(...prices),
        max: Math.max(...prices),
        avg: Math.round(prices.reduce((a: number, b: number) => a + b, 0) / prices.length),
        current: prices[prices.length - 1],
        dataPoints: prices.length,
      }
    : null;

  // Calculate trend
  let trend: string | null = null;
  if (prices.length >= 2) {
    const first = prices[0];
    const last = prices[prices.length - 1];
    const changePercent = Math.round(((last - first) / first) * 100);
    if (changePercent > 5) trend = `Rising (+${changePercent}%)`;
    else if (changePercent < -5) trend = `Falling (${changePercent}%)`;
    else trend = `Stable (${changePercent >= 0 ? '+' : ''}${changePercent}%)`;
  }

  return JSON.stringify({
    eaId: input.eaId,
    timeRange,
    stats,
    trend,
    history: (history || []).map((h: any) => ({
      date: h.recorded_at,
      price: h.ps_price,
    })),
  });
}

const STAT_TO_FACE: Record<string, string> = {
  pace: 'face_pace',
  shooting: 'face_shooting',
  passing: 'face_passing',
  dribbling: 'face_dribbling',
  defending: 'face_defending',
  physical: 'face_physicality',
};

function recommendChemStyle(position: string, faceStats: Record<string, number>): { recommended: ChemStyleData; reason: string } {
  if (position === 'GK') {
    return { recommended: CHEM_STYLES.find(c => c.name === 'Glove')!, reason: 'Best all-round GK chem style — boosts diving and reflexes' };
  }

  // Find weakest stats for the position
  const attackingPositions = ['ST', 'CF', 'LW', 'RW', 'LF', 'RF'];
  const midfieldPositions = ['CAM', 'CM', 'CDM', 'LM', 'RM'];
  const defensivePositions = ['CB', 'LB', 'RB', 'LWB', 'RWB'];

  const relevantStyles = CHEM_STYLES.filter(c =>
    c.category !== 'gk' && c.bestPositions.some(p => p === position || p === 'ANY')
  );

  if (relevantStyles.length > 0) {
    // Prefer premium styles (bigger boosts), then triple, then basic
    const premium = relevantStyles.filter(c => c.category === 'premium');
    if (premium.length > 0) {
      return { recommended: premium[0], reason: `Best for ${position} — maximizes ${premium[0].boosts.map(b => b.stat).join(' + ')} with +6 each at 3 chem` };
    }
    return { recommended: relevantStyles[0], reason: `Recommended for ${position} — boosts ${relevantStyles[0].boosts.map(b => b.stat).join(' + ')}` };
  }

  // Fallback: position-based recommendation
  if (attackingPositions.includes(position)) {
    return { recommended: CHEM_STYLES.find(c => c.name === 'Hunter')!, reason: 'Pace + shooting is king for attackers' };
  } else if (defensivePositions.includes(position)) {
    return { recommended: CHEM_STYLES.find(c => c.name === 'Shadow')!, reason: 'Pace + defending for defenders' };
  } else {
    return { recommended: CHEM_STYLES.find(c => c.name === 'Engine')!, reason: 'Pace + passing + dribbling for midfielders' };
  }
}

async function getChemStyleGuide(input: { position?: string; playerEaId?: number }): Promise<string> {
  let filtered = CHEM_STYLES;

  if (input.position) {
    const pos = input.position.toUpperCase();
    if (pos === 'GK') {
      filtered = CHEM_STYLES.filter(c => c.category === 'gk');
    } else {
      filtered = CHEM_STYLES.filter(c => c.category !== 'gk' && (c.bestPositions.includes(pos) || c.bestPositions.includes('ANY')));
    }
  }

  let recommendation = null;

  if (input.playerEaId) {
    const db = getDb();
    const { data: player } = await db
      .from('players')
      .select('ea_id, name, common_name, position, card_image_url, face_pace, face_shooting, face_passing, face_dribbling, face_defending, face_physicality')
      .eq('ea_id', input.playerEaId)
      .single();

    if (player) {
      const faceStats = {
        pace: player.face_pace,
        shooting: player.face_shooting,
        passing: player.face_passing,
        dribbling: player.face_dribbling,
        defending: player.face_defending,
        physical: player.face_physicality,
      };
      const rec = recommendChemStyle(player.position, faceStats);
      recommendation = {
        playerName: player.common_name || player.name,
        eaId: player.ea_id,
        position: player.position,
        cardImageUrl: player.card_image_url,
        currentStats: faceStats,
        recommended: {
          name: rec.recommended.name,
          boosts: Object.fromEntries(rec.recommended.boosts.map(b => [b.stat, b.amount3])),
          reason: rec.reason,
        },
        boostedStats: Object.fromEntries(
          Object.entries(faceStats).map(([stat, val]) => {
            const boost = rec.recommended.boosts.find(b => b.stat === stat);
            return [stat, (val as number) + (boost ? boost.amount3 : 0)];
          })
        ),
      };
    }
  }

  return JSON.stringify({
    chemStyles: filtered.map(cs => ({
      name: cs.name,
      category: cs.category,
      boosts: Object.fromEntries(cs.boosts.map(b => [b.stat, { chem1: b.amount1, chem2: b.amount2, chem3: b.amount3 }])),
      bestPositions: cs.bestPositions,
      description: cs.description,
    })),
    recommendation,
  });
}

function getCustomTactics(input: { formation: string; style?: string }): string {
  const formation = input.formation.trim();
  const style = input.style?.toLowerCase() || 'balanced';

  let presets = TACTICAL_PRESETS.filter(p => p.formation === formation);

  if (presets.length === 0) {
    // Try fuzzy match (remove spaces/dashes)
    const normalized = formation.replace(/[\s-]/g, '');
    presets = TACTICAL_PRESETS.filter(p => p.formation.replace(/[\s-]/g, '') === normalized);
  }

  if (presets.length === 0) {
    return JSON.stringify({ error: `No tactical presets found for formation: ${formation}. Available: 4-2-3-1, 4-3-3, 4-4-2, 4-1-2-1-2(2), 3-5-2, 5-2-1-2` });
  }

  // Filter by style if available
  const styleMatch = presets.find(p => p.style === style);
  const selected = styleMatch || presets[0];

  return JSON.stringify({
    selected,
    allPresets: presets.map(p => ({ presetName: p.presetName, style: p.style })),
  });
}

function getSkillMoves(input: { stars?: number; name?: string }): string {
  let filtered = SKILL_MOVES;

  if (input.name) {
    const query = input.name.toLowerCase();
    filtered = SKILL_MOVES.filter(m => m.name.toLowerCase().includes(query));
    if (filtered.length === 0) {
      return JSON.stringify({ error: `No skill move found matching "${input.name}". Available: ${SKILL_MOVES.map(m => m.name).join(', ')}` });
    }
  }

  if (input.stars !== undefined) {
    filtered = filtered.filter(m => m.stars === input.stars);
    if (filtered.length === 0) {
      return JSON.stringify({ error: `No skill moves found for ${input.stars}★. Available star levels: 2, 3, 4, 5.` });
    }
  }

  return JSON.stringify({
    count: filtered.length,
    skillMoves: filtered,
  });
}

// ── Public entry point ───────────────────────────────────────────────────────

/**
 * Execute a tool call from the agent and return the result as a JSON string.
 * Unknown tool names return an error object.
 */
export async function executeTool(
  name: string,
  input: Record<string, any>
): Promise<string> {
  try {
    return await withTimeout(name, async () => {
      switch (name) {
        case 'search_players':
          return await searchPlayers(input as any);
        case 'get_player_detail':
          return await getPlayerDetail(input as any);
        case 'get_better_alternatives':
          return await getBetterAlternatives(input as any);
        case 'get_chemistry_links':
          return await getChemistryLinks(input as any);
        case 'get_meta_tier_list':
          return await getMetaTierList(input as any);
        case 'get_formations':
          return getFormations();
        case 'get_price_history':
          return await getPriceHistory(input as any);
        case 'get_chem_style_guide':
          return await getChemStyleGuide(input as any);
        case 'get_custom_tactics':
          return getCustomTactics(input as any);
        case 'get_skill_moves':
          return getSkillMoves(input as any);
        default:
          return JSON.stringify({ error: `Unknown tool: ${name}` });
      }
    });
  } catch (err: any) {
    console.error(`[Agent Tool] Error executing ${name}:`, err);
    return JSON.stringify({
      error: `Tool execution failed: ${err.message || 'Unknown error'}`,
    });
  }
}
