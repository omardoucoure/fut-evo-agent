/**
 * GET /api/agent/context?subscriptionId=X
 * Load the user's saved agent context (squad snapshot, budget, platform, preferences).
 *
 * POST /api/agent/context
 * Save or update the user's agent context.
 *
 * Body (POST):
 * - subscriptionId: number (push subscription ID)
 * - squadSnapshot: object (formation, players, summary)
 * - budget: number (coin budget)
 * - platform: string ('ps' | 'xbox' | 'pc')
 * - preferences: object (user preferences)
 * - learnedPatterns: object (agent-learned patterns)
 */

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/database/client';
import { validateMobileApiKey } from '@/lib/push/auth';

function getDb() {
  return createClient();
}

export async function GET(request: NextRequest) {
  const authError = validateMobileApiKey(request);
  if (authError) return authError;
  const subscriptionId = request.nextUrl.searchParams.get('subscriptionId');
  if (!subscriptionId) {
    return NextResponse.json({ error: 'subscriptionId required' }, { status: 400 });
  }

  console.log(`[Agent Context] Loading context for subscription ${subscriptionId}`);

  const { data, error } = await getDb()
    .from('user_agent_contexts')
    .select('*')
    .eq('push_subscription_id', parseInt(subscriptionId))
    .maybeSingle();

  if (error) {
    console.error('[Agent Context] Load error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ success: true, context: data });
}

export async function POST(request: NextRequest) {
  const authError = validateMobileApiKey(request);
  if (authError) return authError;
  try {
    const body = await request.json();
    const { subscriptionId, squadSnapshot, budget, platform, preferences, learnedPatterns } = body;

    if (!subscriptionId) {
      return NextResponse.json({ error: 'subscriptionId required' }, { status: 400 });
    }

    console.log(`[Agent Context] Saving context for subscription ${subscriptionId}`);

    const db = getDb();

    // Check if context exists for this subscription
    const { data: existing } = await db
      .from('user_agent_contexts')
      .select('id')
      .eq('push_subscription_id', subscriptionId)
      .maybeSingle();

    if (existing) {
      // Update existing context
      const { data, error } = await db
        .from('user_agent_contexts')
        .update({
          squad_snapshot: squadSnapshot || {},
          budget: budget || 0,
          platform: platform || 'ps',
          preferences: preferences || {},
          learned_patterns: learnedPatterns || {},
          last_interaction_at: new Date().toISOString(),
        })
        .eq('id', existing.id)
        .select('*');

      if (error) {
        console.error('[Agent Context] Update error:', error);
        return NextResponse.json({ error: error.message }, { status: 500 });
      }

      console.log(`[Agent Context] Updated context id=${existing.id}`);
      return NextResponse.json({ success: true, context: data });
    } else {
      // Insert new context
      const { data, error } = await db
        .from('user_agent_contexts')
        .insert({
          push_subscription_id: subscriptionId,
          squad_snapshot: squadSnapshot || {},
          budget: budget || 0,
          platform: platform || 'ps',
          preferences: preferences || {},
          learned_patterns: learnedPatterns || {},
          last_interaction_at: new Date().toISOString(),
        })
        .select('*');

      if (error) {
        console.error('[Agent Context] Insert error:', error);
        return NextResponse.json({ error: error.message }, { status: 500 });
      }

      console.log(`[Agent Context] Created new context for subscription ${subscriptionId}`);
      return NextResponse.json({ success: true, context: data });
    }
  } catch (error: any) {
    console.error('[Agent Context] Error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
