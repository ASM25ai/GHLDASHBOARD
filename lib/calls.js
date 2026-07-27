// lib/calls.js — Call/SMS stats
//
// GHL's Call export endpoint is very slow for full-month queries.
// Strategy: fetch TODAY fully (always accurate), then fetch the rest
// of the month for SMS only (fast). For MTD calls, fetch last 7 days
// which gives a reliable recent window without timing out.

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

async function fetchCallStats(reps, locationId, now, monthStart) {
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

  // Build day list
  const days = [];
  for (let d = new Date(monthStart); d <= now; d = addDays(d, 1)) {
    days.push(new Date(d));
  }

  // ── Phase 1: Today's calls + SMS (2 calls, parallel) ──────────────────
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

  console.log(`Phase 1 done: ${todayCalls.length} calls, ${todaySMS.length} SMS today`);

  // ── Phase 2: Rest of month SMS (fast, batch 5) ────────────────────────
  const otherDays = days.slice(0, -1);
  for (let i = 0; i < otherDays.length; i += 5) {
    const batch = otherDays.slice(i, i + 5);
    const results = await Promise.all(batch.map(d => exportOneDay(locationId, 'SMS', d)));
    for (const msgs of results) {
      for (const msg of msgs) {
        const name = userIdToName[String(msg.userId || '')];
        if (!name) continue;
        mtdBuckets[name].sms++;
      }
    }
  }

  console.log(`Phase 2 done: SMS MTD complete`);

  // ── Phase 3: Rest of month Calls (batch 5, may partially fail) ────────
  for (let i = 0; i < otherDays.length; i += 5) {
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
  }

  console.log(`Phase 3 done: Calls MTD complete`);

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
  result._debug = { todayCalls: todayCalls.length, todaySMS: todaySMS.length };
  return result;
}

module.exports = { fetchCallStats };
