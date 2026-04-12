# FUT Evo Agent

AI-powered FC 26 Ultimate Team assistant agent using **Ollama** (local LLM) with tool-calling capabilities.

## Overview

The FUT Evo Agent helps players with squad building, player comparisons, evolution verdicts, chemistry optimization, and market insights — all powered by a local Ollama model.

## Architecture

### TypeScript Agent (Next.js API)
- **Core**: `typescript/lib/agent/` — Agent runner, tools, prompts, dynamic UI
- **API Routes**: `typescript/api/agent/` — Chat, streaming, tool endpoints
- **Evolutions API**: `typescript/api/evolutions/` — Evolution verdicts, progression, card images
- **UI**: `typescript/ui/page.tsx` — Agent chat interface

### Kotlin Agent (KMP)
- **Agent**: `kotlin/agent/` — EvoAgent core
- **Config**: `kotlin/config/` — Ollama model configuration
- **Engagement**: `kotlin/engagement/` — Reddit posting, reply drafting, engagement scanning

## Agent Tools
- `search_players` — Search by name, position, rating
- `get_player_detail` — Detailed sub-stats, playstyles
- `get_meta_tier` — Meta tier ratings
- `get_chemistry_links` — Chemistry link suggestions
- `get_alternatives` — Player alternatives within budget
- `get_game_data` — Live game data
- `get_price_history` — Market price trends

## Stack
- **LLM**: Ollama (qwen2.5:7b default)
- **TypeScript**: Next.js 15, OpenAI SDK (Ollama-compatible)
- **Kotlin**: KMP + Ktor HTTP client
- **Database**: PostgreSQL

## Environment Variables
```
OLLAMA_BASE_URL=http://localhost:11434/v1
OLLAMA_MODEL=qwen2.5:7b
```
