import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const AI_GAP_MS = 20_000; // 20s between calls
const MAX_RETRIES = 1;

// ─── Scenario context injection ─────────────────────────────────────────────
const CONFLICT_START = new Date('2026-02-28T00:00:00Z');

function getScenarioContext(): string {
  const now = new Date();
  const day = Math.max(1, Math.ceil((now.getTime() - CONFLICT_START.getTime()) / (1000 * 60 * 60 * 24)));
  const dateStr = now.toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' });
  return (
    `You are an intelligence analyst supporting the Saudi National Emergency Management Authority (NEMA) during the Iran-GCC conflict. ` +
    `Current scenario: Day ${day}, ${dateStr}. ` +
    `The conflict began 28 February 2026 when Iran launched coordinated missile and drone attacks across GCC states. ` +
    `Key facts: Strait of Hormuz closed Day 5, still closed. 19 confirmed projectile attacks on KSA. ` +
    `Brent crude at $92.69 (+42% above pre-conflict baseline of $65). TASI at 10,776 (-10% since conflict). ` +
    `6 CI sectors affected: Oil & Gas DEGRADED, Airports RESTRICTED, Ports DISRUPTED, Water OPERATIONAL, Power ELEVATED, Telecom ELEVATED. ` +
    `Your role: provide direct, evidence-based analysis for ministerial decision-making. ` +
    `Be specific, cite numbers, avoid generic statements. Respond in the same language as the question.`
  );
}

// ─── Prompts for each feed ───────────────────────────────────────────────────

