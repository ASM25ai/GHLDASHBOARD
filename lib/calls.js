// lib/calls.js — Call/SMS stats with time-budgeted fetching
//
// GHL's Call export is very slow. This version:
// 1. Fetches today's Calls + SMS (fast, ~3s)
// 2. Fetches MTD SMS (fast, ~15s)
// 3. Fetches MTD Calls with a time budget — stops when time runs out
// Returns whatever data it collected, even if incomplete.

const GHL_BASE    = 'https://services.leadconnectorhq.com';
const GHL_VERSION = '2021-07-28';

async function ghlGet(path) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    const res = await fetch(`${GHL_BASE}${path}`, {
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${process.env.GHL_PRIVATE_TOKEN}`,
        Version: GHL_VERSION,
        'Content-Type': 'application/json',
      },
    });
    clearTimeout(timeout);
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`GHL ${res.status}: ${body.slice(0, 100)}`);
    }
    return res.json();
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === 'AbortError') throw new Error('timeout');
    throw err;
  }
}

function fmtDuration(secs) {
  if (!secs) return '0s';
  return secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${secs % 60}s`;
}

function dateStr(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function addDays(d, n) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}

async function exportOneDay(locationId, channel, dayDate) {
  const start = dateStr(dayDate);
  const end   = dateStr(addDays(dayDate, 1));
  const params = new URLSearchParams({
    locationId, channel, startDate: start, endDate: end, limit: '500',
  });
  try {
    const data = await ghlGet(`/conversations/messages/export?${params}`);
    return data.messages || [];
  } catch (e) {
    return [];
  }
}

// Main function — accepts a timeBudgetMs (default 50s) to stop before Vercel kills us
async function fetchCallStats(reps, locationId, now, monthStart, timeBudgetMs = 50000) {
  const startTime = Date.now();
  const deadline = startTime + timeBudgetMs;
  const todayStr = dateStr(now);

  const userIdToName = {};
  for (const [name, rep] of Object.entries(reps)) {
    userIdToName[String(rep.ghlUserId)] = name;
  }

  const mkBucket = () => ({ calls: 0, callSecs: 0, calls30s: 0, sms: 0 });
  const todayBuckets = {}, mtdBuckets = {};
  for (const name of Object.keys(reps)) {
    todayBuckets[name] = mkBucket();
    mtdBuckets[name]   = mkBucket();
  }

  const days = [];
  for (let d = new Date(monthStart); d <= now; d = addDays(d, 1)) {
    days.push(new Date(d));
  }

  let callsDaysComplete = 0;
  let smsDaysComplete = 0;
  let callsMTDPartial = false;

  // ── Phase 1: Today (always runs) ──────────────────────────────────────
  const todayDate = days[days.length - 1];
  const [todayCalls, todaySMS] = await Promise.all([
    exportOneDay(locationId, 'Call', todayDate),
    exportOneDay(locationId, 'SMS', todayDate),
  ]);

  for (const msg of todayCalls) {
    const name = userIdToName[String(msg.userId || '')];
    if (!name) continue;
    const dur = Number(msg.meta?.call?.duration || 0);
    todayBuckets[name].calls++;
    todayBuckets[name].callSecs += dur;
    if (dur >= 30) todayBuckets[name].calls30s++;
    mtdBuckets[name].calls++;
    mtdBuckets[name].callSecs += dur;
    if (dur >= 30) mtdBuckets[name].calls30s++;
  }
  for (const msg of todaySMS) {
    const name = userIdToName[String(msg.userId || '')];
    if (!name) continue;
    todayBuckets[name].sms++;
    mtdBuckets[name].sms++;
  }
  callsDaysComplete = 1;
  smsDaysComplete = 1;

  console.log(`Phase 1: ${todayCalls.length} calls, ${todaySMS.length} SMS today (${Date.now() - startTime}ms)`);

  // ── Phase 2: MTD SMS (fast) ───────────────────────────────────────────
  const otherDays = days.slice(0, -1);
  for (let i = 0; i < otherDays.length && Date.now() < deadline; i += 5) {
    const batch = otherDays.slice(i, i + 5);
    const results = await Promise.all(batch.map(d => exportOneDay(locationId, 'SMS', d)));
    for (const msgs of results) {
      for (const msg of msgs) {
        const name = userIdToName[String(msg.userId || '')];
        if (!name) continue;
        mtdBuckets[name].sms++;
      }
    }
    smsDaysComplete += batch.length;
  }

  console.log(`Phase 2: SMS MTD done, ${smsDaysComplete} days (${Date.now() - startTime}ms)`);

  // ── Phase 3: MTD Calls (time-budgeted) ────────────────────────────────
  for (let i = 0; i < otherDays.length && Date.now() < deadline; i += 5) {
    const batch = otherDays.slice(i, i + 5);
    const results = await Promise.all(batch.map(d => exportOneDay(locationId, 'Call', d)));
    for (const msgs of results) {
      for (const msg of msgs) {
        const name = userIdToName[String(msg.userId || '')];
        if (!name) continue;
        const dur = Number(msg.meta?.call?.duration || 0);
        mtdBuckets[name].calls++;
        mtdBuckets[name].callSecs += dur;
        if (dur >= 30) mtdBuckets[name].calls30s++;
      }
    }
    callsDaysComplete += batch.length;
  }

  if (callsDaysComplete < days.length) {
    callsMTDPartial = true;
    console.log(`Phase 3: Calls MTD PARTIAL — ${callsDaysComplete}/${days.length} days (${Date.now() - startTime}ms)`);
  } else {
    console.log(`Phase 3: Calls MTD complete — ${callsDaysComplete} days (${Date.now() - startTime}ms)`);
  }

  const result = {};
  for (const name of Object.keys(reps)) {
    const t = todayBuckets[name], m = mtdBuckets[name];
    result[name] = {
      callsToday: t.calls, calls30sToday: t.calls30s,
      avgDurToday: t.calls > 0 ? fmtDuration(Math.round(t.callSecs / t.calls)) : '-',
      smsToday: t.sms,
      callsMTD: m.calls, calls30sMTD: m.calls30s,
      avgDurMTD: m.calls > 0 ? fmtDuration(Math.round(m.callSecs / m.calls)) : '-',
      smsMTD: m.sms,
    };
  }
  result._debug = { todayCalls: todayCalls.length, todaySMS: todaySMS.length, callsMTDPartial, callsDaysComplete, totalDays: days.length };
  return result;
}

module.exports = { fetchCallStats };
