# NATIONAL COMMON OPERATING PICTURE (NCOP)
## Design Architecture & Approach Methodology

**Classification:** UNCLASSIFIED — DEMONSTRATION SYSTEM  
**Version:** 1.0  
**Date:** 08 March 2026  
**Platform:** Lovable Cloud (React + Supabase)

---

## 1. EXECUTIVE SUMMARY

The National Common Operating Picture (NCOP) is a real-time, web-based situational awareness dashboard designed for ministerial-level decision support during a multi-domain national security crisis. The system fuses live open-source intelligence (OSINT) feeds, AI-synthesised analysis, and static seed data into a unified operational interface spanning seven functional tabs.

The prototype demonstrates a hybrid data architecture where:
- **Live feeds** provide real-time market, internet, and news data
- **AI-enriched cache** delivers synthesised strike tallies, infrastructure status, and maritime advisories via Claude API with web search
- **Static seed data** serves as authoritative fallback when live/cached sources are unavailable

---

## 2. SYSTEM ARCHITECTURE

### 2.1 High-Level Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    BROWSER (React SPA)                       │
│  ┌──────────────────────────────────────────────────────┐   │
│  │              NEMACOPLive.jsx (~2,200 lines)          │   │
│  │  ┌─────────┬──────────┬───────┬────────┬──────────┐  │   │
│  │  │SITUATION│RISK CLUST│  CI   │ IMPACT │SCENARIOS │  │   │
│  │  │         │          │       │        │          │  │   │
│  │  │DECISIONS│ AI BRIEF │       │        │          │  │   │
│  │  └─────────┴──────────┴───────┴────────┴──────────┘  │   │
│  └──────────────────────────────────────────────────────┘   │
│         │                    │                    │          │
│    Live Fetchers        Supabase Client      Anthropic Proxy│
└─────────┼────────────────────┼────────────────────┼─────────┘
          │                    │                    │
          ▼                    ▼                    ▼
  ┌───────────────┐   ┌──────────────┐   ┌─────────────────┐
  │ External APIs │   │  ai_cache    │   │ anthropic-proxy  │
  │ (EIA, OPA,    │   │  (Supabase)  │   │ (Edge Function)  │
  │  GDELT, IODA) │   │              │   │                  │
  └───────────────┘   └──────┬───────┘   └─────────────────┘
                             │
                    ┌────────┴────────┐
                    │ ai-cache-refresh │
                    │ (Edge Function)  │
                    │ pg_cron: 10 min  │
                    └────────┬────────┘
                             │
                    ┌────────┴────────┐
                    │  Anthropic API   │
                    │ Claude Sonnet 4  │
                    │ + web_search     │
                    └─────────────────┘
