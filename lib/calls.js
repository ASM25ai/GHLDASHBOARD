// lib/calls.js
//
// GHL message structure (CONFIRMED 2026-07-03):
//
// GET /conversations/{id}/messages returns:
//   { messages: { lastMessageId, nextPage, messages: [ ...actual messages ] } }
//   (double-nested: data.messages.messages is the array)
//
// Each call message:
//   messageType: "TYPE_CALL"
//   userId: "5bzrcYuCmbEzYn2tvaRz"  (the ISA who made/received the call)
//   meta: { call: { duration: 257, status: "completed" } }
//   dateAdded: "2026-07-02T21:46:27.092Z"
//
// Each SMS message:
//   messageType: "TYPE_SMS"
//   userId: "5bzrcYuCmbEzYn2tvaRz"  (may be absent on inbound)
//   dateAdded: "2026-07-02T21:36:19.900Z"

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

function dayStart(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

async function batchAsync(items, fn, concurrency = 10) {
  const results = [];
  for (let i = 0; i < items.length; i += concurrency) {
    const batch   = items.slice(i, i + concurrency);
    const settled = await Promise.allSettled(batch.map(fn));
    results.push(...settled.map(r => r.status === 'fulfilled' ? r.value : []));
  }
  return results;
}

async function getConvsSince(locationId, sinceMs, maxPages = 5) {
  const all = [];
  let startAfterId;

  for (let page = 0; page < maxPages; page++) {
    const params = new URLSearchParams({
      locationId,
      startAfterDate: String(sinceMs),
      limit:          '100',
    });
    if (startAfterId) params.set('startAfterId', startAfterId);

    let data;
    try {
      data = await ghlGet(`/conversations/search?${params}`);
    } catch {
      data = await ghlGet(`/conversations/?${params}`);
    }

    const convs = Array.isArray(data.conversations) ? data.conversations
                : Array.isArray(data.data)          ? data.data
                : [];
    if (!convs.length) break;
    all.push(...convs);
    if (convs.length < 100) break;
    startAfterId = convs[convs.length - 1]?.id;
    if (!startAfterId) break;
  }

  return all;
}

// Extract call + SMS messages from one conversation.
// CONFIRMED nesting: data.messages.messages (double-nested)
async function getMsgsFromConv(convId, sinceMs) {
  try {
    const data = await ghlGet(`/conversations/${convId}/messages?limit=100`);

    // Double-nested: data.messages is an object with a .messages array inside
    const wrapper = data.messages || data.data || {};
    const msgs    = Array.isArray(wrapper) ? wrapper
                  : Array.isArray(wrapper.messages) ? wrapper.messages
                  : [];

    const results = [];
    for (const m of msgs) {
      const dt = m.dateAdded ? new Date(m.dateAdded).getTime() : 0;
      if (dt < sinceMs) continue;

      const type   = m.messageType || '';
      const userId = String(m.userId || '');

      if (type === 'TYPE_CALL' && userId) {
        // CONFIRMED: duration lives at meta.call.duration (NOT meta.duration)
        const duration = Number(m.meta?.call?.duration || 0);
        results.push({ kind: 'call', userId, duration });
      } else if (type === 'TYPE_SMS' && userId) {
        results.push({ kind: 'sms', userId, duration: 0 });
      }
    }
    return results;
  } catch {
    return [];
  }
}

async function fetchCallStats(reps, locationId, now, monthStart) {
  const todayMs = dayStart(now);
  const mtdMs   = dayStart(monthStart);

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

  function applyMsgs(msgs, bucket) {
    for (const { kind, userId, duration } of msgs) {
      const name = userIdToName[userId];
      if (!name) continue;
      if (kind === 'call') {
        bucket[name].calls++;
        bucket[name].callSecs += duration;
        if (duration >= 30) bucket[name].calls30s++;
      } else {
        bucket[name].sms++;
      }
    }
  }

  // ── TODAY: all conversations updated today, no pre-filter ─────────────
  const todayConvs = await getConvsSince(locationId, todayMs, 5);

  const todayMsgResults = await batchAsync(
    todayConvs,
    c => getMsgsFromConv(c.id, todayMs),
    10
  );
  todayMsgResults.forEach(msgs => applyMsgs(msgs, todayBuckets));

  // ── MTD: conversations updated this month, pre-today only ─────────────
  const mtdConvs = await getConvsSince(locationId, mtdMs, 10);
  const preToday = mtdConvs.filter(c => {
    const dt = c.lastMessageDate
      ? (typeof c.lastMessageDate === 'number' ? c.lastMessageDate : new Date(c.lastMessageDate).getTime())
      : (c.dateUpdated ? new Date(c.dateUpdated).getTime() : 0);
    return dt < todayMs;
  });

  const mtdMsgResults = await batchAsync(
    preToday.slice(0, 500),
    c => getMsgsFromConv(c.id, mtdMs),
    10
  );
  mtdMsgResults.forEach(msgs => applyMsgs(msgs, mtdBuckets));

  // Merge today into MTD
  for (const name of Object.keys(reps)) {
    mtdBuckets[name].calls    += todayBuckets[name].calls;
    mtdBuckets[name].callSecs += todayBuckets[name].callSecs;
    mtdBuckets[name].calls30s += todayBuckets[name].calls30s;
    mtdBuckets[name].sms      += todayBuckets[name].sms;
  }

  // Format
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
    todayConvsScanned: todayConvs.length,
    mtdPreTodayConvs:  preToday.length,
  };

  return result;
}

module.exports = { fetchCallStats };
