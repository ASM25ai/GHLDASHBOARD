// lib/calls.js
//
// Fetches call stats per ISA from GHL.
//
// Approach (simple):
// 1. Get conversations updated TODAY — small set (100-200 max)
// 2. Batch-fetch their messages (5 at a time, ~5-10 secs total)
// 3. Find call-type messages from today, grab userId from each
// 4. Map userId → ISA name → count
//
// For MTD: same approach but filter conversations updated this month
// AND only fetch messages for conversations that have a call in their
// messageTypes list (available on each conversation object — avoids
// fetching messages for email/SMS-only conversations)

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

function hasCallInTypes(conv) {
  // messageTypes is available on each conversation — use it to skip
  // conversations that never had any call message at all
  const types = conv.messageTypes || conv.lastMessageType || '';
  if (Array.isArray(types)) return types.some(t => isCallType(t));
  if (typeof types === 'string') return isCallType(types);
  return true; // can't tell — include it to be safe
}

function fmtDuration(secs) {
  if (!secs) return '0s';
  return secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${secs % 60}s`;
}

function dayStart(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

// Batch async calls with concurrency limit
async function batchAsync(items, fn, concurrency = 5) {
  const results = [];
  for (let i = 0; i < items.length; i += concurrency) {
    const batch   = items.slice(i, i + concurrency);
    const settled = await Promise.allSettled(batch.map(fn));
    results.push(...settled.map(r => r.status === 'fulfilled' ? r.value : []));
  }
  return results;
}

// Get all conversations updated since sinceMs (no user filter)
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

// Get call messages (with userId + duration) from one conversation since sinceMs
async function getCallMsgs(convId, sinceMs) {
  try {
    const data    = await ghlGet(`/conversations/${convId}/messages?limit=100`);
    const rawMsgs = data.messages || data.data || [];
    const msgs    = Array.isArray(rawMsgs) ? rawMsgs
                  : Array.isArray(rawMsgs.messages) ? rawMsgs.messages
                  : [];

    return msgs
      .filter(m => {
        const dt = m.dateAdded ? new Date(m.dateAdded).getTime() : 0;
        return dt >= sinceMs && isCallType(m.messageType || m.type || '');
      })
      .map(m => ({
        userId:   String(m.userId || m.user_id || ''),
        duration: Number(m.meta?.duration || m.meta?.callDuration || m.callDuration || m.duration || 0),
      }));
  } catch {
    return [];
  }
}

async function fetchCallStats(reps, locationId, now, monthStart) {
  const todayMs = dayStart(now);
  const mtdMs   = dayStart(monthStart);

  // userId → ISA name lookup
  const userIdToName = {};
  for (const [name, rep] of Object.entries(reps)) {
    userIdToName[String(rep.ghlUserId)] = name;
  }

  // Initialise counters
  const today = {}, mtd = {};
  for (const name of Object.keys(reps)) {
    today[name] = { calls: 0, secs: 0, calls30s: 0 };
    mtd[name]   = { calls: 0, secs: 0, calls30s: 0 };
  }

  // ── TODAY ──────────────────────────────────────────────────────────────
  // Scan conversations updated today — small set, fast
  const todayConvs = await getConvsSince(locationId, todayMs, 5); // max 500

  const todayCallMsgs = await batchAsync(
    todayConvs.filter(hasCallInTypes),
    c => getCallMsgs(c.id, todayMs),
    5
  );

  for (const msgs of todayCallMsgs) {
    for (const { userId, duration } of msgs) {
      const name = userIdToName[userId];
      if (!name) continue;
      today[name].calls++;
      today[name].secs += duration;
      if (duration >= 30) today[name].calls30s++;
    }
  }

  // ── MTD (excluding today — add today's totals at the end) ─────────────
  // Only scan conversations updated this month that have a call in messageTypes
  // maxPages = 10 (1000 convs), but filtered to call-only convs before fetching
  const mtdConvs      = await getConvsSince(locationId, mtdMs, 10);
  const mtdCallConvs  = mtdConvs.filter(c => hasCallInTypes(c) && (() => {
    const dt = c.lastMessageDate ? new Date(c.lastMessageDate).getTime()
             : c.dateUpdated     ? new Date(c.dateUpdated).getTime() : 0;
    return dt < todayMs; // exclude today (already counted above)
  })());

  const mtdCallMsgs = await batchAsync(
    mtdCallConvs.slice(0, 300), // cap MTD message fetches at 300 convs
    c => getCallMsgs(c.id, mtdMs),
    5
  );

  for (const msgs of mtdCallMsgs) {
    for (const { userId, duration } of msgs) {
      const name = userIdToName[userId];
      if (!name) continue;
      mtd[name].calls++;
      mtd[name].secs += duration;
      if (duration >= 30) mtd[name].calls30s++;
    }
  }

  // Combine today into MTD
  for (const name of Object.keys(reps)) {
    mtd[name].calls    += today[name].calls;
    mtd[name].secs     += today[name].secs;
    mtd[name].calls30s += today[name].calls30s;
  }

  // Format results
  const result = {};
  for (const name of Object.keys(reps)) {
    const t = today[name], m = mtd[name];
    result[name] = {
      callsToday:    t.calls,
      calls30sToday: t.calls30s,
      avgDurToday:   t.calls > 0 ? fmtDuration(Math.round(t.secs / t.calls)) : '-',
      callsMTD:      m.calls,
      calls30sMTD:   m.calls30s,
      avgDurMTD:     m.calls > 0 ? fmtDuration(Math.round(m.secs / m.calls)) : '-',
    };
  }

  result._debug = {
    todayConvsScanned:     todayConvs.length,
    todayCallConvsChecked: todayConvs.filter(hasCallInTypes).length,
    mtdConvsScanned:       mtdConvs.length,
    mtdCallConvsChecked:   mtdCallConvs.length,
  };

  return result;
}

module.exports = { fetchCallStats };
