// lib/calls.js — Call/SMS stats with time-budgeted fetching
//
// Strategy: fetch today first (always accurate), then fetch older days
// with both Call + SMS in the same batch to progress evenly.

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

  let daysComplete = 0;
  let mtdPartial = false;

  function processCalls(msgs, isTodayData) {
    for (const msg of msgs) {
      const name = userIdToName[String(msg.userId || '')];
      if (!name) continue;
      const dur = Number(msg.meta?.call?.duration || 0);
      mtdBuckets[name].calls++;
      mtdBuckets[name].callSecs += dur;
      if (dur >= 30) mtdBuckets[name].calls30s++;
      if (isTodayData) {
        todayBuckets[name].calls++;
        todayBuckets[name].callSecs += dur;
        if (dur >= 30) todayBuckets[name].calls30s++;
      }
    }
  }

  function processSMS(msgs, isTodayData) {
    for (const msg of msgs) {
      const name = userIdToName[String(msg.userId || '')];
      if (!name) continue;
      mtdBuckets[name].sms++;
      if (isTodayData) todayBuckets[name].sms++;
    }
  }

  // ── Phase 1: Today (always runs) ──────────────────────────────────────
  const todayDate = days[days.length - 1];
  const [todayCalls, todaySMS] = await Promise.all([
    exportOneDay(locationId, 'Call', todayDate),
    exportOneDay(locationId, 'SMS', todayDate),
  ]);
  processCalls(todayCalls, true);
  processSMS(todaySMS, true);
  daysComplete = 1;

  console.log(`Phase 1: ${todayCalls.length} calls, ${todaySMS.length} SMS today (${Date.now() - startTime}ms)`);

  // ── Phase 2: Older days — Call + SMS together per day ─────────────────
  // Fetch both channels for each day in the same batch so both progress evenly
  const otherDays = days.slice(0, -1);
  for (let i = 0; i < otherDays.length && Date.now() < deadline; i += 3) {
    const batch = otherDays.slice(i, i + 3);
    // Fetch Call + SMS for each day in the batch (6 requests max, 3 parallel pairs)
    const results = await Promise.all(
      batch.map(async (day) => {
        const [calls, sms] = await Promise.all([
          exportOneDay(locationId, 'Call', day),
          exportOneDay(locationId, 'SMS', day),
        ]);
        return { calls, sms };
      })
    );
    for (const { calls, sms } of results) {
      processCalls(calls, false);
      processSMS(sms, false);
    }
    daysComplete += batch.length;
  }

  if (daysComplete < days.length) {
    mtdPartial = true;
    console.log(`Phase 2: MTD PARTIAL — ${daysComplete}/${days.length} days (${Date.now() - startTime}ms)`);
  } else {
    console.log(`Phase 2: MTD complete — ${daysComplete} days (${Date.now() - startTime}ms)`);
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
  result._debug = { todayCalls: todayCalls.length, todaySMS: todaySMS.length, mtdPartial, daysComplete, totalDays: days.length };
  return result;
}

module.exports = { fetchCallStats };