const PROMPTS: Record<string, { prompt: string; max_tokens: number; parse: (text: string) => unknown }> = {
  financial: {
    prompt: "Find current Brent crude price and Saudi TASI index today. Reply ONLY: BRENT:XX.XX BRENTCHG:+X.X% TASI:XXXXX TASICHG:-X.X%",
    max_tokens: 400,
    parse: (text) => ({
      brent: (text.match(/BRENT[:\s]+\$?([\d.]+)/i) || [])[1] ? parseFloat(text.match(/BRENT[:\s]+\$?([\d.]+)/i)![1]) : null,
      brentChg: (text.match(/BRENTCHG[:\s]+([+-]?[\d.]+%)/i) || [])[1] || null,
      tasi: (text.match(/TASI[:\s]+([\d,]+)/i) || [])[1]?.replace(/,/g, "") || null,
      tasiChg: (text.match(/TASICHG[:\s]+([+-]?[\d.]+%)/i) || [])[1] || null,
    }),
  },
  ukmto: {
    prompt: `Search for the latest UKMTO maritime security advisory for the Arabian Gulf and Strait of Hormuz, March 2026. Return ONLY:
LEVEL: [ELEVATED/HIGH/SIGNIFICANT]
AREA: [max 60 chars]
ADVISORY: [e.g. 003-26 Update 002]
DATE: [YYYY-MM-DD]
HORMUZ: [SUSPENDED/CLOSED/RESTRICTED/DISRUPTED/OPEN]
GNSS: [YES or NO]
TEXT: [max 120 char summary]`,
    max_tokens: 400,
    parse: (text) => {
      const get = (k: string) => (text.match(new RegExp(`${k}:\\s*(.+?)(?:\\n|$)`, "i")) || [])[1]?.trim() ?? null;
      return {
        level: get("LEVEL") ?? "ELEVATED",
        area: get("AREA") ?? "Arabian Gulf / Gulf of Oman / Hormuz",
        advisory: get("ADVISORY") ?? "003-26 Update 002",
        date: get("DATE") ?? "2026-03-01",
        hormuzStatus: get("HORMUZ") ?? "SUSPENDED",
        gnssInterference: (get("GNSS") || "YES").toUpperCase() === "YES",
        text: get("TEXT") ?? "Significant military activity. Elevated GNSS/AIS interference.",
        source: "UKMTO",
      };
    },
  },
  gcc_strikes: {
    prompt: `Search for the most recent confirmed projectile attack totals (missiles + drones) launched against each GCC state since the Iran-GCC conflict began in late February 2026. For each country provide: total projectile count, intercept percentage, confidence level (CONFIRMED if official MoD statement / REPORTED if major wire / EST if estimated), and primary source with date. Countries: Saudi Arabia, UAE, Kuwait, Bahrain, Qatar, Oman. Return as JSON only with this structure: {"KSA":{"total":0,"intercept_pct":0,"confidence":"EST","source":""},"UAE":{"total":0,"intercept_pct":0,"confidence":"EST","source":""},"Kuwait":{"total":0,"intercept_pct":0,"confidence":"EST","source":""},"Bahrain":{"total":0,"intercept_pct":0,"confidence":"EST","source":""},"Qatar":{"total":0,"intercept_pct":0,"confidence":"EST","source":""},"Oman":{"total":0,"intercept_pct":0,"confidence":"EST","source":""}}`,
    max_tokens: 1000,
    parse: (text) => {
      const m = text.match(/\{[\s\S]*\}/);
      if (!m) return null;
      const raw = JSON.parse(m[0]);
      // Remap prompt keys to GCC_SEED codes used by the frontend
      const KEY_MAP: Record<string, string> = { KSA:"SA", UAE:"AE", Kuwait:"KW", Bahrain:"BH", Qatar:"QA", Oman:"OM" };
      const normalized: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(raw)) {
        normalized[KEY_MAP[k] ?? k] = v;
      }
      return Object.keys(normalized).length ? normalized : null;
    },
  },
  ksa_strikes: {
    prompt: `You are a conflict data analyst. Search for the latest verified reports of Iranian missile, drone, and cruise missile attacks against Saudi Arabia (KSA) during the Iran-GCC conflict, February 28 – March 2026.
Find the 10 most recent individual strike events against KSA. For each event return:
- time: date and time (e.g. "Mar 06 02:15")
- type: weapon type (e.g. "Ballistic Missile", "Drone (3x)", "Cruise Missile")
- loc: target location (e.g. "Ras Tanura Oil Terminal")
- status: outcome (e.g. "Intercepted", "Hit — minor damage", "All destroyed")
- sev: severity — "critical" if energy/military infra hit or near-miss, "high" otherwise
Reply ONLY with valid JSON array, no other text:
[{"id":1,"time":"Mar 06 02:15","type":"Ballistic Missile","loc":"Abqaiq Processing vicinity","status":"Intercepted","sev":"critical"},{"id":2,"time":"Mar 05 23:40","type":"Drone (4x)","loc":"Yanbu Port","status":"Intercepted","sev":"high"}]
Prioritise sources: Saudi MoD statements via SPA, Reuters, AP, CTP-ISW, Alma Research. If fewer than 10 events confirmed, return what is verified. Do not fabricate events.`,
    max_tokens: 1200,
    parse: (text) => {
      const m = text.match(/\[[\s\S]*\]/);
      if (!m) return null;
      const arr = JSON.parse(m[0]);
      return Array.isArray(arr) && arr.length ? arr : null;
    },
  },
  ci_status: {
    prompt: `You are a critical infrastructure analyst. Search for the current operational status of Saudi Arabia's key infrastructure sectors during the Iran-GCC conflict, March 2026.
For each of the 6 sectors below, return the current status based on verified reporting:
1. Oil & Gas — Aramco, Ras Tanura, Abqaiq, Yanbu refinery status
2. Airports — RUH (Riyadh), DMM (Dammam), JED (Jeddah) capacity %
3. Ports & Maritime — Jubail, Dammam, Jeddah, Yanbu port operations + Hormuz status
4. Power Grid — SEC eastern province grid status
5. Water / Desal — SWCC Jubail and Yanbu desalination plant status
6. Telecom & Cyber — STC/Mobily network status, cyber threat level
Reply ONLY with valid JSON, no other text:
{"oilgas":{"status":"DEGRADED","pct":82,"note":"Ras Tanura 85% cap. Abqaiq near-miss Mar 4.","confidence":"EST"},"airports":{"status":"RESTRICTED","pct":60,"note":"RUH 42%. DMM 33%. JED 112% overflow.","confidence":"CONFIRMED"},"ports":{"status":"DISRUPTED","pct":45,"note":"Hormuz D7 — 0 transits. ~91 tankers holding.","confidence":"EST"},"power":{"status":"ELEVATED","pct":88,"note":"Eastern Province proximity threat.","confidence":"EST"},"water":{"status":"OPERATIONAL","pct":90,"note":"Jubail RO on elevated watch.","confidence":"EST"},"telecom":{"status":"ELEVATED","pct":73,"note":"APT33 activity. AWS Gulf degraded.","confidence":"EST"}}
Status values: OPERATIONAL / ELEVATED / RESTRICTED / DEGRADED / DISRUPTED / CRITICAL / OFFLINE
Confidence: CONFIRMED (official source) or EST (synthesised estimate)
pct: operational capacity 0-100
note: max 60 chars, specific and factual
Prioritise: Saudi MoD/Aramco/GACA/SEC/SWCC official statements, Reuters, AP, CTP-ISW.`,
    max_tokens: 800,
    parse: (text) => {
      const m = text.match(/\{[\s\S]*\}/);
      if (!m) return null;
      const d = JSON.parse(m[0]);
      const required = ["oilgas", "airports", "ports", "power", "water", "telecom"];
      return required.every(k => d[k]?.status) ? d : null;
    },
  },
};

