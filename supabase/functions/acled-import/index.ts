import { createClient } from "https://esm.sh/@supabase/supabase-js@2.98.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
      else { inQuotes = !inQuotes; }
    } else if (char === ',' && !inQuotes) {
      result.push(current); current = '';
    } else { current += char; }
  }
  result.push(current);
  return result;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(supabaseUrl, serviceKey);

  // Check if data already exists
  const { count } = await supabase.from("acled_events").select("*", { count: "exact", head: true });
  if (count && count > 0) {
    return new Response(JSON.stringify({ success: true, total: count, message: "Data already loaded" }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const csvText = await req.text();
  const lines = csvText.split('\n').filter(l => l.trim());
  if (lines.length < 2) {
    return new Response(JSON.stringify({ error: "No data rows" }), {
      status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const headers = parseCSVLine(lines[0]);
  const headerIdx: Record<string, number> = {};
  headers.forEach((h, i) => { headerIdx[h.trim()] = i; });

  const rows: any[] = [];
  for (let i = 1; i < lines.length; i++) {
    const fields = parseCSVLine(lines[i]);
    if (fields.length < 10) continue;
    const get = (name: string) => { const v = fields[headerIdx[name]]; return v?.trim() || null; };
    const row = {
      event_id_cnty: get("event_id_cnty"),
      event_date: get("event_date"),
      year: get("year") ? parseInt(get("year")!) : null,
      disorder_type: get("disorder_type"),
      event_type: get("event_type"),
      sub_event_type: get("sub_event_type"),
      actor1: get("actor1"),
      actor2: get("actor2"),
      country: get("country"),
      admin1: get("admin1"),
      location: get("location"),
      latitude: get("latitude") ? parseFloat(get("latitude")!) : null,
      longitude: get("longitude") ? parseFloat(get("longitude")!) : null,
      fatalities: get("fatalities") ? parseInt(get("fatalities")!) : 0,
      notes: get("notes"),
      source: get("source"),
      population_best: get("population_best") ? parseFloat(get("population_best")!) : null,
      timestamp: get("timestamp") ? parseInt(get("timestamp")!) : null,
    };
    if (row.event_id_cnty) rows.push(row);
  }

  let total = 0;
  for (let i = 0; i < rows.length; i += 100) {
    const batch = rows.slice(i, i + 100);
    const { error } = await supabase.from("acled_events").upsert(batch, { onConflict: "event_id_cnty" });
    if (error) {
      return new Response(JSON.stringify({ error: error.message, total }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    total += batch.length;
  }

  return new Response(JSON.stringify({ success: true, total }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
