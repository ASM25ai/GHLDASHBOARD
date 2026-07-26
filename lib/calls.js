// lib/calls.js — Uses /conversations/messages/export endpoint
//
// Optimized: fetches the full month in one call per channel (limit=10000)
// instead of day-by-day. Falls back gracefully on failure.

const GHL_BASE    = 'https://services.leadconnectorhq.com';
const GHL_VERSION = '2021-07-28';

async function ghlGet(path) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000); // 15s timeout

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
    const elapsed = Date.now() - start;

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`GHL ${res.status} on ${path.split('?')[0]}: ${body.slice(0, 150)}`);
    }

    console.log(`GHL ${path.split('?')[0]} → ${res.status} (${elapsed}ms)`);
    return res.json();
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === 'AbortError') {
      throw new Error(`GHL timeout on ${path.split('?')[0]} after 15s`);
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

// Fetch an entire date range of messages, paginating with limit=500.
async function exportRange(locationId, channel, startDate, endDate) {
  const start = dateStr(startDate);
  const end   = dateStr(addDays(endDate, 1)); // endDate is inclusive
  const allMessages = [];
  let page = 1;

  while (true) {
    const params = new URLSearchParams({
      locationId, channel, startDate: start, endDate: end, limit: '500', page: String(page),
    });

    try {
      const data = await ghlGet(`/conversations/messages/export?${params}`);
      const msgs = data.messages || [];
      allMessages.push(...msgs);

      // If we got fewer than 500, we've reached the last page
      if (msgs.length < 500) break;
      page++;

      // Safety: max 20 pages = 10,000 messages
      if (page > 20) {
        console.warn(`Export ${channel}: hit 20-page limit (${allMessages.length} messages)`);
        break;
      }
    } catch (e) {
      console.warn(`Export failed for ${channel} ${start}→${end} page ${page}: ${e.message.slice(0, 100)}`);
      break;
    }
  }

  return allMessages;
}

async function fetchCallStats(reps, locationId, now, monthStart) {
  // Use ET for "today" detection since CRM is in Eastern Time
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

  // ── Fetch full month of calls + SMS in parallel (2 API calls total) ──
  const [allCalls, allSMS] = await Promise.all([
    exportRange(locationId, 'Call', monthStart, now),
    exportRange(locationId, 'SMS',  monthStart, now),
  ]);

  for (const msg of allCalls) {
    const name = userIdToName[String(msg.userId || '')];
    if (!name) continue;

    const dur = Number(msg.meta?.call?.duration || 0);
    const msgDate = (msg.dateAdded || '').slice(0, 10);
    const isToday = msgDate === todayStr;

    // MTD (includes today)
    mtdBuckets[name].calls++;
    mtdBuckets[name].callSecs += dur;
    if (dur >= 30) mtdBuckets[name].calls30s++;

    // Today only
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
