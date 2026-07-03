// lib/calls.js
//
// Fetches call stats per sales rep from GHL conversations + messages API.
// Strategy: search recent conversations (not filtered by assignedTo since
// contacts may use a custom sales_rep field rather than GHL's native
// assignedTo field). Filter call messages by userId to attribute them
// to the correct ISA. Returns debug info on first run so we can verify.

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

function fmtDuration(seconds) {
  if (!seconds) return '0s';
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

// Step 1: Get all conversations updated since sinceMs for the location.
// We do NOT filter by assignedTo here because Direct Finance uses a
// custom sales_rep field, not GHL's native conversation assignment.
async function getRecentConversations(locationId, sinceMs) {
  const all = [];
  let startAfterId;

  for (let page = 0; page < 20; page++) { // max 2000 conversations
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

    const convs = data.conversations || data.data || [];
    if (!convs.length) break;

    all.push(...convs);
    if (convs.length < 100) break;
    startAfterId = convs[convs.length - 1]?.id;
    if (!startAfterId) break;
  }

  return all;
}

// Step 2: Get messages from a single conversation and find call messages
// made by a specific GHL user.
async function getCallMessagesFromConv(convId, sinceMs, ghlUserId) {
  const calls = [];
  try {
    const data     = await ghlGet(`/conversations/${convId}/messages?limit=100`);
    const messages = data.messages || data.data || [];

    for (const msg of messages) {
      const msgDate = msg.dateAdded ? new Date(msg.dateAdded).getTime() : 0;
      if (msgDate < sinceMs) continue;

      const type = msg.messageType || msg.type || '';
      if (!isCallType(type)) continue;

      // Check this message belongs to the right ISA
      const msgUserId = msg.userId || msg.user_id || '';
      if (String(msgUserId) !== String(ghlUserId)) continue;

      const duration =
        msg.meta?.duration     ||
        msg.meta?.callDuration ||
        msg.callDuration       ||
        msg.duration           ||
        0;

      calls.push({ duration: Number(duration) || 0 });
    }
  } catch {
    // Ignore per-conversation message fetch errors
  }
  return calls;
}

// Returns call stats for all ISAs in one pass over today's conversations.
// Also returns debug info so we can verify the message types found.
async function fetchCallStats(reps, locationId, now, monthStart) {
  const todayMs = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const mtdMs   = new Date(monthStart.getFullYear(), monthStart.getMonth(), 1).getTime();

  // Build a lookup: ghlUserId → ghlName for fast attribution
  const userIdToName = {};
  for (const [ghlName, rep] of Object.entries(reps)) {
    userIdToName[String(rep.ghlUserId)] = ghlName;
  }

  // Initialise stats buckets
  const stats = {};
  for (const ghlName of Object.keys(reps)) {
    stats[ghlName] = {
      today: { calls: 0, secs: 0, calls30s: 0 },
      mtd:   { calls: 0, secs: 0, calls30s: 0 },
    };
  }

  // Debug counters
  const debug = {
    convsToday: 0, convsMTD: 0,
    msgTypesFound: new Set(),
    sampleMessages: [],
  };

  // Fetch conversations for today first
  const todayConvs = await getRecentConversations(locationId, todayMs);
  debug.convsToday = todayConvs.length;

  for (const conv of todayConvs.slice(0, 300)) {
    const data     = await ghlGet(`/conversations/${conv.id}/messages?limit=100`).catch(() => null);
    if (!data) continue;
    const messages = data.messages || data.data || [];

    for (const msg of messages) {
      const type = msg.messageType || msg.type || '';
      if (type) debug.msgTypesFound.add(type);

      const msgDate = msg.dateAdded ? new Date(msg.dateAdded).getTime() : 0;
      if (msgDate < todayMs) continue;
      if (!isCallType(type)) continue;

      // Save a sample for debugging
      if (debug.sampleMessages.length < 3) {
        debug.sampleMessages.push({
          type, userId: msg.userId || msg.user_id,
          duration: msg.meta?.duration || msg.duration || 0,
          dateAdded: msg.dateAdded,
        });
      }

      const userId   = String(msg.userId || msg.user_id || '');
      const ghlName  = userIdToName[userId];
      if (!ghlName) continue;

      const duration = Number(msg.meta?.duration || msg.callDuration || msg.duration || 0);
      stats[ghlName].today.calls++;
      stats[ghlName].today.secs += duration;
      if (duration >= 30) stats[ghlName].today.calls30s++;
    }
  }

  // For MTD we ALSO add today's stats, then fetch earlier days
  // (today's convs already counted above — now fetch older ones)
  const olderConvs = await getRecentConversations(locationId, mtdMs);
  debug.convsMTD = olderConvs.length;

  for (const conv of olderConvs.slice(0, 500)) {
    const data     = await ghlGet(`/conversations/${conv.id}/messages?limit=100`).catch(() => null);
    if (!data) continue;
    const messages = data.messages || data.data || [];

    for (const msg of messages) {
      const type    = msg.messageType || msg.type || '';
      const msgDate = msg.dateAdded ? new Date(msg.dateAdded).getTime() : 0;
      if (msgDate < mtdMs || msgDate >= todayMs) continue; // only pre-today for MTD
      if (!isCallType(type)) continue;

      const userId  = String(msg.userId || msg.user_id || '');
      const ghlName = userIdToName[userId];
      if (!ghlName) continue;

      const duration = Number(msg.meta?.duration || msg.callDuration || msg.duration || 0);
      stats[ghlName].mtd.calls++;
      stats[ghlName].mtd.secs += duration;
      if (duration >= 30) stats[ghlName].mtd.calls30s++;
    }
  }

  // Add today to MTD totals
  for (const ghlName of Object.keys(reps)) {
    stats[ghlName].mtd.calls    += stats[ghlName].today.calls;
    stats[ghlName].mtd.secs     += stats[ghlName].today.secs;
    stats[ghlName].mtd.calls30s += stats[ghlName].today.calls30s;
  }

  // Format output
  const result = {};
  for (const [ghlName, s] of Object.entries(stats)) {
    result[ghlName] = {
      callsToday:    s.today.calls,
      calls30sToday: s.today.calls30s,
      avgDurToday:   s.today.calls > 0 ? fmtDuration(Math.round(s.today.secs / s.today.calls)) : '-',
      callsMTD:      s.mtd.calls,
      calls30sMTD:   s.mtd.calls30s,
      avgDurMTD:     s.mtd.calls > 0 ? fmtDuration(Math.round(s.mtd.secs / s.mtd.calls)) : '-',
    };
  }

  result._debug = {
    convsToday:    debug.convsToday,
    convsMTD:      debug.convsMTD,
    msgTypesFound: Array.from(debug.msgTypesFound).slice(0, 30),
    sampleCallMsgs: debug.sampleMessages,
  };

  return result;
}

module.exports = { fetchCallStats };
