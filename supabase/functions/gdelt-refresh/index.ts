import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const GDELT_URL =
  'https://api.gdeltproject.org/api/v2/doc/doc?query=Saudi+Arabia+OR+GCC+OR+Yemen+conflict&mode=artlist&maxrecords=10&format=json&timespan=24h';

interface GdeltArticle {
  title: string;
  url: string;
  domain: string;
  seendate: string;
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
    const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      return new Response(JSON.stringify({ error: 'Missing env vars' }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    // Fetch GDELT article list
    console.log('[gdelt] Fetching articles...');
    const res = await fetch(GDELT_URL);
    if (!res.ok) {
      throw new Error(`GDELT ${res.status}: ${await res.text()}`);
    }

    const data = await res.json();
    const articles: GdeltArticle[] = data?.articles ?? [];

    const top5 = articles.slice(0, 5).map((a) => ({
      title: a.title,
      url: a.url,
      source: a.domain,
      date: a.seendate,
    }));

    const payload = {
      count: articles.length,
      articles: top5,
      updatedAt: new Date().toISOString(),
    };

    console.log(`[gdelt] Fetched ${articles.length} articles, upserting...`);

    const { error } = await supabase
      .from('ai_cache')
      .upsert(
        { key: 'gdelt_articles', data: payload, updated_at: new Date().toISOString() },
        { onConflict: 'key' },
      );

    if (error) throw new Error(`DB upsert: ${error.message}`);

    console.log('[gdelt] ✓ cached');

    return new Response(JSON.stringify({ success: true, count: articles.length }), {
      status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (e) {
    console.error('[gdelt] Error:', e);
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : 'Unknown error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }
});
