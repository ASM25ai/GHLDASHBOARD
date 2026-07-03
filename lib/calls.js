// lib/calls.js — CONFIRMED WORKING via /conversations/messages/export endpoint
//
// This endpoint returns ALL messages for the location filtered by channel
// (Call, SMS) and date range. Flat array, cursor-paginated, userId on each
// message. 2-4 API calls total instead of scanning hundreds of conversations.
//
// Confirmed fields (2026-07-03):
//   messageType: "TYPE_CALL" or "TYPE_SMS"
//   userId: GHL user ID (present on outbound, sometimes missing on inbound)
//   meta.call.duration: seconds (null for failed/no-answer calls)
//   meta.call.status: "completed", "failed", "no-answer", "busy", "ringing"
//   direction: "inbound" or "outbound"
//   dateAdded: ISO timestamp

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

function nextDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
}

// Fetch all messages of a given channel (Call or SMS) in a date range.
// Paginates using nextCursor. Returns flat array of messages.
async function exportMessages(locationId, channel, startDate, endDate, maxPages) {
  const all = [];
  let cursor = null;

  for (let page = 0; page < maxPages; page++) {
    const params = new URLSearchParams({
      locationId,
      channel,
      startDate,
      endDate,
      limit: '100',
    });
    if (cursor) params.set('cursor', cursor);

    const data = await ghlGet(`/conversations/messages/export?${params}`);
    const msgs = data.messages || [];
    all.push(...msgs);

    cursor = data.nextCursor || null;
    if (!cursor || msgs.length === 0) break;
  }

  return all;
}

async function fetchCallStats(reps, locationId, now, monthStart) {
  const todayStr    = dateStr(now);
  const tomorrowStr = dateStr(nextDay(now));
  const mtdStartStr = dateStr(monthStart);

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

  // ── Fetch today's calls and SMS (2 API call chains) ───────────────────
  const [todayCalls, todaySMS] = await Promise.all([
    exportMessages(locationId, 'Call', todayStr, tomorrowStr, 10),
    exportMessages(locationId, 'SMS',  todayStr, tomorrowStr, 20),
  ]);

  // Process today's calls
  for (const msg of todayCalls) {
    const name = userIdToName[String(msg.userId || '')];
    if (!name) continue;
    todayBuckets[name].calls++;
    const dur = Number(msg.meta?.call?.duration || 0);
    todayBuckets[name].callSecs += dur;
    if (dur >= 30) todayBuckets[name].calls30s++;
  }

  // Process today's SMS (only count outbound with a userId)
  for (const msg of todaySMS) {
    const name = userIdToName[String(msg.userId || '')];
    if (!name) continue;
    todayBuckets[name].sms++;
  }

  // ── Fetch MTD calls and SMS ───────────────────────────────────────────
  const [mtdCalls, mtdSMS] = await Promise.all([
    exportMessages(locationId, 'Call', mtdStartStr, tomorrowStr, 30),
    exportMessages(locationId, 'SMS',  mtdStartStr, tomorrowStr, 50),
  ]);

  // Process MTD calls
  for (const msg of mtdCalls) {
    const name = userIdToName[String(msg.userId || '')];
    if (!name) continue;
    mtdBuckets[name].calls++;
    const dur = Number(msg.meta?.call?.duration || 0);
    mtdBuckets[name].callSecs += dur;
    if (dur >= 30) mtdBuckets[name].calls30s++;
  }

  // Process MTD SMS
  for (const msg of mtdSMS) {
    const name = userIdToName[String(msg.userId || '')];
    if (!name) continue;
    mtdBuckets[name].sms++;
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
    mtdCallsRaw:   mtdCalls.length,
    mtdSMSRaw:     mtdSMS.length,
  };

  return result;
}

module.exports = { fetchCallStats };
