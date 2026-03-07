import { useState, useEffect, useCallback, useRef, memo } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

const CSS = `
  @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700&display=swap');
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body, #root { background: #060b17; color: #d8e6f5; font-family: 'JetBrains Mono','SF Mono','Fira Code',monospace; -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale; }
  @keyframes cop-pulse { 0%,100%{opacity:1} 50%{opacity:0.35} }
  @keyframes strike-pulse { 0%{transform:scale(1);opacity:0.9} 50%{transform:scale(2.2);opacity:0} 100%{transform:scale(1);opacity:0} }
  .strike-ping { position:absolute; border-radius:50%; animation: strike-pulse 2s ease-out infinite; }
  .leaflet-container { background: #060b17 !important; }
  .leaflet-control-attribution { display: none !important; }
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
  { code:"SA", name:"🇸🇦 KSA",     airspace:"RESTRICTED", strikes:19,   interceptPct:96, confidence:"CONFIRMED", source:"Saudi MoD spokesman",     note:"96% intercept. Ras Tanura degraded. Abqaiq near-miss Mar 4." },
  { code:"AE", name:"🇦🇪 UAE",     airspace:"RESTRICTED", strikes:1276, interceptPct:92, confidence:"CONFIRMED", source:"UAE MoD press conference",  note:"Jebel Ali + Dubai T3 + French base hit." },
  { code:"QA", name:"🇶🇦 Qatar",   airspace:"CLOSED",     strikes:115,  interceptPct:90, confidence:"EST",       source:"CTP-ISW / LWJ",             note:"Al Udeid 2 BM impacts. LNG suspended." },
  { code:"KW", name:"🇰🇼 Kuwait",  airspace:"RESTRICTED", strikes:484,  interceptPct:88, confidence:"EST",       source:"KUNA / US DoD",             note:"Ali Al Salem struck. US Embassy hit." },
  { code:"BH", name:"🇧🇭 Bahrain", airspace:"RESTRICTED", strikes:198,  interceptPct:85, confidence:"EST",       source:"NAVCENT / Alma Research",   note:"5th Fleet HQ struck. Bapco refinery hit." },
  { code:"OM", name:"🇴🇲 Oman",    airspace:"OPEN",       strikes:4,    interceptPct:50, confidence:"EST",       source:"ONA / Reuters",             note:"Duqm Port drone. Mediator status." },
];

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
  if (loading) return <span style={{ fontSize:7, padding:"2px 6px", borderRadius:4, background:"rgba(59,130,246,0.15)", color:C.info, letterSpacing:"0.04em" }} className="cop-pulse">●</span>;
  const map = { "AI+WEB":[C.success,"AI+WEB"], LIVE:[C.success,"LIVE"], CONFIRMED:[C.success,"CONFIRMED"], EST:["#f97316","EST"], GDELT:[C.warning,"GDELT"], STATIC:[C.dim,"STATIC"], IODA:[C.info,"IODA"] };
  const [col, lbl] = map[feed] || [C.muted, feed];
  return <span style={{ fontSize:7, padding:"2px 6px", borderRadius:4, background:`${col}18`, color:col, letterSpacing:"0.04em", fontWeight:500 }}>{lbl}</span>;
};

const StatusBadge = ({ s }) => {
  const map = { DEGRADED:C.critical, RESTRICTED:C.warning, DISRUPTED:"#f97316", ELEVATED:C.warning, OPERATIONAL:C.success, CRITICAL:C.critical, CLOSED:C.critical, OPEN:C.success, CLEAR:C.success, ATTENTION:"#f59e0b", ADEQUATE:C.success, UNKNOWN:"#64748b" };
  const col = map[s] || C.muted;
  return <span style={{ fontSize:8, padding:"2px 8px", borderRadius:4, background:`${col}14`, color:col, border:`1px solid ${col}28`, fontWeight:600, letterSpacing:"0.05em" }}>{s}</span>;
};

const KpiCard = ({ label, value, change, color, note, feed, loading }) => (
  <div style={{ flex:1, padding:"10px 12px", background:C.surface, border:`1px solid ${C.surfBorder}`, borderRadius:6, textAlign:"center", minWidth:90, boxShadow:"0 2px 8px rgba(0,0,0,0.2)" }}>
    <div style={{ fontSize:7, color:C.muted, letterSpacing:"0.08em", marginBottom:4, textTransform:"uppercase", fontWeight:500 }}>{label}</div>
    {loading
      ? <div style={{ fontSize:16, fontWeight:700, color:C.info, marginBottom:4 }} className="cop-pulse">…</div>
      : <div style={{ fontSize:17, fontWeight:700, color:color||C.fg, marginBottom:4, lineHeight:1.1 }}>{value}</div>
    }
    <div style={{ display:"flex", justifyContent:"center", gap:5, alignItems:"center", flexWrap:"wrap" }}>
      {(change||note) && <span style={{ fontSize:7, color:C.dim }}>{change||note}</span>}
      <FeedTag feed={feed} loading={loading} />
    </div>
  </div>
);

// ─── FETCHERS ─────────────────────────────────────────────────────────────────
async function fetchFinancial() {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method:"POST", headers:{"Content-Type":"application/json"},
    body: JSON.stringify({
      model:"claude-sonnet-4-20250514", max_tokens:400,
      tools:[{ type:"web_search_20250305", name:"web_search" }],
      messages:[{ role:"user", content:"Find current Brent crude price and Saudi TASI index today. Reply ONLY: BRENT:XX.XX BRENTCHG:+X.X% TASI:XXXXX TASICHG:-X.X%" }]
    })
  });
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
  return (data.articles||[]).length;
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
  const res = await fetch("https://api.anthropic.com/v1/messages", {
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

// ─── LEAFLET THEATER MAP (plain Leaflet, no react-leaflet) ───────────────────
const GCC_CAPITALS = {
  SA: [24.69, 46.63], AE: [24.47, 54.37], QA: [25.28, 51.53],
  KW: [29.37, 47.98], BH: [26.22, 50.59], OM: [23.61, 58.59],
};

const LeafletTheaterMap = memo(({ filteredStrikes, getMarkers, theaterView, gccMarkers }) => {
  const mapRef = useRef(null);
  const mapContainerRef = useRef(null);
  const layersRef = useRef([]);

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
          icon: L.divIcon({
            className: "",
            html: isCritical
              ? `<div style="position:relative;width:14px;height:14px"><div class="strike-ping" style="width:14px;height:14px;border:1px solid ${col};top:0;left:0"></div><div style="position:absolute;top:3px;left:3px;width:8px;height:8px;border-radius:50%;background:${col};opacity:0.9"></div></div>`
              : `<div style="width:8px;height:8px;border-radius:50%;background:${col};opacity:0.9"></div>`,
            iconSize: [14, 14], iconAnchor: [7, 7],
          }),
        }).addTo(map);
        layersRef.current.push(m);
        // Country label
        const lbl = L.marker(coords, {
          icon: L.divIcon({
            className: "",
            html: `<div style="color:${col};font-size:8px;font-family:JetBrains Mono,monospace;font-weight:600;white-space:nowrap">${g.code} ${g.strikes.toLocaleString()}</div>`,
            iconSize: [0, 0], iconAnchor: [-10, 4],
          }),
        }).addTo(map);
        layersRef.current.push(lbl);
      });
    } else {
      // KSA EVENT LOG — only KSA markers
      const markers = getMarkers();
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
  const filteredStrikes = isCumulative ? STRIKES_KSA : STRIKES_KSA.filter(s => s.day === activeDay);

  const getMarkers = () => {
    const strikes = isCumulative ? STRIKES_KSA : STRIKES_KSA.filter(s => s.day === activeDay);
    return strikes.map(s => ({ lat:s.lat, lng:s.lng, s:s.sev }));
  };

  // Build GCC theater data (all 6 countries) with per-day filtering
  const getGCCTheaterData = () => {
    const ksaDayCount = isCumulative ? STRIKES_KSA.length : STRIKES_KSA.filter(s=>s.day===activeDay).length;
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

  const dateTabs = ["CUMULATIVE", ...STRIKE_DAYS];

  return (
    <div>
      <div style={{ display:"flex", gap:8, marginBottom:12, flexWrap:"wrap" }}>
        <KpiCard label="STRIKES KSA"  value="19"     change="+3/24h"                color={C.critical} feed="CONFIRMED" />
        <KpiCard label="INTERCEPTS"   value="96%"    note="Patriot/THAAD"           color={C.success}  feed="CONFIRMED" />
        <KpiCard label="BRENT CRUDE"  value={live.brent.value} change={live.brent.change} color={C.warning} feed={live.brent.source} loading={live.brent.loading} />
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
            const isActive = activeDay === t;
            const dayStrikes = t==="CUMULATIVE" ? STRIKES_KSA.length : STRIKES_KSA.filter(s=>s.day===t).length;
            return (
              <button key={t} onClick={()=>{setActiveDay(t);setSelEvent(null);}} style={{
                padding:"8px 14px", border:"none", cursor:"pointer", whiteSpace:"nowrap",
                background:isActive?"#192233":"transparent",
                borderBottom:isActive?`2px solid ${C.info}`:"2px solid transparent",
                color:isActive?C.fg:C.muted, fontSize:7, fontWeight:isActive?700:500,
                fontFamily:"'JetBrains Mono',monospace", letterSpacing:"0.06em",
                display:"flex", alignItems:"center", gap:5, transition:"all 0.15s ease",
              }}>
                {t==="CUMULATIVE"?"⊞ ":""}{t}
                {dayStrikes > 0 && <span style={{ fontSize:6, padding:"1px 4px", borderRadius:3, background:isActive?`${C.info}22`:`${C.dim}22`, color:isActive?C.info:C.dim, fontWeight:700 }}>{dayStrikes}</span>}
              </button>
            );
          })}
        </div>

        {/* Map + Right Panel */}
        <div style={{ display:"flex", gap:0 }}>
          {/* Left: Theater Map */}
          <div style={{ flex:1.3, padding:14, borderRight:`1px solid ${C.surfBorder}` }}>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:8 }}>
              <span style={{ fontSize:9, fontWeight:700, color:C.fg, letterSpacing:"0.08em" }}>THEATER MAP{!isCumulative?` · ${activeDay}`:""}</span>
              <div style={{ display:"flex", gap:5, alignItems:"center" }}>
                <span style={{ fontSize:8, color:C.muted }}>{filteredStrikes.length} strike{filteredStrikes.length!==1?"s":""}</span>
                <FeedTag feed="STATIC" />
                <div style={{ display:"flex", marginLeft:8, borderRadius:4, overflow:"hidden", border:`1px solid ${C.surfBorder}` }}>
                  {[["LOG","KSA EVENT LOG"],["GCC","GCC THEATER"]].map(([k,label])=>(
                    <button key={k} onClick={()=>setTheaterView(k)} style={{
                      padding:"3px 8px", border:"none", cursor:"pointer",
                      background:theaterView===k?C.info+"22":"transparent",
                      color:theaterView===k?C.info:C.dim, fontSize:7, fontWeight:theaterView===k?700:500,
                      fontFamily:"'JetBrains Mono',monospace", letterSpacing:"0.04em",
                    }}>{label}</button>
                  ))}
                </div>
              </div>
            </div>
            <LeafletTheaterMap filteredStrikes={filteredStrikes} getMarkers={getMarkers} theaterView={theaterView} gccMarkers={getGCCTheaterData()} />
          </div>

          {/* Right column */}
          <div style={{ flex:1, maxHeight: theaterView === "GCC" ? undefined : 380, overflowY: theaterView === "GCC" ? "hidden" : "auto", display:"flex", flexDirection:"column" }}>
            {theaterView === "LOG" ? (
              <>
                {/* KSA Event Log */}
                <div style={{ padding:14, borderBottom:`1px solid ${C.surfBorder}` }}>
                  <div style={{ display:"flex", justifyContent:"space-between", marginBottom:8 }}>
                    <span style={{ fontSize:9, fontWeight:700, color:C.fg, letterSpacing:"0.08em" }}>KSA EVENT LOG</span>
                    <span style={{ fontSize:7, color:C.dim }}>{filteredStrikes.length} event{filteredStrikes.length!==1?"s":""}</span>
                  </div>
                  {filteredStrikes.length === 0 ? (
                    <div style={{ padding:"12px 0", fontSize:8, color:C.dim, textAlign:"center" }}>No KSA strikes recorded for {activeDay}</div>
                  ) : (
                    <div style={{ display:"flex", flexDirection:"column", gap:3 }}>
                      {filteredStrikes.map(e => {
                        const col = e.sev==="critical"?C.critical:C.warning;
                        return (
                          <div key={e.id} onClick={()=>setSelEvent(selEvent===e.id?null:e.id)}
                            style={{ padding:"6px 8px", borderRadius:4, cursor:"pointer", background:selEvent===e.id?`${col}12`:"rgba(255,255,255,0.02)", borderLeft:`2px solid ${col}`, transition:"background 0.1s" }}>
                            <div style={{ display:"flex", justifyContent:"space-between" }}>
                              <span style={{ fontSize:8, fontWeight:700, color:col }}>{e.type}</span>
                              <span style={{ fontSize:7, color:C.dim }}>{e.time}</span>
                            </div>
                            <div style={{ fontSize:8, color:C.fg, marginTop:2 }}>{e.loc}</div>
                            {selEvent===e.id && <div style={{ fontSize:8, color:e.status.includes("Hit")?C.critical:C.success, marginTop:3 }}>{e.status}</div>}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>

                {/* Divider label */}
                <div style={{ padding:"6px 14px", background:"#0a1628", borderBottom:`1px solid ${C.surfBorder}`, display:"flex", justifyContent:"space-between", alignItems:"center" }}>
                  <span style={{ fontSize:8, fontWeight:700, color:C.dim, letterSpacing:"0.08em" }}>GCC COUNTRIES</span>
                  <FeedTag feed="STATIC" />
                </div>

                {/* GCC Country Rows */}
                <div style={{ padding:14 }}>
                  <div style={{ display:"flex", flexDirection:"column", gap:4 }}>
                    {getGCCForDay().map(g => {
                      const col = g.strikes > 100 ? C.critical : g.strikes > 0 ? C.warning : C.success;
                      return (
                        <div key={g.code} style={{ display:"flex", alignItems:"center", gap:8, padding:"7px 9px", borderRadius:4, background:"rgba(255,255,255,0.02)", borderLeft:`2px solid ${col}` }}>
                          <span style={{ fontSize:9, fontWeight:600, color:C.fg, width:72, flexShrink:0 }}>{g.name}</span>
                          <div style={{ flex:1, display:"flex", alignItems:"center", gap:6 }}>
                            <span style={{ fontSize:12, fontWeight:700, color:col }}>{g.strikes.toLocaleString()}</span>
                            <span style={{ fontSize:7, color:C.dim }}>{isCumulative?"total":"today"}</span>
                          </div>
                          <span style={{ fontSize:7, padding:"2px 5px", borderRadius:3, background:`${C.success}14`, color:C.success, fontWeight:600 }}>{g.interceptPct}% ✓</span>
                        </div>
                      );
                    })}
                  </div>
                  <div style={{ marginTop:8, fontSize:7, color:C.dim, lineHeight:1.5 }}>
                    {getGCCForDay().filter(g=>g.strikes>0).slice(0,2).map(g=>g.note).join(" ")}
                  </div>
                </div>
              </>
            ) : (
              /* GCC THEATER view */
              <div style={{ padding:"8px 10px", display:"flex", flexDirection:"column", gap:3, flex:1, justifyContent:"space-between", overflowY: expandedCountry ? "auto" : "hidden" }}>
                {getGCCTheaterData().map(g => {
                  const airCol = g.airspace==="CLOSED"?C.critical:g.airspace==="RESTRICTED"?C.warning:C.success;
                  const confCol = g.confidence==="CONFIRMED"?C.success:"#f97316";
                  const isExpanded = expandedCountry === g.code;
                  return (
                    <div key={g.code}>
                      <div onClick={()=>setExpandedCountry(isExpanded?null:g.code)}
                        style={{ padding:"6px 10px", borderRadius:isExpanded?"4px 4px 0 0":4, background:isExpanded?"rgba(255,255,255,0.04)":"rgba(255,255,255,0.02)", border:`1px solid ${C.surfBorder}`, borderLeft:`3px solid ${airCol}`, cursor:"pointer", transition:"background 0.15s", borderBottom:isExpanded?"none":`1px solid ${C.surfBorder}` }}>
                        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:3 }}>
                          <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                            <span style={{ fontSize:8, color:C.dim, fontWeight:500, letterSpacing:"0.06em" }}>{g.code}</span>
                            <span style={{ fontSize:10, fontWeight:700, color:C.fg }}>{g.name}</span>
                            <span style={{ fontSize:7, padding:"2px 6px", borderRadius:3, background:`${airCol}22`, color:airCol, fontWeight:600 }}>{g.airspace}</span>
                          </div>
                          <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                            <span style={{ fontSize:18, fontWeight:800, color:airCol, lineHeight:1 }}>{g.strikes.toLocaleString()}</span>
                            <span style={{ fontSize:9, color:C.dim, transition:"transform 0.2s", transform:isExpanded?"rotate(180deg)":"rotate(0)" }}>▾</span>
                          </div>
                        </div>
                        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
                          <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                            <span style={{ fontSize:8, padding:"2px 6px", borderRadius:3, background:`${C.success}14`, color:C.success, fontWeight:600 }}>✓ {g.interceptPct}%</span>
                            <span style={{ fontSize:7, padding:"2px 6px", borderRadius:3, background:`${confCol}18`, color:confCol, fontWeight:500 }}>{g.confidence}</span>
                          </div>
                        </div>
                        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-end", marginTop:3 }}>
                          <span style={{ fontSize:8, color:C.muted, flex:1 }}>{g.note}</span>
                          <span style={{ fontSize:7, color:C.dim, whiteSpace:"nowrap", marginLeft:8 }}>{g.source}</span>
                        </div>
                      </div>
                      {/* Expandable commentary panel */}
                      <div style={{
                        maxHeight: isExpanded ? 200 : 0,
                        overflow: "hidden",
                        transition: "max-height 0.3s ease, opacity 0.25s ease, padding 0.3s ease",
                        opacity: isExpanded ? 1 : 0,
                        background: "rgba(255,255,255,0.02)",
                        borderLeft: `3px solid ${airCol}`,
                        border: isExpanded ? `1px solid ${C.surfBorder}` : "none",
                        borderTop: "none",
                        borderRadius: "0 0 4px 4px",
                        padding: isExpanded ? "10px 12px" : "0 12px",
                      }}>
                        <div style={{ fontSize:8, color:C.fg, marginBottom:6, lineHeight:1.6 }}>
                          <span style={{ fontWeight:700, color:airCol }}>SITUATION: </span>
                          {g.note} {g.airspace === "CLOSED" ? "All commercial flights suspended." : g.airspace === "RESTRICTED" ? "Military operations ongoing, limited civilian access." : "Airspace open with heightened monitoring."}
                        </div>
                        <div style={{ fontSize:8, color:C.muted, marginBottom:4 }}>
                          <span style={{ fontWeight:600, color:C.fg }}>INTERCEPT RATE: </span>
                          {g.interceptPct}% — {g.interceptPct >= 95 ? "Near-total defense effectiveness." : g.interceptPct >= 85 ? "High effectiveness, occasional penetration." : g.interceptPct >= 50 ? "Moderate effectiveness, significant leakage risk." : "Low intercept capability."}
                        </div>
                        <div style={{ fontSize:8, color:C.muted, marginBottom:4 }}>
                          <span style={{ fontWeight:600, color:C.fg }}>AIRSPACE: </span>
                          {g.airspace} — {g.code === "QA" ? "Al Udeid operations impacted. LNG exports halted." : g.code === "AE" ? "Dubai/Abu Dhabi airports at reduced capacity. Jebel Ali port restricted." : g.code === "KW" ? "Ali Al Salem base struck. US military assets relocating." : g.code === "BH" ? "5th Fleet HQ damage assessed. Bapco refinery offline." : g.code === "OM" ? "Maintaining neutrality. Duqm port under watch." : "Eastern Province infrastructure primary target."}
                        </div>
                        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", paddingTop:5, borderTop:`1px solid ${C.surfBorder}40` }}>
                          <span style={{ fontSize:7, color:confCol }}>{g.confidence === "CONFIRMED" ? "✓ CONFIRMED" : "~ ESTIMATED"}</span>
                          <span style={{ fontSize:7, color:C.dim }}>{g.source}</span>
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
      <GCCTheater gcc={live.gcc} />
      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10 }}>
        <div style={{ background:C.surface, border:`1px solid ${C.surfBorder}`, borderRadius:6, padding:14, boxShadow:"0 2px 12px rgba(0,0,0,0.18)" }}>
          <div style={{ display:"flex", justifyContent:"space-between", marginBottom:8 }}>
            <span style={{ fontSize:10, fontWeight:700, color:C.fg, letterSpacing:"0.08em" }}>AIRSPACE</span>
            <FeedTag feed="STATIC" />
          </div>
          {[{l:"KSA",s:"RESTRICTED"},{l:"Qatar",s:"CLOSED"},{l:"UAE",s:"RESTRICTED"},{l:"Kuwait",s:"RESTRICTED"},{l:"Bahrain",s:"RESTRICTED"},{l:"Oman",s:"OPEN"}].map(a=>(
            <div key={a.l} style={{ display:"flex", justifyContent:"space-between", padding:"3px 0", borderBottom:`1px solid ${C.surfBorder}30` }}>
              <span style={{ fontSize:9, color:C.fg }}>{a.l}</span><StatusBadge s={a.s}/>
            </div>
          ))}
        </div>
        <div style={{ background:C.surface, border:`1px solid ${C.surfBorder}`, borderRadius:6, padding:14, boxShadow:"0 2px 12px rgba(0,0,0,0.18)" }}>
          <div style={{ display:"flex", justifyContent:"space-between", marginBottom:8 }}>
            <span style={{ fontSize:10, fontWeight:700, color:C.fg, letterSpacing:"0.08em" }}>MARITIME CHOKEPOINTS</span>
            <FeedTag feed="STATIC" />
          </div>
          {[{l:"Strait of Hormuz",s:"CLOSED",n:"0/35 transits. ~91 tankers holding."},{l:"Bab al-Mandeb",s:"RESTRICTED",n:"28/35 transits. Houthi quiet."},{l:"Suez Canal",s:"OPERATIONAL",n:"No disruption."}].map(m=>(
            <div key={m.l} style={{ padding:"5px 0", borderBottom:`1px solid ${C.surfBorder}30` }}>
              <div style={{ display:"flex", justifyContent:"space-between", marginBottom:2 }}>
                <span style={{ fontSize:9, color:C.fg, fontWeight:"bold" }}>{m.l}</span><StatusBadge s={m.s}/>
              </div>
              <span style={{ fontSize:8, color:C.muted }}>{m.n}</span>
            </div>
          ))}
        </div>
      </div>
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
      <div onClick={()=>setOpen(!open)} style={{ display:"flex", justifyContent:"space-between", alignItems:"center", padding:"7px 10px", cursor:"pointer", background:`${sevColor(r.severity)}06` }}>
        <div style={{ display:"flex", alignItems:"center", gap:7 }}>
          <span style={{ fontSize:9, color:C.fg }}>{statIcon(r.status)} <strong>{r.id}</strong> — {r.name}</span>
        </div>
        <div style={{ display:"flex", alignItems:"center", gap:5 }}>
          <span style={{ fontSize:7, padding:"1px 5px", borderRadius:3, background:`${sevColor(r.severity)}22`, color:sevColor(r.severity) }}>{r.severity.toUpperCase()}</span>
          <FeedTag feed={r.badge} />
          <span style={{ fontSize:9, color:C.dim }}>{open?"▾":"▸"}</span>
        </div>
      </div>
      {open && (
        <div style={{ padding:"8px 10px", background:"rgba(255,255,255,0.01)" }}>
          <div style={{ fontSize:9, color:C.muted, marginBottom:6, lineHeight:1.5 }}>{r.detail}</div>
          {/* Live signals */}
          {r.liveSignals && r.liveSignals.length > 0 && (
            <div style={{ display:"flex", gap:5, flexWrap:"wrap", marginBottom:6 }}>
              {r.liveSignals.map((sig, i) => (
                <div key={i} style={{ display:"flex", alignItems:"center", gap:4, padding:"3px 7px", borderRadius:3, background:"rgba(34,197,94,0.06)", border:"1px solid rgba(34,197,94,0.15)" }}>
                  <span className="cop-pulse" style={{ fontSize:6, color:C.success }}>●</span>
                  <span style={{ fontSize:7, color:C.dim }}>{sig.label}:</span>
                  <span style={{ fontSize:8, fontWeight:"bold", color:sig.color(live) }}>{sig.render(live)}</span>
                </div>
              ))}
            </div>
          )}
          {r.liveSignals && r.liveSignals.length === 0 && (
            <div style={{ padding:"3px 7px", borderRadius:3, background:"rgba(82,97,117,0.15)", border:`1px solid ${C.surfBorder}`, marginBottom:6, display:"inline-block" }}>
              <span style={{ fontSize:7, color:C.dim }}>STATIC — no API publishes this classification at required latency</span>
            </div>
          )}
          <div style={{ fontSize:7, color:C.dim }}>SOURCES: {r.sources.join(" · ")}</div>
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
          <div style={{ fontSize:8, color:C.muted, letterSpacing:"0.05em" }}>NATIONAL CONSEQUENCE SCORE</div>
          <div style={{ display:"flex", alignItems:"baseline", gap:4 }}>
            <span style={{ fontSize:30, fontWeight:"bold", color:C.critical }}>72</span>
            <span style={{ fontSize:12, color:C.muted }}>/100 HIGH</span>
          </div>
          <div style={{ fontSize:7, color:C.dim }}>Composite model · STATIC</div>
        </div>
        <div style={{ display:"flex", gap:8 }}>
          {[{l:"POP",v:18,m:25},{l:"INFRA",v:20,m:25},{l:"ECON",v:18,m:25},{l:"SEC",v:22,m:25}].map((f,i)=>(
            <div key={i} style={{ textAlign:"center", padding:"6px 10px", background:C.surface, borderRadius:4 }}>
              <div style={{ fontSize:7, color:C.muted }}>{f.l}</div>
              <div style={{ fontSize:14, fontWeight:"bold", color:C.fg }}>{f.v}</div>
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
                <span style={{ fontWeight:"bold", fontSize:11, color:C.fg }}>{c.icon} {c.label}</span>
                <span style={{ fontSize:7, padding:"1px 5px", borderRadius:3, background:`${sc}22`, color:sc, fontWeight:"bold" }}>{c.status}</span>
                <span style={{ fontSize:8, color:C.muted }}>{c.risks} risks</span>
              </div>
              <div style={{ display:"flex", alignItems:"center", gap:6 }}>
                <span style={{ fontSize:8, color:C.muted }}>
                  {c.active>0&&`${c.active}🔴`} {c.elevated>0&&`${c.elevated}🟡`}
                </span>
                {c.decisions.length>0 && <span style={{ fontSize:7, padding:"1px 5px", borderRadius:3, background:"rgba(239,68,68,0.12)", color:C.critical }}>{c.decisions.length} decision{c.decisions.length>1?"s":""}</span>}
                <span style={{ fontSize:9, color:C.muted }}>{isOpen?"▾":"▸"}</span>
              </div>
            </div>
            {/* Expanded body */}
            {isOpen && (
              <div style={{ padding:"8px 12px", background:`${sc}04` }}>
                {c.riskItems.map((r,i) => <ClusterRiskItem key={i} r={r} live={live} />)}
                {c.decisions.length > 0 && (
                  <div style={{ marginTop:8, padding:"8px 10px", borderRadius:3, background:"rgba(239,68,68,0.06)", border:"1px solid rgba(239,68,68,0.15)" }}>
                    <div style={{ fontSize:8, color:C.critical, fontWeight:"bold", marginBottom:5 }}>⚡ DECISIONS REQUIRED</div>
                    {c.decisions.map((d,i) => {
                      const dc = d.severity==="critical"?C.critical:d.severity==="high"?C.warning:C.info;
                      return <div key={i} style={{ fontSize:9, color:C.fg, marginBottom:3 }}>▸ {d.title} <span style={{ color:dc }}>({d.window})</span></div>;
                    })}
                  </div>
                )}
                <div style={{ marginTop:8, fontSize:8, color:C.dim }}>
                  AGENCIES: {c.agencies.join(" · ")}
                </div>
              </div>
            )}
          </div>
        );
      })}

      {/* Dependency chain warning */}
      <div style={{ padding:12, borderRadius:4, marginTop:4, background:"rgba(239,68,68,0.06)", border:"1px solid rgba(239,68,68,0.12)" }}>
        <div style={{ fontSize:9, color:C.critical, fontWeight:"bold", marginBottom:4 }}>⚠ DEPENDENCY CHAIN</div>
        <div style={{ fontSize:10, color:"#fca5a5" }}>Eastern Province Power Grid → Jubail + Ras Al-Khair Desal → Water for 3.9M people. Grid strike = water crisis 48h.</div>
        <div style={{ fontSize:7, color:C.dim, marginTop:4 }}>SOURCES: SWCC · SEC annual reports · STATIC</div>
      </div>
    </div>
  );
};

// ─── SCREEN 3: INFRASTRUCTURE ─────────────────────────────────────────────────
const ScreenInfra = ({ live }) => (
  <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
    {CI_SECTORS.map(s=>{
      const col=s.status==="DEGRADED"||s.status==="CRITICAL"?C.critical:s.status==="DISRUPTED"?"#f97316":s.status==="RESTRICTED"||s.status==="ELEVATED"?C.warning:C.success;
      const note = s.feed==="IODA"&&live.ioda.value!==null?`Connectivity: ${live.ioda.value}% of baseline`:s.note;
      return (
        <div key={s.name} style={{ background:C.surface, border:`1px solid ${col}22`, borderRadius:6, padding:"12px 14px", boxShadow:"0 2px 12px rgba(0,0,0,0.18)" }}>
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:6 }}>
            <div style={{ display:"flex", alignItems:"center", gap:8 }}>
              <span style={{ fontSize:14 }}>{s.icon}</span>
              <span style={{ fontSize:11, fontWeight:"bold", color:C.fg }}>{s.name}</span>
              <StatusBadge s={s.status}/>
            </div>
            <div style={{ display:"flex", gap:8, alignItems:"center" }}>
              <span style={{ fontSize:9, color:col, fontWeight:"bold" }}>{s.pct}%</span>
              <FeedTag feed={s.feed} loading={s.feed==="IODA"&&live.ioda.loading}/>
            </div>
          </div>
          <div style={{ height:4, background:C.surfBorder, borderRadius:2, marginBottom:6 }}>
            <div style={{ height:"100%", width:`${s.pct}%`, background:col, borderRadius:2 }}/>
          </div>
          <div style={{ fontSize:8, color:C.muted }}>{note}</div>
        </div>
      );
    })}
  </div>
);

// ─── SCREEN 4: DECISIONS ──────────────────────────────────────────────────────
const ScreenDecisions = () => {
  const sevOrder = { critical:0, high:1, medium:2 };
  const allDecisions = CLUSTERS.flatMap(c=>c.decisions.map(d=>({...d,cluster:c.label,clusterIcon:c.icon,clusterColor:c.color})));
  const sorted = [...allDecisions].sort((a,b)=>sevOrder[a.severity]-sevOrder[b.severity]);
  return (
    <div>
      {/* Summary bar */}
      <div style={{ display:"flex", gap:6, marginBottom:12 }}>
        {[
          { l:"DECISIONS PENDING", v:sorted.length, c:C.critical },
          { l:"≤24H WINDOW",  v:sorted.filter(d=>d.window.includes("6h")||d.window.includes("12h")||d.window.includes("24h")).length, c:C.critical },
          { l:"≤48H WINDOW",  v:sorted.filter(d=>d.window.includes("48h")).length, c:C.warning },
          { l:"≤72H WINDOW",  v:sorted.filter(d=>d.window.includes("72h")).length, c:C.info },
        ].map((item,i)=>(
          <div key={i} style={{ flex:1, padding:"10px 12px", background:C.surface, border:`1px solid ${item.c}22`, borderRadius:4, textAlign:"center" }}>
            <div style={{ fontSize:7, color:C.muted, letterSpacing:"0.05em" }}>{item.l}</div>
            <div style={{ fontSize:22, fontWeight:"bold", color:item.c, margin:"4px 0" }}>{item.v}</div>
          </div>
        ))}
      </div>

      <div style={{ fontSize:9, color:C.dim, marginBottom:10 }}>Sorted by urgency · STATIC — scenario-generated decision matrix</div>

      <div style={{ display:"flex", flexDirection:"column", gap:6 }}>
        {sorted.map((d,i)=>{
          const sc = d.severity==="critical"?C.critical:d.severity==="high"?C.warning:C.info;
          return (
            <div key={i} style={{ padding:"12px 14px", borderRadius:"0 4px 4px 0", background:`${sc}06`, border:`1px solid ${sc}22`, borderLeft:`3px solid ${sc}` }}>
              <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:6 }}>
                <span style={{ fontSize:11, fontWeight:"600", color:C.fg, flex:1, marginRight:8 }}>{d.title}</span>
                <span style={{ fontSize:10, fontWeight:"bold", padding:"2px 10px", borderRadius:3, background:`${sc}22`, color:sc, whiteSpace:"nowrap" }}>⏱ {d.window}</span>
              </div>
              <div style={{ display:"flex", gap:6 }}>
                <span style={{ fontSize:7, padding:"1px 7px", borderRadius:3, background:`${d.clusterColor}22`, color:d.clusterColor }}>{d.clusterIcon} {d.cluster}</span>
                <span style={{ fontSize:7, padding:"1px 7px", borderRadius:3, background:`${sc}22`, color:sc }}>{d.severity.toUpperCase()}</span>
              </div>
            </div>
          );
        })}
      </div>

      {/* Readiness snapshot */}
      <div style={{ marginTop:16 }}>
        <div style={{ fontSize:10, fontWeight:"bold", color:C.fg, marginBottom:8 }}>AGENCY READINESS SNAPSHOT</div>
        <div style={{ display:"flex", flexDirection:"column", gap:4 }}>
          {[
            { m:"Civil Defence", v:"ACTIVATED",    c:C.success, src:"SPA" },
            { m:"MoD EOC",       v:"ACTIVE",        c:C.success, src:"SPA" },
            { m:"National EOC",  v:"ACTIVATED",     c:C.success, src:"NEMA" },
            { m:"Provincial EOCs",v:"3 / 13 ACTIVE",c:C.warning, src:"NEMA" },
            { m:"Hospital Surge",v:"PHASE 1",       c:C.warning, src:"MoH" },
          ].map((r,i)=>(
            <div key={i} style={{ display:"flex", alignItems:"center", gap:10, padding:"6px 12px", background:C.surface, border:`1px solid ${C.surfBorder}`, borderRadius:3 }}>
              <span style={{ flex:2, fontSize:9, color:C.fg }}>{r.m}</span>
              <StatusBadge s={r.v.split(" ")[0]} />
              <span style={{ fontSize:7, color:C.dim }}>{r.v}</span>
              <span style={{ fontSize:7, color:C.dim, marginLeft:"auto" }}>SRC: {r.src} · STATIC</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

// ─── SCREEN 5: ECONOMIC ───────────────────────────────────────────────────────
const ScreenEconomic = ({ live }) => (
  <div>
    {/* Live financial KPIs */}
    <div style={{ display:"flex", gap:6, marginBottom:12 }}>
      <KpiCard label="BRENT CRUDE" value={live.brent.value} change={live.brent.change} color={C.critical} feed={live.brent.source} loading={live.brent.loading} />
      <KpiCard label="TASI INDEX"  value={live.tasi.value}  change={live.tasi.change}  color={C.critical} feed={live.tasi.source}  loading={live.tasi.loading} />
      <KpiCard label="DAILY COST"  value="$4.2B" note="Hormuz Day 7"      color={C.critical} feed="STATIC" />
      <KpiCard label="CUMULATIVE"  value="~$29B" note="7 days (est)"      color={C.critical} feed="STATIC" />
      <KpiCard label="SAR/USD PEG" value="3.75"  note="Stable · SAMA"     color={C.success}  feed="STATIC" />
    </div>

    {/* Strategic Reserves */}
    <div style={{ marginBottom:12 }}>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:8 }}>
        <span style={{ fontSize:10, fontWeight:"bold", color:C.fg }}>STRATEGIC RESERVES</span>
        <span style={{ fontSize:7, color:C.dim }}>STATIC · OSINT estimates + SAGO/MoH baselines</span>
      </div>
      <div style={{ display:"flex", flexDirection:"column", gap:4 }}>
        {RESERVES.map((r,i)=>(
          <div key={i} style={{ display:"flex", alignItems:"center", gap:8, padding:"8px 12px", background:C.surface, border:`1px solid ${C.surfBorder}`, borderRadius:4 }}>
            <div style={{ flex:2, fontSize:9, color:C.fg }}>{r.name}</div>
            <div style={{ flex:1 }}>
              {r.pct>0
                ? <div style={{ width:"100%", height:4, background:C.surfBorder, borderRadius:2 }}><div style={{ height:"100%", borderRadius:2, width:`${r.pct}%`, background:r.color }}/></div>
                : <div style={{ fontSize:8, color:C.dim }}>No data</div>}
            </div>
            <span style={{ width:40, textAlign:"right", fontSize:13, fontWeight:"bold", color:r.color }}>{r.days!==null?`${r.days}d`:"—"}</span>
            <span style={{ fontSize:6, padding:"1px 4px", borderRadius:3, background:C.surface, border:`1px solid ${C.surfBorder}`, color:C.dim }}>±{r.conf}</span>
            <StatusBadge s={r.status} />
          </div>
        ))}
      </div>
      <div style={{ marginTop:6, fontSize:7, color:C.dim }}>Confidence: 90-100 = verified · 70-89 = agency baseline · 50-69 = OSINT estimated · &lt;50 = unverified</div>
    </div>

    {/* Scenario comparison */}
    <div>
      <div style={{ fontSize:10, fontWeight:"bold", color:C.fg, marginBottom:8 }}>ECONOMIC SCENARIO COMPARISON</div>
      <div style={{ display:"flex", gap:6 }}>
        {[
          { sc:"Hormuz reopens 7d",    brent:"$82",   food:"-5%",  medical:"Adequate",           c:C.success },
          { sc:"Hormuz closed 30d",    brent:"$120+", food:"+40%", medical:"CRITICAL Day 21",     c:C.critical },
          { sc:"Closed + Abqaiq hit",  brent:"$150+", food:"+60%", medical:"Multiple critical",   c:C.critical },
        ].map((s,i)=>(
          <div key={i} style={{ flex:1, padding:12, borderRadius:4, background:`${s.c}06`, border:`1px solid ${s.c}22` }}>
            <div style={{ fontSize:9, fontWeight:"bold", color:s.c, marginBottom:8 }}>{s.sc}</div>
            <div style={{ fontSize:8, color:C.muted }}>Brent: <span style={{ color:C.fg }}>{s.brent}</span></div>
            <div style={{ fontSize:8, color:C.muted }}>Food price: <span style={{ color:C.fg }}>{s.food}</span></div>
            <div style={{ fontSize:8, color:C.muted }}>Medical: <span style={{ color:C.fg }}>{s.medical}</span></div>
          </div>
        ))}
      </div>
      <div style={{ marginTop:6, fontSize:7, color:C.dim }}>SOURCES: AI scenario modeling · Yahoo Finance · PortWatch · STATIC</div>
    </div>
  </div>
);

// ─── SCREEN 6: MEDIA & NARRATIVE ─────────────────────────────────────────────
const ScreenMedia = ({ live }) => (
  <div>
    {/* Live signal bar */}
    <div style={{ display:"flex", gap:6, marginBottom:12 }}>
      <KpiCard label="GDELT/24H"   value={live.gdelt.loading?"…":`${live.gdelt.value}`}  note="conflict articles (KSA+Iran)"      color={live.gdelt.value>15?C.critical:C.warning} feed="GDELT"  loading={live.gdelt.loading} />
      <KpiCard label="MISINFO FLAGS" value="12" note="24h · GDELT narrative cluster"   color={C.critical} feed="STATIC" />
      <KpiCard label="DOMINANT NARRATIVE" value="Escalation" note="Iranian media frame" color={C.warning} feed="STATIC" />
    </div>

    {/* Active narratives */}
    <div style={{ marginBottom:12 }}>
      <div style={{ fontSize:10, fontWeight:"bold", color:C.fg, marginBottom:8 }}>ACTIVE NARRATIVES — Day 7</div>
      {[
        { label:"'Saudi coalition strikes imminent'",   severity:"CRITICAL", origin:"Iranian state media (IRNA, Press TV)", reach:"High — picked up Reuters, Al Jazeera", action:"Corrective messaging required within 12h", actionColor:C.critical },
        { label:"'Hormuz closure hurting Iran most'",   severity:"HIGH",     origin:"Western wire services (AP, Reuters)",   reach:"Medium — accurate but being counter-amplified", action:"Monitor — does not require correction", actionColor:C.success },
        { label:"'GCC civilian casualties mounting'",   severity:"HIGH",     origin:"Social media + Iranian proxies",         reach:"High — viral in MENA, Europe", action:"Factual rebuttal with MoH data (0 KSA fatalities)", actionColor:C.warning },
        { label:"'KSA oil infrastructure destroyed'",   severity:"MEDIUM",   origin:"OSINT over-interpretation (Telegram)",   reach:"Low — niche mil-OSINT circles", action:"No action — contained", actionColor:C.success },
      ].map((n,i)=>{
        const sc = n.severity==="CRITICAL"?C.critical:n.severity==="HIGH"?C.warning:C.info;
        return (
          <div key={i} style={{ marginBottom:6, padding:"10px 12px", borderRadius:"0 4px 4px 0", background:`${sc}06`, border:`1px solid ${sc}22`, borderLeft:`3px solid ${sc}` }}>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:5 }}>
              <span style={{ fontSize:10, fontWeight:"600", color:C.fg }}>"{n.label}"</span>
              <span style={{ fontSize:7, padding:"1px 6px", borderRadius:3, background:`${sc}22`, color:sc }}>{n.severity}</span>
            </div>
            <div style={{ fontSize:8, color:C.muted, marginBottom:3 }}>Origin: {n.origin}</div>
            <div style={{ fontSize:8, color:C.muted, marginBottom:5 }}>Reach: {n.reach}</div>
            <div style={{ fontSize:8, color:n.actionColor }}>▸ {n.action}</div>
          </div>
        );
      })}
    </div>

    {/* Media breakdown */}
    <div>
      <div style={{ fontSize:10, fontWeight:"bold", color:C.fg, marginBottom:8 }}>MEDIA ENVIRONMENT BREAKDOWN</div>
      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8 }}>
        {[
          { label:"Tone (GDELT/24h)", items:[["Negative/conflict",`${Math.round((live.gdelt.value||20)*0.7)}`,"#ef4444"],["Neutral/factual",`${Math.round((live.gdelt.value||20)*0.2)}`,"#7d8fa3"],["Positive/de-escalation",`${Math.round((live.gdelt.value||20)*0.1)}`,"#22c55e"]], feed:"GDELT" },
          { label:"Source breakdown (STATIC)", items:[["Western wire (AP/Reuters/BBC)","42%","#3b82f6"],["Gulf state media (SPA/WAM/QNA)","28%","#6366f1"],["Iranian state (IRNA/PressTV)","18%","#ef4444"],["Social/Telegram/OSINT","12%","#f59e0b"]], feed:"STATIC" },
        ].map((panel,i)=>(
          <div key={i} style={{ background:C.surface, border:`1px solid ${C.surfBorder}`, borderRadius:4, padding:10 }}>
            <div style={{ display:"flex", justifyContent:"space-between", marginBottom:8 }}>
              <span style={{ fontSize:9, fontWeight:"bold", color:C.fg }}>{panel.label}</span>
              <FeedTag feed={panel.feed} loading={panel.feed==="GDELT"&&live.gdelt.loading}/>
            </div>
            {panel.items.map(([label,val,col],j)=>(
              <div key={j} style={{ display:"flex", justifyContent:"space-between", padding:"3px 0", borderBottom:`1px solid ${C.surfBorder}30` }}>
                <span style={{ fontSize:8, color:C.muted }}>{label}</span>
                <span style={{ fontSize:9, fontWeight:"bold", color:col }}>{val}</span>
              </div>
            ))}
          </div>
        ))}
      </div>
      <div style={{ marginTop:8, fontSize:7, color:C.dim }}>SOURCES: GDELT DOC 2.0 API (live 15min) · UANI narrative monitor (daily) · Claude API semantic analysis · STATIC classifications</div>
    </div>
  </div>
);

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
      {/* Severity level */}
      <div style={{ display:"flex", alignItems:"center", gap:16, padding:12, borderRadius:6, marginBottom:12, background:`${severityColor}08`, border:`1px solid ${severityColor}22` }}>
        <div>
          <div style={{ fontSize:8, color:C.muted, letterSpacing:"0.05em" }}>NATIONAL SEVERITY LEVEL</div>
          <div style={{ display:"flex", alignItems:"baseline", gap:6 }}>
            <span style={{ fontSize:32, fontWeight:"bold", color:severityColor }}>{severityLevel}</span>
            <span style={{ fontSize:13, color:C.muted }}>{severityLabel[severityLevel]}</span>
          </div>
          <div style={{ fontSize:8, color:C.dim }}>{severityScore}/100 · Auto-calculated composite</div>
        </div>
        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:4, flex:1 }}>
          {Object.entries(SEVERITY_FACTORS).map(([k,f])=>{
            const pct=(f.value/f.max)*100;
            const col=pct>=80?C.critical:pct>=60?C.warning:C.success;
            return (
              <div key={k} style={{ padding:"5px 8px", borderRadius:3, background:"rgba(255,255,255,0.02)", border:`1px solid ${C.surfBorder}` }}>
                <div style={{ display:"flex", justifyContent:"space-between", marginBottom:2 }}>
                  <span style={{ fontSize:7, color:C.fg }}>{f.label}</span>
                  <span style={{ fontSize:7, fontWeight:"bold", color:col }}>{f.value}/{f.max}</span>
                </div>
                <div style={{ height:2, background:C.surfBorder, borderRadius:1 }}>
                  <div style={{ height:"100%", width:`${pct}%`, background:col, borderRadius:1 }}/>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Scenario probability cards */}
      <div style={{ marginBottom:12 }}>
        <div style={{ fontSize:10, fontWeight:"bold", color:C.fg, marginBottom:8 }}>SCENARIO PROBABILITIES — Day 7</div>
        <div style={{ display:"flex", gap:8 }}>
          {SCENARIOS.map((s,i)=>(
            <div key={i} style={{ flex:1, padding:12, borderRadius:"0 0 4px 4px", background:`${s.color}06`, border:`1px solid ${s.color}22`, borderTop:`3px solid ${s.color}` }}>
              <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:6 }}>
                <span style={{ fontSize:9, fontWeight:"bold", color:s.color }}>{s.name}</span>
                <span style={{ fontSize:20, fontWeight:"bold", color:s.color }}>{s.prob}</span>
              </div>
              <div style={{ fontSize:8, color:C.muted, lineHeight:1.5 }}>{s.desc}</div>
              {/* Probability bar */}
              <div style={{ marginTop:8, height:3, background:C.surfBorder, borderRadius:2 }}>
                <div style={{ height:"100%", width:s.prob, background:s.color, borderRadius:2 }}/>
              </div>
            </div>
          ))}
        </div>
        <div style={{ marginTop:6, fontSize:7, color:C.dim }}>SOURCES: INSS · Alma Center · AI modeling · STATIC</div>
      </div>

      {/* FAQ / What-If */}
      <div>
        <div style={{ fontSize:10, fontWeight:"bold", color:C.fg, marginBottom:8 }}>WHAT-IF ANALYSIS</div>
        {FAQS.map((faq,i)=>(
          <div key={i} style={{ marginBottom:4, borderRadius:3, overflow:"hidden", border:`1px solid ${C.surfBorder}` }}>
            <div onClick={()=>setExpandedFAQ(expandedFAQ===i?null:i)} style={{ display:"flex", justifyContent:"space-between", alignItems:"center", padding:"8px 12px", cursor:"pointer", background:expandedFAQ===i?"rgba(59,130,246,0.08)":C.surface }}>
              <span style={{ fontSize:9, color:expandedFAQ===i?C.info:C.fg }}>{faq.q}</span>
              <span style={{ fontSize:9, color:C.dim }}>{expandedFAQ===i?"▾":"▸"}</span>
            </div>
            {expandedFAQ===i && (
              <div style={{ padding:"8px 12px", background:"rgba(255,255,255,0.01)", fontSize:9, color:C.muted, lineHeight:1.7 }}>
                {faq.a}
                <div style={{ marginTop:6, fontSize:7, color:C.dim }}>STATIC · INSS / Alma / OSINT synthesis</div>
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
      const res = await fetch("https://api.anthropic.com/v1/messages", {
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
      const res = await fetch("https://api.anthropic.com/v1/messages", {
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
          <span style={{ fontSize:9, fontWeight:"bold", color:C.fg }}>▣ EXECUTIVE SITUATION BRIEF</span>
          <FeedTag feed="LIVE" />
        </div>
        <div style={{ fontSize:8, color:C.dim, marginBottom:8 }}>Brent {live.brent.value} · TASI {live.tasi.value} · GDELT {live.gdelt.value}/24h · Day 7 injected live</div>
        {!brief&&!loading&&<button onClick={generateBrief} style={{ padding:"8px 16px", background:"rgba(59,130,246,0.12)", border:"1px solid rgba(59,130,246,0.25)", borderRadius:3, color:C.info, fontSize:9, cursor:"pointer", fontFamily:"JetBrains Mono,monospace" }}>▣ GENERATE BRIEF</button>}
        {loading&&<div style={{ fontSize:9, color:C.muted }}><span className="cop-pulse">●</span> Generating from live data…</div>}
        {brief&&<div>
          <div style={{ fontSize:9, color:C.fg, lineHeight:1.8, whiteSpace:"pre-line", padding:"10px 12px", background:"rgba(255,255,255,0.02)", borderRadius:3, border:`1px solid ${C.surfBorder}` }}>{brief}</div>
          <button onClick={generateBrief} style={{ marginTop:8, padding:"4px 10px", background:"rgba(59,130,246,0.08)", border:"1px solid rgba(59,130,246,0.2)", borderRadius:3, color:C.info, fontSize:8, cursor:"pointer", fontFamily:"JetBrains Mono,monospace" }}>↻ REGENERATE</button>
        </div>}
      </div>
      <div style={{ background:C.surface, border:`1px solid ${C.surfBorder}`, borderRadius:4, padding:12 }}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:6 }}>
          <span style={{ fontSize:9, fontWeight:"bold", color:C.fg }}>💬 MINISTER QUERY — NEMA AI</span>
          <FeedTag feed="LIVE" />
        </div>
        {msgs.length===0&&<div style={{ display:"flex", gap:6, flexWrap:"wrap", marginBottom:8 }}>
          {["What if Abqaiq is hit?","When will food run out?","Economic cost so far?","Oman mediation options?","Worst-case 30 days?"].map(q=>(
            <button key={q} onClick={()=>setInput(q)} style={{ fontSize:7, padding:"3px 8px", background:"rgba(59,130,246,0.08)", border:"1px solid rgba(59,130,246,0.18)", borderRadius:3, color:C.info, cursor:"pointer", fontFamily:"JetBrains Mono,monospace" }}>{q}</button>
          ))}
        </div>}
        <div ref={chatRef} style={{ maxHeight:220, overflowY:"auto", marginBottom:8, display:"flex", flexDirection:"column", gap:6 }}>
          {msgs.map((m,i)=>(
            <div key={i} style={{ padding:"6px 8px", borderRadius:3, background:m.role==="user"?"rgba(59,130,246,0.08)":"rgba(255,255,255,0.02)", borderLeft:`2px solid ${m.role==="user"?C.info:C.muted}` }}>
              <div style={{ fontSize:7, color:C.dim, marginBottom:2 }}>{m.role==="user"?"MINISTER":"NEMA AI"}</div>
              <div style={{ fontSize:9, color:C.fg, lineHeight:1.6, whiteSpace:"pre-wrap" }}>{m.content}</div>
            </div>
          ))}
          {chatLoading&&<div style={{ padding:"6px 8px", borderRadius:3, background:"rgba(255,255,255,0.02)", borderLeft:`2px solid ${C.muted}` }}>
            <div style={{ fontSize:7, color:C.dim, marginBottom:2 }}>NEMA AI</div>
            <span className="cop-pulse" style={{ fontSize:9, color:C.muted }}>●●●</span>
          </div>}
        </div>
        <div style={{ display:"flex", gap:6 }}>
          <input value={input} onChange={e=>setInput(e.target.value)} onKeyDown={e=>e.key==="Enter"&&sendChat()}
            placeholder="Ask anything about the situation…"
            style={{ flex:1, padding:"6px 8px", background:"rgba(255,255,255,0.04)", border:`1px solid ${C.surfBorder}`, borderRadius:3, color:C.fg, fontSize:8, fontFamily:"JetBrains Mono,monospace" }}
          />
          <button onClick={sendChat} disabled={chatLoading}
            style={{ padding:"6px 12px", background:"rgba(59,130,246,0.12)", border:"1px solid rgba(59,130,246,0.25)", borderRadius:3, color:chatLoading?C.muted:C.info, fontSize:8, cursor:"pointer", fontFamily:"JetBrains Mono,monospace" }}>
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
    gdelt: { value:20, source:"STATIC", loading:false },
    ioda:  { value:null, source:"IODA", loading:false },
    gcc:   { data:null, loading:false, error:false },
  });

  const refresh = useCallback(async () => {
    setRefreshing(true);
    setLive(d=>({...d,
      brent:{...d.brent,loading:true}, tasi:{...d.tasi,loading:true},
      gdelt:{...d.gdelt,loading:true}, ioda:{...d.ioda,loading:true},
      gcc:{...d.gcc,loading:true,error:false},
    }));
    const [fin, gdelt, ioda, gcc] = await Promise.allSettled([
      fetchFinancial(), fetchGdelt(), fetchIoda(), fetchGCCStrikes()
    ]);
    setLive(d=>{
      const n={...d};
      if (fin.status==="fulfilled"&&fin.value.brent) {
        n.brent={value:`$${fin.value.brent.toFixed(2)}`,change:fin.value.brentChg||d.brent.change,source:"AI+WEB",loading:false};
        n.tasi={value:fin.value.tasi?Number(fin.value.tasi).toLocaleString():d.tasi.value,change:fin.value.tasiChg||d.tasi.change,source:"AI+WEB",loading:false};
      } else { n.brent={...d.brent,source:"STATIC",loading:false}; n.tasi={...d.tasi,source:"STATIC",loading:false}; }
      n.gdelt = gdelt.status==="fulfilled"?{value:gdelt.value,source:"GDELT",loading:false}:{...d.gdelt,source:"STATIC",loading:false};
      n.ioda  = ioda.status==="fulfilled"&&ioda.value!==null?{value:ioda.value,source:"IODA",loading:false}:{value:null,source:"IODA",loading:false};
      n.gcc   = gcc.status==="fulfilled"&&gcc.value?{data:gcc.value,loading:false,error:false}:{data:d.gcc.data,loading:false,error:true};
      return n;
    });
    setLastRefresh(new Date());
    setRefreshing(false);
  }, []);

  useEffect(()=>{refresh();},[refresh]);

  const fmt = d=>d?`${d.getHours().toString().padStart(2,"0")}:${d.getMinutes().toString().padStart(2,"0")}`:"--:--";

  const TABS = [
    { label:"SITUATION",       icon:"◉" },
    { label:"RISK CLUSTERS",   icon:"⬡" },
    { label:"INFRASTRUCTURE",  icon:"⚙" },
    { label:"DECISIONS",       icon:"▣" },
    { label:"ECONOMIC",        icon:"◈" },
    { label:"MEDIA",           icon:"📡" },
    { label:"SCENARIOS",       icon:"⚠" },
    { label:"AI BRIEF",        icon:"🤖" },
  ];

  const screens = [
    <ScreenSituation    live={live}/>,
    <ScreenRiskClusters live={live}/>,
    <ScreenInfra        live={live}/>,
    <ScreenDecisions />,
    <ScreenEconomic     live={live}/>,
    <ScreenMedia        live={live}/>,
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
              <div style={{fontSize:14,fontWeight:700,letterSpacing:"0.14em",color:C.fg}}>NEMA MINISTER COP</div>
              <div style={{fontSize:8,color:C.dim,letterSpacing:"0.1em",marginTop:2}}>NATIONAL EMERGENCY MANAGEMENT AUTHORITY · LIVE DEMO</div>
            </div>
          </div>
          <div style={{display:"flex",gap:10,flexWrap:"wrap"}}>
            {[["HORMUZ","CLOSED D7",C.critical],["KSA AIRSPACE","RESTRICTED",C.warning],["CIVIL DEFENSE","ACTIVATED",C.success],["THREAT","CRITICAL",C.critical]].map(([l,v,c])=>(
              <div key={l} style={{textAlign:"center"}}>
                <div style={{fontSize:7,color:C.dim,letterSpacing:"0.06em",marginBottom:3}}>{l}</div>
                <span style={{fontSize:8,padding:"3px 8px",borderRadius:4,background:`${c}14`,color:c,border:`1px solid ${c}28`,fontWeight:600}}>{v}</span>
              </div>
            ))}
          </div>
          <div style={{fontSize:8,color:C.dim,textAlign:"right"}}>
            <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:4}}>
              <span style={{color:C.success,fontWeight:600}}>● Day 7 · 07 MAR 2026</span>
              <button onClick={refresh} disabled={refreshing} style={{padding:"4px 10px",background:"rgba(34,197,94,0.1)",border:"1px solid rgba(34,197,94,0.25)",borderRadius:4,color:refreshing?C.dim:C.success,fontSize:7,cursor:"pointer",fontFamily:"JetBrains Mono,monospace",fontWeight:600}}>
                {refreshing?<span className="cop-pulse">↻ FETCHING…</span>:"↻ REFRESH LIVE"}
              </button>
            </div>
            <div style={{fontSize:7,color:C.dim}}>Last fetch: {fmt(lastRefresh)}</div>
            <div style={{marginTop:4,display:"flex",gap:5}}>
              {[["#22c55e","AI+WEB"],["#22c55e","CONFIRMED"],["#f97316","EST"],["#f59e0b","GDELT"],["#3b82f6","IODA"],["#526175","STATIC"]].map(([c,l])=>(
                <span key={l} style={{fontSize:6,padding:"2px 5px",borderRadius:3,background:`${c}14`,color:c,fontWeight:500}}>{l}</span>
              ))}
            </div>
          </div>
        </header>

        {/* LIVE STATUS BAR */}
        <div style={{background:"#0a1220",borderBottom:`1px solid ${C.surfBorder}`,padding:"6px 20px",display:"flex",gap:16,alignItems:"center",flexWrap:"wrap"}}>
          <span style={{fontSize:7,color:C.dim,fontWeight:600,letterSpacing:"0.08em"}}>LIVE:</span>
          {[
            {l:"BRENT", src:live.brent.source, loading:live.brent.loading, v:live.brent.value},
            {l:"TASI",  src:live.tasi.source,  loading:live.tasi.loading,  v:live.tasi.value},
            {l:"GDELT", src:live.gdelt.source, loading:live.gdelt.loading, v:`${live.gdelt.value}/24h`},
            {l:"IODA",  src:live.ioda.source,  loading:live.ioda.loading,  v:live.ioda.value!==null?`${live.ioda.value}%`:"N/A"},
            {l:"GCC",   src:live.gcc.data?"AI+WEB":"STATIC", loading:live.gcc.loading, v:live.gcc.error?"⚠ failed":live.gcc.data?"✓ sourced":"seed"},
          ].map(f=>(
            <div key={f.l} style={{display:"flex",alignItems:"center",gap:5}}>
              <span style={{fontSize:7,color:C.dim,fontWeight:500}}>{f.l}:</span>
              {f.loading?<span className="cop-pulse" style={{fontSize:7,color:C.info}}>●</span>:<span style={{fontSize:7,color:f.src==="STATIC"?C.dim:C.success,fontWeight:500}}>{f.v}</span>}
              <FeedTag feed={f.src} loading={f.loading}/>
            </div>
          ))}
          <span style={{marginLeft:"auto",fontSize:7,color:C.dim}}>CORS-blocked: Yahoo Finance direct · NASA FIRMS · PortWatch (use server-side proxy in repo)</span>
        </div>

        {/* TAB BAR */}
        <nav style={{display:"flex",background:"#0a1628",borderBottom:`1px solid ${C.surfBorder}`,overflowX:"auto"}}>
          {TABS.map((t,i)=>(
            <button key={i} onClick={()=>setTab(i)} style={{
              padding:"10px 16px", background:tab===i?"#192233":"transparent",
              border:"none", borderBottom:tab===i?`2px solid ${C.info}`:"2px solid transparent",
              cursor:"pointer", color:tab===i?C.fg:C.muted,
              fontFamily:"'JetBrains Mono',monospace", fontSize:8,
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
        <footer style={{borderTop:`1px solid ${C.surfBorder}`,padding:"8px 20px",background:"#0a1220",display:"flex",justifyContent:"space-between",fontSize:7,color:C.dim,flexWrap:"wrap",gap:6}}>
          <span>BRENT · TASI · GCC STRIKES: Claude API + web_search · GDELT: gdeltproject.org · IODA: inetintel.cc.gatech.edu · All other: STATIC / OSINT</span>
          <span style={{color:"#f97316"}}>PENDING SERVER-SIDE: Yahoo Finance direct · NASA FIRMS · OpenWeatherMap · PortWatch · ACLED</span>
        </footer>
      </div>
    </>
  );
}
