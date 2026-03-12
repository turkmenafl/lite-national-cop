#!/usr/bin/env node
// ── DEPRECATED — 12 Mar 2026 ──────────────────────────────────────────
// This script targeted the old GCC_AI_WEB_NUMBERS block in NEMACOPLive.jsx.
// GCC_STRIKE_DATA_v2.js is now the single source of truth for all projectile
// display values. Do NOT run this script until it is rewritten to target v2.
// See: src/data/GCC_STRIKE_DATA_v2.js
// ─────────────────────────────────────────────────────────────────────────

/**
 * Run the AI_WEB (gcc_strikes) Edge Function for all countries, then read
 * the result from ai_cache and write it into GCC_AI_WEB_NUMBERS in NEMACOPLive.jsx.
 *
 * Usage (from project root):
 *   node scripts/fetch-gcc-ai-web-numbers.mjs
 *
 * Requires .env with VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.
 */

import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

function loadEnv() {
  for (const p of [join(root, '.env'), join(root, '.env.local'), join(root, '..', '.env')]) {
    try {
      const raw = readFileSync(p, 'utf8');
      for (const line of raw.split('\n')) {
        const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
        if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
      }
      break;
    } catch (_) {}
  }
}
loadEnv();

const SUPABASE_URL = process.env.VITE_SUPABASE_URL?.replace(/\/$/, '');
const ANON_KEY = process.env.VITE_SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_PUBLISHABLE_KEY;

const COUNTRY_ORDER = ['SA', 'AE', 'KW', 'BH', 'QA', 'OM', 'IL', 'IQ', 'JO', 'SY', 'LB', 'YE', 'IR'];

function fmt(val) {
  if (val == null) return 'null';
  if (typeof val === 'number') return String(val);
  return `"${String(val).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function formatOne(code, o, isLast) {
  const inc = o?.total_incoming ?? null;
  const int = o?.total_intercepted ?? null;
  const src = (o?.source ?? '').trim();
  const conf = (o?.confidence ?? 'EST').trim();
  const note = (o?.note ?? '').trim();
  const comma = isLast ? '' : ',';
  return `  ${code}:  { total_incoming: ${inc ?? 'null'},   total_intercepted: ${int ?? 'null'},   source: ${fmt(src)}, confidence: ${fmt(conf)}, note: ${fmt(note)} }${comma}`;
}

async function main() {
  if (!SUPABASE_URL || !ANON_KEY) {
    console.error('Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY in .env');
    process.exit(1);
  }

  const functionsUrl = `${SUPABASE_URL}/functions/v1/ai-cache-refresh`;
  console.log('Calling ai-cache-refresh with keys=gcc_strikes&force=1...');
  const res = await fetch(`${functionsUrl}?keys=gcc_strikes&force=1`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${ANON_KEY}`,
      'Content-Type': 'application/json',
    },
  });

  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error('Edge Function error:', res.status, body);
    process.exit(1);
  }
  if (body.error) {
    console.error('Edge Function returned error:', body.error);
    process.exit(1);
  }
  if (body.results?.gcc_strikes?.error) {
    console.error('gcc_strikes feed error:', body.results.gcc_strikes.error);
    process.exit(1);
  }
  console.log('Refresh result:', body.results?.gcc_strikes || body);

  const restUrl = `${SUPABASE_URL}/rest/v1/ai_cache?key=eq.gcc_strikes&select=data`;
  const restRes = await fetch(restUrl, {
    method: 'GET',
    headers: {
      apikey: ANON_KEY,
      Authorization: `Bearer ${ANON_KEY}`,
      Accept: 'application/json',
    },
  });
  if (!restRes.ok) {
    console.error('Failed to read ai_cache:', restRes.status, await restRes.text());
    process.exit(1);
  }
  const rows = await restRes.json();
  const row = Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
  if (!row?.data) {
    console.error('No gcc_strikes data in ai_cache');
    process.exit(1);
  }

  const gcc = row.data;
  const lines = [
    '// ─── AI+WEB numbers: single source for country popup (projectiles in/out, note). Update here for client-facing display when cache is stale.',
    'const GCC_AI_WEB_NUMBERS = {',
    ...COUNTRY_ORDER.map((code, i) => formatOne(code, gcc[code], i === COUNTRY_ORDER.length - 1)),
    '};',
  ];
  const block = lines.join('\n');

  const jsxPath = join(root, 'src', 'components', 'NEMACOPLive.jsx');
  let jsx = readFileSync(jsxPath, 'utf8');

  const startMarker = '// ─── AI+WEB numbers: single source for country popup';
  const endMarker = '};';
  const startIdx = jsx.indexOf(startMarker);
  if (startIdx === -1) {
    console.error('Could not find GCC_AI_WEB_NUMBERS block in NEMACOPLive.jsx');
    console.log('\n--- Paste this into NEMACOPLive.jsx (replace the GCC_AI_WEB_NUMBERS block) ---\n');
    console.log(block);
    process.exit(1);
  }

  const afterStart = jsx.slice(startIdx);
  const endOfBlock = afterStart.indexOf('\nconst GCC_FALLBACK');
  if (endOfBlock === -1) {
    console.error('Could not find end of GCC_AI_WEB_NUMBERS block');
    console.log('\n--- Paste this manually ---\n');
    console.log(block);
    process.exit(1);
  }

  const newJsx =
    jsx.slice(0, startIdx) +
    block +
    '\n' +
    jsx.slice(startIdx + endOfBlock);
  writeFileSync(jsxPath, newJsx, 'utf8');

  console.log('\nUpdated GCC_AI_WEB_NUMBERS in src/components/NEMACOPLive.jsx with AI_WEB data for all countries.');
  console.log('Countries:', COUNTRY_ORDER.join(', '));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
