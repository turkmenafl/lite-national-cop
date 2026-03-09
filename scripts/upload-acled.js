import { createClient } from "@supabase/supabase-js";
import { parse } from "csv-parse";
import { createReadStream, readdirSync, statSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join, resolve } from "path";
import dotenv from "dotenv";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load .env — walk up from worktree root to find it
for (const rel of ["../.env", "../../.env", "../../../.env", ".env"]) {
  dotenv.config({ path: resolve(__dirname, rel) });
}

// Auto-detect newest ACLED CSV in src/data/
const DATA_DIR = join(__dirname, "../src/data");
const acledFiles = readdirSync(DATA_DIR)
  .filter(f => f.startsWith("ACLED") && f.endsWith(".csv"))
  .map(f => ({ name: f, mtime: statSync(join(DATA_DIR, f)).mtimeMs }))
  .sort((a, b) => b.mtime - a.mtime);

if (!acledFiles.length) {
  console.error("No ACLED CSV found in src/data/");
  process.exit(1);
}

const CSV_PATH = join(DATA_DIR, acledFiles[0].name);
console.log(`Detected ACLED file: ${acledFiles[0].name}`);

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("Missing env vars. Set SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in .env");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

function mapRow(r) {
  return {
    event_id_cnty:   r.event_id_cnty,
    event_date:      r.event_date || null,
    year:            r.year ? parseInt(r.year) : null,
    disorder_type:   r.disorder_type || null,
    event_type:      r.event_type || null,
    sub_event_type:  r.sub_event_type || null,
    actor1:          r.actor1 || null,
    actor2:          r.actor2 || null,
    country:         r.country || null,
    admin1:          r.admin1 || null,
    location:        r.location || null,
    latitude:        r.latitude ? parseFloat(r.latitude) : null,
    longitude:       r.longitude ? parseFloat(r.longitude) : null,
    fatalities:      r.fatalities ? parseInt(r.fatalities) : 0,
    notes:           r.notes || null,
    source:          r.source || null,
    population_best: r.population_best ? parseFloat(r.population_best) : null,
    timestamp:       r.timestamp ? parseInt(r.timestamp) : null,
  };
}

async function upsertBatch(rows) {
  const { error } = await supabase
    .from("acled_events")
    .upsert(rows, { onConflict: "event_id_cnty" });
  if (error) throw error;
}

async function main() {
  const rows = [];

  await new Promise((resolve, reject) => {
    createReadStream(CSV_PATH)
      .pipe(parse({ columns: true, skip_empty_lines: true, trim: true }))
      .on("data", (row) => rows.push(mapRow(row)))
      .on("end", resolve)
      .on("error", reject);
  });

  console.log(`Parsed ${rows.length} rows. Uploading in batches of 100...`);

  let total = 0;
  for (let i = 0; i < rows.length; i += 100) {
    const batch = rows.slice(i, i + 100);
    await upsertBatch(batch);
    total += batch.length;
    console.log(`Uploaded ${total}/${rows.length} rows`);
  }

  // Verify KSA count
  const { count, error } = await supabase
    .from("acled_events")
    .select("*", { count: "exact", head: true })
    .eq("country", "Saudi Arabia");

  if (error) {
    console.error("Count query failed:", error.message);
  } else {
    console.log(`\nDone. Total rows: ${total}. KSA events in DB: ${count}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
