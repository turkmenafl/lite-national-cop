import { useState, useEffect, useCallback, useRef, memo } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { supabase } from "@/integrations/supabase/client";

const ANTHROPIC_PROXY_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/anthropic-proxy`;

// Helper: call an async fn with retry on 429
async function withRetry(fn, maxRetries = 2, baseDelay = 15000) {
  for (let i = 0; i <= maxRetries; i++) {
    try { return await fn(); } catch (e) {
      if (i < maxRetries && e?.message?.includes("429")) {
        console.warn(`[AI] 429 rate limit, retry ${i+1} in ${baseDelay*(i+1)/1000}s`);
        await new Promise(r => setTimeout(r, baseDelay * (i + 1)));
      } else { throw e; }
    }
  }
}
// Delay helper
const delay = ms => new Promise(r => setTimeout(r, ms));
const AI_GAP = 15000; // 15s gap between AI calls to stay under 30k tokens/min
let _refreshLock = false; // module-level lock to prevent concurrent refreshes

const CSS = `
  @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700&display=swap');
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body, #root { background: #060b17; color: #d8e6f5; font-family: 'JetBrains Mono','SF Mono','Fira Code',monospace; -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale; }
  @keyframes cop-pulse { 0%,100%{opacity:1} 50%{opacity:0.35} }
  @keyframes strike-pulse { 0%{transform:scale(1);opacity:0.9} 50%{transform:scale(2.2);opacity:0} 100%{transform:scale(1);opacity:0} }
  .strike-ping { position:absolute; border-radius:50%; animation: strike-pulse 2s ease-out infinite; }
  .leaflet-container { background: #060b17 !important; }
  .leaflet-control-attribution { display: none !important; }
  .cop-popup .leaflet-popup-tip-container { display: none !important; }
  .cop-popup .leaflet-popup-content-wrapper { background: #0d1a2e; border: 1px solid #273248; border-radius: 6px; padding: 0; box-shadow: 0 4px 20px rgba(0,0,0,0.4); }
  .cop-popup .leaflet-popup-content { margin: 0; padding: 12px; font-family: 'JetBrains Mono', monospace; color: #d8e6f5; font-size: 9px; max-width: 280px; }
  .cop-popup .leaflet-popup-close-button { color: #7d8fa3 !important; font-size: 16px !important; top: 6px !important; right: 8px !important; }
  .cop-pulse { animation: cop-pulse 1.5s ease-in-out infinite; }
  @keyframes cop-fade-in { from { opacity:0; transform: translateY(4px); } to { opacity:1; transform: translateY(0); } }
  .cop-fade-in { animation: cop-fade-in 0.25s ease-out; }
  ::-webkit-scrollbar { width: 5px; }
  ::-webkit-scrollbar-track { background: #0a1220; }
  ::-webkit-scrollbar-thumb { background: #1e2d42; border-radius: 6px; }
  ::-webkit-scrollbar-thumb:hover { background: #2a3d56; }
  button { transition: all 0.15s ease; }
  button:hover { filter: brightness(1.15); }
`;
const C = {
  bg:'#060b17', surface:'#192233', surfBorder:'#273248',
  critical:'#ef4444', warning:'#f59e0b', success:'#22c55e', info:'#3b82f6',
  muted:'#7d8fa3', dim:'#526175', fg:'#d8e6f5',
};

// ─── DATA ─────────────────────────────────────────────────────────────────────
const GCC_SEED = [
  { code:"SA", name:"🇸🇦 KSA",     airspace:"RESTRICTED", strikes:19,   interceptPct:96, confidence:"CONFIRMED", source:"Saudi MoD spokesman",     note:"96% intercept. Ras Tanura degraded. Abqaiq near-miss Mar 4.", daily:[3,2,1,2,3,3,5] },
  { code:"AE", name:"🇦🇪 UAE",     airspace:"RESTRICTED", strikes:1276, interceptPct:92, confidence:"CONFIRMED", source:"UAE MoD press conference",  note:"Jebel Ali + Dubai T3 + French base hit.", daily:[120,145,160,185,200,220,246] },
  { code:"QA", name:"🇶🇦 Qatar",   airspace:"CLOSED",     strikes:115,  interceptPct:90, confidence:"EST",       source:"CTP-ISW / LWJ",             note:"Al Udeid 2 BM impacts. LNG suspended.", daily:[8,10,14,18,20,22,23] },
  { code:"KW", name:"🇰🇼 Kuwait",  airspace:"RESTRICTED", strikes:484,  interceptPct:88, confidence:"EST",       source:"KUNA / US DoD",             note:"Ali Al Salem struck. US Embassy hit.", daily:[45,55,62,70,78,85,89] },
  { code:"BH", name:"🇧🇭 Bahrain", airspace:"RESTRICTED", strikes:198,  interceptPct:85, confidence:"EST",       source:"NAVCENT / Alma Research",   note:"5th Fleet HQ struck. Bapco refinery hit.", daily:[18,22,25,28,32,35,38] },
  { code:"OM", name:"🇴🇲 Oman",    airspace:"OPEN",       strikes:4,    interceptPct:50, confidence:"EST",       source:"ONA / Reuters",             note:"Duqm Port drone. Mediator status.", daily:[0,0,0,1,1,1,1] },
];

function makeSparklineSvg(daily, color) {
  const w = 240, h = 36, pad = 2;
  const max = Math.max(...daily, 1);
  const pts = daily.map((v, i) => {
    const x = pad + (i / (daily.length - 1)) * (w - pad * 2);
    const y = h - pad - (v / max) * (h - pad * 2);
    return `${x},${y}`;
  });
  const fillPts = [pts[0].split(",")[0] + "," + (h - pad), ...pts, pts[pts.length - 1].split(",")[0] + "," + (h - pad)].join(" ");
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" style="display:block;margin:6px 0 2px 0">
    <polygon points="${fillPts}" fill="${color}15" />
    <polyline points="${pts.join(" ")}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
    ${daily.map((v, i) => {
      const x = pad + (i / (daily.length - 1)) * (w - pad * 2);
      const y = h - pad - (v / max) * (h - pad * 2);
      return i === daily.length - 1 ? `<circle cx="${x}" cy="${y}" r="2.5" fill="${color}"/>` : "";
    }).join("")}
    <text x="${pad}" y="${h - 1}" fill="#526175" font-size="6" font-family="JetBrains Mono">Feb 28</text>
    <text x="${w - pad}" y="${h - 1}" fill="#526175" font-size="6" font-family="JetBrains Mono" text-anchor="end">Mar 07</text>
  </svg>`
}

const STRIKES_KSA = [
  { id:1,  time:"Mar 07 09:30", type:"Ballistic Missile", loc:"Abqaiq vicinity — 2nd attempt",       status:"Intercepted",               sev:"critical", day:"Mar 07", wep:"Ballistic", lat:25.94, lng:49.68 },
  { id:2,  time:"Mar 07 01:15", type:"Drone (6x)",        loc:"Ras Tanura 3rd attempt",              status:"Intercepted — 1 shrapnel hit", sev:"critical", day:"Mar 07", wep:"Drone",     lat:26.64, lng:50.16 },
  { id:3,  time:"Mar 06 14:20", type:"Cruise Missile",    loc:"Riyadh airspace",                     status:"Intercepted",               sev:"high",     day:"Mar 06", wep:"Cruise",    lat:24.69, lng:46.63 },
  { id:4,  time:"Mar 06 03:45", type:"Ballistic Missile", loc:"Eastern Province — Al-Kharj corridor",status:"Intercepted",               sev:"critical", day:"Mar 06", wep:"Ballistic", lat:24.15, lng:47.30 },
  { id:5,  time:"Mar 05 22:10", type:"Drone (2x)",        loc:"Jubail Industrial City",              status:"Intercepted",               sev:"high",     day:"Mar 05", wep:"Drone",     lat:27.00, lng:49.66 },
  { id:6,  time:"Mar 04 04:15", type:"Drone (4x)",        loc:"Yanbu Port / Refinery",               status:"Intercepted",               sev:"high",     day:"Mar 04", wep:"Drone",     lat:24.06, lng:38.06 },
  { id:7,  time:"Mar 04 01:30", type:"Ballistic Missile", loc:"Abqaiq Processing vicinity",          status:"Intercepted",               sev:"critical", day:"Mar 04", wep:"Ballistic", lat:25.94, lng:49.68 },
  { id:8,  time:"Mar 03 19:20", type:"Drone (3x)",        loc:"Riyadh — Embassy area",               status:"Intercepted",               sev:"high",     day:"Mar 03", wep:"Drone",     lat:24.69, lng:46.63 },
  { id:9,  time:"Mar 03 06:45", type:"Cruise Missile",    loc:"Eastern Province Oil Infra",          status:"Intercepted",               sev:"critical", day:"Mar 03", wep:"Cruise",    lat:26.64, lng:50.16 },
  { id:10, time:"Mar 02 14:00", type:"Drone (9x)",        loc:"KSA Airspace — multi-vector",         status:"All destroyed",             sev:"high",     day:"Mar 02", wep:"Drone",     lat:24.50, lng:45.00 },
  { id:11, time:"Mar 01 08:40", type:"Drone (2x)",        loc:"Diplomatic Quarter 2nd wave",         status:"Hit — property damage",     sev:"high",     day:"Mar 01", wep:"Drone",     lat:24.67, lng:46.69 },
  { id:12, time:"Mar 01 03:15", type:"Drone (2x)",        loc:"US Embassy — Riyadh",                 status:"Hit — fire, 0 KIA",         sev:"critical", day:"Mar 01", wep:"Drone",     lat:24.69, lng:46.63 },
  { id:13, time:"Feb 28 15:10", type:"Drone (5x)",        loc:"Ras Tanura Oil Terminal",             status:"Intercepted — shrapnel",    sev:"critical", day:"Feb 28", wep:"Drone",     lat:26.64, lng:50.16 },
  { id:14, time:"Feb 28 14:35", type:"Ballistic Missile", loc:"King Abdulaziz Air Base, EP",         status:"Intercepted",               sev:"high",     day:"Feb 28", wep:"Ballistic", lat:26.27, lng:50.15 },
  { id:15, time:"Feb 28 14:20", type:"Ballistic Missile", loc:"Riyadh — Diplomatic Quarter",         status:"Intercepted",               sev:"high",     day:"Feb 28", wep:"Ballistic", lat:24.69, lng:46.63 },
];

const CI_SECTORS = [
  { name:"Oil & Gas",        icon:"⬢", status:"DEGRADED",    pct:82, feed:"GDELT",  note:"Ras Tanura 85% cap. Abqaiq near-miss Mar 4." },
  { name:"Airports",         icon:"✈", status:"RESTRICTED",  pct:60, feed:"GDELT",  note:"RUH 42%. DMM 33%. JED 112% (overflow)." },
  { name:"Ports & Maritime", icon:"⚓", status:"DISRUPTED",   pct:45, feed:"STATIC", note:"Hormuz D7 — 0 transits. ~91 tankers holding." },
  { name:"Power Grid",       icon:"⚡", status:"ELEVATED",    pct:88, feed:"STATIC", note:"Eastern Province proximity threat." },
  { name:"Water / Desal",    icon:"💧", status:"OPERATIONAL", pct:90, feed:"STATIC", note:"Jubail RO on elevated watch." },
  { name:"Telecom & Cyber",  icon:"📡", status:"ELEVATED",    pct:73, feed:"IODA",   note:"APT33 activity. AWS Gulf degraded." },
];

// Risk Clusters — badges STATIC per handover decision (live signals appear inline as evidence only)
const CLUSTERS = [
  {
    id:"nat", label:"Natural", icon:"🌊", color:"#22c55e", status:"CLEAR", risks:1, active:0, elevated:0,
    agencies:["PME","Civil Defense","SWCC","Aramco"],
    decisions:[],
    riskItems:[{
      id:"N11", name:"Marine oil spill / coastal contamination", severity:"medium", status:"monitoring",
      badge:"STATIC",
      detail:"Ras Tanura shrapnel damage increases spill risk. Containment booms on standby. Desal intake vulnerability monitored.",
      liveSignals:[], sources:["ACLED+SPA (trigger)","NASA FIRMS (3h)","PortWatch (tanker)","GDELT (news)"],
    }],
  },
  {
    id:"hlth", label:"Health", icon:"🏥", color:"#f59e0b", status:"ELEVATED", risks:1, active:0, elevated:1,
    agencies:["MoH","Red Crescent"],
    decisions:[{ title:"Hospital surge protocol activation", window:"72h", severity:"medium" }],
    riskItems:[{
      id:"H1", name:"Human disease outbreak", severity:"high", status:"elevated",
      badge:"STATIC",
      detail:"Gulf port closures reduce pharmaceutical imports. Medical supply reserve at 55% (30 days). Monitoring for conflict-related disease vectors.",
      liveSignals:[], sources:["ProMED-mail (real-time)","WHO DON (daily)","Saudi MoH via SPA"],
    }],
  },
  {
    id:"infra", label:"Infrastructure", icon:"⬡", color:"#ef4444", status:"CRITICAL", risks:5, active:2, elevated:1,
    agencies:["SEC","SWCC","Civil Defense","GACA","Ports Authority","CITC"],
    decisions:[
      { title:"Deploy containment booms — Jubail Desal intake", window:"6h",  severity:"critical" },
      { title:"Emergency medical procurement via Jeddah",        window:"48h", severity:"critical" },
      { title:"Cloud migration from AWS Gulf",                   window:"72h", severity:"medium" },
    ],
    riskItems:[
      { id:"I1", name:"CNI failure [age/human error]", severity:"high", status:"monitoring",
        badge:"IODA",
        detail:"Monitoring KSA internet for non-strike disruptions. STC/Mobily/SEC service status tracked.",
        liveSignals:[{ label:"IODA KSA BGP", key:"ioda", render:(live)=>live.ioda.value!==null?`${live.ioda.value}% baseline`:"N/A", color:(live)=>live.ioda.value!==null&&live.ioda.value<80?C.critical:C.success }],
        sources:["IODA (real-time)","Downdetector (STC/Mobily)"],
      },
      { id:"I5", name:"Industrial fire", severity:"medium", status:"monitoring",
        badge:"STATIC",
        detail:"Monitoring industrial zones for non-strike fires. FIRMS satellite feeds checked against CI coordinates.",
        liveSignals:[], sources:["NASA FIRMS (3h) — CORS-blocked in artifact"],
      },
      { id:"I6", name:"Transportation incidents", severity:"high", status:"active",
        badge:"STATIC",
        detail:"Port and airport disruption from military ops. DMM 33%, RUH 42%. Eastern ports restricted.",
        liveSignals:[], sources:["PortWatch (weekly)","Flightradar24 (real-time)","NOTAM feeds"],
      },
      { id:"I7", name:"Food supply disruption", severity:"high", status:"elevated",
        badge:"STATIC",
        detail:"Gulf port closures reducing food imports. Wheat reserves 45 days. Jeddah port compensating (+18%).",
        liveSignals:[], sources:["PortWatch (weekly)","Yahoo Finance ZW=F"],
      },
      { id:"I8", name:"Fuel & gas supply disruption", severity:"critical", status:"active",
        badge:"AI+WEB",
        detail:"Hormuz closure Day 7. KSA production disrupted by infrastructure damage.",
        liveSignals:[{ label:"Brent Crude", key:"brent", render:(live)=>live.brent.value, color:()=>C.warning }],
        sources:["Yahoo Finance BZ=F (AI+WEB)","PortWatch","EIA"],
      },
    ],
  },
  {
    id:"sec", label:"Security", icon:"⊕", color:"#ef4444", status:"CRITICAL", risks:4, active:3, elevated:1,
    agencies:["MoD","SANG","Border Guard","NCA","State Security"],
    decisions:[
      { title:"Abqaiq perimeter reinforcement",              window:"24h", severity:"high" },
      { title:"Activate Houthi contingency (Red Sea route)", window:"48h", severity:"high" },
    ],
    riskItems:[
      { id:"S1", name:"Physical attack on CNI", severity:"critical", status:"active",
        badge:"AI+WEB",
        detail:"19 strikes Day 1-7. 96% intercept rate. Targeting military bases and oil infrastructure.",
        liveSignals:[{ label:"GCC strikes", key:"gcc", render:(live)=>live.gcc.data?`KSA: ${live.gcc.data.SA?.total||19} strikes`:`19 strikes (seed)`, color:()=>C.critical }],
        sources:["ACLED (daily)","LiveuaMap (real-time)","Saudi MoD via SPA"],
      },
      { id:"S2", name:"UAV attacks", severity:"critical", status:"active",
        badge:"AI+WEB",
        detail:"Coordinated drone waves. Ras Tanura and DQ targeted.",
        liveSignals:[{ label:"GCC strikes", key:"gcc", render:(live)=>live.gcc.data?`✓ sourced`:"seed", color:(live)=>live.gcc.data?C.success:C.dim }],
        sources:["ACLED (drone)","Alma","Saudi MoD via SPA"],
      },
      { id:"S3", name:"Maritime & air route restrictions", severity:"high", status:"elevated",
        badge:"STATIC",
        detail:"Hormuz closed Day 7. Bab al-Mandeb at 80% baseline. Houthi quiet but risk remains.",
        liveSignals:[], sources:["PortWatch (weekly)","gCaptain (real-time)","NOTAM feeds","UK MITO"],
      },
      { id:"S5", name:"Missile attack", severity:"critical", status:"active",
        badge:"AI+WEB",
        detail:"Ballistic and cruise missile attacks ongoing. Multiple vectors. 96% intercept rate.",
        liveSignals:[{ label:"GCC strikes", key:"gcc", render:(live)=>live.gcc.data?`KSA: ${live.gcc.data.SA?.intercept_pct||96}% intercept`:"96% intercept (seed)", color:()=>C.success }],
        sources:["ACLED (daily)","INSS","Saudi MoD via SPA"],
      },
    ],
  },
  {
    id:"socio", label:"Socioeconomic", icon:"◈", color:"#ef4444", status:"CRITICAL", risks:3, active:2, elevated:1,
    agencies:["MoFA","SAMA","MoC","SAGO"],
    decisions:[
      { title:"Corrective media messaging — 'Saudi strikes imminent' narrative", window:"12h", severity:"high" },
      { title:"Fuel reserve release policy confirmation",                         window:"48h", severity:"medium" },
    ],
    riskItems:[
      { id:"E1", name:"Import/export disruption", severity:"critical", status:"active",
        badge:"STATIC",
        detail:"Hormuz closure Day 7. Gulf-side ports -60%. Jeddah compensating partially. ~$4.3B revenue lost.",
        liveSignals:[], sources:["PortWatch (weekly) — CORS-blocked","gCaptain (real-time)"],
      },
      { id:"E2", name:"Financial system crises", severity:"high", status:"elevated",
        badge:"AI+WEB",
        detail:"TASI volatile. Brent at $98+. SAR peg stable but monitoring capital flows.",
        liveSignals:[
          { label:"Brent",  key:"brent", render:(live)=>live.brent.value, color:()=>C.warning },
          { label:"TASI",   key:"tasi",  render:(live)=>live.tasi.value,  color:()=>C.warning },
        ],
        sources:["Yahoo Finance (AI+WEB)","SAMA"],
      },
      { id:"E3", name:"Media & disinformation", severity:"high", status:"active",
        badge:"GDELT",
        detail:"False narratives spreading — 'Saudi strikes imminent'. Iranian state media amplifying. Requires corrective messaging within 12h.",
        liveSignals:[{ label:"GDELT/24h", key:"gdelt", render:(live)=>live.gdelt.loading?"…":`${live.gdelt.value} articles`, color:(live)=>live.gdelt.value>15?C.critical:C.warning }],
        sources:["GDELT (15min)","UANI (daily)","Claude API"],
      },
    ],
  },
];

const RESERVES = [
  { name:"Strategic Petroleum Reserve", days:90, pct:95, conf:"70-89", status:"ADEQUATE",   color:"#22c55e" },
  { name:"Food Reserves (Wheat/Rice)",  days:45, pct:72, conf:"50-69", status:"ADEQUATE",   color:"#22c55e" },
  { name:"Fuel (Domestic Distribution)",days:60, pct:80, conf:"50-69", status:"ADEQUATE",   color:"#22c55e" },
  { name:"Medical Supplies",            days:30, pct:55, conf:"50-69", status:"ATTENTION",  color:"#f59e0b" },
  { name:"Desalination Chemicals",      days:21, pct:48, conf:"50-69", status:"ATTENTION",  color:"#f59e0b" },
  { name:"Emergency Shelters",          days:null,pct:0, conf:"<50",   status:"UNKNOWN",    color:"#64748b" },
];

const SCENARIOS = [
  { name:"Most Likely",    prob:"55%", desc:"Continued drone/missile probes 2-4/day. Cyber intensifies. No KSA offensive.",                      color:"#f59e0b" },
  { name:"Most Dangerous", prob:"20%", desc:"Hormuz mining + coordinated Abqaiq strike + banking/water cyber attack.",                            color:"#ef4444" },
  { name:"De-escalation",  prob:"25%", desc:"Ceasefire via Oman channel. Hormuz partial reopening 48-72h.",                                      color:"#22c55e" },
];

const SEVERITY_FACTORS = {
  ciAffected:  { weight:0.25, value:3, max:5, label:"CI Assets Affected",   detail:"1 Tier-1 degraded + 2 Tier-2 restricted" },
  population:  { weight:0.20, value:1, max:5, label:"Population Impacted",  detail:"0 casualties, ~12K expat departures" },
  cascade:     { weight:0.20, value:2, max:5, label:"Cascade Chain",        detail:"Power→desal identified — NOT activated" },
  chokepoint:  { weight:0.15, value:4, max:5, label:"Chokepoint Impact",    detail:"Hormuz closed + airspace restricted" },
  escalation:  { weight:0.10, value:3, max:5, label:"Escalation Trajectory",detail:"+3 strikes/24h, rising" },
  strategic:   { weight:0.10, value:4, max:5, label:"Strategic/Diplomatic", detail:"Regional multi-state conflict" },
};
const severityScore = Math.round(Object.values(SEVERITY_FACTORS).reduce((s,f)=>s+f.value*f.weight,0)*20);
const severityLabel = { L1:"Minor", L2:"Localized", L3:"Significant", L4:"Major", L5:"National Catastrophe" };
const severityLevel = severityScore<=20?"L1":severityScore<=40?"L2":severityScore<=60?"L3":severityScore<=80?"L4":"L5";
const severityColor = severityScore<=40?"#22c55e":severityScore<=60?"#f59e0b":"#ef4444";

// ─── UI ATOMS ─────────────────────────────────────────────────────────────────
const FeedTag = ({ feed, loading }) => {
  if (loading) return <span style={{ fontSize:10, padding:"3px 8px", borderRadius:4, background:"rgba(59,130,246,0.15)", color:C.info, letterSpacing:"0.04em" }} className="cop-pulse">●</span>;
  const map = { "AI+WEB":[C.success,"AI+WEB"], LIVE:[C.success,"LIVE"], CONFIRMED:[C.success,"CONFIRMED"], EST:["#f97316","EST"], GDELT:[C.warning,"GDELT"], STATIC:[C.dim,"STATIC"], IODA:[C.info,"IODA"] };
  const [col, lbl] = map[feed] || [C.muted, feed];
  return <span style={{ fontSize:10, padding:"3px 8px", borderRadius:4, background:`${col}18`, color:col, letterSpacing:"0.04em", fontWeight:500 }}>{lbl}</span>;
};

const StatusBadge = ({ s }) => {
  const map = { DEGRADED:C.critical, RESTRICTED:C.warning, DISRUPTED:"#f97316", ELEVATED:C.warning, OPERATIONAL:C.success, CRITICAL:C.critical, CLOSED:C.critical, OPEN:C.success, CLEAR:C.success, ATTENTION:"#f59e0b", ADEQUATE:C.success, UNKNOWN:"#64748b" };
  const col = map[s] || C.muted;
  return <span style={{ fontSize:11, padding:"3px 10px", borderRadius:4, background:`${col}14`, color:col, border:`1px solid ${col}28`, fontWeight:600, letterSpacing:"0.05em" }}>{s}</span>;
};

const KpiCard = ({ label, value, change, color, note, feed, loading, secondary, secondaryColor }) => (
  <div style={{ flex:1, padding:"12px 14px", background:C.surface, border:`1px solid ${C.surfBorder}`, borderRadius:6, textAlign:"center", minWidth:100, boxShadow:"0 2px 8px rgba(0,0,0,0.2)" }}>
    <div style={{ fontSize:10, color:C.muted, letterSpacing:"0.08em", marginBottom:4, textTransform:"uppercase", fontWeight:500 }}>{label}</div>
    {loading
      ? <div style={{ fontSize:20, fontWeight:700, color:C.info, marginBottom:4 }} className="cop-pulse">…</div>
      : <div style={{ fontSize:22, fontWeight:700, color:color||C.fg, marginBottom:4, lineHeight:1.1 }}>{value}</div>
    }
    {secondary && !loading && <div style={{ fontSize:9, color:secondaryColor||C.warning, fontWeight:600, marginBottom:4, lineHeight:1.2 }}>{secondary}</div>}
    <div style={{ display:"flex", justifyContent:"center", gap:5, alignItems:"center", flexWrap:"wrap" }}>
      {(change||note) && <span style={{ fontSize:10, color:C.dim }}>{change||note}</span>}
      <FeedTag feed={feed} loading={loading} />
    </div>
  </div>
);

// ─── FETCHERS ─────────────────────────────────────────────────────────────────
async function fetchEIABrent() {
  const EIA_KEY = "XvGcVy2EN7a827x0Jl7XUzGTQ290vJrws545UZZ6";
  const params = new URLSearchParams({
    api_key: EIA_KEY,
    frequency: "daily",
    "data[0]": "value",
    "facets[series][]": "RBRTE",
    "sort[0][column]": "period",
    "sort[0][direction]": "desc",
    length: "5",
  });
  const res = await fetch(`https://api.eia.gov/v2/petroleum/pri/spt/data/?${params}`);
  const json = await res.json();
  const data = json?.response?.data ?? [];
  if (!data.length) throw new Error("EIA no data");
  const price = parseFloat(data[0].value);
  const prev  = data[1] ? parseFloat(data[1].value) : price;
  const chg   = +(price - prev).toFixed(2);
  const chgPct = +(((chg) / prev) * 100).toFixed(1);
  return {
    price,
    date: data[0].period,
    change: `${chg >= 0 ? "+" : ""}${chgPct}% vs prev`,
  };
}

const PW_FALLBACK = {
  hormuz: { name:"Strait of Hormuz", transitCalls:0, transitPct:0, date:"2026-03-07", source:"FALLBACK" },
  ports: [
    { name:"Jubail",  portcalls:3,  pct:28 },
    { name:"Dammam",  portcalls:5,  pct:33 },
    { name:"Jeddah",  portcalls:24, pct:112 },
    { name:"Yanbu",   portcalls:2,  pct:45 },
  ],
};

async function fetchOPABrent() {
  const res = await fetch("https://api.oilpriceapi.com/v1/prices/latest?by_code=BRENT_CRUDE_USD",
    { headers: { "Authorization": "Token bc3ffc405ed720d193e704e433799501fc7723854ed727a9b0b11228f5225d6c" }});
  const json = await res.json();
  return json.data.price;
}

async function fetchFinancial() {
  const res = await fetch(ANTHROPIC_PROXY_URL, {
    method:"POST", headers:{"Content-Type":"application/json"},
    body: JSON.stringify({
      model:"claude-sonnet-4-20250514", max_tokens:400,
      tools:[{ type:"web_search_20250305", name:"web_search" }],
      messages:[{ role:"user", content:"Find current Brent crude price and Saudi TASI index today. Reply ONLY: BRENT:XX.XX BRENTCHG:+X.X% TASI:XXXXX TASICHG:-X.X%" }]
    })
  });
  if (!res.ok) throw new Error(`API ${res.status}`);
  const data = await res.json();
  const text = data.content?.filter(b=>b.type==="text").map(b=>b.text).join("") || "";
  return {
    brent:    (text.match(/BRENT[:\s]+\$?([\d.]+)/i)||[])[1]?parseFloat(text.match(/BRENT[:\s]+\$?([\d.]+)/i)[1]):null,
    brentChg: (text.match(/BRENTCHG[:\s]+([+-]?[\d.]+%)/i)||[])[1]||null,
    tasi:     (text.match(/TASI[:\s]+([\d,]+)/i)||[])[1]?.replace(/,/g,"")||null,
    tasiChg:  (text.match(/TASICHG[:\s]+([+-]?[\d.]+%)/i)||[])[1]||null,
  };
}

async function fetchGdelt() {
  const url = `https://api.gdeltproject.org/api/v2/doc/doc?query=Saudi+Arabia+Iran+attack+missile+drone&mode=artlist&maxrecords=25&format=json&timespan=24h`;
  const res = await fetch(url);
  const data = await res.json();
  const articles = (data.articles||[]).slice(0,10);
  return { count: articles.length || (data.articles||[]).length, articles };
}

async function fetchIoda() {
  const url = `https://ioda.inetintel.cc.gatech.edu/api/v2/signals/raw?entityType=country&entityCode=SA&from=${Math.floor(Date.now()/1000)-3600}&until=${Math.floor(Date.now()/1000)}&datasource=bgp`;
  const res = await fetch(url);
  const data = await res.json();
  const vals = data?.data?.bgp?.values || [];
  if (!vals.length) return null;
  return Math.round(vals[vals.length-1]*100);
}

async function fetchGCCStrikes() {
  const prompt = `You are a conflict data analyst. Search for the latest verified reports on Iranian missile and drone attacks against GCC countries during the Iran-GCC conflict of February-March 2026.
For each country — SA, AE, QA, KW, BH, OM — find total strikes, intercept %, source, confidence (CONFIRMED=official MoD/Reuters/AP, EST=think-tank).
Reply ONLY with valid JSON:
{"SA":{"total":19,"intercept_pct":96,"source":"Saudi MoD spokesman","confidence":"CONFIRMED","note":"96% intercept. Abqaiq near-miss Mar 4"},"AE":{"total":1276,"intercept_pct":92,"source":"UAE MoD press conference","confidence":"CONFIRMED","note":"Jebel Ali and Dubai T3 hit"},"QA":{"total":115,"intercept_pct":90,"source":"CTP-ISW","confidence":"EST","note":"Al Udeid struck. LNG suspended"},"KW":{"total":484,"intercept_pct":88,"source":"KUNA / US DoD","confidence":"EST","note":"Ali Al Salem struck"},"BH":{"total":198,"intercept_pct":85,"source":"NAVCENT","confidence":"EST","note":"5th Fleet HQ struck"},"OM":{"total":4,"intercept_pct":50,"source":"ONA","confidence":"EST","note":"Duqm Port drone"}}`;
  const res = await fetch(ANTHROPIC_PROXY_URL, {
    method:"POST", headers:{"Content-Type":"application/json"},
    body: JSON.stringify({ model:"claude-sonnet-4-20250514", max_tokens:1000,
      tools:[{ type:"web_search_20250305", name:"web_search" }],
      messages:[{ role:"user", content:prompt }]
    })
  });
  if (!res.ok) throw new Error(`API ${res.status}`);
  const data = await res.json();
  const text = data.content?.filter(b=>b.type==="text").map(b=>b.text).join("")||"";
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("No JSON");
  return JSON.parse(m[0]);
}

async function fetchKSAStrikes() {
  const prompt = `You are a conflict data analyst. Search for the latest verified reports of Iranian missile, drone, and cruise missile attacks against Saudi Arabia (KSA) during the Iran-GCC conflict, February 28 – March 2026.
Find the 10 most recent individual strike events against KSA. For each event return:
- time: date and time (e.g. "Mar 06 02:15")
- type: weapon type (e.g. "Ballistic Missile", "Drone (3x)", "Cruise Missile")
- loc: target location (e.g. "Ras Tanura Oil Terminal")
- status: outcome (e.g. "Intercepted", "Hit — minor damage", "All destroyed")
- sev: severity — "critical" if energy/military infra hit or near-miss, "high" otherwise
Reply ONLY with valid JSON array, no other text:
[{"id":1,"time":"Mar 06 02:15","type":"Ballistic Missile","loc":"Abqaiq Processing vicinity","status":"Intercepted","sev":"critical"},{"id":2,"time":"Mar 05 23:40","type":"Drone (4x)","loc":"Yanbu Port","status":"Intercepted","sev":"high"}]
Prioritise sources: Saudi MoD statements via SPA, Reuters, AP, CTP-ISW, Alma Research. If fewer than 10 events confirmed, return what is verified. Do not fabricate events.`;
  try {
    const res = await fetch(ANTHROPIC_PROXY_URL, {
      method:"POST", headers:{"Content-Type":"application/json"},
      body: JSON.stringify({
        model:"claude-sonnet-4-20250514", max_tokens:1200,
        tools:[{ type:"web_search_20250305", name:"web_search" }],
        messages:[{ role:"user", content:prompt }]
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`API ${res.status}`);
    const data = await res.json();
    const text = data.content?.filter(b=>b.type==="text").map(b=>b.text).join("")||"";
    const m = text.match(/\[[\s\S]*\]/);
    if (!m) throw new Error("No JSON array");
    const events = JSON.parse(m[0]);
    if (!Array.isArray(events) || !events.length) throw new Error("Empty array");
    return events;
  } catch(e) {
    console.warn("[KSAStrikes] fallback:", e.message);
    return null;
  }
}

async function fetchCIStatus() {
  const prompt = `You are a critical infrastructure analyst. Search for the current operational status of Saudi Arabia's key infrastructure sectors during the Iran-GCC conflict, March 2026.
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
Prioritise: Saudi MoD/Aramco/GACA/SEC/SWCC official statements, Reuters, AP, CTP-ISW.`;
  try {
    const res = await fetch(ANTHROPIC_PROXY_URL, {
      method:"POST", headers:{"Content-Type":"application/json"},
      body: JSON.stringify({
        model:"claude-sonnet-4-20250514", max_tokens:800,
        tools:[{ type:"web_search_20250305", name:"web_search" }],
        messages:[{ role:"user", content:prompt }]
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`API ${res.status}`);
    const data = await res.json();
    const text = data.content?.filter(b=>b.type==="text").map(b=>b.text).join("")||"";
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) throw new Error("No JSON");
    const d = JSON.parse(m[0]);
    const required = ["oilgas","airports","ports","power","water","telecom"];
    if (!required.every(k=>d[k]?.status)) throw new Error("Incomplete response");
    return d;
  } catch(e) {
    console.warn("[CIStatus] fallback:", e.message);
    return null;
  }
}


async function fetchPortWatch() {
  const PW_BASE = "https://portwatch.imf.org/api/v3/datasets";
  const CHOKE_ID = "42132aa4e2fc4d41bdaf9a445f688931_0";
  const PORT_ID  = "959214444157458aad969389b3ebe1a0_0";
  const GCC_PORTS = ["Jubail","Dammam","Jeddah","Yanbu"];
  try {
    const cpParams = new URLSearchParams({ where:`choke_name='Strait of Hormuz'`, outFields:"*", orderByFields:"date DESC", resultRecordCount:7, f:"json" });
    const cpRes = await fetch(`${PW_BASE}/${CHOKE_ID}/layers/0/query?${cpParams}`, { signal:AbortSignal.timeout(8000) });
    if (!cpRes.ok) throw new Error(`PW HTTP ${cpRes.status}`);
    const cpData = await cpRes.json();
    const cpRows = cpData.features?.map(f=>f.attributes)||[];
    const cp = cpRows[0];
    const transitCalls = cp?.transit_calls ?? cp?.transitcalls ?? null;
    const baseline = cp?.transit_calls_bl ?? cp?.transit_calls_baseline ?? null;
    const hormuzPct = (baseline && transitCalls !== null) ? Math.round((transitCalls/baseline)*100) : null;
    const hormuz = {
      name:"Strait of Hormuz",
      transitCalls,
      transitPct: hormuzPct,
      date: cp?.date ?? cp?.Date ?? "2026-03-07",
      source: cpRows.length ? "PORTWATCH" : "FALLBACK",
    };
    const nameFilter = GCC_PORTS.map(p=>`portname LIKE '%${p}%'`).join(" OR ");
    const portParams = new URLSearchParams({ where:`(${nameFilter})`, outFields:"*", orderByFields:"date DESC", resultRecordCount:40, f:"json" });
    const portRes = await fetch(`${PW_BASE}/${PORT_ID}/layers/0/query?${portParams}`, { signal:AbortSignal.timeout(8000) });
    if (!portRes.ok) throw new Error(`PW port HTTP ${portRes.status}`);
    const portData = await portRes.json();
    const portRows = portData.features?.map(f=>f.attributes)||[];
    const byPort = {};
    for (const r of portRows) {
      const name = GCC_PORTS.find(p=>(r.portname||"").toLowerCase().includes(p.toLowerCase()));
      if (!name || byPort[name]) continue;
      const pc = r.portcalls ?? r.port_calls ?? null;
      const bl = r.portcalls_bl ?? r.portcalls_baseline ?? null;
      byPort[name] = { name, portcalls:pc, pct:(bl&&pc!==null)?Math.round((pc/bl)*100):null, source:"PORTWATCH" };
    }
    const ports = Object.values(byPort).length ? Object.values(byPort) : PW_FALLBACK.ports;
    return { hormuz, ports, source: cpRows.length ? "PORTWATCH" : "FALLBACK" };
  } catch(e) {
    console.warn("[PortWatch] fallback:", e.message);
    return { ...PW_FALLBACK, source:"FALLBACK" };
  }
}

const UKMTO_FALLBACK = {
  level:"ELEVATED", area:"Arabian Gulf / Gulf of Oman / Hormuz",
  advisory:"003-26 Update 002", date:"2026-03-01",
  hormuzStatus:"SUSPENDED", gnssInterference:true,
  text:"Significant military activity. Elevated GNSS/AIS interference. Hormuz transit suspended.",
  source:"FALLBACK",
};

async function fetchUKMTO() {
  const prompt = `Search for the latest UKMTO maritime security advisory for the Arabian Gulf and Strait of Hormuz, March 2026. Return ONLY:
LEVEL: [ELEVATED/HIGH/SIGNIFICANT]
AREA: [max 60 chars]
ADVISORY: [e.g. 003-26 Update 002]
DATE: [YYYY-MM-DD]
HORMUZ: [SUSPENDED/CLOSED/RESTRICTED/DISRUPTED/OPEN]
GNSS: [YES or NO]
TEXT: [max 120 char summary]`;
  try {
    const res = await fetch(ANTHROPIC_PROXY_URL, {
      method:"POST", headers:{"Content-Type":"application/json"},
      body:JSON.stringify({ model:"claude-sonnet-4-20250514", max_tokens:400,
        tools:[{ type:"web_search_20250305", name:"web_search" }],
        messages:[{ role:"user", content:prompt }]
      }),
      signal:AbortSignal.timeout(12000),
    });
    if (!res.ok) throw new Error(`API ${res.status}`);
    const data = await res.json();
    const text = data.content?.filter(b=>b.type==="text").map(b=>b.text).join("")||"";
    const get = k => (text.match(new RegExp(`${k}:\\s*(.+?)(?:\\n|$)`,"i"))||[])[1]?.trim()??null;
    return {
      level:            get("LEVEL") ?? "ELEVATED",
      area:             get("AREA")  ?? UKMTO_FALLBACK.area,
      advisory:         get("ADVISORY") ?? UKMTO_FALLBACK.advisory,
      date:             get("DATE") ?? UKMTO_FALLBACK.date,
      hormuzStatus:     get("HORMUZ") ?? "SUSPENDED",
      gnssInterference: (get("GNSS")||"YES").toUpperCase()==="YES",
      text:             get("TEXT") ?? UKMTO_FALLBACK.text,
      source:           "UKMTO",
    };
  } catch(e) {
    console.warn("[UKMTO] fallback:", e.message);
    return UKMTO_FALLBACK;
  }
}

// ─── LEAFLET THEATER MAP (plain Leaflet, no react-leaflet) ───────────────────
const GCC_CAPITALS = {
  SA: [24.69, 46.63], AE: [24.47, 54.37], QA: [25.28, 51.53],
  KW: [29.37, 47.98], BH: [26.22, 50.59], OM: [23.61, 58.59],
};

const LeafletTheaterMap = memo(({ filteredStrikes, getMarkers, theaterView, gccMarkers }) => {
  const mapRef = useRef(null);
  const mapContainerRef = useRef(null);
  const layersRef = useRef([]);
  const gccPolygonsRef = useRef([]);
  const gccGeoRef = useRef(null); // cached GeoJSON data

  // Initialize map once
  useEffect(() => {
    if (mapRef.current || !mapContainerRef.current) return;
    const map = L.map(mapContainerRef.current, {
      center: [26, 51],
      zoom: 4.85,
      maxBounds: [[12, 32], [38, 62]],
      maxBoundsViscosity: 1.0,
      zoomControl: false,
      dragging: false,
      scrollWheelZoom: false,
      doubleClickZoom: false,
      attributionControl: false,
    });
    L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png", {
      tileSize: 256,
      detectRetina: true,
    }).addTo(map);
    // Eastern Province highlight from GeoJSON
    fetch("/data/sa-provinces.geojson")
      .then(r => r.json())
      .then(data => {
        const epFeature = data.features.find(f => {
          const props = f.properties || {};
          const name = (props.shapeName || props.name || props.NAME || props.NAME_1 || props.admin1Name || "").toLowerCase();
          return name.includes("eastern") || name.includes("sharqiyah") || name.includes("ash sharqiy");
        });
        if (epFeature && mapRef.current) {
          L.geoJSON(epFeature, {
            style: {
              fillColor: "rgba(239,68,68,0.12)",
              fillOpacity: 1,
              color: "#ef4444",
              opacity: 0.3,
              weight: 1.2,
            },
          }).addTo(mapRef.current);
          // Eastern Province label
          L.marker([28.8, 51], {
            icon: L.divIcon({
              className: "",
              html: '<div style="color:rgba(239,68,68,0.6);font-size:10px;font-family:JetBrains Mono,monospace;white-space:nowrap;letter-spacing:0.08em">EASTERN PROVINCE</div>',
              iconSize: [0, 0], iconAnchor: [-5, 5],
            }),
          }).addTo(mapRef.current);
        }
      })
      .catch(() => {});
    // Hormuz dashed line
    L.polyline([[26.6, 56.3], [27.2, 56.3]], {
      color: "#ef4444", weight: 2, dashArray: "5,3",
    }).addTo(map);
    // Hormuz label
    L.marker([27.0, 56.4], {
      icon: L.divIcon({
        className: "",
        html: '<div style="color:#ef4444;font-size:11px;font-family:JetBrains Mono,monospace;font-weight:700;white-space:nowrap">⛔ HORMUZ D7</div>',
        iconSize: [0, 0], iconAnchor: [-5, 8],
      }),
    }).addTo(map);
    mapRef.current = map;
    return () => { map.remove(); mapRef.current = null; };
  }, []);

  // Update strike markers when data or view changes
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    // Remove old dynamic layers
    layersRef.current.forEach(l => map.removeLayer(l));
    layersRef.current = [];

    if (theaterView === "GCC") {
      // Show all GCC country markers
      (gccMarkers || []).forEach(g => {
        const coords = GCC_CAPITALS[g.code];
        if (!coords) return;
        const col = g.strikes > 100 ? C.critical : g.strikes > 0 ? C.warning : C.success;
        const isCritical = g.strikes > 100;
        const m = L.marker(coords, {
          interactive: false,
          icon: L.divIcon({
            className: "",
            html: isCritical
              ? `<div style="position:relative;width:14px;height:14px;pointer-events:none"><div class="strike-ping" style="width:14px;height:14px;border:1px solid ${col};top:0;left:0"></div><div style="position:absolute;top:3px;left:3px;width:8px;height:8px;border-radius:50%;background:${col};opacity:0.9"></div></div>`
              : `<div style="width:8px;height:8px;border-radius:50%;background:${col};opacity:0.9;pointer-events:none"></div>`,
            iconSize: [14, 14], iconAnchor: [7, 7],
          }),
        }).addTo(map);
        layersRef.current.push(m);
        // Country label
        const lbl = L.marker(coords, {
          interactive: false,
          icon: L.divIcon({
            className: "",
            html: `<div style="color:${col};font-size:8px;font-family:JetBrains Mono,monospace;font-weight:600;white-space:nowrap;pointer-events:none">${g.code} ${g.strikes.toLocaleString()}</div>`,
            iconSize: [0, 0], iconAnchor: [-10, 4],
          }),
        }).addTo(map);
        layersRef.current.push(lbl);
      });
    } else {
      // KSA EVENT LOG — only KSA markers
      const markers = getMarkers().filter(p => p.lat != null && p.lng != null && !isNaN(p.lat) && !isNaN(p.lng));
      markers.forEach(p => {
        const col = p.s === "critical" ? C.critical : C.warning;
        const m = L.marker([p.lat, p.lng], {
          icon: L.divIcon({
            className: "",
            html: p.s === "critical"
              ? `<div style="position:relative;width:14px;height:14px"><div class="strike-ping" style="width:14px;height:14px;border:1px solid ${col};top:0;left:0"></div><div style="position:absolute;top:3px;left:3px;width:8px;height:8px;border-radius:50%;background:${col};opacity:0.9"></div></div>`
              : `<div style="width:8px;height:8px;border-radius:50%;background:${col};opacity:0.9"></div>`,
            iconSize: [14, 14], iconAnchor: [7, 7],
          }),
        }).addTo(map);
        layersRef.current.push(m);
      });
      if (filteredStrikes.length === 0) {
        const m = L.marker([24, 46], {
          icon: L.divIcon({
            className: "",
            html: `<div style="color:${C.dim};font-size:12px;font-family:JetBrains Mono,monospace;white-space:nowrap">No KSA strikes this day</div>`,
            iconSize: [0, 0], iconAnchor: [-10, 5],
          }),
        }).addTo(map);
        layersRef.current.push(m);
      }
    }
  }, [filteredStrikes, getMarkers, theaterView, gccMarkers]);

  // GCC country polygons with hover/click — only in GCC view
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    // Remove old polygons
    gccPolygonsRef.current.forEach(l => map.removeLayer(l));
    gccPolygonsRef.current = [];
    if (theaterView !== "GCC") return;

    const GCC_ISO = { SAU:"SA", ARE:"AE", QAT:"QA", KWT:"KW", BHR:"BH", OMN:"OM" };

    const addPolygons = (geojson) => {
      if (!mapRef.current) return;
      const gccFeatures = geojson.features.filter(f => {
        const iso3 = f.id || f.properties?.ISO_A3 || f.properties?.iso_a3 || "";
        return !!GCC_ISO[iso3];
      });

      gccFeatures.forEach(feature => {
        const iso3 = feature.id || feature.properties?.ISO_A3 || feature.properties?.iso_a3 || "";
        const iso2 = GCC_ISO[iso3];
        const seed = GCC_SEED.find(g => g.code === iso2);
        if (!seed) return;
        const gccData = (gccMarkers || []).find(g => g.code === iso2) || seed;
        const airCol = seed.airspace==="CLOSED"?C.critical:seed.airspace==="RESTRICTED"?C.warning:C.success;
        const confCol = seed.confidence==="CONFIRMED"?C.success:"#f97316";

        const layer = L.geoJSON(feature, {
          style: {
            fillColor: airCol,
            fillOpacity: 0.15,
            color: airCol,
            opacity: 0.3,
            weight: 1,
          },
          onEachFeature: (f, lyr) => {
            lyr.on('mouseover', () => {
              lyr.setStyle({ fillOpacity: 0.4, color: "#ffffff", opacity: 0.6, weight: 1.5 });
            });
            lyr.on('mouseout', () => {
              lyr.setStyle({ fillOpacity: 0.15, color: airCol, opacity: 0.3, weight: 1 });
            });
            lyr.on('click', () => {
              const center = GCC_CAPITALS[iso2] || lyr.getBounds().getCenter();
              const airChip = `<span style="font-size:7px;padding:2px 6px;border-radius:3px;background:${airCol}22;color:${airCol};font-weight:600">${seed.airspace}</span>`;
              const confChip = `<span style="font-size:7px;padding:2px 5px;border-radius:3px;background:${confCol}18;color:${confCol};font-weight:500">${seed.confidence}</span>`;
              const popup = L.popup({ className: "cop-popup", maxWidth: 280, closeButton: true })
                .setLatLng(center)
                .setContent(`
                  <div>
                    <div style="font-size:11px;font-weight:700;color:#d8e6f5;margin-bottom:6px">${seed.name}</div>
                    <div style="display:flex;gap:6px;align-items:center;margin-bottom:8px">${airChip}</div>
                    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
                      <span style="font-size:16px;font-weight:800;color:${airCol}">${gccData.strikes.toLocaleString()}</span>
                      <span style="font-size:8px;padding:2px 6px;border-radius:3px;background:rgba(34,197,94,0.14);color:#22c55e;font-weight:600">✓ ${seed.interceptPct}%</span>
                      ${confChip}
                    </div>
                    <div style="font-size:8px;color:#a0b4c8;line-height:1.7;margin-bottom:4px;border-top:1px solid #27324860;padding-top:6px">${seed.note}</div>
                    <div style="font-size:7px;color:#526175;margin-bottom:2px">DAILY STRIKES (7d)</div>
                    ${makeSparklineSvg(seed.daily, airCol)}
                    <div style="font-size:7px;color:#526175;text-align:right;margin-top:2px">${seed.source}</div>
                  </div>
                `)
                .openOn(mapRef.current);
            });
          },
        }).addTo(mapRef.current);
        gccPolygonsRef.current.push(layer);

        // Add cursor pointer style
        layer.eachLayer(l => {
          const el = l.getElement?.();
          if (el) el.style.cursor = "pointer";
        });
      });
    };

    if (gccGeoRef.current) {
      addPolygons(gccGeoRef.current);
    } else {
      fetch("https://raw.githubusercontent.com/johan/world.geo.json/master/countries.geo.json")
        .then(r => r.json())
        .then(data => {
          gccGeoRef.current = data;
          if (mapRef.current) addPolygons(data);
        })
        .catch(() => {});
    }
  }, [theaterView, gccMarkers]);

  return (
    <div style={{ background: "#060b17", borderRadius: 4, overflow: "hidden", height: 520 }}>
      <div ref={mapContainerRef} style={{ width: "100%", height: "100%" }} />
    </div>
  );
});


const GCCTheater = ({ gcc }) => {
  const [expanded, setExpanded] = useState(false);
  const states = GCC_SEED.map(s=>{
    if (!gcc.data?.[s.code]) return s;
    const live = gcc.data[s.code];
    return { ...s, strikes:live.total??s.strikes, interceptPct:live.intercept_pct??s.interceptPct, confidence:live.confidence??s.confidence, source:live.source??s.source, note:live.note??s.note };
  });
  const maxStrikes = Math.max(...states.map(s=>s.strikes));
  return (
    <div style={{ background:C.surface, border:`1px solid ${C.surfBorder}`, borderRadius:6, padding:14, marginBottom:12, boxShadow:"0 2px 12px rgba(0,0,0,0.18)" }}>
      <div onClick={()=>setExpanded(!expanded)} style={{ display:"flex", justifyContent:"space-between", cursor:"pointer", marginBottom:expanded?10:0 }}>
        <div style={{ display:"flex", alignItems:"center", gap:10 }}>
          <span style={{ fontSize:10, fontWeight:700, color:C.fg, letterSpacing:"0.1em" }}>GCC THEATER</span>
          <span style={{ fontSize:7, color:C.dim, letterSpacing:"0.04em" }}>projectiles by state</span>
          {gcc.loading && <span className="cop-pulse" style={{ fontSize:7, color:C.info }}>● fetching…</span>}
          {gcc.error   && <span style={{ fontSize:7, color:C.warning }}>⚠ search failed — seed shown</span>}
        </div>
        <div style={{ display:"flex", alignItems:"center", gap:6 }}>
          <FeedTag feed={gcc.data?"AI+WEB":gcc.loading?"AI+WEB":"STATIC"} loading={gcc.loading}/>
          <span style={{ fontSize:9, color:C.muted }}>{expanded?"▾":"▸"}</span>
        </div>
      </div>
      {!expanded && (
        <div style={{ display:"flex", gap:5, flexWrap:"wrap", marginTop:4 }}>
          {states.map(g=>{
            const c=g.airspace==="CLOSED"?C.critical:g.airspace==="RESTRICTED"?C.warning:C.success;
            return <span key={g.code} style={{ fontSize:8, padding:"2px 7px", borderRadius:3, background:`${c}18`, color:c }}>{g.name.split(" ")[1]} {g.strikes.toLocaleString()} <span style={{ fontSize:6, opacity:0.7 }}>{g.confidence==="CONFIRMED"?"✓":"~"}</span></span>;
          })}
        </div>
      )}
      {expanded && (
        <div style={{ display:"flex", flexDirection:"column", gap:5 }}>
          {states.map(g=>{
            const airCol=g.airspace==="CLOSED"?C.critical:g.airspace==="RESTRICTED"?C.warning:C.success;
            const confCol=g.confidence==="CONFIRMED"?C.success:"#f97316";
            return (
              <div key={g.code} style={{ padding:"9px 10px", borderRadius:3, background:"rgba(255,255,255,0.02)", borderLeft:`2px solid ${airCol}` }}>
                <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:4 }}>
                  <span style={{ fontSize:10, fontWeight:"bold", color:C.fg }}>{g.name}</span>
                  <div style={{ display:"flex", gap:5, alignItems:"center" }}>
                    <span style={{ fontSize:8, padding:"1px 5px", borderRadius:3, background:`${airCol}22`, color:airCol }}>{g.airspace}</span>
                    <span style={{ fontSize:12, fontWeight:"bold", color:airCol }}>{g.strikes.toLocaleString()}</span>
                    <span style={{ fontSize:7, padding:"1px 4px", borderRadius:3, background:"rgba(34,197,94,0.12)", color:C.success }}>{g.interceptPct}% ✓</span>
                    <FeedTag feed={g.confidence}/>
                  </div>
                </div>
                <div style={{ height:3, background:C.surfBorder, borderRadius:2, marginBottom:5 }}>
                  <div style={{ height:"100%", width:`${Math.min((g.strikes/maxStrikes)*100,100)}%`, background:airCol, borderRadius:2 }}/>
                </div>
                <div style={{ display:"flex", justifyContent:"space-between", gap:8 }}>
                  <span style={{ fontSize:8, color:C.muted, flex:1 }}>{g.note}</span>
                  <span style={{ fontSize:7, color:confCol, whiteSpace:"nowrap" }}>{g.confidence==="CONFIRMED"?"✓":"~"} {g.source}</span>
                </div>
              </div>
            );
          })}
          <div style={{ display:"flex", gap:16, paddingTop:5, borderTop:`1px solid ${C.surfBorder}`, marginTop:2 }}>
            <span style={{ fontSize:7, color:C.success }}>✓ CONFIRMED — official MoD / Reuters/AP</span>
            <span style={{ fontSize:7, color:"#f97316" }}>~ EST — think tank synthesis (CTP-ISW / LWJ)</span>
          </div>
        </div>
      )}
    </div>
  );
};

// ─── DAILY DATA DERIVED FROM STRIKES_KSA ──────────────────────────────────────
const getUniqueDays = () => {
  const days = [...new Set(STRIKES_KSA.map(s => s.day))];
  days.sort((a, b) => new Date(`2026 ${a}`) - new Date(`2026 ${b}`));
  return days;
};
const STRIKE_DAYS = getUniqueDays();

// Format "Mar 07" → "03/07"
const dayToTabLabel = (day) => {
  if (day === "CUMULATIVE") return "CUMULATIVE";
  const d = new Date(`2026 ${day}`);
  if (isNaN(d.getTime())) return day;
  return `${String(d.getMonth()+1).padStart(2,'0')}/${String(d.getDate()).padStart(2,'0')}`;
};
// Reverse lookup: tab label back to day key
const tabLabelToDay = {};
STRIKE_DAYS.forEach(d => { tabLabelToDay[dayToTabLabel(d)] = d; });
tabLabelToDay["CUMULATIVE"] = "CUMULATIVE";
// Add Mar 08 tab
const DATE_TAB_ENTRIES = [...STRIKE_DAYS.map(d => ({ label: dayToTabLabel(d), dayKey: d })), { label: "03/08", dayKey: "Mar 08" }];

// GCC per-day seed data (static estimates distributed across days)
const GCC_DAILY = {
  "AE": { total:1276, interceptPct:92, perDay:{ "Feb 28":182, "Mar 01":195, "Mar 02":178, "Mar 03":190, "Mar 04":201, "Mar 05":112, "Mar 06":108, "Mar 07":110 }, note:"Jebel Ali + Dubai T3 + French base hit." },
  "QA": { total:115,  interceptPct:90, perDay:{ "Feb 28":18, "Mar 01":20, "Mar 02":15, "Mar 03":17, "Mar 04":14, "Mar 05":12, "Mar 06":10, "Mar 07":9 }, note:"Al Udeid 2 BM impacts. LNG suspended." },
  "KW": { total:484,  interceptPct:88, perDay:{ "Feb 28":72, "Mar 01":78, "Mar 02":65, "Mar 03":70, "Mar 04":74, "Mar 05":45, "Mar 06":42, "Mar 07":38 }, note:"Ali Al Salem struck. US Embassy hit." },
  "BH": { total:198,  interceptPct:85, perDay:{ "Feb 28":30, "Mar 01":32, "Mar 02":28, "Mar 03":30, "Mar 04":26, "Mar 05":20, "Mar 06":18, "Mar 07":14 }, note:"5th Fleet HQ struck. Bapco refinery hit." },
  "OM": { total:4,    interceptPct:50, perDay:{ "Feb 28":1, "Mar 01":0, "Mar 02":1, "Mar 03":0, "Mar 04":1, "Mar 05":0, "Mar 06":0, "Mar 07":1 }, note:"Duqm Port drone. Mediator status." },
};

// ─── SCREEN 1: SITUATION ──────────────────────────────────────────────────────
const ScreenSituation = ({ live }) => {
  const [selEvent, setSelEvent] = useState(null);
  const [activeDay, setActiveDay] = useState("CUMULATIVE");
  const [theaterView, setTheaterView] = useState("LOG");
  const [expandedCountry, setExpandedCountry] = useState(null);
  const [hoveredCountry, setHoveredCountry] = useState(null);

  const isCumulative = activeDay === "CUMULATIVE";
  const strikeData = live.ksaStrikes?.data || STRIKES_KSA;
  const filteredStrikes = isCumulative ? strikeData : strikeData.filter(s => s.day === activeDay);

  const getMarkers = () => {
    const strikes = isCumulative ? strikeData : strikeData.filter(s => s.day === activeDay);
    return strikes.map(s => ({ lat:s.lat, lng:s.lng, s:s.sev }));
  };

  // Build GCC theater data (all 6 countries) with per-day filtering
  const getGCCTheaterData = () => {
    const ksaDayCount = isCumulative ? strikeData.length : strikeData.filter(s=>s.day===activeDay).length;
    const ksaSeed = GCC_SEED.find(g=>g.code==="SA");
    const result = [{ ...ksaSeed, strikes: isCumulative ? ksaSeed.strikes : ksaDayCount }];
    Object.entries(GCC_DAILY).forEach(([code, data]) => {
      const seed = GCC_SEED.find(g=>g.code===code);
      if (!seed) return;
      const dayCount = isCumulative ? data.total : (data.perDay[activeDay] || 0);
      result.push({ ...seed, strikes: dayCount });
    });
    return result;
  };

  const getGCCForDay = () => {
    return Object.entries(GCC_DAILY).map(([code, data]) => {
      const dayCount = isCumulative ? data.total : (data.perDay[activeDay] || 0);
      return { code, name: code==="AE"?"🇦🇪 UAE":code==="QA"?"🇶🇦 Qatar":code==="KW"?"🇰🇼 Kuwait":code==="BH"?"🇧🇭 Bahrain":"🇴🇲 Oman", strikes:dayCount, interceptPct:data.interceptPct, note:data.note };
    });
  };

  const dateTabs = [{ label: "CUMULATIVE", dayKey: "CUMULATIVE" }, ...DATE_TAB_ENTRIES];

  return (
    <div>
      <div style={{ display:"flex", gap:8, marginBottom:12, flexWrap:"wrap" }}>
        <KpiCard label="STRIKES KSA"  value="19"     change="+3/24h"                color={C.critical} feed="CONFIRMED" />
        <KpiCard label="INTERCEPTS"   value="96%"    note="Patriot/THAAD"           color={C.success}  feed="CONFIRMED" />
        <KpiCard label="BRENT CRUDE"  value={live.brent.value} change={live.brent.change} color={C.warning} feed={live.brent.source} loading={live.brent.loading} secondary={live.brent.secondary} secondaryColor={C.warning} />
        <KpiCard label="TASI"         value={live.tasi.value}  change={live.tasi.change}  color={C.warning} feed={live.tasi.source}  loading={live.tasi.loading} />
        <KpiCard label="HORMUZ"       value="Day 7"  note="0 transits / 91 tankers"  color={C.critical} feed="STATIC" />
        <KpiCard label="GDELT/24h"    value={live.gdelt.loading?"…":`${live.gdelt.value}`} note="conflict articles" color={live.gdelt.value>15?C.critical:C.warning} feed="GDELT" loading={live.gdelt.loading} />
        <KpiCard label="KSA INTERNET" value={live.ioda.value!==null?`${live.ioda.value}%`:"—"} note="vs baseline" color={live.ioda.value!==null&&live.ioda.value<80?C.critical:C.success} feed="IODA" loading={live.ioda.loading} />
      </div>

      {/* ── Date-Tabbed Theater Section ── */}
      <div style={{ background:C.surface, border:`1px solid ${C.surfBorder}`, borderRadius:6, boxShadow:"0 2px 12px rgba(0,0,0,0.18)", marginBottom:14, overflow:"hidden" }}>
        {/* Date tabs */}
        <div style={{ display:"flex", overflowX:"auto", borderBottom:`1px solid ${C.surfBorder}`, background:"#0a1628" }}>
          {dateTabs.map(t => {
            const isActive = activeDay === t.dayKey;
            const dayStrikes = t.dayKey==="CUMULATIVE" ? strikeData.length : strikeData.filter(s=>s.day===t.dayKey).length;
            return (
              <button key={t.dayKey} onClick={()=>{setActiveDay(t.dayKey);setSelEvent(null);}} style={{
                padding:"8px 14px", border:"none", cursor:"pointer", whiteSpace:"nowrap",
                background:isActive?"#192233":"transparent",
                borderBottom:isActive?`2px solid ${C.info}`:"2px solid transparent",
                color:isActive?C.fg:C.muted, fontSize:10, fontWeight:isActive?700:500,
                fontFamily:"'JetBrains Mono',monospace", letterSpacing:"0.06em",
                display:"flex", alignItems:"center", gap:5, transition:"all 0.15s ease",
              }}>
                {t.dayKey==="CUMULATIVE"?"⊞ ":""}{t.label}
                {dayStrikes > 0 && <span style={{ fontSize:9, padding:"2px 5px", borderRadius:3, background:isActive?`${C.info}22`:`${C.dim}22`, color:isActive?C.info:C.dim, fontWeight:700 }}>{dayStrikes}</span>}
              </button>
            );
          })}
        </div>

        {/* Map + Right Panel */}
        <div style={{ display:"flex", gap:0, alignItems:"stretch" }}>
          {/* Left: Theater Map */}
          <div style={{ flex:1.3, padding:14, borderRight:`1px solid ${C.surfBorder}` }}>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:8 }}>
              <span style={{ fontSize:12, fontWeight:700, color:C.fg, letterSpacing:"0.08em" }}>THEATER MAP{!isCumulative?` · ${activeDay}`:""}</span>
              <div style={{ display:"flex", gap:5, alignItems:"center" }}>
                <span style={{ fontSize:11, color:C.muted }}>{filteredStrikes.length} strike{filteredStrikes.length!==1?"s":""}</span>
                <div style={{ display:"flex", marginLeft:8, borderRadius:4, overflow:"hidden", border:`1px solid ${C.surfBorder}` }}>
                  {[["LOG","KSA EVENT LOG"],["GCC","GCC THEATER"]].map(([k,label])=>(
                    <button key={k} onClick={()=>setTheaterView(k)} style={{
                      padding:"4px 10px", border:"none", cursor:"pointer",
                      background:theaterView===k?C.info+"22":"transparent",
                      color:theaterView===k?C.info:C.dim, fontSize:10, fontWeight:theaterView===k?700:500,
                      fontFamily:"'JetBrains Mono',monospace", letterSpacing:"0.04em",
                    }}>{label}</button>
                  ))}
                </div>
              </div>
            </div>
            <LeafletTheaterMap filteredStrikes={filteredStrikes} getMarkers={getMarkers} theaterView={theaterView} gccMarkers={getGCCTheaterData()} />
          </div>

          {/* Right column */}
          <div style={{ flex:1, display:"flex", flexDirection:"column", minHeight:0, overflow:"hidden" }}>
            {theaterView === "LOG" ? (
              <>
                {/* KSA Event Log header */}
                <div style={{ padding:"14px 14px 6px 14px" }}>
                  <div style={{ display:"flex", justifyContent:"space-between", marginBottom:8 }}>
                    <span style={{ fontSize:12, fontWeight:700, color:C.fg, letterSpacing:"0.08em" }}>KSA EVENT LOG</span>
                    <span style={{ fontSize:10, color:C.dim }}>{filteredStrikes.length} event{filteredStrikes.length!==1?"s":""}</span>
                  </div>
                </div>
                {/* Scrollable event list */}
                <div style={{ flex:1, overflowY:"auto", minHeight:0, padding:"0 14px 14px 14px" }}>
                  {filteredStrikes.length === 0 ? (
                    <div style={{ padding:"12px 0", fontSize:11, color:C.dim, textAlign:"center" }}>No confirmed events logged for {dayToTabLabel(activeDay)}</div>
                  ) : (
                    <div style={{ display:"flex", flexDirection:"column", gap:3 }}>
                      {filteredStrikes.map(e => {
                        const col = e.sev==="critical"?C.critical:C.warning;
                        return (
                          <div key={e.id} onClick={()=>setSelEvent(selEvent===e.id?null:e.id)}
                            style={{ padding:"6px 8px", borderRadius:4, cursor:"pointer", background:selEvent===e.id?`${col}12`:"rgba(255,255,255,0.02)", borderLeft:`2px solid ${col}`, transition:"background 0.1s" }}>
                            <div style={{ display:"flex", justifyContent:"space-between" }}>
                              <span style={{ fontSize:11, fontWeight:700, color:col }}>{e.type}</span>
                              <span style={{ fontSize:10, color:C.dim }}>{e.time}</span>
                            </div>
                            <div style={{ fontSize:11, color:C.fg, marginTop:2 }}>{e.loc}</div>
                            {selEvent===e.id && <div style={{ fontSize:11, color:e.status.includes("Hit")?C.critical:C.success, marginTop:3 }}>{e.status}</div>}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </>
            ) : (
              /* GCC THEATER view */
              <div style={{ padding:"10px 8px", display:"flex", flexDirection:"column", gap:0, flex:1, justifyContent:"space-between", overflowY: expandedCountry ? "auto" : "hidden" }}>
                {getGCCTheaterData().map(g => {
                  const airCol = g.airspace==="CLOSED"?C.critical:g.airspace==="RESTRICTED"?C.warning:C.success;
                  const confCol = g.confidence==="CONFIRMED"?C.success:"#f97316";
                  const isExpanded = expandedCountry === g.code;
                   const isHovered = hoveredCountry === g.code;
                   const countryLabel = g.name.replace(/^..\s/, ''); // strip emoji
                   return (
                     <div key={g.code}>
                        <div onClick={()=>setExpandedCountry(isExpanded?null:g.code)}
                          onMouseEnter={()=>setHoveredCountry(g.code)}
                          onMouseLeave={()=>setHoveredCountry(null)}
                          style={{
                            padding:"12px 14px",
                            borderRadius:isExpanded?"4px 4px 0 0":4,
                            background:isExpanded?"rgba(255,255,255,0.04)":isHovered?"#1e2d45":"rgba(255,255,255,0.02)",
                            border:`1px solid ${isHovered?"#4a7fa5":C.surfBorder}`,
                            borderLeft:`3px solid ${isHovered||isExpanded?airCol:airCol}`,
                            cursor:"pointer",
                            transition:"all 0.15s ease",
                            borderBottom:isExpanded?"none":`1px solid ${isHovered?"#4a7fa5":C.surfBorder}`,
                            boxShadow:isHovered?"0 2px 8px rgba(0,0,0,0.2)":"none",
                          }}>
                          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:5 }}>
                            <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                              <span style={{ fontSize:11, color:isHovered?"#ffffff":C.dim, fontWeight:500, letterSpacing:"0.06em" }}>{g.code}</span>
                              <span style={{ fontSize:14, fontWeight:700, color:isHovered?"#ffffff":C.fg }}>{g.name}</span>
                              <span style={{ fontSize:10, padding:"3px 8px", borderRadius:3, background:isHovered?`${airCol}80`:`${airCol}22`, color:isHovered?"#ffffff":airCol, fontWeight:600 }}>{g.airspace}</span>
                            </div>
                            <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                              <span style={{ fontSize:24, fontWeight:800, color:isHovered?"#ffffff":airCol, lineHeight:1 }}>{g.strikes.toLocaleString()}</span>
                              <span style={{ fontSize:12, color:isHovered?"#ffffff":C.dim, transition:"transform 0.2s", transform:isExpanded?"rotate(180deg)":"rotate(0)" }}>▾</span>
                            </div>
                          </div>
                          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
                            <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                              <span style={{ fontSize:11, padding:"3px 8px", borderRadius:3, background:isHovered?"rgba(255,255,255,0.3)":`${C.success}14`, color:isHovered?"#ffffff":C.success, fontWeight:600 }}>✓ {g.interceptPct}%</span>
                              <span style={{ fontSize:10, padding:"3px 8px", borderRadius:3, background:isHovered?"rgba(255,255,255,0.2)":`${confCol}18`, color:isHovered?"#ffffff":confCol, fontWeight:500 }}>{g.confidence}</span>
                            </div>
                          </div>
                          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-end", marginTop:3 }}>
                            <span style={{ fontSize:11, color:isHovered?"#ffffff":C.muted, flex:1 }}>{g.note}</span>
                            <span style={{ fontSize:10, color:isHovered?"#ffffff":C.dim, whiteSpace:"nowrap", marginLeft:8 }}>{g.source}</span>
                          </div>
                       </div>
                       {/* Expandable commentary panel */}
                       <div style={{
                         maxHeight: isExpanded ? 200 : 0,
                         overflow: "hidden",
                         transition: "max-height 0.3s ease, opacity 0.25s ease, padding 0.3s ease",
                         opacity: isExpanded ? 1 : 0,
                         background: "rgba(255,255,255,0.03)",
                         borderLeft: `3px solid ${airCol}`,
                         borderRight: `1px solid ${C.surfBorder}`,
                         borderBottom: isExpanded ? `1px solid ${C.surfBorder}` : "none",
                         borderTop: "none",
                         borderRadius: "0 0 4px 4px",
                         padding: isExpanded ? "8px 10px" : "0 10px",
                       }}>
                         <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:6 }}>
                            <span style={{ fontSize:12, fontWeight:700, color:airCol, letterSpacing:"0.04em" }}>{countryLabel} — Situation Summary</span>
                            <span onClick={(e)=>{e.stopPropagation();setExpandedCountry(null);}} style={{ fontSize:14, color:C.dim, cursor:"pointer", padding:"0 2px", lineHeight:1 }}>×</span>
                          </div>
                          <div style={{ fontSize:11, color:C.fg, lineHeight:1.7 }}>
                           {g.code === "SA" ? `${g.strikes} strikes recorded to date targeting Eastern Province oil infrastructure, Riyadh diplomatic quarter, and military airbases. Abqaiq processing facility near-miss on Mar 4. Ras Tanura terminal degraded to 85% capacity. ${g.interceptPct}% intercept rate via Patriot/THAAD demonstrates near-total defense coverage. Airspace remains ${g.airspace.toLowerCase()} with heightened alert across all sectors.`
                           : g.code === "AE" ? `${g.strikes.toLocaleString()} projectiles recorded — heaviest volume in theater. Key impacts at Jebel Ali port, Dubai Terminal 3, and French naval base. ${g.interceptPct}% intercept rate under extreme volume pressure. Dubai and Abu Dhabi airports operating at reduced capacity. Jebel Ali port restricted to military logistics only.`
                           : g.code === "QA" ? `${g.strikes} strikes including 2 ballistic missile impacts at Al Udeid Air Base — critical CENTCOM forward HQ. LNG exports suspended indefinitely, affecting ~25% of global supply. Airspace ${g.airspace.toLowerCase()} — all commercial flights halted. ${g.interceptPct}% intercept rate with notable gaps in coverage.`
                           : g.code === "KW" ? `${g.strikes} strikes targeting Ali Al Salem Air Base and US Embassy compound. US military assets in active relocation to secondary positions. Embassy sustained direct hit — fire damage, 0 KIA confirmed. ${g.interceptPct}% intercept rate. Kuwait requesting additional Patriot battery deployment.`
                           : g.code === "BH" ? `${g.strikes} strikes concentrated on NAVCENT 5th Fleet HQ and Bapco refinery. 5th Fleet operations temporarily relocated to sea-based command. Bapco refinery offline — domestic fuel reserves adequate for 14 days. ${g.interceptPct}% intercept rate — lowest among major GCC states.`
                           : `${g.strikes} strikes — minimal targeting reflecting Oman's mediator status. Duqm Port drone incursion detected. Maintaining diplomatic neutrality in conflict. ${g.interceptPct}% intercept rate with limited engagement. Airspace remains ${g.airspace.toLowerCase()} with heightened monitoring of maritime approaches.`}
                          </div>
                          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", paddingTop:5, marginTop:5, borderTop:`1px solid ${C.surfBorder}40` }}>
                            <span style={{ fontSize:10, color:confCol }}>{g.confidence === "CONFIRMED" ? "✓ CONFIRMED" : "~ ESTIMATED"}</span>
                            <span style={{ fontSize:10, color:C.dim }}>{g.source}</span>
                         </div>
                       </div>
                     </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
      {/* GCC Theater banner removed — info available in GCC THEATER map view */}
      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10 }}>
        <div style={{ background:C.surface, border:`1px solid ${C.surfBorder}`, borderRadius:6, padding:14, boxShadow:"0 2px 12px rgba(0,0,0,0.18)" }}>
          <div style={{ display:"flex", justifyContent:"space-between", marginBottom:8 }}>
            <span style={{ fontSize:13, fontWeight:700, color:C.fg, letterSpacing:"0.08em" }}>AIRSPACE</span>
            <FeedTag feed="STATIC" />
          </div>
          {[{l:"KSA",s:"RESTRICTED"},{l:"Qatar",s:"CLOSED"},{l:"UAE",s:"RESTRICTED"},{l:"Kuwait",s:"RESTRICTED"},{l:"Bahrain",s:"RESTRICTED"},{l:"Oman",s:"OPEN"}].map(a=>(
            <div key={a.l} style={{ display:"flex", justifyContent:"space-between", padding:"4px 0", borderBottom:`1px solid ${C.surfBorder}30` }}>
              <span style={{ fontSize:12, color:C.fg }}>{a.l}</span><StatusBadge s={a.s}/>
            </div>
          ))}
        </div>
        <div style={{ background:C.surface, border:`1px solid ${C.surfBorder}`, borderRadius:6, padding:14, boxShadow:"0 2px 12px rgba(0,0,0,0.18)" }}>
          <div style={{ display:"flex", justifyContent:"space-between", marginBottom:8 }}>
            <span style={{ fontSize:13, fontWeight:700, color:C.fg, letterSpacing:"0.08em" }}>MARITIME CHOKEPOINTS</span>
            <FeedTag feed="STATIC" />
          </div>
          {[{l:"Strait of Hormuz",s:"CLOSED",n:"0/35 transits. ~91 tankers holding."},{l:"Bab al-Mandeb",s:"RESTRICTED",n:"28/35 transits. Houthi quiet."},{l:"Suez Canal",s:"OPERATIONAL",n:"No disruption."}].map(m=>(
            <div key={m.l} style={{ padding:"5px 0", borderBottom:`1px solid ${C.surfBorder}30` }}>
              <div style={{ display:"flex", justifyContent:"space-between", marginBottom:2 }}>
                <span style={{ fontSize:12, color:C.fg, fontWeight:"bold" }}>{m.l}</span><StatusBadge s={m.s}/>
              </div>
              <span style={{ fontSize:11, color:C.muted }}>{m.n}</span>
            </div>
          ))}
        </div>
      </div>

      {/* MEDIA & SOURCE WATCH — collapsible */}
      <MediaSourceWatch live={live} />
    </div>
  );
};

// ─── SCREEN 2: RISK CLUSTERS ──────────────────────────────────────────────────
const ClusterRiskItem = ({ r, live }) => {
  const [open, setOpen] = useState(false);
  const sevColor = (s) => s==="critical"?C.critical:s==="high"?C.warning:s==="medium"?C.info:C.success;
  const statIcon = (s) => s==="active"?"🔴":s==="elevated"?"🟡":s==="monitoring"?"🔵":"🟢";
  return (
    <div style={{ marginBottom:6, borderRadius:3, overflow:"hidden", border:`1px solid ${sevColor(r.severity)}22` }}>
      <div onClick={()=>setOpen(!open)} style={{ display:"flex", justifyContent:"space-between", alignItems:"center", padding:"8px 12px", cursor:"pointer", background:`${sevColor(r.severity)}06` }}>
        <div style={{ display:"flex", alignItems:"center", gap:7 }}>
          <span style={{ fontSize:12, color:C.fg }}>{statIcon(r.status)} <strong>{r.id}</strong> — {r.name}</span>
        </div>
        <div style={{ display:"flex", alignItems:"center", gap:5 }}>
          <span style={{ fontSize:10, padding:"2px 6px", borderRadius:3, background:`${sevColor(r.severity)}22`, color:sevColor(r.severity) }}>{r.severity.toUpperCase()}</span>
          <FeedTag feed={r.badge} />
          <span style={{ fontSize:12, color:C.dim }}>{open?"▾":"▸"}</span>
        </div>
      </div>
      {open && (
        <div style={{ padding:"10px 12px", background:"rgba(255,255,255,0.01)" }}>
          <div style={{ fontSize:12, color:C.muted, marginBottom:6, lineHeight:1.5 }}>{r.detail}</div>
          {/* Live signals */}
          {r.liveSignals && r.liveSignals.length > 0 && (
            <div style={{ display:"flex", gap:5, flexWrap:"wrap", marginBottom:6 }}>
              {r.liveSignals.map((sig, i) => (
                <div key={i} style={{ display:"flex", alignItems:"center", gap:4, padding:"3px 7px", borderRadius:3, background:"rgba(34,197,94,0.06)", border:"1px solid rgba(34,197,94,0.15)" }}>
                  <span className="cop-pulse" style={{ fontSize:9, color:C.success }}>●</span>
                  <span style={{ fontSize:10, color:C.dim }}>{sig.label}:</span>
                  <span style={{ fontSize:11, fontWeight:"bold", color:sig.color(live) }}>{sig.render(live)}</span>
                </div>
              ))}
            </div>
          )}
          {r.liveSignals && r.liveSignals.length === 0 && (
            <div style={{ padding:"3px 7px", borderRadius:3, background:"rgba(82,97,117,0.15)", border:`1px solid ${C.surfBorder}`, marginBottom:6, display:"inline-block" }}>
              <span style={{ fontSize:10, color:C.dim }}>STATIC — no API publishes this classification at required latency</span>
            </div>
          )}
          <div style={{ fontSize:10, color:C.dim }}>SOURCES: {r.sources.join(" · ")}</div>
        </div>
      )}
    </div>
  );
};

const ScreenRiskClusters = ({ live }) => {
  const [expanded, setExpanded] = useState({});
  const toggle = (id) => setExpanded(p=>({...p,[id]:!p[id]}));
  return (
    <div>
      {/* NCS Score */}
      <div style={{ display:"flex", alignItems:"center", gap:16, padding:12, borderRadius:6, marginBottom:12, background:"rgba(239,68,68,0.06)", border:"1px solid rgba(239,68,68,0.15)" }}>
        <div>
          <div style={{ fontSize:11, color:C.muted, letterSpacing:"0.05em" }}>NATIONAL CONSEQUENCE SCORE</div>
          <div style={{ display:"flex", alignItems:"baseline", gap:4 }}>
            <span style={{ fontSize:36, fontWeight:"bold", color:C.critical }}>72</span>
            <span style={{ fontSize:16, color:C.muted }}>/100 HIGH</span>
          </div>
          <div style={{ fontSize:10, color:C.dim }}>Composite model · STATIC</div>
        </div>
        <div style={{ display:"flex", gap:8 }}>
          {[{l:"POP",v:18,m:25},{l:"INFRA",v:20,m:25},{l:"ECON",v:18,m:25},{l:"SEC",v:22,m:25}].map((f,i)=>(
            <div key={i} style={{ textAlign:"center", padding:"6px 10px", background:C.surface, borderRadius:4 }}>
              <div style={{ fontSize:10, color:C.muted }}>{f.l}</div>
              <div style={{ fontSize:18, fontWeight:"bold", color:C.fg }}>{f.v}</div>
              <div style={{ width:32, height:2, background:C.surfBorder, borderRadius:1, margin:"4px auto 0" }}>
                <div style={{ height:"100%", borderRadius:1, width:`${(f.v/f.m)*100}%`, background:f.v>20?C.critical:f.v>15?C.warning:C.success }}/>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Cluster Cards */}
      {CLUSTERS.map(c => {
        const sc = c.status==="CRITICAL"?C.critical:c.status==="ELEVATED"?C.warning:C.success;
        const isOpen = expanded[c.id];
        return (
          <div key={c.id} style={{ marginBottom:8, borderRadius:4, overflow:"hidden", border:`1px solid ${sc}22` }}>
            {/* Header row */}
            <div onClick={()=>toggle(c.id)} style={{ display:"flex", justifyContent:"space-between", alignItems:"center", padding:"10px 12px", cursor:"pointer", background:`${sc}08` }}>
              <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                <span style={{ fontWeight:"bold", fontSize:14, color:C.fg }}>{c.icon} {c.label}</span>
                <span style={{ fontSize:10, padding:"2px 6px", borderRadius:3, background:`${sc}22`, color:sc, fontWeight:"bold" }}>{c.status}</span>
                <span style={{ fontSize:11, color:C.muted }}>{c.risks} risks</span>
              </div>
              <div style={{ display:"flex", alignItems:"center", gap:6 }}>
                <span style={{ fontSize:11, color:C.muted }}>
                  {c.active>0&&`${c.active}🔴`} {c.elevated>0&&`${c.elevated}🟡`}
                </span>
                {c.decisions.length>0 && <span style={{ fontSize:10, padding:"2px 6px", borderRadius:3, background:"rgba(239,68,68,0.12)", color:C.critical }}>{c.decisions.length} decision{c.decisions.length>1?"s":""}</span>}
                <span style={{ fontSize:12, color:C.muted }}>{isOpen?"▾":"▸"}</span>
              </div>
            </div>
            {/* Expanded body */}
            {isOpen && (
              <div style={{ padding:"8px 12px", background:`${sc}04` }}>
                {c.riskItems.map((r,i) => <ClusterRiskItem key={i} r={r} live={live} />)}
                {c.decisions.length > 0 && (
                  <div style={{ marginTop:8, padding:"8px 10px", borderRadius:3, background:"rgba(239,68,68,0.06)", border:"1px solid rgba(239,68,68,0.15)" }}>
                    <div style={{ fontSize:11, color:C.critical, fontWeight:"bold", marginBottom:5 }}>⚡ DECISIONS REQUIRED</div>
                    {c.decisions.map((d,i) => {
                      const dc = d.severity==="critical"?C.critical:d.severity==="high"?C.warning:C.info;
                      return <div key={i} style={{ fontSize:12, color:C.fg, marginBottom:3 }}>▸ {d.title} <span style={{ color:dc }}>({d.window})</span></div>;
                    })}
                  </div>
                )}
                <div style={{ marginTop:8, fontSize:11, color:C.dim }}>
                  AGENCIES: {c.agencies.join(" · ")}
                </div>
              </div>
            )}
          </div>
        );
      })}

      {/* Dependency chain warning */}
      <div style={{ padding:12, borderRadius:4, marginTop:4, background:"rgba(239,68,68,0.06)", border:"1px solid rgba(239,68,68,0.12)" }}>
        <div style={{ fontSize:12, color:C.critical, fontWeight:"bold", marginBottom:4 }}>⚠ DEPENDENCY CHAIN</div>
        <div style={{ fontSize:13, color:"#fca5a5" }}>Eastern Province Power Grid → Jubail + Ras Al-Khair Desal → Water for 3.9M people. Grid strike = water crisis 48h.</div>
        <div style={{ fontSize:10, color:C.dim, marginTop:4 }}>SOURCES: SWCC · SEC annual reports · STATIC</div>
      </div>
    </div>
  );
};

// ─── SCREEN 3: INFRASTRUCTURE ─────────────────────────────────────────────────
const CI_KEY_MAP = {
  "Oil & Gas":"oilgas", "Airports":"airports",
  "Ports & Maritime":"ports", "Power Grid":"power",
  "Water / Desal":"water", "Telecom & Cyber":"telecom"
};

const ScreenInfra = ({ live }) => {
  const liveCI = live.ciStatus?.data;
  return (
  <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
    {CI_SECTORS.map(s=>{
      const key = CI_KEY_MAP[s.name];
      const merged = (liveCI && key && liveCI[key]) ? {
        ...s,
        status: liveCI[key].status ?? s.status,
        pct:    liveCI[key].pct    ?? s.pct,
        note:   liveCI[key].note   ?? s.note,
        feed:   liveCI[key].confidence === "CONFIRMED" ? "CONFIRMED" : "AI+WEB",
      } : s;
      const col=merged.status==="DEGRADED"||merged.status==="CRITICAL"?C.critical:merged.status==="DISRUPTED"?"#f97316":merged.status==="RESTRICTED"||merged.status==="ELEVATED"?C.warning:merged.status==="OFFLINE"?C.critical:C.success;
      const note = merged.feed==="IODA"&&live.ioda.value!==null?`Connectivity: ${live.ioda.value}% of baseline`:merged.note;
      return (
        <div key={merged.name} style={{ background:C.surface, border:`1px solid ${col}22`, borderRadius:6, padding:"12px 14px", boxShadow:"0 2px 12px rgba(0,0,0,0.18)" }}>
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:6 }}>
            <div style={{ display:"flex", alignItems:"center", gap:8 }}>
              <span style={{ fontSize:18 }}>{merged.icon}</span>
              <span style={{ fontSize:14, fontWeight:"bold", color:C.fg }}>{merged.name}</span>
              <StatusBadge s={merged.status}/>
            </div>
            <div style={{ display:"flex", gap:8, alignItems:"center" }}>
              <span style={{ fontSize:12, color:col, fontWeight:"bold" }}>{merged.pct}%</span>
              <FeedTag feed={merged.feed} loading={merged.feed==="IODA"&&live.ioda.loading}/>
            </div>
          </div>
          <div style={{ height:4, background:C.surfBorder, borderRadius:2, marginBottom:6 }}>
            <div style={{ height:"100%", width:`${merged.pct}%`, background:col, borderRadius:2 }}/>
          </div>
          <div style={{ fontSize:11, color:C.muted }}>{note}</div>
          {/* PORTWATCH + UKMTO maritime live block */}
          {s.name==="Ports & Maritime" && (live.portwatch?.data || live.ukmto?.data) && (
            <div style={{ marginTop:8, padding:"8px 10px", background:"rgba(255,255,255,0.03)", borderRadius:3, borderLeft:`2px solid #3b82f6` }}>
              <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:6 }}>
                <span style={{ fontSize:8, fontWeight:"bold", color:C.fg }}>MARITIME INTELLIGENCE</span>
                <div style={{ display:"flex", gap:5 }}>
                  {live.portwatch?.data?.source==="PORTWATCH" && <FeedTag feed="PORTWATCH"/>}
                  {live.ukmto?.data?.source==="UKMTO" && <FeedTag feed="UKMTO"/>}
                  {(live.portwatch?.data?.source==="FALLBACK" || live.ukmto?.data?.source==="FALLBACK") && <FeedTag feed="STATIC"/>}
                </div>
              </div>
              {/* Hormuz status row */}
              {live.portwatch?.data?.hormuz && (() => {
                const h = live.portwatch.data.hormuz;
                const pct = h.transitPct;
                const col = pct===0?"#ef4444":pct<40?"#ef4444":pct<70?"#f59e0b":"#22c55e";
                const label = (h.transitCalls===0||pct===0)?"CLOSED":pct<40?"NEAR-CLOSED":pct<70?"DISRUPTED":"RESTRICTED";
                return (
                  <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:4 }}>
                    <span style={{ fontSize:8, color:C.muted }}>Hormuz transit</span>
                    <div style={{ display:"flex", alignItems:"center", gap:6 }}>
                      <span style={{ fontSize:8, fontWeight:"bold", color:col }}>{h.transitCalls !== null ? h.transitCalls : "—"} calls/day</span>
                      <span style={{ fontSize:7, padding:"1px 5px", borderRadius:3, background:`${col}20`, color:col }}>{label}</span>
                      {pct !== null && <span style={{ fontSize:7, color:C.dim }}>{pct}% baseline</span>}
                    </div>
                  </div>
                );
              })()}
              {/* GCC port throughput */}
              {live.portwatch?.data?.ports?.length > 0 && (
                <div style={{ display:"flex", gap:5, flexWrap:"wrap", marginBottom:4 }}>
                  {live.portwatch.data.ports.map(p => {
                    const col = p.pct===null?"#7d8fa3":p.pct<40?"#ef4444":p.pct<70?"#f59e0b":p.pct<100?"#eab308":"#22c55e";
                    return (
                      <div key={p.name} style={{ fontSize:7, padding:"2px 7px", borderRadius:3, background:`${col}15`, color:col }}>
                        {p.name} {p.pct !== null ? `${p.pct}%` : "—"}
                      </div>
                    );
                  })}
                  <span style={{ fontSize:7, color:C.dim, alignSelf:"center" }}>vs 2023 baseline</span>
                </div>
              )}
              {/* UKMTO advisory chip */}
              {live.ukmto?.data && (() => {
                const u = live.ukmto.data;
                const hCol = (s => s==="SUSPENDED"||s==="CLOSED"?"#ef4444":s==="RESTRICTED"||s==="DISRUPTED"?"#f59e0b":"#22c55e")(u.hormuzStatus);
                return (
                  <div style={{ display:"flex", flexDirection:"column", gap:3, paddingTop:4, borderTop:`1px solid ${C.surfBorder}` }}>
                    <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
                      <span style={{ fontSize:7, color:C.muted }}>UKMTO Advisory {u.advisory}</span>
                      <div style={{ display:"flex", gap:4 }}>
                        <span style={{ fontSize:7, padding:"1px 5px", borderRadius:3, background:`${hCol}20`, color:hCol }}>{u.hormuzStatus}</span>
                        {u.gnssInterference && <span style={{ fontSize:7, padding:"1px 5px", borderRadius:3, background:"rgba(239,68,68,0.12)", color:"#ef4444" }}>GNSS ⚠</span>}
                      </div>
                    </div>
                    <span style={{ fontSize:7, color:C.muted, lineHeight:1.4 }}>{u.text}</span>
                    <span style={{ fontSize:6, color:C.dim }}>Updated {u.date} · {u.source}</span>
                  </div>
                );
              })()}
            </div>
          )}
        </div>
      );
    })}
  </div>
  );
};

// ─── SCREEN 4: DECISIONS ──────────────────────────────────────────────────────

const DECISIONS_SEED = [
  {
    id:1, severity:'CRITICAL', domain:'ENERGY', window:'48H',
    keyDev:'Brent settled at $92.69/bbl (+19.9% vs pre-conflict baseline of $77.24). Supply disruption estimated at 4–4.7 mb/d. Aramco Ras Tanura export terminal struck by drone 04 Mar. Trade disruption — not production — is the binding constraint.',
    implication:'GCC faces revenue paradox — high prices but blocked export routes. Saudi/UAE spare capacity cannot reach markets. Hormuz closure forces reliance on Red Sea pipeline route (5M bbl/day capacity) currently underutilised.',
    decision:'Accelerate Aramco Red Sea export route activation. Coordinate Saudi-UAE spare capacity via non-Hormuz routes. Ring-fence any windfall revenue — do not expand recurrent spending.',
    sources:'OPA 07 Mar, EIA 02 Mar, Reuters 04 Mar',
    liveKey:'ciStatus', liveField:'energy'
  },
  {
    id:2, severity:'CRITICAL', domain:'LOGISTICS', window:'24H',
    keyDev:'Strait of Hormuz paralysed — Day 7. 200+ ships stranded off Iraq, Saudi Arabia, Qatar. 8 vessels hit since conflict began. VLCC rates at all-time high $423,736/day (+94%). War risk insurance surged 5×. Major insurers dropped cover (Gard, Skuld, NorthStandard, London P&I, American Club). Maersk suspended cargo to 8 GCC countries.',
    implication:'GCC export/import logistics frozen. Insurance withdrawal makes transit commercially unviable even if physically possible. Ports effectively cut off. Each closure day estimated at $4.2B global economic impact.',
    decision:'Engage US Navy on escort proposal. Coordinate emergency berthing at Oman Sohar and Red Sea ports. Activate bilateral shipping agreements. Prepare for weeks-long logistics disruption — not days.',
    sources:'Reuters 04 Mar, CNBC 03 Mar, UKMTO 003-26'
  },
  {
    id:3, severity:'CRITICAL', domain:'DEFENCE', window:'24H',
    keyDev:'Iran launched 1,000+ drones and missiles at Gulf states. 65 drones penetrated UAE air defences. Strikes hit AWS UAE data centres, Dubai International Airport, Aramco Ras Tanura. Iran drone production capacity: 10,000/month. Sea mine stockpile: 5,000–6,000. Economist: Gulf states may be running low on interceptors.',
    implication:'GCC states are active targets with demonstrated air defence penetration. Critical infrastructure (ports, airports, data centres, energy terminals) directly vulnerable. Sea mine deployment could extend Hormuz closure by months beyond ceasefire.',
    decision:'Coordinate joint GCC missile/drone defence allocation. Establish protected perimeters for Tier-1 CI. Engage US on extended air defence umbrella. Activate backup data centre failover to non-Gulf regions. Begin scenario planning for sea mine clearance operations.',
    sources:'Reuters 04 Mar, CNBC 03 Mar, Economist 03 Mar',
    liveKey:'gccStrikes'
  },
  {
    id:4, severity:'HIGH', domain:'ECONOMIC', window:'72H',
    keyDev:'Dubai stocks slumped most since 2022 on market reopen. Maersk suspended cargo to 8 GCC countries. Force majeure declarations by Asian LNG partners signal extended commercial disruption. FDI confidence damaged by physical attacks on GCC soil.',
    implication:'GCC financial markets under severe pressure. Trade routes frozen across all modalities. Asian refiners cutting output. Economic disruption extends beyond conflict duration due to perception and insurance effects.',
    decision:'Deploy central bank liquidity facilities without altering dollar peg. Establish strategic communications cell for investors and media. Host investor roadshow within 30 days of de-escalation. Prepare emergency trade corridor agreements with non-Gulf partners.',
    sources:'Bloomberg 04 Mar, Reuters 04 Mar, CNBC 03 Mar'
  },
  {
    id:5, severity:'HIGH', domain:'ENERGY', window:'72H',
    keyDev:'Iran drone production at 10,000/month could sustain Hormuz disruption for months. Sea mine stockpile 5,000–6,000 could prolong disruption even after ceasefire. Conflict duration risk currently underpriced per Vitol senior executive and Rapidan Energy.',
    implication:'GCC cannot assume rapid normalisation. Extended disruption (3+ months) would exhaust strategic reserves and expose domestic supply gaps. Current planning horizon likely too short.',
    decision:'Begin scenario planning for extended (3+ month) Hormuz disruption. Accelerate non-Hormuz energy and trade infrastructure. Coordinate with CENTCOM on mine countermeasures readiness. Review bilateral security agreements with urgency.',
    sources:'Reuters 04 Mar, Economist 03 Mar, Vitol/Rapidan 04 Mar'
  },
];

const DOMAIN_COLORS = { ENERGY:C.warning, DEFENCE:C.critical, LOGISTICS:'#f97316', ECONOMIC:C.info, HEALTH:C.success };

const DecisionTable = ({ live }) => {
  const rows = DECISIONS_SEED.map(row => {
    let keyDev = row.keyDev;
    let sources = row.sources;
    // Live overlay: ciStatus for energy row 1
    if (row.liveKey === 'ciStatus' && live?.ciStatus?.value) {
      try {
        const ci = typeof live.ciStatus.value === 'string' ? JSON.parse(live.ciStatus.value) : live.ciStatus.value;
        if (ci?.energy) {
          const e = ci.energy;
          const extra = e.note ? ` CI Status: Energy sector at ${e.pct || '—'}% — ${e.note}.` : '';
          if (extra) { keyDev = keyDev + extra; sources = sources + ', AI+WEB'; }
        }
      } catch {}
    }
    // Live overlay: gccStrikes for defence row 3
    if (row.liveKey === 'gccStrikes' && live?.gccStrikes?.value) {
      try {
        const gs = typeof live.gccStrikes.value === 'string' ? JSON.parse(live.gccStrikes.value) : live.gccStrikes.value;
        if (gs) {
          const ksaCount = gs.ksa?.total ?? gs.ksa_total ?? null;
          const uaeCount = gs.uae?.total ?? gs.uae_total ?? null;
          if (ksaCount !== null || uaeCount !== null) {
            const extra = ` Live strike count: KSA ${ksaCount ?? '—'}, UAE ${uaeCount ?? '—'}.`;
            keyDev = keyDev + extra;
            sources = sources + ', AI+WEB';
          }
        }
      } catch {}
    }
    return { ...row, keyDev, sources };
  });

  const windowColor = w => {
    if (w.includes('24')) return C.critical;
    if (w.includes('48') || w.includes('72')) return C.warning;
    return C.muted;
  };

  const headers = ['#','SEV','DOMAIN','KEY DEVELOPMENT','IMPLICATIONS','DECISION REQUIRED','WINDOW','SOURCES'];

  return (
    <div style={{ overflowX:'auto', background:C.surface, border:`1px solid ${C.surfBorder}`, borderRadius:4 }}>
      <table style={{ width:'100%', borderCollapse:'collapse', fontFamily:"'JetBrains Mono',monospace", fontSize:11 }}>
        <thead>
          <tr>
            {headers.map(h => (
              <th key={h} style={{ textAlign:'left', padding:'8px 10px', textTransform:'uppercase', letterSpacing:'0.1em', fontSize:10, color:C.dim, fontWeight:600, borderBottom:`1px solid ${C.surfBorder}`, whiteSpace:'nowrap' }}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, idx) => {
            const isCrit = row.severity === 'CRITICAL';
            const isLast = idx === rows.length - 1;
            const domCol = DOMAIN_COLORS[row.domain] || C.muted;
            const wCol = windowColor(row.window);
            return (
              <tr key={row.id} style={{ borderBottom: isLast ? 'none' : `1px solid ${C.surfBorder}`, borderLeft:`3px solid ${isCrit ? C.critical : C.warning}` }}>
                <td style={{ padding:'12px 10px', color:C.dim, textAlign:'center', width:'3ch', verticalAlign:'top' }}>{row.id}</td>
                <td style={{ padding:'12px 10px', width:'9ch', verticalAlign:'top' }}>
                  <span style={{ padding:'3px 7px', borderRadius:3, fontSize:10, fontWeight:700, background: isCrit ? C.critical : C.warning, color: isCrit ? '#ffffff' : '#0a0a0a' }}>{row.severity}</span>
                </td>
                <td style={{ padding:'12px 10px', width:'11ch', verticalAlign:'top', color:domCol, fontWeight:600, fontSize:10, textTransform:'uppercase' }}>{row.domain}</td>
                <td style={{ padding:'12px 10px', width:'22%', lineHeight:1.6, color:C.fg, verticalAlign:'top' }}>{row.keyDev}</td>
                <td style={{ padding:'12px 10px', width:'22%', lineHeight:1.6, color:C.muted, verticalAlign:'top' }}>{row.implication}</td>
                <td style={{ padding:'12px 10px', width:'20%', lineHeight:1.6, color:'#e2e8f0', fontWeight:600, verticalAlign:'top' }}>{row.decision}</td>
                <td style={{ padding:'12px 10px', width:'7ch', verticalAlign:'top', fontFamily:"'JetBrains Mono',monospace", fontSize:11, color:wCol, fontWeight:600 }}>{row.window}</td>
                <td style={{ padding:'12px 10px', width:'10%', verticalAlign:'top', fontSize:10, color:C.dim, lineHeight:1.3 }}>{row.sources}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
};

const ScreenDecisions = ({ live }) => {
  return (
    <div>
      <DecisionTable live={live} />
    </div>
  );
};

// ─── SCREEN 5: ECONOMIC ───────────────────────────────────────────────────────
const ScreenEconomic = ({ live }) => (
  <div>
    {/* National Severity Level */}
    <div style={{ display:"flex", alignItems:"center", gap:16, padding:12, borderRadius:6, marginBottom:12, background:`${severityColor}08`, border:`1px solid ${severityColor}22` }}>
      <div>
        <div style={{ fontSize:11, color:C.muted, letterSpacing:"0.05em" }}>NATIONAL SEVERITY LEVEL</div>
        <div style={{ display:"flex", alignItems:"baseline", gap:6 }}>
          <span style={{ fontSize:38, fontWeight:"bold", color:severityColor }}>{severityLevel}</span>
          <span style={{ fontSize:16, color:C.muted }}>{severityLabel[severityLevel]}</span>
        </div>
        <div style={{ fontSize:11, color:C.dim }}>{severityScore}/100 · Auto-calculated composite</div>
      </div>
      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:4, flex:1 }}>
        {Object.entries(SEVERITY_FACTORS).map(([k,f])=>{
          const pct=(f.value/f.max)*100;
          const col=pct>=80?C.critical:pct>=60?C.warning:C.success;
          return (
            <div key={k} style={{ padding:"5px 8px", borderRadius:3, background:"rgba(255,255,255,0.02)", border:`1px solid ${C.surfBorder}` }}>
              <div style={{ display:"flex", justifyContent:"space-between", marginBottom:2 }}>
                <span style={{ fontSize:10, color:C.fg }}>{f.label}</span>
                <span style={{ fontSize:10, fontWeight:"bold", color:col }}>{f.value}/{f.max}</span>
              </div>
              <div style={{ height:2, background:C.surfBorder, borderRadius:1 }}>
                <div style={{ height:"100%", width:`${pct}%`, background:col, borderRadius:1 }}/>
              </div>
            </div>
          );
        })}
      </div>
    </div>
    {/* Live financial KPIs */}
    <div style={{ display:"flex", gap:6, marginBottom:12 }}>
      <KpiCard label="BRENT CRUDE" value={live.brent.value} change={live.brent.change} color={C.critical} feed={live.brent.source} loading={live.brent.loading} secondary={live.brent.secondary} secondaryColor={C.warning} />
      <KpiCard label="TASI INDEX"  value={live.tasi.value}  change={live.tasi.change}  color={C.critical} feed={live.tasi.source}  loading={live.tasi.loading} />
      <KpiCard label="DAILY COST"  value="$4.2B" note="Hormuz Day 7"      color={C.critical} feed="STATIC" />
      <KpiCard label="CUMULATIVE"  value="~$29B" note="7 days (est)"      color={C.critical} feed="STATIC" />
      <KpiCard label="SAR/USD PEG" value="3.75"  note="Stable · SAMA"     color={C.success}  feed="STATIC" />
    </div>

    {/* Strategic Reserves */}
    <div style={{ marginBottom:12 }}>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:8 }}>
        <span style={{ fontSize:13, fontWeight:"bold", color:C.fg }}>STRATEGIC RESERVES</span>
        <span style={{ fontSize:10, color:C.dim }}>STATIC · OSINT estimates + SAGO/MoH baselines</span>
      </div>
      <div style={{ display:"flex", flexDirection:"column", gap:4 }}>
        {RESERVES.map((r,i)=>(
          <div key={i} style={{ display:"flex", alignItems:"center", gap:8, padding:"8px 12px", background:C.surface, border:`1px solid ${C.surfBorder}`, borderRadius:4 }}>
            <div style={{ flex:2, fontSize:12, color:C.fg }}>{r.name}</div>
            <div style={{ flex:1 }}>
              {r.pct>0
                ? <div style={{ width:"100%", height:4, background:C.surfBorder, borderRadius:2 }}><div style={{ height:"100%", borderRadius:2, width:`${r.pct}%`, background:r.color }}/></div>
                : <div style={{ fontSize:11, color:C.dim }}>No data</div>}
            </div>
            <span style={{ width:40, textAlign:"right", fontSize:16, fontWeight:"bold", color:r.color }}>{r.days!==null?`${r.days}d`:"—"}</span>
            <span style={{ fontSize:9, padding:"2px 5px", borderRadius:3, background:C.surface, border:`1px solid ${C.surfBorder}`, color:C.dim }}>±{r.conf}</span>
            <StatusBadge s={r.status} />
          </div>
        ))}
      </div>
      <div style={{ marginTop:6, fontSize:10, color:C.dim }}>Confidence: 90-100 = verified · 70-89 = agency baseline · 50-69 = OSINT estimated · &lt;50 = unverified</div>
    </div>

    {/* Scenario comparison */}
    <div>
      <div style={{ fontSize:13, fontWeight:"bold", color:C.fg, marginBottom:8 }}>ECONOMIC SCENARIO COMPARISON</div>
      <div style={{ display:"flex", gap:6 }}>
        {[
          { sc:"Hormuz reopens 7d",    brent:"$82",   food:"-5%",  medical:"Adequate",           c:C.success },
          { sc:"Hormuz closed 30d",    brent:"$120+", food:"+40%", medical:"CRITICAL Day 21",     c:C.critical },
          { sc:"Closed + Abqaiq hit",  brent:"$150+", food:"+60%", medical:"Multiple critical",   c:C.critical },
        ].map((s,i)=>(
          <div key={i} style={{ flex:1, padding:12, borderRadius:4, background:`${s.c}06`, border:`1px solid ${s.c}22` }}>
            <div style={{ fontSize:12, fontWeight:"bold", color:s.c, marginBottom:8 }}>{s.sc}</div>
            <div style={{ fontSize:11, color:C.muted }}>Brent: <span style={{ color:C.fg }}>{s.brent}</span></div>
            <div style={{ fontSize:11, color:C.muted }}>Food price: <span style={{ color:C.fg }}>{s.food}</span></div>
            <div style={{ fontSize:11, color:C.muted }}>Medical: <span style={{ color:C.fg }}>{s.medical}</span></div>
          </div>
        ))}
      </div>
      <div style={{ marginTop:6, fontSize:10, color:C.dim }}>SOURCES: AI scenario modeling · Yahoo Finance · PortWatch · STATIC</div>
    </div>
  </div>
);

// ─── MEDIA & SOURCE WATCH (collapsible, used inside Situation tab) ────────────
const OUTLET_COLORS = { reuters:'#3b82f6', bloomberg:'#06b6d4', economist:'#8b5cf6', cnbc:'#f59e0b', ap:'#10b981', 'al jazeera':'#ef4444', 'oxford economics':'#8b5cf6' };
const SEED_HEADLINES = [
  { title:"Gulf shipping crisis deepens as tankers stranded for fifth day", domain:"reuters.com", seendate:"2H AGO", type:"NEWS REPORT" },
  { title:"Aramco explores oil exports from Red Sea to avoid Hormuz", domain:"bloomberg.com", seendate:"4H AGO", type:"EXCLUSIVE" },
  { title:"Are Gulf states running out of missile interceptors?", domain:"economist.com", seendate:"6H AGO", type:"ANALYSIS" },
  { title:"Oil supertanker rates hit all-time high as insurers drop cover", domain:"cnbc.com", seendate:"3H AGO", type:"NEWS REPORT" },
  { title:"Tourism impacts in Middle East from Iran War", domain:"oxfordeconomics.com", seendate:"5H AGO", type:"RESEARCH BRIEFING" },
];

const getOutletFromDomain = (domain) => {
  const d = (domain||"").toLowerCase();
  if (d.includes("reuters")) return "REUTERS";
  if (d.includes("bloomberg")) return "BLOOMBERG";
  if (d.includes("economist")) return "ECONOMIST";
  if (d.includes("cnbc")) return "CNBC";
  if (d.includes("apnews")||d.includes("ap.org")) return "AP";
  if (d.includes("aljazeera")) return "AL JAZEERA";
  if (d.includes("oxford")) return "OXFORD ECONOMICS";
  return domain?.split(".")[0]?.toUpperCase()||"OTHER";
};
const getOutletColor = (outlet) => {
  const key = outlet.toLowerCase();
  return OUTLET_COLORS[key] || '#6b7280';
};
const getContentType = (title) => {
  const t = (title||"").toLowerCase();
  if (t.includes("analysis")||t.includes("opinion")) return "ANALYSIS";
  if (t.includes("live")) return "LIVE BLOG";
  return "NEWS REPORT";
};
const timeAgo = (seendate) => {
  if (!seendate) return '';
  const s = String(seendate);
  const d = new Date(`${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}T${s.slice(8,10)}:${s.slice(10,12)}:${s.slice(12,14)}Z`);
  if (isNaN(d.getTime())) return '';
  const mins = Math.floor((Date.now() - d.getTime()) / 60000);
  if (mins < 60) return `${mins}M AGO`;
  if (mins < 1440) return `${Math.floor(mins/60)}H AGO`;
  return `${Math.floor(mins/1440)}D AGO`;
};

const MediaSourceWatch = ({ live }) => {
  const [open, setOpen] = useState(false);

  const gdeltArticles = live.gdelt.articles || [];
  const headlines = gdeltArticles.length > 0
    ? gdeltArticles.slice(0,5).map(a => ({
        title: a.title || a.Title || "",
        domain: a.domain || a.Domain || a.source_name || "",
        seendate: timeAgo(a.seendate || a.Seendate || ""),
        type: getContentType(a.title || a.Title || ""),
      }))
    : SEED_HEADLINES;

  return (
    <div style={{ marginTop:12 }}>
      {/* Header bar */}
      <div onClick={()=>setOpen(!open)} style={{ display:"flex", justifyContent:"space-between", alignItems:"center", padding:"10px 14px", background:C.surface, borderBottom:`1px solid ${C.surfBorder}`, borderRadius: open?"6px 6px 0 0":"6px", cursor:"pointer" }}>
        <span style={{ fontSize:13, fontWeight:700, color:C.fg, letterSpacing:"0.06em" }}>📡 MEDIA & SOURCE WATCH</span>
        <span style={{ fontSize:14, color:C.dim }}>{open?"▾":"▸"}</span>
      </div>

      {open && (
        <div style={{ background:C.surface, borderRadius:"0 0 6px 6px", border:`1px solid ${C.surfBorder}`, borderTop:"none", padding:14 }} className="cop-fade-in">

          {/* SUB-SECTION A: LIVE HEADLINES */}
          <div style={{ marginBottom:16 }}>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:8 }}>
              <span style={{ fontSize:11, color:C.muted, textTransform:"uppercase", letterSpacing:"0.08em" }}>LIVE HEADLINES</span>
              <FeedTag feed={gdeltArticles.length>0?"GDELT":"STATIC"} loading={live.gdelt.loading} />
            </div>
            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8 }}>
              {headlines.map((h,i) => (
                <div key={i} style={{ background:C.bg, border:`1px solid ${C.surfBorder}`, borderRadius:4, padding:"10px 12px", ...(i===headlines.length-1 && headlines.length%2!==0 ? {gridColumn:"1/-1"} : {}) }}>
                  <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:5 }}>
                    <span style={{ fontSize:10, padding:"2px 6px", borderRadius:3, background:`${getOutletColor(getOutletFromDomain(h.domain))}22`, color:getOutletColor(getOutletFromDomain(h.domain)), fontWeight:600 }}>{getOutletFromDomain(h.domain)}</span>
                    <span style={{ fontSize:10, color:C.dim }}>{h.seendate}</span>
                  </div>
                  <div style={{ fontSize:12, color:C.fg, lineHeight:1.5, display:"-webkit-box", WebkitLineClamp:2, WebkitBoxOrient:"vertical", overflow:"hidden" }}>{h.title}</div>
                  <div style={{ fontSize:10, color:C.dim, marginTop:4 }}>{h.type}</div>
                </div>
              ))}
            </div>
          </div>

          {/* SUB-SECTION B: NARRATIVE SIGNAL */}
          <div style={{ marginBottom:16 }}>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:8 }}>
              <span style={{ fontSize:11, color:C.muted, textTransform:"uppercase", letterSpacing:"0.08em" }}>NARRATIVE SIGNAL</span>
              <FeedTag feed="STATIC" />
            </div>
            {[
              { icon:"🌐", label:"INTERNATIONAL FRAME", value:"Economic shock + Hormuz closure dominating. Ceasefire speculation emerging." },
              { icon:"📺", label:"ARABIC MEDIA FRAME", value:"GCC resilience narrative. Saudi MoD statements prominent. Civilian impact in focus." },
            ].map((row,i)=>(
              <div key={i} style={{ padding:"6px 0", borderBottom:i===0?`1px solid ${C.surfBorder}30`:"none" }}>
                <div style={{ fontSize:10, color:C.dim, marginBottom:2 }}>{row.icon} {row.label}</div>
                <div style={{ fontSize:12, color:C.fg, lineHeight:1.5 }}>{row.value}</div>
              </div>
            ))}
          </div>

          {/* SUB-SECTION C: SOURCE TRANSPARENCY FOOTER */}
          <div style={{ borderTop:`1px solid ${C.surfBorder}`, padding:"8px 0 0", fontSize:10, color:C.dim, lineHeight:1.5 }}>
            SOURCES ACTIVE: GDELT (live) · OPA (live) · EIA (Mar 02 baseline) · UKMTO Advisory 003-26 (Mar 01) · Reuters · Bloomberg · The Economist · Oxford Economics — All published 03–07 Mar 2026
          </div>
        </div>
      )}
    </div>
  );
};

