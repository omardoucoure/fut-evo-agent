import { NextRequest, NextResponse } from 'next/server';

async function fetchFutGGEvolutions(page: number = 1): Promise<any> {
  const endpoints = [
    `https://www.fut.gg/api/fut/evolutions/v2/26/players/?page=${page}`,
    `https://www.fut.gg/api/evolutions/26/players/?page=${page}`,
  ];

  const userAgents = [
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
    'Unknown/1.0',
    'curl/8.0.0',
  ];

  for (const endpoint of endpoints) {
    for (const userAgent of userAgents) {
      try {
        console.log(`Trying Evolutions ${endpoint} with User-Agent: ${userAgent}`);

        const response = await fetch(endpoint, {
          headers: {
            'User-Agent': userAgent,
            'Accept': 'application/json',
            'Cache-Control': 'no-cache',
            'Referer': 'https://www.fut.gg/',
            'Origin': 'https://www.fut.gg',
          },
          next: { revalidate: 300 }, // Cache for 5 minutes
        });

        if (!response.ok) {
          console.log(`${endpoint} responded with ${response.status}: ${response.statusText}`);
          continue;
        }

        const contentType = response.headers.get('content-type');
        if (!contentType || !contentType.includes('application/json')) {
          console.log(`${endpoint} returned non-JSON content: ${contentType}`);
          continue;
        }

        const data = await response.json();
        console.log(`Successfully fetched Evolutions data from FUT.GG: ${endpoint}`);

        return data;

      } catch (error) {
        console.log(`Failed to fetch Evolutions from ${endpoint}:`, (error as Error).message);
        continue;
      }
    }
  }

  throw new Error('All FUT.GG Evolutions API endpoints failed - likely blocked by Cloudflare protection');
}

async function fetchAllEvolutions(): Promise<any[]> {
  const allEvolutions: any[] = [];
  let currentPage = 1;
  let hasMore = true;

  // Fetch all pages of Evolutions
  while (hasMore && currentPage <= 10) { // Limit to 10 pages for safety
    try {
      const pageData = await fetchFutGGEvolutions(currentPage);

      // Extract Evolutions from response
      let evoList = [];
      if (Array.isArray(pageData)) {
        evoList = pageData;
      } else if (pageData.data && Array.isArray(pageData.data)) {
        evoList = pageData.data;
      } else if (pageData.results && Array.isArray(pageData.results)) {
        evoList = pageData.results;
      } else if (pageData.evolutions && Array.isArray(pageData.evolutions)) {
        evoList = pageData.evolutions;
      } else if (pageData.players && Array.isArray(pageData.players)) {
        evoList = pageData.players;
      } else {
        const potentialArrays = Object.values(pageData).filter(value => Array.isArray(value));
        if (potentialArrays.length > 0) {
          evoList = potentialArrays[0] as any[];
        }
      }

      if (evoList.length === 0) {
        hasMore = false;
      } else {
        allEvolutions.push(...evoList);
        // If we got less than 20 items, we're probably on the last page
        hasMore = evoList.length >= 20;
        currentPage++;
      }
    } catch (error) {
      console.log(`Failed to fetch page ${currentPage}:`, error);
      hasMore = false;
    }
  }

  return allEvolutions;
}

function transformEvolutionData(evoData: any): any {
  return {
    id: evoData.id || evoData.eaId || Math.random().toString(),
    name: evoData.name || evoData.playerName || 'Unknown Evolution',
    playerName: evoData.playerName || evoData.name,
    description: evoData.description || '',
    requirements: evoData.requirements || [],
    upgrades: evoData.upgrades || evoData.boosts || [],
    category: evoData.category || 'Unknown',
    level: evoData.level || evoData.tier || 1,
    maxLevel: evoData.maxLevel || evoData.maxTier || 5,
    cost: evoData.cost || 0,
    imageUrl: evoData.imageUrl || evoData.cardImageUrl || evoData.image,
    cardImagePath: evoData.cardImagePath ? `https://game-assets.fut.gg/${evoData.cardImagePath}` : (evoData.cardImageUrl || evoData.image),
    playerImageUrl: evoData.imagePath ? `https://game-assets.fut.gg/${evoData.imagePath}` : (evoData.playerImageUrl || evoData.playerImage),
    cardType: evoData.cardType || evoData.rarity || 'gold',
    overall: evoData.overall || evoData.rating || 0,
    position: evoData.position || 'ST',
    // Stats upgrades
    paceUpgrade: evoData.paceUpgrade || 0,
    shootingUpgrade: evoData.shootingUpgrade || 0,
    passingUpgrade: evoData.passingUpgrade || 0,
    dribblingUpgrade: evoData.dribblingUpgrade || 0,
    defendingUpgrade: evoData.defendingUpgrade || 0,
    physicalUpgrade: evoData.physicalUpgrade || 0,
    // Metadata
    isActive: evoData.isActive !== false,
    expiryDate: evoData.expiryDate || evoData.expires,
    slug: evoData.slug,
    url: evoData.url || `https://www.fut.gg/evolutions/${evoData.slug}/`,
  };
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ playerId: string }> }) {
  try {
    const { playerId } = await params;
    console.log(`Attempting to fetch Evolution Player data for ID: ${playerId}`);

    // Fetch all evolutions from FUT.GG
    const allEvolutions = await fetchAllEvolutions();

    // Filter evolutions that match the player ID (base player ID before underscore)
    const playerEvolutions = allEvolutions.filter((evo: any) => {
      const evoId = evo.id || evo.eaId || '';
      const basePlayerId = evoId.split('_')[0];
      return basePlayerId === playerId;
    });

    const transformedEvolutions = playerEvolutions.map(transformEvolutionData);
    console.log(`Successfully transformed ${transformedEvolutions.length} evolutions for player ${playerId}`);

    return NextResponse.json({
      data: transformedEvolutions,
      source: 'fut.gg',
      success: true,
      message: `Retrieved ${transformedEvolutions.length} evolutions for player ${playerId}`,
      playerId,
      totalCount: transformedEvolutions.length
    });

  } catch (error) {
    console.error('FUT.GG Evolution Player API completely failed:', error);
    const { playerId } = await params;

    return NextResponse.json({
      error: 'FUT.GG Evolution Player API is unavailable',
      message: (error as Error).message,
      source: 'fut.gg',
      success: false,
      playerId,
      details: 'Unable to fetch evolution player data from FUT.GG API. This may be due to Cloudflare protection or API changes.'
    }, {
      status: 503 // Service Unavailable
    });
  }
}