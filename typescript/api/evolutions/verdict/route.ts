/**
 * GET /api/evolutions/verdict?evolutionId=123
 *
 * Returns an AI-generated "Worth It?" verdict for an evolution.
 * Uses Ollama (futevo-7b) on MadMac, cached in DB for 24 hours.
 */

import { NextRequest, NextResponse } from 'next/server';
import OpenAI from 'openai';
import { createClient } from '@/lib/database/client';

export const revalidate = 3600; // 1 hour cache

type VerdictRating = 'great_value' | 'good' | 'situational' | 'skip' | 'meta_changing';

interface VerdictResponse {
  evolutionId: number;
  rating: VerdictRating;
  score: number; // 1-5
  summary: string;
  cached: boolean;
}

// In-memory cache (survives across requests within same process)
const memCache = new Map<number, { verdict: VerdictResponse; timestamp: number }>();
const MEM_TTL = 4 * 60 * 60 * 1000; // 4 hours

function getDb() {
  return createClient();
}

export async function GET(request: NextRequest) {
  const evolutionId = parseInt(request.nextUrl.searchParams.get('evolutionId') || '0');

  if (!evolutionId) {
    return NextResponse.json({ success: false, error: 'evolutionId is required' }, { status: 400 });
  }

  // Check memory cache
  const cached = memCache.get(evolutionId);
  if (cached && Date.now() - cached.timestamp < MEM_TTL) {
    return NextResponse.json({ success: true, ...cached.verdict, cached: true });
  }

  // Check DB cache
  const db = getDb();
  const { data: dbCached } = await db
    .from('evolution_verdicts')
    .select('*')
    .eq('evolution_id', evolutionId)
    .single();

  if (dbCached && new Date(dbCached.updated_at).getTime() > Date.now() - 24 * 60 * 60 * 1000) {
    const verdict: VerdictResponse = {
      evolutionId,
      rating: dbCached.rating,
      score: dbCached.score,
      summary: dbCached.summary,
      cached: true,
    };
    memCache.set(evolutionId, { verdict, timestamp: Date.now() });
    return NextResponse.json({ success: true, ...verdict });
  }

  // Fetch evolution template data
  const { data: evo } = await db
    .from('evolution_templates')
    .select('*')
    .eq('evolution_id', evolutionId)
    .single();

  if (!evo) {
    return NextResponse.json({ success: false, error: 'Evolution not found' }, { status: 404 });
  }

  // Generate verdict via Ollama
  try {
    const verdict = await generateVerdict(evo);

    // Save to DB
    await db.from('evolution_verdicts').upsert({
      evolution_id: evolutionId,
      rating: verdict.rating,
      score: verdict.score,
      summary: verdict.summary,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'evolution_id' });

    memCache.set(evolutionId, { verdict, timestamp: Date.now() });
    return NextResponse.json({ success: true, ...verdict });
  } catch (error) {
    console.error('[Evo Verdict] AI generation failed:', error);
    // Fallback: compute a basic verdict without AI
    const fallback = computeFallbackVerdict(evo);
    return NextResponse.json({ success: true, ...fallback, cached: false });
  }
}