// ─── SCREEN 7: SCENARIOS ──────────────────────────────────────────────────────
const ScreenScenarios = () => {
  const [expandedFAQ, setExpandedFAQ] = useState(null);
  const FAQS = [
    { q:"What if Abqaiq is struck?",       a:"Abqaiq processes ~5.7M bbl/day. Successful strike removes ~5% global supply. 2019 precedent: prices +15% overnight. With Hormuz closed, Brent could exceed $150. KSA revenue loss: ~$500M/day from Abqaiq alone. Cascade: Jubail petrochemical halts." },
    { q:"When will food shortages start?",  a:"At current disruption (-60% Gulf ports), wheat reserves critical in ~38 days. Jeddah +18% extends to ~52 days. Medical supplies binding constraint at 30 days/55%. Desal chemicals critical at 21 days." },
    { q:"Economic cost so far?",            a:"Est. cumulative Day 1-7: ~$29B global (Hormuz). KSA-specific: ~$4.3B oil export revenue lost + ~$200M infrastructure damage. Offset: Brent at $98+ increases Yanbu pipeline export value." },
    { q:"Hormuz closed 30 days?",           a:"Day 30: Brent ~$120-140. Food +30-40%. Medical CRITICAL at Day 21. Desal chemicals CRITICAL at Day 18. SPR adequate (60 days remaining). Global recession risk. Most likely trigger for international intervention." },
    { q:"Which CI most at risk next?",      a:"Abqaiq (score 85, T1). Highest-value unharmed target, 2019 precedent, multiple approach vectors, 5.7M bbl/day = max economic impact. Secondary: Ras Al-Khair — single strike = power + water cascade." },
    { q:"Iran missile capacity remaining?", a:"Pre-war est: ~3,000 ballistic + ~1,000+ drones (INSS/AEI). Day 7 est ~47 confirmed launches. Remaining ~2,950+ ballistic. Production ~50/month — attrition sustainable for months. OSINT estimate only." },
  ];
  return (
    <div>
      {/* Scenario probability cards */}
      <div style={{ marginBottom:12 }}>
        <div style={{ fontSize:13, fontWeight:"bold", color:C.fg, marginBottom:8 }}>SCENARIO PROBABILITIES — Day 7</div>
        <div style={{ display:"flex", gap:8 }}>
          {SCENARIOS.map((s,i)=>(
            <div key={i} style={{ flex:1, padding:12, borderRadius:"0 0 4px 4px", background:`${s.color}06`, border:`1px solid ${s.color}22`, borderTop:`3px solid ${s.color}` }}>
              <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:6 }}>
                <span style={{ fontSize:12, fontWeight:"bold", color:s.color }}>{s.name}</span>
                <span style={{ fontSize:24, fontWeight:"bold", color:s.color }}>{s.prob}</span>
              </div>
              <div style={{ fontSize:11, color:C.muted, lineHeight:1.5 }}>{s.desc}</div>
              {/* Probability bar */}
              <div style={{ marginTop:8, height:3, background:C.surfBorder, borderRadius:2 }}>
                <div style={{ height:"100%", width:s.prob, background:s.color, borderRadius:2 }}/>
              </div>
            </div>
          ))}
        </div>
        <div style={{ marginTop:6, fontSize:10, color:C.dim }}>SOURCES: INSS · Alma Center · AI modeling · STATIC</div>
      </div>

      {/* FAQ / What-If */}
      <div>
        <div style={{ fontSize:13, fontWeight:"bold", color:C.fg, marginBottom:8 }}>WHAT-IF ANALYSIS</div>
        {FAQS.map((faq,i)=>(
          <div key={i} style={{ marginBottom:4, borderRadius:3, overflow:"hidden", border:`1px solid ${C.surfBorder}` }}>
            <div onClick={()=>setExpandedFAQ(expandedFAQ===i?null:i)} style={{ display:"flex", justifyContent:"space-between", alignItems:"center", padding:"8px 12px", cursor:"pointer", background:expandedFAQ===i?"rgba(59,130,246,0.08)":C.surface }}>
              <span style={{ fontSize:12, color:expandedFAQ===i?C.info:C.fg }}>{faq.q}</span>
              <span style={{ fontSize:12, color:C.dim }}>{expandedFAQ===i?"▾":"▸"}</span>
            </div>
            {expandedFAQ===i && (
              <div style={{ padding:"8px 12px", background:"rgba(255,255,255,0.01)", fontSize:12, color:C.muted, lineHeight:1.7 }}>
                {faq.a}
                <div style={{ marginTop:6, fontSize:10, color:C.dim }}>STATIC · INSS / Alma / OSINT synthesis</div>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
};

// ─── SCREEN 8: AI BRIEF ───────────────────────────────────────────────────────
const ScreenAIBrief = ({ live }) => {
  const [brief, setBrief] = useState(null);
  const [loading, setLoading] = useState(false);
  const [msgs, setMsgs] = useState([]);
  const [input, setInput] = useState("");
  const [chatLoading, setChatLoading] = useState(false);
  const chatRef = useRef(null);

  const ctx = `You are NEMA AI advising Saudi Minister of Interior. Day 7 Iran-GCC conflict (Feb 28–Mar 7 2026). Live data: Brent ${live.brent.value} (${live.brent.change}), TASI ${live.tasi.value}, Hormuz closed Day 7, 91 tankers holding, ~$4.2B/day impact, KSA 19 strikes 96% intercept, UAE 1276 projectiles, Qatar LNG halted + airspace closed, Ras Tanura 85%, Abqaiq near-miss Mar 4. KSA reserves: wheat 45d, rice 38d, medical 30d at 55%, fuel 60d. GDELT: ${live.gdelt.value}/24h conflict articles. IODA KSA connectivity: ${live.ioda.value!==null?live.ioda.value+"% baseline":"unavailable"}. Be concise, executive-grade, no preamble.`;

  const generateBrief = async () => {
    setLoading(true); setBrief(null);
    try {
      const res = await fetch(ANTHROPIC_PROXY_URL, {
        method:"POST", headers:{"Content-Type":"application/json"},
        body: JSON.stringify({ model:"claude-sonnet-4-20250514", max_tokens:600, system:ctx,
          messages:[{ role:"user", content:"Generate 200-word executive brief. Format: BOTTOM LINE UP FRONT (2 sentences). CRITICAL GAPS (3 bullets). DECISIONS REQUIRED IN 24H (2 bullets). Use hard numbers." }]
        })
      });
      const data = await res.json();
      setBrief(data.content?.[0]?.text || "API error");
    } catch(e) { setBrief(`Error: ${e.message}`); }
    setLoading(false);
  };

  const sendChat = async () => {
    if (!input.trim()||chatLoading) return;
    const q=input.trim(); setInput("");
    setMsgs(p=>[...p,{role:"user",content:q}]); setChatLoading(true);
    try {
      const res = await fetch(ANTHROPIC_PROXY_URL, {
        method:"POST", headers:{"Content-Type":"application/json"},
        body: JSON.stringify({ model:"claude-sonnet-4-20250514", max_tokens:400, system:ctx,
          messages:[...msgs.map(m=>({role:m.role,content:m.content})),{role:"user",content:q}]
        })
      });
      const data = await res.json();
      setMsgs(p=>[...p,{role:"assistant",content:data.content?.[0]?.text||"No response"}]);
    } catch(e) { setMsgs(p=>[...p,{role:"assistant",content:`Error: ${e.message}`}]); }
    setChatLoading(false);
    setTimeout(()=>chatRef.current?.scrollTo(0,9999),100);
  };

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
      <div style={{ background:C.surface, border:`1px solid ${C.surfBorder}`, borderRadius:4, padding:12 }}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:8 }}>
          <span style={{ fontSize:12, fontWeight:"bold", color:C.fg }}>▣ EXECUTIVE SITUATION BRIEF</span>
          <FeedTag feed="LIVE" />
        </div>
        <div style={{ fontSize:11, color:C.dim, marginBottom:8 }}>Brent {live.brent.value} · TASI {live.tasi.value} · GDELT {live.gdelt.value}/24h · Day 7 injected live</div>
        {!brief&&!loading&&<button onClick={generateBrief} style={{ padding:"8px 16px", background:"rgba(59,130,246,0.12)", border:"1px solid rgba(59,130,246,0.25)", borderRadius:3, color:C.info, fontSize:12, cursor:"pointer", fontFamily:"JetBrains Mono,monospace" }}>▣ GENERATE BRIEF</button>}
        {loading&&<div style={{ fontSize:12, color:C.muted }}><span className="cop-pulse">●</span> Generating from live data…</div>}
        {brief&&<div>
          <div style={{ fontSize:12, color:C.fg, lineHeight:1.8, whiteSpace:"pre-line", padding:"10px 12px", background:"rgba(255,255,255,0.02)", borderRadius:3, border:`1px solid ${C.surfBorder}` }}>{brief}</div>
          <button onClick={generateBrief} style={{ marginTop:8, padding:"4px 10px", background:"rgba(59,130,246,0.08)", border:"1px solid rgba(59,130,246,0.2)", borderRadius:3, color:C.info, fontSize:11, cursor:"pointer", fontFamily:"JetBrains Mono,monospace" }}>↻ REGENERATE</button>
        </div>}
      </div>
      <div style={{ background:C.surface, border:`1px solid ${C.surfBorder}`, borderRadius:4, padding:12 }}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:6 }}>
          <span style={{ fontSize:12, fontWeight:"bold", color:C.fg }}>💬 MINISTER QUERY — NEMA AI</span>
          <FeedTag feed="LIVE" />
        </div>
        {msgs.length===0&&<div style={{ display:"flex", gap:6, flexWrap:"wrap", marginBottom:8 }}>
          {["What if Abqaiq is hit?","When will food run out?","Economic cost so far?","Oman mediation options?","Worst-case 30 days?"].map(q=>(
            <button key={q} onClick={()=>setInput(q)} style={{ fontSize:10, padding:"4px 10px", background:"rgba(59,130,246,0.08)", border:"1px solid rgba(59,130,246,0.18)", borderRadius:3, color:C.info, cursor:"pointer", fontFamily:"JetBrains Mono,monospace" }}>{q}</button>
          ))}
        </div>}
        <div ref={chatRef} style={{ maxHeight:220, overflowY:"auto", marginBottom:8, display:"flex", flexDirection:"column", gap:6 }}>
          {msgs.map((m,i)=>(
            <div key={i} style={{ padding:"6px 8px", borderRadius:3, background:m.role==="user"?"rgba(59,130,246,0.08)":"rgba(255,255,255,0.02)", borderLeft:`2px solid ${m.role==="user"?C.info:C.muted}` }}>
              <div style={{ fontSize:10, color:C.dim, marginBottom:2 }}>{m.role==="user"?"MINISTER":"NEMA AI"}</div>
              <div style={{ fontSize:12, color:C.fg, lineHeight:1.6, whiteSpace:"pre-wrap" }}>{m.content}</div>
            </div>
          ))}
          {chatLoading&&<div style={{ padding:"6px 8px", borderRadius:3, background:"rgba(255,255,255,0.02)", borderLeft:`2px solid ${C.muted}` }}>
            <div style={{ fontSize:10, color:C.dim, marginBottom:2 }}>NEMA AI</div>
            <span className="cop-pulse" style={{ fontSize:12, color:C.muted }}>●●●</span>
          </div>}
        </div>
        <div style={{ display:"flex", gap:6 }}>
          <input value={input} onChange={e=>setInput(e.target.value)} onKeyDown={e=>e.key==="Enter"&&sendChat()}
            placeholder="Ask anything about the situation…"
            style={{ flex:1, padding:"8px 10px", background:"rgba(255,255,255,0.04)", border:`1px solid ${C.surfBorder}`, borderRadius:3, color:C.fg, fontSize:11, fontFamily:"JetBrains Mono,monospace" }}
          />
          <button onClick={sendChat} disabled={chatLoading}
            style={{ padding:"6px 12px", background:"rgba(59,130,246,0.12)", border:"1px solid rgba(59,130,246,0.25)", borderRadius:3, color:chatLoading?C.muted:C.info, fontSize:11, cursor:"pointer", fontFamily:"JetBrains Mono,monospace" }}>
            {chatLoading?"…":"SEND"}
          </button>
        </div>
      </div>
    </div>
  );
};

