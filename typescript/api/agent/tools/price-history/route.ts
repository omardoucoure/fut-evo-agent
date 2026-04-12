import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/database/client';

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const eaId = searchParams.get('eaId');
  const timeRange = searchParams.get('range') || '7d';

  if (!eaId) {
    return NextResponse.json({ error: 'eaId parameter is required' }, { status: 400 });
  }

  const now = new Date();
  const cutoff = new Date();
  switch (timeRange) {
    case '24h': cutoff.setHours(now.getHours() - 24); break;
    case '7d': cutoff.setDate(now.getDate() - 7); break;
    case '30d': cutoff.setDate(now.getDate() - 30); break;
    case 'all': cutoff.setFullYear(2020); break;
    default: cutoff.setDate(now.getDate() - 7);
  }

  const db = createClient();
  const { data: history, error } = await db
    .from('price_history')
    .select('recorded_at, ps_price')
    .eq('ea_id', parseInt(eaId))
    .gte('recorded_at', cutoff.toISOString())
    .order('recorded_at', { ascending: true });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const prices = (history || []).map((h: any) => h.ps_price as number).filter((p: number) => p > 0);

  const stats = prices.length > 0
    ? {
        min: Math.min(...prices),
        max: Math.max(...prices),
        avg: Math.round(prices.reduce((a, b) => a + b, 0) / prices.length),
        current: prices[prices.length - 1],
        dataPoints: prices.length,
      }
    : null;

  let trend: string | null = null;
  if (prices.length >= 2) {
    const first = prices[0];
    const last = prices[prices.length - 1];
    const changePercent = Math.round(((last - first) / first) * 100);
    if (changePercent > 5) trend = `Rising (+${changePercent}%)`;
    else if (changePercent < -5) trend = `Falling (${changePercent}%)`;
    else trend = `Stable (${changePercent >= 0 ? '+' : ''}${changePercent}%)`;
  }

  return NextResponse.json({
    eaId: parseInt(eaId),
    timeRange,
    stats,
    trend,
    history: (history || []).map((h: any) => ({ date: h.recorded_at, price: h.ps_price })),
  });
}