```

### 2.2 Component Hierarchy

| Layer | Component | Responsibility |
|-------|-----------|----------------|
| **Entry** | `NEMACOPLive` | State management, data refresh orchestration, tab routing |
| **Screens** | `ScreenSituation` | Theater map, KSA event log, GCC theater, KPIs, media watch |
| | `ScreenRiskClusters` | 5-tier risk taxonomy, national consequence score, live signal overlay |
| | `ScreenInfra` | 6 CI sectors with per-asset drill-down, live cache overlay |
| | `ScreenEconomic` | National severity scoring, financial KPIs, reserves, scenarios |
| | `ScreenScenarios` | Probability assessment, what-if FAQ |
| | `ScreenDecisions` | Decision matrix with severity, window, implications |
| | `ScreenAIBrief` | Executive summary + AI chat interface |
| **Map** | `LeafletTheaterMap` | Interactive Leaflet map with strike markers, GCC polygons, GeoJSON |
| **Widgets** | `GCCTheater` | Expandable GCC country cards with sparklines |
| | `MediaSourceWatch` | Live headlines + narrative signal monitor |
| **Atoms** | `KpiCard`, `FeedTag`, `StatusBadge` | Reusable UI primitives |

---

## 3. DATA ARCHITECTURE

### 3.1 Three-Tier Data Strategy

The system implements a deliberate three-tier data strategy to balance freshness, reliability, and cost:

| Tier | Source | Freshness | Examples |
|------|--------|-----------|----------|
| **Tier 1: Live** | Direct API calls | Real-time | EIA Brent, OilPriceAPI, GDELT, IODA |
| **Tier 2: AI Cache** | Anthropic + web_search → Supabase cache | ≤10 min | GCC strikes, KSA strikes, CI status, UKMTO, Financial |
| **Tier 3: Static Seed** | Hardcoded in component | Baseline | All datasets have seed fallbacks |

### 3.2 AI Cache System

**Database Table:** `ai_cache`
| Column | Type | Description |
|--------|------|-------------|
| `key` | text (PK) | Feed identifier: `financial`, `gcc_strikes`, `ksa_strikes`, `ci_status`, `ukmto` |
| `data` | jsonb | Parsed AI response |
| `updated_at` | timestamptz | Last refresh timestamp |

**Cache Keys & Prompts:**

| Key | AI Prompt Purpose | Max Tokens | Output |
|-----|-------------------|------------|--------|
| `financial` | Brent crude + TASI index prices | 400 | `{brent, brentChg, tasi, tasiChg}` |
| `gcc_strikes` | Per-country strike totals, intercept %, source, confidence | 1000 | `{SA:{total,intercept_pct,...}, AE:{...}, ...}` |
| `ksa_strikes` | 10 most recent KSA strike events with geolocation | 1200 | `[{id,time,type,loc,status,sev,lat,lng}, ...]` |
| `ci_status` | 6 CI sector operational status | 800 | `{oilgas:{status,pct,note}, airports:{...}, ...}` |
| `ukmto` | Maritime security advisory | 400 | `{level,area,advisory,hormuzStatus,...}` |

**Refresh Mechanism:**
- `ai-cache-refresh` Edge Function triggered by `pg_cron` every 10 minutes
- Sequential Anthropic API calls with 20s gaps (rate limit: 30k input tokens/min)
- Skips feeds refreshed <9 minutes ago
- Retry logic for 429 rate limits (1 retry, doubled delay)

### 3.3 Live Feed Sources

| Feed | API | Endpoint | Frequency |
|------|-----|----------|-----------|
| Brent Crude | EIA Petroleum API | `api.eia.gov/v2/petroleum/pri/spt/data` | On refresh |
| Brent Crude (secondary) | OilPriceAPI | `api.oilpriceapi.com/v1/prices/latest` | On refresh |
| News Articles | GDELT | `api.gdeltproject.org/api/v2/doc/doc` | On refresh |
| Internet Connectivity | IODA | `api.ioda.inetintel.cc.gatech.edu` | On refresh |
| Port Activity | PortWatch (IMF) | `portwatch.imf.org/api/v1` | On refresh |

### 3.4 Data Merge Strategy

The system uses a **seed-first, cache-overlay** pattern:

```
Static Seed Data (always available)
       │
       ▼
  Read ai_cache from Supabase
       │
       ▼
  For each feed key:
    if cache[key] exists AND is valid:
      → overlay cache values onto seed
      → set feed tag = "AI+WEB" or "CACHED"
    else:
      → keep seed values
      → set feed tag = "STATIC"
```

**Example: GCC Strikes Merge**
```javascript
// Seed provides baseline
GCC_SEED = [{ code:"SA", strikes:19, interceptPct:96, ... }]

// Cache overlay (when available)
cache.gcc_strikes = { SA: { total:22, intercept_pct:97, ... } }

// Merged result: cache values replace seed per-country
```

**Example: CI Status Merge**
```javascript
// CI_KEY_MAP maps sector names to cache keys
CI_KEY_MAP = { "Oil & Gas":"oilgas", "Airports":"airports", ... }

// For each sector, if cache has matching key:
//   sector.status = cache[key].status
//   sector.pct = cache[key].pct
//   sector.note = cache[key].note
//   sector.feed = "AI+WEB"
```

---

## 4. EDGE FUNCTIONS

### 4.1 `anthropic-proxy`

**Purpose:** General-purpose proxy for ad-hoc AI calls (AI Brief chat, inline queries)

**Features:**
- In-memory response cache (5-minute TTL)
- IP-based rate limiting (20 requests/minute)
- Supports Claude Sonnet 4 with web_search tool
- CORS headers for browser access

**Flow:**
```
Browser → anthropic-proxy → Anthropic API
                ↕ (in-memory cache)
