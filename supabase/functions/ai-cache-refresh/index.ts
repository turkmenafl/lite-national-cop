import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const AI_GAP_MS = 15_000; // 15s between calls
const delay = (ms: number) => new Promise(r => setTimeout(r, ms));

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
  gcc_strikes: {
    prompt: `You are a conflict data analyst. Search for the latest verified reports on Iranian missile and drone attacks against GCC countries during the Iran-GCC conflict of February-March 2026.
For each country — SA, AE, QA, KW, BH, OM — find total strikes, intercept %, source, confidence (CONFIRMED=official MoD/Reuters/AP, EST=think-tank).
Reply ONLY with valid JSON:
{"SA":{"total":19,"intercept_pct":96,"source":"Saudi MoD spokesman","confidence":"CONFIRMED","note":"96% intercept. Abqaiq near-miss Mar 4"},"AE":{"total":1276,"intercept_pct":92,"source":"UAE MoD press conference","confidence":"CONFIRMED","note":"Jebel Ali and Dubai T3 hit"},"QA":{"total":115,"intercept_pct":90,"source":"CTP-ISW","confidence":"EST","note":"Al Udeid struck. LNG suspended"},"KW":{"total":484,"intercept_pct":88,"source":"KUNA / US DoD","confidence":"EST","note":"Ali Al Salem struck"},"BH":{"total":198,"intercept_pct":85,"source":"NAVCENT","confidence":"EST","note":"5th Fleet HQ struck"},"OM":{"total":4,"intercept_pct":50,"source":"ONA","confidence":"EST","note":"Duqm Port drone"}}`,
    max_tokens: 1000,
    parse: (text) => {
      const m = text.match(/\{[\s\S]*\}/);
      return m ? JSON.parse(m[0]) : null;
    },
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

async function callAnthropic(apiKey: string, prompt: string, maxTokens: number): Promise<string> {
  const res = await fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: maxTokens,
      tools: [{ type: "web_search_20250305", name: "web_search" }],
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Anthropic ${res.status}: ${err}`);
  }

  const data = await res.json();
  return data.content?.filter((b: { type: string }) => b.type === "text")
    .map((b: { text: string }) => b.text).join("") || "";
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
    const results: Record<string, { success: boolean; error?: string }> = {};
    const feedKeys = Object.keys(PROMPTS);

    for (let i = 0; i < feedKeys.length; i++) {
      const key = feedKeys[i];
      const config = PROMPTS[key];
      
      try {
        console.log(`[${key}] Calling Anthropic...`);
        const text = await callAnthropic(ANTHROPIC_API_KEY, config.prompt, config.max_tokens);
        const parsed = config.parse(text);

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
