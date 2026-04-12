import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/database/client';

const META_TIER_COLUMNS = `
  ea_id, name, common_name, position, overall,
  ps_price, xbox_price, pc_price,
  card_image_url, rarity_name,
  club, league, nationality,
  meta_score, meta_tier, meta_primary_role, meta_primary_score, meta_primary_tier
`;

const POSITION_COMPAT: Record<string, string[]> = {
  ST: ['ST', 'CF'], CF: ['CF', 'ST', 'CAM'], CAM: ['CAM', 'CF', 'CM'],
  CM: ['CM', 'CAM', 'CDM'], CDM: ['CDM', 'CM'], LW: ['LW', 'LM', 'LF'],
  RW: ['RW', 'RM', 'RF'], LM: ['LM', 'LW'], RM: ['RM', 'RW'],
  LF: ['LF', 'LW', 'ST'], RF: ['RF', 'RW', 'ST'],
  LB: ['LB', 'LWB'], RB: ['RB', 'RWB'], LWB: ['LWB', 'LB'], RWB: ['RWB', 'RB'],
  CB: ['CB'], GK: ['GK'],
};

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const position = searchParams.get('position');

  if (!position) {
    return NextResponse.json({ error: 'position parameter is required' }, { status: 400 });
  }

  const posUpper = position.toUpperCase();
  const positions = POSITION_COMPAT[posUpper] || [posUpper];

  const db = createClient();
  const { data, error } = await db
    .from('players')
    .select(META_TIER_COLUMNS)
    .in('position', positions)
    .not('meta_primary_score', 'is', null)
    .order('meta_primary_score', { ascending: false })
    .limit(20);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const tiers: Record<string, any[]> = { S: [], A: [], B: [], C: [] };
  for (const p of data || []) {
    const tier = p.meta_primary_tier || 'C';
    if (!tiers[tier]) tiers[tier] = [];
    tiers[tier].push({
      eaId: p.ea_id, name: p.common_name || p.name, position: p.position,
      overall: p.overall, psPrice: p.ps_price, xboxPrice: p.xbox_price, pcPrice: p.pc_price,
      cardImageUrl: p.card_image_url, rarityName: p.rarity_name,
      metaScore: p.meta_primary_score, metaTier: p.meta_primary_tier, metaRole: p.meta_primary_role,
    });
  }

  return NextResponse.json({
    position: posUpper,
    totalPlayers: data?.length || 0,
    tiers,
  });
}