async function callAnthropic(apiKey: string, prompt: string, maxTokens: number, system?: string): Promise<string> {
  const body: Record<string, unknown> = {
    model: 'claude-sonnet-4-20250514',
    max_tokens: maxTokens,
    tools: [{ type: "web_search_20250305", name: "web_search" }],
    messages: [{ role: "user", content: prompt }],
  };
  if (system) body.system = system;

  const res = await fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Anthropic ${res.status}: ${err}`);
  }

  const data = await res.json();
  return data.content?.filter((b: { type: string }) => b.type === "text")
    .map((b: { text: string }) => b.text).join("") || "";
}

const delay = (ms: number) => new Promise(r => setTimeout(r, ms));

// ─── Direct Brent price fetch (OilPriceAPI → EIA → Claude fallback) ──────────

async function fetchBrentDirect(): Promise<{ price: number; source: string; updatedAt?: string; period?: string } | null> {
  // 1. Try OilPriceAPI
  try {
    const opaKey = Deno.env.get('OILPRICE_API_KEY');
    if (opaKey) {
      const res = await fetch('https://api.oilpriceapi.com/v1/prices/latest?by_code=BRENT_CRUDE_USD', {
        headers: { Authorization: `Token ${opaKey}` },
      });
      if (res.ok) {
        const data = await res.json();
        const price = parseFloat(data?.data?.price);
        if (!isNaN(price)) {
          console.log(`[Brent] OPA: ${price}`);
          return { price, source: 'OPA', updatedAt: data?.data?.created_at ?? new Date().toISOString() };
        }
      }
    }
  } catch (e) {
    console.warn('[Brent] OPA failed:', e instanceof Error ? e.message : e);
  }

  // 2. Fall back to EIA
  try {
    const eiaKey = Deno.env.get('EIA_API_KEY');
    if (eiaKey) {
      const url = `https://api.eia.gov/v2/petroleum/pri/spt/data/?api_key=${eiaKey}&frequency=daily&data%5B0%5D=value&facets%5Bseries%5D%5B%5D=RBRTE&length=1`;
      const res = await fetch(url);
      if (res.ok) {
        const data = await res.json();
        const row = data?.response?.data?.[0];
        const price = parseFloat(row?.value);
        if (!isNaN(price)) {
          console.log(`[Brent] EIA: ${price} (${row.period})`);
          return { price, source: 'EIA', period: row.period };
        }
      }
    }
  } catch (e) {
    console.warn('[Brent] EIA failed:', e instanceof Error ? e.message : e);
  }

  console.warn('[Brent] Both OPA and EIA failed — falling back to Claude');
  return null;
}

