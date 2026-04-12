import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/database/client';

const SEARCH_COLUMNS = `
  ea_id, name, common_name, position, overall,
  ps_price, xbox_price, pc_price,
  card_image_url, rarity_name,
  club, league, nationality
`;

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const query = searchParams.get('query');
  const position = searchParams.get('position');
  const minRating = searchParams.get('minRating');
  const maxPrice = searchParams.get('maxPrice');

  if (!query) {
    return NextResponse.json({ error: 'query parameter is required' }, { status: 400 });
  }

  const db = createClient();
  let dbQuery = db
    .from('players')
    .select(SEARCH_COLUMNS)
    .or(`name.ilike.%${query}%,common_name.ilike.%${query}%`)
    .order('overall', { ascending: false })
    .limit(10);

  if (position) {
    dbQuery = dbQuery.eq('position', position.toUpperCase());
  }
  if (minRating) {
    dbQuery = dbQuery.gte('overall', parseInt(minRating));
  }
  if (maxPrice) {
    dbQuery = dbQuery.lte('ps_price', parseInt(maxPrice));
  }

  const { data, error } = await dbQuery;

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({
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
    })),
  });
}