async function generateVerdict(evo: any): Promise<VerdictResponse> {
  const baseUrl = process.env.OLLAMA_BASE_URL;
  const model = process.env.OLLAMA_MODEL || 'futevo-7b';

  if (!baseUrl) {
    return computeFallbackVerdict(evo);
  }

  const ollama = new OpenAI({ baseURL: baseUrl, apiKey: 'ollama' });

  const upgrades = typeof evo.upgrades === 'string' ? JSON.parse(evo.upgrades) : evo.upgrades || [];
  const requirements = typeof evo.requirements === 'string' ? JSON.parse(evo.requirements) : evo.requirements || {};

  const totalOvrBoost = upgrades.reduce((sum: number, l: any) => sum + (l.overallBoost || 0), 0);
  const totalStats = upgrades.reduce((acc: any, l: any) => {
    const b = l.statBoosts || {};
    return {
      pace: (acc.pace || 0) + (b.pace || 0),
      shooting: (acc.shooting || 0) + (b.shooting || 0),
      passing: (acc.passing || 0) + (b.passing || 0),
      dribbling: (acc.dribbling || 0) + (b.dribbling || 0),
      defending: (acc.defending || 0) + (b.defending || 0),
      physical: (acc.physical || 0) + (b.physical || 0),
    };
  }, {});

  const prompt = `You are an EA FC 26 Ultimate Team expert. Rate this evolution and give a verdict.

Evolution: "${evo.name}"
Description: "${evo.description || ''}"
Cost: ${evo.coins_cost > 0 ? evo.coins_cost + ' coins' : 'FREE'}
OVR Boost: +${totalOvrBoost}
Stat Boosts: PAC +${totalStats.pace}, SHO +${totalStats.shooting}, PAS +${totalStats.passing}, DRI +${totalStats.dribbling}, DEF +${totalStats.defending}, PHY +${totalStats.physical}
Max OVR: ${requirements.maxOverall || 'any'}
Levels: ${upgrades.length}

Respond in this exact JSON format:
{"rating": "great_value|good|situational|skip|meta_changing", "score": 1-5, "summary": "one sentence explanation"}

Rating guide:
- meta_changing (5): Transforms cards into top-tier meta players
- great_value (4): Excellent boosts for the cost, widely useful
- good (3): Solid boosts, worth doing for most eligible cards
- situational (2): Only worth it for specific players/positions
- skip (1): Low boosts or too expensive for what you get`;

  const response = await ollama.chat.completions.create({
    model,
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.3,
    max_tokens: 150,
  });

  const text = response.choices[0]?.message?.content || '';

  try {
    // Extract JSON from response
    const jsonMatch = text.match(/\{[^}]+\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        evolutionId: evo.evolution_id,
        rating: parsed.rating || 'good',
        score: Math.min(5, Math.max(1, parsed.score || 3)),
        summary: parsed.summary || 'Solid evolution worth considering.',
        cached: false,
      };
    }
  } catch {}

  return computeFallbackVerdict(evo);
}

function computeFallbackVerdict(evo: any): VerdictResponse {
  const upgrades = typeof evo.upgrades === 'string' ? JSON.parse(evo.upgrades) : evo.upgrades || [];
  const totalOvrBoost = upgrades.reduce((sum: number, l: any) => sum + (l.overallBoost || 0), 0);
  const isFree = (evo.coins_cost || 0) === 0;

  let rating: VerdictRating = 'good';
  let score = 3;
  let summary = 'Solid evolution worth considering.';

  if (isFree && totalOvrBoost >= 5) {
    rating = 'great_value';
    score = 4;
    summary = `Free evolution with +${totalOvrBoost} OVR — always worth doing.`;
  } else if (isFree) {
    rating = 'good';
    score = 3;
    summary = `Free with +${totalOvrBoost} OVR boost. Low effort, decent reward.`;
  } else if (totalOvrBoost >= 8) {
    rating = 'great_value';
    score = 4;
    summary = `+${totalOvrBoost} OVR is a massive boost. Great for eligible cards.`;
  } else if (totalOvrBoost >= 5 && (evo.coins_cost || 0) <= 30000) {
    rating = 'good';
    score = 3;
    summary = `+${totalOvrBoost} OVR for ${evo.coins_cost > 0 ? (evo.coins_cost / 1000).toFixed(0) + 'K' : 'free'}. Fair value.`;
  } else if (totalOvrBoost <= 2 && (evo.coins_cost || 0) > 20000) {
    rating = 'skip';
    score = 1;
    summary = `Only +${totalOvrBoost} OVR for ${(evo.coins_cost / 1000).toFixed(0)}K coins. Not worth it.`;
  } else {
    rating = 'situational';
    score = 2;
    summary = `+${totalOvrBoost} OVR — only worth it for specific player needs.`;
  }

  return { evolutionId: evo.evolution_id, rating, score, summary, cached: false };
}
