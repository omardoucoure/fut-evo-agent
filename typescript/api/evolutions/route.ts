import { NextRequest, NextResponse } from 'next/server';
import { fetchEvolutionTemplatesDB } from '@/lib/database/homepage';

/**
 * GET /api/evolutions
 *
 * Returns active evolution templates from the database.
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const limit = parseInt(searchParams.get('limit') || '50');

    const { templates, players } = await fetchEvolutionTemplatesDB(limit);

    return NextResponse.json({
      templates,
      players,
      success: true,
      total: templates.length,
    });
  } catch (error) {
    console.error('[EVOLUTIONS] Error:', error);
    return NextResponse.json({
      templates: [],
      players: {},
      success: false,
      total: 0,
    }, { status: 500 });
  }
}

export const revalidate = 1800;
