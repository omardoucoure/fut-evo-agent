# FUT Evo Agent

AI-powered FC 26 Ultimate Team assistant and community engagement agent, built on **Ollama** (local LLM) with tool-calling, dynamic UI rendering, and automated Reddit engagement.

Part of the [FUT Evolution](https://futevolution.com) ecosystem.

## What It Does

### 1. AI Squad Coach ("Futties")
A conversational agent that helps FC 26 players with:
- **Player Search & Comparison** — Search 10,000+ players by name, position, rating, or price. Side-by-side stat comparisons with radar charts.
- **Squad Analysis** — Upload a squad screenshot → get personalized upgrade suggestions with Accept/Reject swap actions.
- **Meta Tier Rankings** — S/A/B/C tier lists per position based on computed meta scores.
- **Chemistry Optimization** — Find perfect/strong/weak chemistry links (club, league, nation).
- **Evolution Verdicts** — AI-powered analysis of whether a player evolution is worth completing.
- **Price History & Market Advice** — Track price trends (24h/7d/30d) with buy/sell recommendations.
- **Chem Style Recommendations** — Position-aware chem style suggestions with stat boost previews.
- **Custom Tactics (FC 26)** — Role + Focus based tactics (not legacy FC 25 instructions/sliders).
- **Skill Move Tutorials** — Controller inputs, star requirements, and usage tips.
- **Community Insights** — Aggregated Reddit/YouTube/forum opinions about specific players.

### 2. Reddit Engagement Engine
Automated community engagement pipeline:
- **Scanner** — Monitors r/fut, r/FIFA, r/EASportsFC for squad-help posts matching keyword patterns.
- **Reply Drafter** — Uses Ollama to generate helpful, stats-backed replies with a natural Reddit tone. Pulls real player data + community insights from the database.
- **Poster** — Posts approved replies via Reddit OAuth2 API with daily rate limits.
- **App Mention Control** — 7/10 ratio: 70% of replies naturally mention futevolution.com, 30% are pure gameplay advice.
- **Anti-Spam Guardrails** — Marketing blacklist, word count limits (50-300), no ALL CAPS, deduplication.

## Architecture

```
┌─────────────────────────────────────────────────┐
│                  User / Reddit                   │
└──────────┬──────────────────────┬────────────────┘
           │                      │
    ┌──────▼──────┐      ┌───────▼────────┐
    │  Next.js    │      │  Kotlin (KMP)  │
    │  Agent API  │      │  EvoAgent      │
    │  (TS)       │      │  Scheduler     │
    └──────┬──────┘      └───────┬────────┘
           │                      │
    ┌──────▼──────────────────────▼──────┐
    │         Ollama (Local LLM)         │
    │         qwen3:8b                   │
    └──────┬──────────────────────┬──────┘
           │                      │
    ┌──────▼──────┐      ┌───────▼────────┐
    │  PostgreSQL │      │  Reddit API    │
    │  Players DB │      │  OAuth2        │
    └─────────────┘      └────────────────┘
```

### TypeScript Agent (Next.js 15)

| Path | Description |
|------|-------------|
| `typescript/lib/agent/agent.ts` | Core agent runner — query classification, player pre-fetch, streaming LLM loop with tool calling (max 4 iterations) |
| `typescript/lib/agent/tools.ts` | 11 OpenAI-format tool definitions (search_players, get_player_detail, get_better_alternatives, etc.) |
| `typescript/lib/agent/tool-executor.ts` | Tool implementations — PostgreSQL queries via Supabase client |
| `typescript/lib/agent/prompts.ts` | System prompts with FC 26 tactics rules, template instructions, and i18n |
| `typescript/lib/agent/dynui-schema.ts` | Dynamic UI block catalog (glass_card, stat_bar, comparison_bar, formation_field, etc.) |
| `typescript/lib/agent/dynui-validator.ts` | JSON repair + validation for LLM-generated UI blocks |
| `typescript/lib/agent/ui-block-utils.ts` | Template wrapper — converts `[TPL:type]{data}[/TPL]` to native UI |
| `typescript/lib/agent/static-data.ts` | Formations, chem styles, tactical presets, skill moves |
| `typescript/api/agent/chat/route.ts` | POST `/api/agent/chat` — non-streaming chat endpoint |
| `typescript/api/agent/chat/stream/route.ts` | POST `/api/agent/chat/stream` — SSE streaming endpoint |
| `typescript/api/agent/suggest/route.ts` | POST `/api/agent/suggest` — suggestion endpoint |
| `typescript/api/agent/context/route.ts` | Squad context management |
| `typescript/api/agent/key/route.ts` | API key management |
| `typescript/api/agent/tools/` | Individual tool API routes (7 endpoints) |
| `typescript/api/evolutions/` | Evolution verdict, progression, player, card-image endpoints |
| `typescript/ui/page.tsx` | Agent chat interface page |

### Kotlin Agent (KMP)

| Path | Description |
|------|-------------|
| `kotlin/agent/EvoAgent.kt.patch` | Main agent scheduler — orchestrates crawlers + engagement pipeline with run counter cadence |
| `kotlin/config/EvoConfig.kt.patch` | Configuration: Ollama URL, model, Reddit credentials, rate limits |
| `kotlin/config/config.properties.patch` | Properties file with defaults |
| `kotlin/engagement/RedditEngagementScanner.kt` | Scans subreddits for squad-help posts using keyword matching |
| `kotlin/engagement/ReplyDrafter.kt` | Drafts replies using Ollama + player stats + community insights |
| `kotlin/engagement/RedditPoster.kt` | Posts approved replies via Reddit OAuth2 with daily limits |

## Agent Tools (11 total)

| Tool | Description | Data Source |
|------|-------------|-------------|
| `search_players` | Search by name, position, rating, max price. Supports card type filters (TOTY, ICON, etc.) | PostgreSQL |
| `get_player_detail` | Full stats: 30+ sub-stats, playstyles, work rates, GK-specific stats, meta roles | PostgreSQL |
| `get_better_alternatives` | Find upgrades ranked by meta score improvement for compatible positions | PostgreSQL |
| `get_chemistry_links` | Perfect (club+nation), strong (club/nation), weak (league) links | PostgreSQL |
| `get_meta_tier_list` | S/A/B/C tier list for a position, ranked by meta primary score | PostgreSQL |
| `get_formations` | All 30 FC 26 formations with position layouts | Static data |
| `get_price_history` | Price trend data with min/max/avg stats (24h/7d/30d/all) | PostgreSQL |
| `get_chem_style_guide` | All chem styles with boost amounts at 1/2/3 chemistry + personalized recommendations | Static + DB |
| `get_custom_tactics` | FC 26 Role + Focus tactical presets per formation | Static data |
| `get_skill_moves` | Skill move tutorials with controller inputs, filterable by star rating | Static data |
| `get_community_insights` | Community opinions from Reddit, YouTube, forums with sentiment analysis | PostgreSQL |

## How the Agent Works

### Query Flow
```
User message
    │
    ├─ Classify query type (greeting/comparison/player_info/squad_advice/general)
    │
    ├─ Greeting? → Fast path (no tools, 1-2 sentence reply)
    │
    ├─ Extract player names → Pre-fetch data (up to 3 players in parallel)
    │
    ├─ Build system prompt with:
    │   ├─ User context (platform, budget, squad, formation)
    │   ├─ Pre-fetched player data
    │   ├─ FC 26 tactics rules
    │   ├─ Dynamic UI template catalog
    │   └─ Response rules + language
    │
    ├─ LLM call with 11 tools (streaming or non-streaming)
    │   ├─ Tool calls → execute → inject results → loop (max 4 iterations)
    │   └─ Final response with [TPL:template]{data}[/TPL] blocks
    │
    └─ Validate + repair UI blocks → return to client
```

### Response Caching
- In-memory LRU cache (100 entries, 30-minute TTL)
- Cache key: normalized message + platform + budget + formation
- Streaming responses bypass cache

### Dynamic UI System
The agent outputs structured JSON blocks that the mobile app renders natively:

**Layout**: `glass_card`, `row`, `column`, `grid`, `section`, `divider`, `spacer`
**Text**: `heading`, `text`, `badge`, `markdown`
**Data**: `stat_bar`, `comparison_bar`, `star_rating`, `sparkline`, `price`
**Media**: `player_image`, `formation_field`, `radar_chart`, `list_item`

Each block can have an `action` (e.g., `swapPlayer` to swap a player directly into the squad).

## Stack

| Component | Technology |
|-----------|------------|
| LLM | Ollama — `qwen3:8b` (local, free) |
| LLM API | OpenAI SDK (Ollama-compatible `/v1` endpoint) |
| Cloud fallback | GPT-4.1-mini (normal) / o4-mini (deep thinking) |
| TypeScript runtime | Next.js 15, App Router |
| Kotlin runtime | KMP + Ktor HTTP client |
| Database | PostgreSQL (via Supabase client) |
| Reddit integration | OAuth2 "script" app + public JSON API |
| Languages | English, French, Spanish, Arabic, German |

## Environment Variables

```bash
# Ollama (local LLM)
OLLAMA_BASE_URL=http://localhost:11434/v1
OLLAMA_MODEL=qwen3:8b

# Cloud fallback (optional)
OPENAI_API_KEY=sk-...
FINE_TUNED_MODEL=ft:gpt-4.1-mini:...  # optional fine-tuned model

# Database
DATABASE_URL=postgresql://...

# Reddit engagement (Kotlin agent)
REDDIT_CLIENT_ID=...
REDDIT_CLIENT_SECRET=...
REDDIT_USERNAME=...
REDDIT_PASSWORD=...
REDDIT_SUBREDDITS=fut,FIFA,EASportsFC

# Agent tuning
AGENT_TOOL_TIMEOUT_MS=15000  # tool execution timeout
```

## Database Tables

The agent reads from these PostgreSQL tables:

| Table | Purpose |
|-------|---------|
| `players` | 10,000+ FC 26 player cards with stats, prices, meta scores, playstyles |
| `price_history` | Historical price data points per player |
| `community_insights` | Aggregated community opinions with sentiment scores |
| `reddit_comment_queue` | Draft/approved/posted Reddit replies |
| `reddit_daily_limits` | Rate limiting for Reddit posting |
| `reddit_engagement_runs` | Run history and stats |

## License

Private — part of the FUT Evolution project.
