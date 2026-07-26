// lib/calls.js — Uses /conversations/messages/export endpoint
//
// Fetches calls and SMS day-by-day (GHL can't handle full-month exports
// in one call for large volumes). Runs 5 days in parallel per batch,
// and Calls + SMS channels in parallel.

const GHL_BASE    = 'https://services.leadconnectorhq.com';
const GHL_VERSION = '2021-07-28';

async function ghlGet(path) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000); // 10s timeout — skip slow days fast

  try {
    const start = Date.now();
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
      throw new Error(`GHL ${res.status}: ${body.slice(0, 150)}`);
    }
    return res.json();
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === 'AbortError') {
      throw new Error(`GHL timeout on messages export after 20s`);
    }
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

// Fetch one day of messages for a channel
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
    console.warn(`Export ${channel} ${start}: ${e.message.slice(0, 80)}`);
    return [];
  }
}

// Fetch messages for a date range, running 5 days in parallel per batch
async function exportParallel(locationId, channel, startDate, endDate) {
  const days = [];
  for (let d = new Date(startDate); d <= endDate; d = addDays(d, 1)) {
    days.push(new Date(d));
  }

  const all = [];
  const BATCH = 5;
  for (let i = 0; i < days.length; i += BATCH) {
    const batch = days.slice(i, i + BATCH);
    const results = await Promise.all(
      batch.map((day) => exportOneDay(locationId, channel, day))
    );
    for (const msgs of results) all.push(...msgs);
  }
  return all;
}

async function fetchCallStats(reps, locationId, now, monthStart) {
  const todayStr = dateStr(now);

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

  // ── Fetch Calls first, then SMS (sequential channels, parallel days) ──
  // Running both channels in parallel overloads GHL with too many concurrent requests
  const allCalls = await exportParallel(locationId, 'Call', monthStart, now);
  const allSMS   = await exportParallel(locationId, 'SMS',  monthStart, now);

  console.log(`Call stats: ${allCalls.length} calls, ${allSMS.length} SMS fetched`);

  for (const msg of allCalls) {
    const name = userIdToName[String(msg.userId || '')];
    if (!name) continue;

    const dur = Number(msg.meta?.call?.duration || 0);
    const msgDate = (msg.dateAdded || '').slice(0, 10);
    const isToday = msgDate === todayStr;

    mtdBuckets[name].calls++;
    mtdBuckets[name].callSecs += dur;
    if (dur >= 30) mtdBuckets[name].calls30s++;

    if (isToday) {
      todayBuckets[name].calls++;
      todayBuckets[name].callSecs += dur;
      if (dur >= 30) todayBuckets[name].calls30s++;
    }
  }

  for (const msg of allSMS) {
    const name = userIdToName[String(msg.userId || '')];
    if (!name) continue;

    const msgDate = (msg.dateAdded || '').slice(0, 10);
    const isToday = msgDate === todayStr;

    mtdBuckets[name].sms++;
    if (isToday) todayBuckets[name].sms++;
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
    totalCallsRaw: allCalls.length,
    totalSMSRaw:   allSMS.length,
  };

  return result;
}

module.exports = { fetchCallStats };
