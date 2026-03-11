import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

// Simple in-memory cache (persists across warm invocations)
const cache = new Map<string, { data: unknown; timestamp: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// Rate limiting per client IP
const rateLimits = new Map<string, { count: number; windowStart: number }>();
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute
const RATE_LIMIT_MAX = 20; // max requests per minute per IP

function hashKey(obj: unknown): string {
  return JSON.stringify(obj);
}

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = rateLimits.get(ip);
  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    rateLimits.set(ip, { count: 1, windowStart: now });
    return true;
  }
  if (entry.count >= RATE_LIMIT_MAX) return false;
  entry.count++;
  return true;
}

// Cleanup stale entries periodically
function cleanup() {
  const now = Date.now();
  for (const [key, val] of cache) {
    if (now - val.timestamp > CACHE_TTL_MS) cache.delete(key);
  }
  for (const [key, val] of rateLimits) {
    if (now - val.windowStart > RATE_LIMIT_WINDOW_MS) rateLimits.delete(key);
  }
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    cleanup();

    const clientIp = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
    if (!checkRateLimit(clientIp)) {
      return new Response(JSON.stringify({ error: 'Rate limit exceeded. Try again in a minute.' }), {
        status: 429, headers: { ...corsHeaders, 'Content-Type': 'application/json', 'Retry-After': '60' },
      });
    }

    const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY');
    if (!ANTHROPIC_API_KEY) {
      return new Response(JSON.stringify({ error: 'ANTHROPIC_API_KEY not configured' }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const body = await req.json();
    const { model, max_tokens, messages, system, tools, no_cache } = body;

    const anthropicBody: Record<string, unknown> = {
      model: model || 'claude-haiku-4-5-20251001',
      max_tokens: max_tokens || 800,
      messages,
    };
    if (system) anthropicBody.system = system;
    if (tools) anthropicBody.tools = tools;

    // Check cache (skip for tool-use requests or explicit no_cache)
    const cacheKey = hashKey(anthropicBody);
    if (!no_cache && !tools) {
      const cached = cache.get(cacheKey);
      if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
        return new Response(JSON.stringify(cached.data), {
          status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json', 'X-Cache': 'HIT' },
        });
      }
    }

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(anthropicBody),
    });

    const data = await res.json();

    if (!res.ok) {
      console.error('Anthropic API error:', res.status, JSON.stringify(data));
      return new Response(JSON.stringify({ error: `Anthropic API error: ${res.status}`, details: data }), {
        status: res.status, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Cache successful non-tool responses
    if (!tools) {
      cache.set(cacheKey, { data, timestamp: Date.now() });
    }

    return new Response(JSON.stringify(data), {
      status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json', 'X-Cache': 'MISS' },
    });
  } catch (e) {
    console.error('Proxy error:', e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : 'Unknown error' }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