```

### 4.2 `ai-cache-refresh`

**Purpose:** Background cron job that refreshes all 5 AI dashboard feeds

**Flow:**
```
pg_cron (10min) → ai-cache-refresh
                       │
                  For each feed:
                    1. Check if fresh (<9 min) → skip
                    2. Call Anthropic with web_search
                    3. Parse structured response
                    4. Upsert to ai_cache table
                    5. Wait 20s → next feed
```

**Rate Limit Management:**
- 20-second gap between sequential API calls
- Retry on 429 with doubled delay
- Fresh-check skips unnecessary calls
- Total cycle: ~100 seconds for 5 feeds

---

## 5. RISK TAXONOMY

### 5.1 Five-Tier Classification

| Tier | Cluster | Icon | Risk Items | Status |
|------|---------|------|------------|--------|
| T1 | Natural | 🌊 | Marine oil spill / coastal contamination | CLEAR |
| T2 | Health | 🏥 | Human disease outbreak | ELEVATED |
| T3 | Infrastructure | ⬡ | CNI failure, Industrial fire, Transport, Food supply, Fuel & gas | CRITICAL |
| T4 | Security | ⊕ | Physical attack on CNI, UAV attacks, Maritime/air restrictions, Missile attack | CRITICAL |
| T5 | Socioeconomic | ◈ | Import/export disruption, Financial crises, Social stability | CRITICAL |

### 5.2 National Consequence Score

Computed from 6 weighted severity factors:

| Factor | Weight | Description |
|--------|--------|-------------|
| CI Assets Affected | 25% | Number and tier of infrastructure impacted |
| Population Impacted | 20% | Casualties, displacement, disruption to services |
| Cascade Chain | 20% | Risk of cascading failures (e.g., power→desal) |
| Chokepoint Impact | 15% | Maritime and airspace chokepoint status |
| Escalation Trajectory | 10% | Rate and direction of threat escalation |
| Strategic/Diplomatic | 10% | Regional and geopolitical implications |

**Formula:** `score = Σ(factor.value × factor.weight) × 20` → mapped to L1–L5 severity

---

## 6. CRITICAL INFRASTRUCTURE MONITORING

### 6.1 Six Sectors

| Sector | Icon | Source Tag | Key Assets |
|--------|------|------------|------------|
| Oil & Gas | ⬢ | ARAMCO+MoD | Ras Tanura, Abqaiq, Yanbu, Shaybah, SATORP |
| Airports | ✈ | NOTAM+FR24 | RUH, DMM, JED |
| Ports & Maritime | 🚢 | IMF PortWatch | Jubail, Dammam, Jeddah, Yanbu |
| Water / Desal | 💧 | SWCC | Jubail RO, Yanbu RO, Riyadh Wells |
| Power Grid | ⚡ | SEC | Eastern Province, Central, Western |
| Telecom & Cyber | 📡 | IODA+CLOUDSEK | Submarine cables, STC backbone, AWS Gulf, .sa DNS |

### 6.2 Status Values

`OPERATIONAL` → `ELEVATED` → `RESTRICTED` → `DEGRADED` → `DISRUPTED` → `CRITICAL` → `OFFLINE`

---

## 7. UI/UX DESIGN

### 7.1 Design System

| Element | Value |
|---------|-------|
| **Typography** | JetBrains Mono (monospace) — military/tactical aesthetic |
| **Background** | `#060b17` (deep navy-black) |
| **Surface** | `#192233` with `#273248` borders |
| **Critical** | `#ef4444` (red) |
| **Warning** | `#f59e0b` (amber) |
| **Success** | `#22c55e` (green) |
| **Info** | `#3b82f6` (blue) |
| **Text Primary** | `#d8e6f5` |
| **Text Muted** | `#7d8fa3` |

### 7.2 Tab Structure

