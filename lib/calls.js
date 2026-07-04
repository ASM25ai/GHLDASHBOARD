// lib/calls.js — Uses /conversations/messages/export endpoint
//
// GHL's export endpoint times out on cursor-based pagination for large
// datasets. Fix: query day-by-day with limit=500 per page (daily volume
// fits in one page — no cursors needed). Same pattern as qualified leads.

const GHL_BASE    = 'https://services.leadconnectorhq.com';
const GHL_VERSION = '2021-07-28';

async function ghlGet(path) {
  const res = await fetch(`${GHL_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${process.env.GHL_PRIVATE_TOKEN}`,
      Version: GHL_VERSION,
      'Content-Type': 'application/json',
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`GHL ${res.status} on ${path}: ${body}`);
  }
  return res.json();
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

// Fetch one day of messages for a channel. No pagination — limit=500
// handles max daily volume (confirmed: ~130 calls, ~380 SMS per day).
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
    console.warn(`Export failed for ${channel} on ${start}: ${e.message.slice(0, 80)}`);
    return [];
  }
}

// Fetch messages for a date range, day by day (sequential, no pagination)
async function exportDayByDay(locationId, channel, startDate, endDate) {
  const all = [];
  for (let d = new Date(startDate); d <= endDate; d = addDays(d, 1)) {
    const msgs = await exportOneDay(locationId, channel, d);
    all.push(...msgs);
  }
  return all;
}

async function fetchCallStats(reps, locationId, now, monthStart) {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  // Build userId → ISA name lookup
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

  // ── TODAY (one day each for calls + SMS = 2 API calls) ────────────────
  const todayCalls = await exportOneDay(locationId, 'Call', today);
  const todaySMS   = await exportOneDay(locationId, 'SMS',  today);

  for (const msg of todayCalls) {
    const name = userIdToName[String(msg.userId || '')];
    if (!name) continue;
    todayBuckets[name].calls++;
    const dur = Number(msg.meta?.call?.duration || 0);
    todayBuckets[name].callSecs += dur;
    if (dur >= 30) todayBuckets[name].calls30s++;
  }

  for (const msg of todaySMS) {
    const name = userIdToName[String(msg.userId || '')];
    if (!name) continue;
    todayBuckets[name].sms++;
  }

  // ── MTD (day by day from month start to yesterday, then add today) ────
  const yesterday = addDays(today, -1);
  const preTodayCalls = monthStart < today
    ? await exportDayByDay(locationId, 'Call', monthStart, yesterday)
    : [];
  const preTodaySMS = monthStart < today
    ? await exportDayByDay(locationId, 'SMS', monthStart, yesterday)
    : [];

  for (const msg of preTodayCalls) {
    const name = userIdToName[String(msg.userId || '')];
    if (!name) continue;
    mtdBuckets[name].calls++;
    const dur = Number(msg.meta?.call?.duration || 0);
    mtdBuckets[name].callSecs += dur;
    if (dur >= 30) mtdBuckets[name].calls30s++;
  }

  for (const msg of preTodaySMS) {
    const name = userIdToName[String(msg.userId || '')];
    if (!name) continue;
    mtdBuckets[name].sms++;
  }

  // Add today's totals into MTD
  for (const name of Object.keys(reps)) {
    mtdBuckets[name].calls    += todayBuckets[name].calls;
    mtdBuckets[name].callSecs += todayBuckets[name].callSecs;
    mtdBuckets[name].calls30s += todayBuckets[name].calls30s;
    mtdBuckets[name].sms      += todayBuckets[name].sms;
  }

  // Format output
  const result = {};
  for (const name of Object.keys(reps)) {
    const t = todayBuckets[name], m = mtdBuckets[name];
    result[name] = {
      callsToday:    t.calls,
      calls30sToday: t.calls30s,
      avgDurToday:   t.calls > 0 ? fmtDuration(Math.round(t.callSecs / t.calls)) : '-',
      smsToday:      t.sms,
      callsMTD:      m.calls,
      calls30sMTD:   m.calls30s,
      avgDurMTD:     m.calls > 0 ? fmtDuration(Math.round(m.callSecs / m.calls)) : '-',
      smsMTD:        m.sms,
    };
  }

  result._debug = {
    todayCallsRaw: todayCalls.length,
    todaySMSRaw:   todaySMS.length,
    mtdCallsRaw:   preTodayCalls.length + todayCalls.length,
    mtdSMSRaw:     preTodaySMS.length + todaySMS.length,
  };

  return result;
}

module.exports = { fetchCallStats };
