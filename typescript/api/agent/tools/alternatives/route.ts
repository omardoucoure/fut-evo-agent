import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/database/client';

const ALTERNATIVE_COLUMNS = `
  ea_id, name, common_name, position, overall,
  ps_price, xbox_price, pc_price,
  card_image_url, rarity_name,
  club, league, nationality, nation_image_url,
  skill_moves, weak_foot,
  face_pace, face_shooting, face_passing, face_dribbling, face_defending, face_physicality,
  meta_score, meta_tier, accelerate_type
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
  const eaId = searchParams.get('eaId');
  const limitParam = searchParams.get('limit');
  const limit = Math.min(parseInt(limitParam || '3'), 5);

  if (!eaId) {
    return NextResponse.json({ error: 'eaId parameter is required' }, { status: 400 });
  }

  const db = createClient();

  const { data: source, error: sourceErr } = await db
    .from('players')
    .select('ea_id, position, overall, meta_score, ps_price')
    .eq('ea_id', parseInt(eaId))
    .single();

  if (sourceErr || !source) {
    return NextResponse.json({ error: sourceErr?.message || 'Player not found' }, { status: 404 });
  }

  const positions = POSITION_COMPAT[source.position] || [source.position];
  const metaScore = source.meta_score || 0;

  const { data, error } = await db
    .from('players')
    .select(ALTERNATIVE_COLUMNS)
    .in('position', positions)
    .neq('ea_id', parseInt(eaId))
    .not('meta_score', 'is', null)
    .gt('meta_score', metaScore)
    .order('meta_score', { ascending: false })
    .limit(limit);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({
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
        pace: p.face_pace, shooting: p.face_shooting, passing: p.face_passing,
        dribbling: p.face_dribbling, defending: p.face_defending, physicality: p.face_physicality,
      },
      skillMoves: p.skill_moves,
      weakFoot: p.weak_foot,
      accelerateType: p.accelerate_type,
    })),
  });
}
