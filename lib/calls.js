// lib/calls.js
//
// Fetches call + SMS stats per ISA from GHL conversations.
//
// Approach:
// 1. Get conversations updated TODAY — small set (100-200), fast
// 2. Batch-fetch their messages 5 at a time
// 3. Find call/SMS messages, grab userId from each
// 4. Map userId → ISA name → count
// 5. Repeat for MTD (filtered to call/SMS conversation types only)

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

function isCallType(type) {
  if (!type) return false;
  return String(type).toLowerCase().includes('call');
}

function isSMSType(type) {
  if (!type) return false;
  const t = String(type).toLowerCase();
  return t.includes('sms') || t === 'type_sms' || t === 'sms';
}

function hasRelevantMsg(conv) {
  // Use messageTypes array on each conversation to skip email-only conversations
  const types = conv.messageTypes || [];
  if (Array.isArray(types) && types.length > 0) {
    return types.some(t => isCallType(t) || isSMSType(t));
  }
  // Can't tell — include to be safe
  return true;
}

function fmtDuration(secs) {
  if (!secs) return '0s';
  return secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${secs % 60}s`;
}

function dayStart(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

async function batchAsync(items, fn, concurrency = 5) {
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

// Get call + SMS messages (with userId + duration) from one conversation
async function getMsgsFromConv(convId, sinceMs) {
  try {
    const data    = await ghlGet(`/conversations/${convId}/messages?limit=100`);
    const rawMsgs = data.messages || data.data || [];
    const msgs    = Array.isArray(rawMsgs) ? rawMsgs
                  : Array.isArray(rawMsgs.messages) ? rawMsgs.messages
                  : [];

    const results = [];
    for (const m of msgs) {
      const dt = m.dateAdded ? new Date(m.dateAdded).getTime() : 0;
      if (dt < sinceMs) continue;

      const type   = m.messageType || m.type || '';
      const userId = String(m.userId || m.user_id || '');
      if (!userId) continue;

      if (isCallType(type)) {
        const duration = Number(
          m.meta?.duration || m.meta?.callDuration ||
          m.callDuration   || m.duration || 0
        );
        results.push({ kind: 'call', userId, duration });
      } else if (isSMSType(type)) {
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

  // Initialise buckets: calls + SMS for today and MTD
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
      } else if (kind === 'sms') {
        bucket[name].sms++;
      }
    }
  }

  // ── TODAY ─────────────────────────────────────────────────────────────
  const todayConvs = await getConvsSince(locationId, todayMs, 5);
  const todayFiltered = todayConvs.filter(hasRelevantMsg);

  const todayMsgs = await batchAsync(
    todayFiltered,
    c => getMsgsFromConv(c.id, todayMs),
    5
  );
  todayMsgs.forEach(msgs => applyMsgs(msgs, todayBuckets));

  // ── MTD (pre-today only) ──────────────────────────────────────────────
  const mtdConvs = await getConvsSince(locationId, mtdMs, 10);
  const mtdFiltered = mtdConvs.filter(c => {
    if (!hasRelevantMsg(c)) return false;
    const dt = c.lastMessageDate ? new Date(c.lastMessageDate).getTime()
             : c.dateUpdated     ? new Date(c.dateUpdated).getTime() : 0;
    return dt < todayMs; // today already counted above
  });

  const mtdMsgs = await batchAsync(
    mtdFiltered.slice(0, 300),
    c => getMsgsFromConv(c.id, mtdMs),
    5
  );
  mtdMsgs.forEach(msgs => applyMsgs(msgs, mtdBuckets));

  // Merge today into MTD
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
      // Today
      callsToday:    t.calls,
      calls30sToday: t.calls30s,
      avgDurToday:   t.calls > 0 ? fmtDuration(Math.round(t.callSecs / t.calls)) : '-',
      smsToday:      t.sms,
      // MTD
      callsMTD:      m.calls,
      calls30sMTD:   m.calls30s,
      avgDurMTD:     m.calls > 0 ? fmtDuration(Math.round(m.callSecs / m.calls)) : '-',
      smsMTD:        m.sms,
    };
  }

  result._debug = {
    todayConvsScanned:     todayConvs.length,
    todayConvsWithMsgs:    todayFiltered.length,
    mtdConvsScanned:       mtdConvs.length,
    mtdConvsWithMsgs:      mtdFiltered.length,
  };

  return result;
}

module.exports = { fetchCallStats };