async function callWithRetry(apiKey: string, prompt: string, maxTokens: number, system?: string): Promise<string> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await callAnthropic(apiKey, prompt, maxTokens, system);
    } catch (e) {
      if (attempt < MAX_RETRIES && e instanceof Error && e.message.includes("429")) {
        console.warn(`Rate limited, retrying in ${AI_GAP_MS * 2 / 1000}s...`);
        await delay(AI_GAP_MS * 2);
      } else { throw e; }
    }
  }
  throw new Error("Unreachable");
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY');
    const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
    const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

    if (!ANTHROPIC_API_KEY || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      return new Response(JSON.stringify({ error: 'Missing env vars' }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const results: Record<string, { success: boolean; error?: string; skipped?: boolean }> = {};
    const feedKeys = Object.keys(PROMPTS);

    // Check which entries are already fresh (< 9 min old)
    const { data: existing } = await supabase.from('ai_cache').select('key, updated_at');
    const freshKeys = new Set<string>();
    const now = Date.now();
    for (const row of existing || []) {
      const age = now - new Date(row.updated_at).getTime();
      if (age < 9 * 60 * 1000) freshKeys.add(row.key); // skip if < 9 min old
    }

    for (let i = 0; i < feedKeys.length; i++) {
      const key = feedKeys[i];
      const config = PROMPTS[key];

      if (freshKeys.has(key)) {
        results[key] = { success: true, skipped: true };
        console.log(`[${key}] ⏭ skipped (fresh)`);
        continue;
      }
      
      try {
        // For the financial key: attempt direct Brent fetch (OPA → EIA) before Claude
        let directBrent: { price: number; source: string; updatedAt?: string; period?: string } | null = null;
        if (key === 'financial') {
          directBrent = await fetchBrentDirect();
          console.log(`[financial] Brent direct: ${directBrent ? `${directBrent.price} via ${directBrent.source}` : 'using Claude fallback'}`);
        }

        console.log(`[${key}] Calling Anthropic...`);
        const text = await callWithRetry(ANTHROPIC_API_KEY, config.prompt, config.max_tokens, getScenarioContext());
        const rawParsed = config.parse(text);

        // Merge direct Brent price into financial result when available
        const parsed = (key === 'financial' && rawParsed && directBrent)
          ? {
              ...(rawParsed as Record<string, unknown>),
              brent: directBrent.price,
              brentSource: directBrent.source,
              ...(directBrent.updatedAt ? { brentUpdatedAt: directBrent.updatedAt } : {}),
              ...(directBrent.period ? { brentPeriod: directBrent.period } : {}),
            }
          : rawParsed;

        if (parsed) {
          const { error } = await supabase
            .from('ai_cache')
            .upsert({ key, data: parsed, updated_at: new Date().toISOString() }, { onConflict: 'key' });

          if (error) throw new Error(`DB upsert: ${error.message}`);
          results[key] = { success: true };
          console.log(`[${key}] ✓ cached`);
        } else {
          results[key] = { success: false, error: 'Parse returned null' };
          console.warn(`[${key}] ✗ parse failed`);
        }
      } catch (e) {
        results[key] = { success: false, error: e instanceof Error ? e.message : String(e) };
        console.error(`[${key}] ✗ ${e instanceof Error ? e.message : e}`);
      }

      // Wait between calls to avoid rate limits
      if (i < feedKeys.length - 1) {
        console.log(`Waiting ${AI_GAP_MS / 1000}s before next call...`);
        await delay(AI_GAP_MS);
      }
    }

    return new Response(JSON.stringify({ results, timestamp: new Date().toISOString() }), {
      status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (e) {
    console.error('Refresh error:', e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : 'Unknown error' }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
