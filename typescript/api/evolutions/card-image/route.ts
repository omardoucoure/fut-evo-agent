import { NextRequest, NextResponse } from 'next/server';

async function fetchFutGGEvolutionData(evolutionId: string): Promise<any> {
  const endpoints = [
    `https://www.fut.gg/api/fut/evolutions/v2/26/players/?id=${evolutionId}`,
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
        const response = await fetch(endpoint, {
          headers: {
            'User-Agent': userAgent,
            'Accept': 'application/json',
            'Cache-Control': 'no-cache',
            'Referer': 'https://www.fut.gg/',
            'Origin': 'https://www.fut.gg',
          },
          next: { revalidate: 300 },
        });

        if (!response.ok) continue;

        const contentType = response.headers.get('content-type');
        if (!contentType || !contentType.includes('application/json')) continue;

        const data = await response.json();
        return data;
      } catch (error) {
        continue;
      }
    }
  }

  throw new Error('Failed to fetch evolution data');
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ evolutionId: string }> }) {
  try {
    const { evolutionId } = await params;

    // Fetch evolution data to get image paths
    const evolutionData = await fetchFutGGEvolutionData(evolutionId);
    const evolution = evolutionData.data[0];

    const playerImageUrl = `https://game-assets.fut.gg/${evolution.imagePath}`;
    const cardImageUrl = `https://game-assets.fut.gg/${evolution.cardImagePath}`;

    // Create HTML for composite image generation
    const html = `
    <!DOCTYPE html>
    <html>
    <head>
        <style>
            body { margin: 0; padding: 0; }
            .card-container {
                position: relative;
                width: 300px;
                height: 400px;
                background-image: url('${cardImageUrl}');
                background-size: cover;
                background-position: center;
                display: flex;
                align-items: center;
                justify-content: center;
            }
            .player-image {
                position: absolute;
                top: 50%;
                left: 50%;
                transform: translate(-50%, -50%);
                max-width: 80%;
                max-height: 80%;
                object-fit: contain;
                z-index: 1;
            }
            .overlay-text {
                position: absolute;
                bottom: 20px;
                left: 20px;
                color: white;
                font-family: Arial, sans-serif;
                font-weight: bold;
                text-shadow: 2px 2px 4px rgba(0,0,0,0.8);
            }
            .overall {
                font-size: 48px;
                line-height: 1;
            }
            .position {
                font-size: 16px;
                margin-top: 5px;
            }
            .player-name {
                position: absolute;
                bottom: 60px;
                left: 20px;
                color: white;
                font-family: Arial, sans-serif;
                font-weight: bold;
                font-size: 18px;
                text-shadow: 2px 2px 4px rgba(0,0,0,0.8);
            }
        </style>
    </head>
    <body>
        <div class="card-container">
            <img src="${playerImageUrl}" alt="Player" class="player-image" />
            <div class="player-name">${evolution.firstName} ${evolution.lastName}</div>
            <div class="overlay-text">
                <div class="overall">${evolution.overall}</div>
                <div class="position">${evolution.position}</div>
            </div>
        </div>
    </body>
    </html>
    `;

    // Return HTML that can be used for image generation
    return new NextResponse(html, {
      headers: {
        'Content-Type': 'text/html',
        'Cache-Control': 'public, max-age=3600', // Cache for 1 hour
      },
    });

  } catch (error) {
    console.error('Failed to generate card image:', error);

    return NextResponse.json({
      error: 'Failed to generate card image',
      message: (error as Error).message,
    }, {
      status: 500
    });
  }
}