import { NextRequest, NextResponse } from 'next/server';
import { CHEM_STYLES, TACTICAL_PRESETS, SKILL_MOVES, FORMATIONS } from '@/lib/agent/static-data';

/**
 * Serves static game data for the Koog agent tools.
 * Centralizes chem styles, tactics, skill moves, and formations
 * so they're not duplicated in Kotlin.
 *
 * GET /api/agent/tools/game-data?type=chem-styles
 * GET /api/agent/tools/game-data?type=tactics&formation=4-2-3-1&style=balanced
 * GET /api/agent/tools/game-data?type=skill-moves&stars=4&name=elastico
 * GET /api/agent/tools/game-data?type=formations
 */
export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const type = searchParams.get('type');

  switch (type) {
    case 'formations':
      return NextResponse.json({ count: FORMATIONS.length, formations: FORMATIONS });

    case 'chem-styles': {
      const position = searchParams.get('position');
      let filtered = CHEM_STYLES;
      if (position) {
        const pos = position.toUpperCase();
        if (pos === 'GK') {
          filtered = CHEM_STYLES.filter(c => c.category === 'gk');
        } else {
          filtered = CHEM_STYLES.filter(c =>
            c.category !== 'gk' && (c.bestPositions.includes(pos) || c.bestPositions.includes('ANY'))
          );
        }
      }
      return NextResponse.json({ chemStyles: filtered });
    }

    case 'tactics': {
      const formation = searchParams.get('formation')?.trim();
      const style = searchParams.get('style')?.toLowerCase() || 'balanced';

      if (!formation) {
        return NextResponse.json({ error: 'formation parameter is required' }, { status: 400 });
      }

      let presets = TACTICAL_PRESETS.filter(p => p.formation === formation);
      if (presets.length === 0) {
        const normalized = formation.replace(/[\s-]/g, '');
        presets = TACTICAL_PRESETS.filter(p => p.formation.replace(/[\s-]/g, '') === normalized);
      }
      if (presets.length === 0) {
        return NextResponse.json({
          error: `No tactical presets found for formation: ${formation}. Available: 4-2-3-1, 4-3-3, 4-4-2, 4-1-2-1-2(2), 3-5-2, 5-2-1-2`,
        });
      }

      const selected = presets.find(p => p.style === style) || presets[0];
      return NextResponse.json({
        selected,
        allPresets: presets.map(p => ({ presetName: p.presetName, style: p.style })),
      });
    }

    case 'skill-moves': {
      const stars = searchParams.get('stars');
      const name = searchParams.get('name');

      let filtered = SKILL_MOVES;
      if (name) {
        const query = name.toLowerCase();
        filtered = filtered.filter(m => m.name.toLowerCase().includes(query));
        if (filtered.length === 0) {
          return NextResponse.json({
            error: `No skill move found matching "${name}". Available: ${SKILL_MOVES.map(m => m.name).join(', ')}`,
          });
        }
      }
      if (stars) {
        filtered = filtered.filter(m => m.stars === parseInt(stars));
        if (filtered.length === 0) {
          return NextResponse.json({
            error: `No skill moves found for ${stars}★. Available star levels: 2, 3, 4, 5.`,
          });
        }
      }
      return NextResponse.json({ count: filtered.length, skillMoves: filtered });
    }

    default:
      return NextResponse.json(
        { error: 'type parameter required. Options: formations, chem-styles, tactics, skill-moves' },
        { status: 400 }
      );
  }
}