// ─── MAIN ─────────────────────────────────────────────────────────────────────
export default function NEMACOPLive() {
  const [tab, setTab] = useState(0);
  const [lastRefresh, setLastRefresh] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [live, setLive] = useState({
    brent: { value:"$92.69", change:"+28.0% wk", source:"STATIC", loading:false },
    tasi:  { value:"10,290", change:"−3.9% wk",  source:"STATIC", loading:false },
    gdelt: { value:20, articles:[], source:"STATIC", loading:false },
    ioda:  { value:null, source:"IODA", loading:false },
    gcc:   { data:null, loading:false, error:false },
    portwatch: { loading:false, error:null, data:null },
    ukmto:     { loading:false, error:null, data:null },
    ksaStrikes: { loading:false, error:null, data:null },
    ciStatus: { loading:false, error:null, data:null },
  });

  const refresh = useCallback(async () => {
    if (_refreshLock) { console.warn("[COP] refresh already in progress, skipping"); return; }
    _refreshLock = true;
    setRefreshing(true);
    setLive(d=>({...d,
      brent:{...d.brent,loading:true}, tasi:{...d.tasi,loading:true},
      gdelt:{...d.gdelt,loading:true}, ioda:{...d.ioda,loading:true},
      gcc:{...d.gcc,loading:true,error:false},
      portwatch:{...d.portwatch,loading:true},
      ukmto:{...d.ukmto,loading:true},
      ksaStrikes:{...d.ksaStrikes,loading:true},
      ciStatus:{...d.ciStatus,loading:true},
    }));

    // Fetch non-AI feeds + AI cache in parallel
    const [eia, opa, gdelt, ioda, pw, cacheRes] = await Promise.allSettled([
      fetchEIABrent(), fetchOPABrent(), fetchGdelt(), fetchIoda(), fetchPortWatch(),
      supabase.from('ai_cache').select('key, data, updated_at'),
    ]);

    // Parse AI cache results
    const cache = {};
    if (cacheRes.status === "fulfilled" && cacheRes.value?.data) {
      for (const row of cacheRes.value.data) {
        cache[row.key] = row.data;
      }
    }
    const cacheAge = cacheRes.status === "fulfilled" && cacheRes.value?.data?.length
      ? cacheRes.value.data[0]?.updated_at : null;
    const cacheSource = Object.keys(cache).length ? "CACHED" : "STATIC";

    setLive(d=>{
      const n={...d};
      if (opa.status==="fulfilled"&&opa.value) {
        const opaPrice = opa.value;
        const eiaBase = eia.status==="fulfilled" ? eia.value.price : null;
        const premium = eiaBase ? +(opaPrice - eiaBase).toFixed(2) : null;
        const premiumPct = eiaBase ? +(((opaPrice - eiaBase) / eiaBase) * 100).toFixed(1) : null;
        const eiaChg = eia.status==="fulfilled" ? eia.value.change : null;
        n.brent={
          value:`$${opaPrice.toFixed(2)}`,
          change: eiaChg || d.brent.change,
          source:"OPA+EIA",
          loading:false,
          secondary: premium!==null ? `CONFLICT PREMIUM +$${premium.toFixed(2)} / +${premiumPct}%` : null,
        };
      } else if (eia.status==="fulfilled") {
        n.brent={value:`$${eia.value.price.toFixed(2)}`,change:eia.value.change,source:"EIA",loading:false};
      } else { n.brent={...d.brent,source:"STATIC",loading:false}; }

      // AI feeds from cache
      const fin = cache.financial;
      if (fin?.tasi) {
        n.tasi={value:Number(fin.tasi).toLocaleString(),change:fin.tasiChg||d.tasi.change,source:cacheSource,loading:false};
      } else { n.tasi={...d.tasi,source:"STATIC",loading:false}; }

      n.gdelt = gdelt.status==="fulfilled"?{value:gdelt.value.count,articles:gdelt.value.articles||[],source:"GDELT",loading:false}:{...d.gdelt,source:"STATIC",loading:false};
      n.ioda  = ioda.status==="fulfilled"&&ioda.value!==null?{value:ioda.value,source:"IODA",loading:false}:{value:null,source:"IODA",loading:false};

      const gccData = cache.gcc_strikes;
      n.gcc = gccData ? {data:gccData,loading:false,error:false} : {data:d.gcc.data,loading:false,error:!Object.keys(cache).length};

      n.portwatch = { loading:false, error:pw.status==="rejected"?pw.reason?.message:null, data:pw.status==="fulfilled"?pw.value:null };

      const ukmtoData = cache.ukmto;
      n.ukmto = { loading:false, error:null, data:ukmtoData||null };

      const ksaData = cache.ksa_strikes;
      n.ksaStrikes = { loading:false, error:null, data:ksaData||null };

      const ciData = cache.ci_status;
      n.ciStatus = { loading:false, error:null, data:ciData||null };

      return n;
    });
    setLastRefresh(new Date());
    setRefreshing(false);
    _refreshLock = false;
  }, []);

  useEffect(()=>{refresh();},[refresh]);

  const fmt = d=>d?`${d.getHours().toString().padStart(2,"0")}:${d.getMinutes().toString().padStart(2,"0")}`:"--:--";

  const TABS = [
    { label:"SITUATION",              icon:"◉" },
    { label:"RISK CLUSTERS",          icon:"⬡" },
    { label:"CRITICAL INFRASTRUCTURE",icon:"⚙" },
    { label:"CONSEQUENCES",           icon:"◈" },
    { label:"DECISIONS",              icon:"▣" },
    { label:"SCENARIOS",              icon:"⚠" },
    { label:"AI BRIEF",              icon:"🤖" },
  ];

  const screens = [
    <ScreenSituation    live={live}/>,
    <ScreenRiskClusters live={live}/>,
    <ScreenInfra        live={live}/>,
    <ScreenEconomic     live={live}/>,
    <ScreenDecisions    live={live}/>,
    <ScreenScenarios />,
    <ScreenAIBrief      live={live}/>,
  ];

  return (
    <>
      <style dangerouslySetInnerHTML={{__html:CSS}}/>
      <div style={{background:C.bg,minHeight:"100vh",display:"flex",flexDirection:"column",fontFamily:"'JetBrains Mono','SF Mono','Fira Code',monospace"}}>

        {/* HEADER */}
        <header style={{background:"#0a1628",borderBottom:`1px solid ${C.surfBorder}`,padding:"12px 20px",display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:12}}>
          <div style={{display:"flex",alignItems:"center",gap:14}}>
            <div style={{width:38,height:38,borderRadius:6,background:"linear-gradient(135deg,#1e40af,#1e3a8a)",border:"1px solid #3b82f644",display:"flex",alignItems:"center",justifyContent:"center",fontSize:16,boxShadow:"0 0 20px rgba(59,130,246,0.15)"}}>⬡</div>
            <div>
              <div style={{fontSize:16,fontWeight:700,letterSpacing:"0.14em",color:C.fg}}>National Common Operating Picture</div>
              <div style={{fontSize:10,color:C.dim,letterSpacing:"0.1em",marginTop:2}}>MINISTER VIEW · LIVE DEMO</div>
            </div>
          </div>
          <div style={{display:"flex",gap:10,flexWrap:"wrap"}}>
            {[["HORMUZ","CLOSED D7",C.critical],["KSA AIRSPACE","RESTRICTED",C.warning],["CIVIL DEFENSE","ACTIVATED",C.success],["THREAT","CRITICAL",C.critical]].map(([l,v,c])=>(
              <div key={l} style={{textAlign:"center"}}>
                <div style={{fontSize:10,color:C.dim,letterSpacing:"0.06em",marginBottom:3}}>{l}</div>
                <span style={{fontSize:11,padding:"3px 10px",borderRadius:4,background:`${c}14`,color:c,border:`1px solid ${c}28`,fontWeight:600}}>{v}</span>
              </div>
            ))}
          </div>
          <div style={{fontSize:11,color:C.dim,textAlign:"right"}}>
            <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:4}}>
              <span style={{color:C.success,fontWeight:600}}>● Day 7 · 07 MAR 2026</span>
              <button onClick={refresh} disabled={refreshing} style={{padding:"4px 10px",background:"rgba(34,197,94,0.1)",border:"1px solid rgba(34,197,94,0.25)",borderRadius:4,color:refreshing?C.dim:C.success,fontSize:10,cursor:"pointer",fontFamily:"JetBrains Mono,monospace",fontWeight:600}}>
                {refreshing?<span className="cop-pulse">↻ FETCHING…</span>:"↻ REFRESH LIVE"}
              </button>
            </div>
            <div style={{fontSize:10,color:C.dim}}>Last fetch: {fmt(lastRefresh)}</div>
            <div style={{marginTop:4,display:"flex",gap:5}}>
              {[["#22c55e","AI+WEB"],["#22c55e","CONFIRMED"],["#f97316","EST"],["#f59e0b","GDELT"],["#3b82f6","IODA"],["#526175","STATIC"]].map(([c,l])=>(
                <span key={l} style={{fontSize:9,padding:"2px 6px",borderRadius:3,background:`${c}14`,color:c,fontWeight:500}}>{l}</span>
              ))}
            </div>
          </div>
        </header>

        {/* LIVE STATUS BAR */}
        <div style={{background:"#0a1220",borderBottom:`1px solid ${C.surfBorder}`,padding:"6px 20px",display:"flex",gap:16,alignItems:"center",flexWrap:"wrap"}}>
          <span style={{fontSize:10,color:C.dim,fontWeight:600,letterSpacing:"0.08em"}}>LIVE:</span>
          {[
            {l:"BRENT", src:live.brent.source, loading:live.brent.loading, v:live.brent.value},
            {l:"TASI",  src:live.tasi.source,  loading:live.tasi.loading,  v:live.tasi.value},
            {l:"GDELT", src:live.gdelt.source, loading:live.gdelt.loading, v:`${live.gdelt.value}/24h`},
            {l:"IODA",  src:live.ioda.source,  loading:live.ioda.loading,  v:live.ioda.value!==null?`${live.ioda.value}%`:"N/A"},
            {l:"GCC",   src:live.gcc.data?"AI+WEB":"STATIC", loading:live.gcc.loading, v:live.gcc.error?"⚠ failed":live.gcc.data?"✓ sourced":"seed"},
          ].map(f=>(
            <div key={f.l} style={{display:"flex",alignItems:"center",gap:5}}>
              <span style={{fontSize:10,color:C.dim,fontWeight:500}}>{f.l}:</span>
              {f.loading?<span className="cop-pulse" style={{fontSize:10,color:C.info}}>●</span>:<span style={{fontSize:10,color:f.src==="STATIC"?C.dim:C.success,fontWeight:500}}>{f.v}</span>}
              <FeedTag feed={f.src} loading={f.loading}/>
            </div>
          ))}
          <span style={{marginLeft:"auto",fontSize:10,color:C.dim}}>CORS-blocked: Yahoo Finance direct · NASA FIRMS · PortWatch (use server-side proxy in repo)</span>
        </div>

        {/* TAB BAR */}
        <nav style={{display:"flex",background:"#0a1628",borderBottom:`1px solid ${C.surfBorder}`,overflowX:"auto"}}>
          {TABS.map((t,i)=>(
            <button key={i} onClick={()=>setTab(i)} style={{
              padding:"10px 16px", background:tab===i?"#192233":"transparent",
              border:"none", borderBottom:tab===i?`2px solid ${C.info}`:"2px solid transparent",
              cursor:"pointer", color:tab===i?C.fg:C.muted,
              fontFamily:"'JetBrains Mono',monospace", fontSize:11,
              fontWeight:tab===i?700:500, letterSpacing:"0.08em",
              whiteSpace:"nowrap", transition:"all 0.15s ease",
            }}>
              {t.icon} {t.label}
            </button>
          ))}
        </nav>

        {/* CONTENT */}
        <main style={{flex:1,overflowY:"auto",padding:"18px 20px"}}>{screens[tab]}</main>

        {/* FOOTER */}
        <footer style={{borderTop:`1px solid ${C.surfBorder}`,padding:"8px 20px",background:"#0a1220",display:"flex",justifyContent:"space-between",fontSize:10,color:C.dim,flexWrap:"wrap",gap:6}}>
          <span>BRENT · TASI · GCC STRIKES: Claude API + web_search · GDELT: gdeltproject.org · IODA: inetintel.cc.gatech.edu · All other: STATIC / OSINT</span>
          <span style={{color:"#f97316"}}>PENDING SERVER-SIDE: Yahoo Finance direct · NASA FIRMS · OpenWeatherMap · PortWatch · ACLED</span>
        </footer>
      </div>
    </>
  );
}
