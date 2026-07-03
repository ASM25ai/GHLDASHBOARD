// lib/calls.js
//
// Fetches call counts per ISA from GHL conversations — conversation-level
// only, NO per-message fetching. This keeps the sync well within Vercel's
// timeout. Trade-off: call duration not available (would need message-level
// fetching which times out). We filter by lastMessageType to identify call
// conversations and attribute them to ISAs via lastMessageUserId.

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

function dayStart(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

async function fetchCallStats(reps, locationId, now, monthStart) {
  const todayMs = dayStart(now);
  const mtdMs   = dayStart(monthStart);

  // Build userId → repName lookup for fast attribution
  const userIdToName = {};
  for (const [name, rep] of Object.entries(reps)) {
    userIdToName[String(rep.ghlUserId)] = name;
  }

  // Initialise counters
  const totals = {};
  for (const name of Object.keys(reps)) {
    totals[name] = { today: 0, mtd: 0 };
  }

  let debugSample = null;
  let totalConvsScanned = 0;
  let callConvsFound = 0;

  // Single pass over MTD conversations (today is a subset of MTD)
  let startAfterId;

  for (let page = 0; page < 10; page++) {
    const params = new URLSearchParams({
      locationId,
      startAfterDate: String(mtdMs),
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

    totalConvsScanned += convs.length;

    // Capture debug sample from first conversation (shows available fields)
    if (!debugSample && convs.length > 0) {
      const c = convs[0];
      debugSample = {
        fieldsAvailable:    Object.keys(c),
        lastMessageType:    c.lastMessageType,
        lastMessageUserId:  c.lastMessageUserId,
        lastMessageSenderId:c.lastMessageSenderId,
        userId:             c.userId,
        assignedTo:         c.assignedTo,
      };
    }

    for (const conv of convs) {
      if (!isCallType(conv.lastMessageType)) continue;
      callConvsFound++;

      // Try every field that might contain the rep's userId
      const userId = String(
        conv.lastMessageUserId  ||
        conv.lastMessageSenderId ||
        conv.userId             ||
        conv.assignedTo         ||
        ''
      );
      const name = userIdToName[userId];
      if (!name) continue;

      // Use lastMessageDate (when the call happened) to bucket into today vs MTD
      const convMs = conv.lastMessageDate
        ? new Date(conv.lastMessageDate).getTime()
        : (conv.dateUpdated ? new Date(conv.dateUpdated).getTime() : 0);

      if (convMs >= mtdMs)   totals[name].mtd++;
      if (convMs >= todayMs) totals[name].today++;
    }

    if (convs.length < 100) break;
    startAfterId = convs[convs.length - 1]?.id;
    if (!startAfterId) break;
  }

  const result = {};
  for (const [name, t] of Object.entries(totals)) {
    result[name] = {
      callsToday:    t.today,
      calls30sToday: '-',   // requires per-message fetch — deferred
      avgDurToday:   '-',   // requires per-message fetch — deferred
      callsMTD:      t.mtd,
      calls30sMTD:   '-',
      avgDurMTD:     '-',
    };
  }

  result._debug = {
    note:              'conversation-level only — no per-message fetching',
    totalConvsScanned,
    callConvsFound,
    debugSample,
  };

  return result;
}

module.exports = { fetchCallStats };
