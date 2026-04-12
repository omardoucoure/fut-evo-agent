import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/database/client';

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

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const eaId = searchParams.get('eaId');

  if (!eaId) {
    return NextResponse.json({ error: 'eaId parameter is required' }, { status: 400 });
  }

  const db = createClient();
  const { data, error } = await db
    .from('players')
    .select(DETAIL_COLUMNS)
    .eq('ea_id', parseInt(eaId))
    .single();

  if (error || !data) {
    return NextResponse.json({ error: error?.message || 'Player not found' }, { status: 404 });
  }

  const p = data as any;
  return NextResponse.json({
    eaId: p.ea_id,
    name: p.common_name || p.name,
    firstName: p.first_name,
    lastName: p.last_name,
    position: p.position,
    overall: p.overall,
    club: p.club,
    league: p.league,
    nationality: p.nationality,
    rarityName: p.rarity_name,
    cardImageUrl: p.card_image_url,
    playerImageUrl: p.player_image_url,
    prices: { ps: p.ps_price, xbox: p.xbox_price, pc: p.pc_price },
    skillMoves: p.skill_moves,
    weakFoot: p.weak_foot,
    height: p.height,
    weight: p.weight,
    foot: p.foot,
    accelerateType: p.accelerate_type,
    alternativePositions: p.alternative_positions,
    faceStats: {
      pace: p.face_pace, shooting: p.face_shooting, passing: p.face_passing,
      dribbling: p.face_dribbling, defending: p.face_defending, physicality: p.face_physicality,
    },
    detailedStats: {
      acceleration: p.acceleration, sprintSpeed: p.sprint_speed,
      positioning: p.positioning, finishing: p.finishing, shotPower: p.shot_power,
      longShots: p.long_shots, volleys: p.volleys, penalties: p.penalties,
      vision: p.vision, crossing: p.crossing, fkAccuracy: p.fk_accuracy,
      shortPassing: p.short_passing, longPassing: p.long_passing, curve: p.curve,
      agility: p.agility, balance: p.balance, reactions: p.reactions,
      ballControl: p.ball_control, dribbling: p.dribbling, composure: p.composure,
      interceptions: p.interceptions, headingAccuracy: p.heading_accuracy,
      defAwareness: p.def_awareness, standingTackle: p.standing_tackle, slidingTackle: p.sliding_tackle,
      jumping: p.jumping, stamina: p.stamina, strength: p.strength, aggression: p.aggression,
    },
    gkStats: {
      diving: p.gk_diving, handling: p.gk_handling, kicking: p.gk_kicking,
      positioning: p.gk_positioning, reflexes: p.gk_reflexes, speed: p.gk_speed,
    },
    playstyles: p.playstyles,
    playstylesPlus: p.playstyles_plus,
    workRates: { attacking: p.attacking_workrate, defensive: p.defensive_workrate },
    meta: {
      score: p.meta_score, tier: p.meta_tier,
      primaryRole: p.meta_primary_role, primaryScore: p.meta_primary_score,
      primaryTier: p.meta_primary_tier, bestRoles: p.meta_best_roles,
    },
  });
}
