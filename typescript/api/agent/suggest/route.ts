/**
 * GET /api/agent/suggest?subscriptionId=X
 *
 * Returns personalized upgrade suggestions based on the user's saved agent context.
 * Queries the players table for higher-rated alternatives at each position,
 * filtered by budget and platform.
 *
 * Returns:
 * - success: boolean
 * - suggestions: array of position-based upgrade recommendations
 * - context: { formation, budget, platform }
 * - message: string (if no context found)
 */

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/database/client';

function getDb() {
  return createClient();
}

export async function GET(request: NextRequest) {
  const subscriptionId = request.nextUrl.searchParams.get('subscriptionId');
  if (!subscriptionId) {
    return NextResponse.json({ error: 'subscriptionId required' }, { status: 400 });
  }

  try {
    const db = getDb();

    console.log(`[Agent Suggest] Loading suggestions for subscription ${subscriptionId}`);

    // Load context
    const { data: ctx } = await db
      .from('user_agent_contexts')
      .select('*')
      .eq('push_subscription_id', parseInt(subscriptionId))
      .maybeSingle();

    if (!ctx || !ctx.squad_snapshot?.players) {
      return NextResponse.json({
        success: true,
        suggestions: [],
        message: 'No squad context found. Analyze a squad first.',
      });
    }

    const platform = ctx.platform || 'ps';
    const budget = ctx.budget || 0;
    const priceCol = platform === 'xbox' ? 'xbox_price' : platform === 'pc' ? 'pc_price' : 'ps_price';

    // Get players in the user's squad
    const squadPlayers = ctx.squad_snapshot.players || [];
    const squadEaIds = squadPlayers.map((p: any) => p.eaId).filter(Boolean);

    if (squadEaIds.length === 0) {
      return NextResponse.json({
        success: true,
        suggestions: [],
        message: 'No players found in squad context.',
      });
    }

    // Find potential upgrades for each position (limit to first 5 players)
    const suggestions = [];

    for (const player of squadPlayers.slice(0, 5)) {
      if (!player.position || !player.rating) continue;

      // Find best players in same position by meta score, within budget, excluding current squad.
      // No overall filter — meta score is the correct quality metric; a player with higher
      // meta but slightly lower overall IS an upgrade for competitive play.
      const priceFilter = budget > 0 ? budget : 999_999_999;
      const { data: upgrades } = await db
        .from('players')
        .select('ea_id, name, common_name, position, overall, ps_price, xbox_price, pc_price, card_image_url, rarity_name, meta_score, meta_tier')
        .eq('position', player.position)
        .lte(priceCol, priceFilter)
        .not('ea_id', 'in', `(${squadEaIds.join(',')})`)
        .order('meta_score', { ascending: false, nullsFirst: false })
        .limit(3);

      if (upgrades && upgrades.length > 0) {
        suggestions.push({
          slot: player.slot,
          currentPlayer: player.name,
          currentRating: player.rating,
          position: player.position,
          upgrades: upgrades.map((u: any) => ({
            eaId: u.ea_id,
            name: u.common_name || u.name,
            overall: u.overall,
            price: u[priceCol] || 0,
            metaTier: u.meta_tier,
            metaScore: u.meta_score,
            cardImageUrl: u.card_image_url,
          })),
        });
      }
    }

    console.log(`[Agent Suggest] Found ${suggestions.length} position suggestions for subscription ${subscriptionId}`);

    return NextResponse.json({
      success: true,
      suggestions,
      context: {
        formation: ctx.squad_snapshot?.formation,
        budget,
        platform,
      },
    });
  } catch (error: any) {
    console.error('[Agent Suggest] Error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
