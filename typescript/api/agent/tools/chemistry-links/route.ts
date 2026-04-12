import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/database/client';

const CHEMISTRY_COLUMNS = `
  ea_id, name, common_name, position, overall,
  club, league, nationality, nation_image_url,
  rarity_name, card_image_url,
  meta_score, meta_tier
`;

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const eaId = searchParams.get('eaId');

  if (!eaId) {
    return NextResponse.json({ error: 'eaId parameter is required' }, { status: 400 });
  }

  const db = createClient();
  const eaIdNum = parseInt(eaId);

  const { data: source, error: sourceErr } = await db
    .from('players')
    .select('ea_id, name, position, club, league, nationality')
    .eq('ea_id', eaIdNum)
    .single();

  if (sourceErr || !source) {
    return NextResponse.json({ error: sourceErr?.message || 'Player not found' }, { status: 404 });
  }

  const sourceClub = typeof source.club === 'string' ? source.club : (source.club as any)?.name || null;
  const sourceLeague = typeof source.league === 'string' ? source.league : (source.league as any)?.name || null;
  const sourceNation = source.nationality || null;

  const links: { player: any; linkType: string }[] = [];
  const usedIds = new Set<number>([eaIdNum]);

  // Perfect links: same club AND same nation
  if (sourceClub && sourceNation) {
    const { data } = await db.from('players').select(CHEMISTRY_COLUMNS)
      .neq('ea_id', eaIdNum).eq('club', sourceClub).eq('nationality', sourceNation)
      .gte('overall', 75).order('meta_score', { ascending: false, nullsFirst: false })
      .order('overall', { ascending: false }).limit(5);
    for (const p of data || []) {
      if (!usedIds.has(p.ea_id)) { links.push({ player: p, linkType: 'perfect' }); usedIds.add(p.ea_id); }
    }
  }

  // Strong links: same club
  if (sourceClub) {
    const { data } = await db.from('players').select(CHEMISTRY_COLUMNS)
      .neq('ea_id', eaIdNum).eq('club', sourceClub)
      .gte('overall', 75).order('meta_score', { ascending: false, nullsFirst: false })
      .order('overall', { ascending: false }).limit(10);
    for (const p of data || []) {
      if (!usedIds.has(p.ea_id)) { links.push({ player: p, linkType: 'club' }); usedIds.add(p.ea_id); }
    }
  }

  // Strong links: same nation
  if (sourceNation) {
    const { data } = await db.from('players').select(CHEMISTRY_COLUMNS)
      .neq('ea_id', eaIdNum).eq('nationality', sourceNation)
      .gte('overall', 80).order('meta_score', { ascending: false, nullsFirst: false })
      .order('overall', { ascending: false }).limit(10);
    for (const p of data || []) {
      if (!usedIds.has(p.ea_id)) { links.push({ player: p, linkType: 'nation' }); usedIds.add(p.ea_id); }
    }
  }

  // Weak links: same league
  if (sourceLeague) {
    const { data } = await db.from('players').select(CHEMISTRY_COLUMNS)
      .neq('ea_id', eaIdNum).eq('league', sourceLeague)
      .gte('overall', 85).order('meta_score', { ascending: false, nullsFirst: false })
      .order('overall', { ascending: false }).limit(10);
    for (const p of data || []) {
      if (!usedIds.has(p.ea_id)) { links.push({ player: p, linkType: 'league' }); usedIds.add(p.ea_id); }
    }
  }

  return NextResponse.json({
    sourcePlayer: {
      eaId: source.ea_id, name: source.name, position: source.position,
      club: sourceClub, league: sourceLeague, nation: sourceNation,
    },
    links: links.slice(0, 15).map(({ player: p, linkType }) => ({
      eaId: p.ea_id, name: p.common_name || p.name, position: p.position,
      overall: p.overall, club: p.club, nationality: p.nationality,
      cardImageUrl: p.card_image_url, metaScore: p.meta_score, metaTier: p.meta_tier, linkType,
    })),
  });
}