```
SITUATION · RISK CLUSTERS · CRITICAL INFRASTRUCTURE · IMPACT · SCENARIOS · DECISIONS · AI BRIEF
```

### 7.3 Key UI Patterns

1. **Feed Tags** — Color-coded source attribution badges (LIVE, AI+WEB, STATIC, IODA, GDELT, EST, CONFIRMED)
2. **Status Badges** — Operational status indicators with severity colouring
3. **KPI Cards** — Standardised metric display with value, change, source, and loading state
4. **Sparkline SVGs** — Inline 7-day trend charts for GCC strike data
5. **Expandable Panels** — Click-to-expand detail views for GCC countries and CI assets
6. **Pulsing Animations** — `cop-pulse` animation for loading states and live indicators

### 7.4 Map Implementation

- **Library:** Leaflet.js with CartoDB dark tile layer
- **Features:**
  - Strike markers with severity-coloured pulsing rings
  - Saudi province GeoJSON overlay (Eastern Province highlight)
  - GCC country polygons with interactive popups
  - Dual view: KSA Event Log / GCC Theater toggle
- **Constraints:** Fixed viewport, no zoom/pan (ministerial briefing view)

---

## 8. SCENARIO ANALYSIS

### 8.1 Three Scenarios

| Scenario | Probability | Description |
|----------|-------------|-------------|
| Most Likely | 55% | Continued drone/missile probes 2-4/day. Cyber intensifies. No KSA offensive. |
| Most Dangerous | 20% | Hormuz mining + coordinated Abqaiq strike + banking/water cyber attack. |
| De-escalation | 25% | Ceasefire via Oman channel. Hormuz partial reopening 48-72h. |

---

## 9. TECHNOLOGY STACK

| Layer | Technology | Purpose |
|-------|-----------|---------|
| **Frontend** | React 18 + Vite | SPA framework and build tool |
| **Styling** | Inline styles + CSS-in-JS | Tactical dark theme (no Tailwind in main component) |
| **Mapping** | Leaflet.js | Interactive theater map |
| **Backend** | Supabase (Lovable Cloud) | Database, Edge Functions, auth |
| **Database** | PostgreSQL (via Supabase) | `ai_cache` table for AI feed storage |
| **Edge Functions** | Deno (Supabase Functions) | `anthropic-proxy`, `ai-cache-refresh` |
| **AI** | Claude Sonnet 4 (Anthropic) | Web search + structured data extraction |
| **Scheduling** | pg_cron | 10-minute cache refresh cycle |
| **Data Sources** | EIA, OilPriceAPI, GDELT, IODA, PortWatch | Live OSINT feeds |

---

## 10. SECURITY CONSIDERATIONS

| Concern | Mitigation |
|---------|-----------|
| API key exposure | Anthropic key stored as Supabase Edge Function secret, never in client code |
| Rate limiting | IP-based rate limiting on anthropic-proxy (20 req/min) |
| Data validation | KSA strike cache validated for lat/lng before overlay |
| CORS | Edge functions configured with permissive CORS for preview domain |
| RLS | `ai_cache` table has RLS enabled; public read via anon key |

---

## 11. KNOWN LIMITATIONS & FUTURE WORK

### CORS-Blocked Sources (Require Server-Side Proxy)
- Yahoo Finance (direct ticker data)
- NASA FIRMS (satellite fire detection)
- PortWatch (IMF port data — partial)
- ACLED (conflict event data)

### Planned Enhancements
- Server-side proxy edge functions for CORS-blocked feeds
- Real-time WebSocket subscriptions for strike data
- Multi-user session with role-based views (Minister / Analyst / Operator)
- PDF/briefing export functionality
- Mobile-responsive layout for tablet use in operations rooms

---

## 12. DEPLOYMENT

| Environment | URL | Type |
|-------------|-----|------|
| Preview | `id-preview--*.lovable.app` | Development |
| Production | `national-cop.lovable.app` | Published |

**Frontend:** Deployed via Lovable publish (manual update required)  
**Backend:** Edge functions deploy automatically on code change  
**Database:** Migrations applied automatically via Lovable Cloud

---

*Document generated from codebase analysis — NCOP v1.0*
