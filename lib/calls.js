// lib/calls.js
//
// Fetches call stats per sales rep from GHL conversations + messages API.
// For each rep, we:
//   1. Search conversations assigned to them, filtered by date
//   2. For each conversation, fetch its messages
//   3. Find call-type messages and extract duration from meta
//   4. Return: totalCalls, avgDuration (secs), calls30s (calls >= 30s)
//
// NOTE: Duration comes from msg.meta.duration (seconds). If GHL doesn't
// populate this field for your account's call setup, durations will show
// as 0 — flag this and we can adjust the field path.

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

// GHL uses various type strings for calls
function isCallType(type) {
  if (!type) return false;
  return String(type).toLowerCase().includes('call');
}

function fmtDuration(seconds) {
  if (!seconds) return '0s';
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

// Get all conversations for a rep since a timestamp
async function getConversations(locationId, ghlUserId, sinceMs) {
  const all = [];
  let lastId;

  for (let page = 0; page < 10; page++) {
    const params = new URLSearchParams({
      locationId,
      assignedTo:     ghlUserId,
      startAfterDate: String(sinceMs),
      limit:          '100',
    });
    if (lastId) params.set('lastId', lastId);

    const data  = await ghlGet(`/conversations/?${params}`);
    const convs = data.conversations || [];
    if (!convs.length) break;

    all.push(...convs);
    if (convs.length < 100) break;
    lastId = convs[convs.length - 1]?.id;
    if (!lastId) break;
  }

  return all;
}

// Get call messages from a single conversation, returning their duration
async function getCallMessages(convId, sinceMs) {
  const calls = [];
  try {
    const data     = await ghlGet(`/conversations/${convId}/messages?limit=100`);
    const messages = data.messages || data.data || [];

    for (const msg of messages) {
      const msgDate = msg.dateAdded ? new Date(msg.dateAdded).getTime() : 0;
      if (msgDate < sinceMs) continue;

      const type = msg.messageType || msg.type || '';
      if (!isCallType(type)) continue;

      // GHL stores call duration in meta.duration (seconds)
      // Try several possible field paths
      const duration =
        msg.meta?.duration       ||
        msg.meta?.callDuration   ||
        msg.callDuration         ||
        msg.duration             ||
        0;

      calls.push({ duration: Number(duration) || 0, type });
    }
  } catch {
    // Ignore per-conversation errors — don't break the whole rep's count
  }
  return calls;
}

// Full call stats for one rep in one date range
async function callStatsForUser(locationId, ghlUserId, sinceMs) {
  const convs     = await getConversations(locationId, ghlUserId, sinceMs);
  let totalCalls  = 0;
  let totalSecs   = 0;
  let calls30s    = 0;

  // Only fetch messages for conversations that MIGHT have calls
  // (optimisation: skip convs where lastMessageType clearly isn't a call,
  // e.g. purely SMS conversations — note this is an approximation)
  const callConvIds = convs
    .filter(c => !c.lastMessageType || isCallType(c.lastMessageType) || true)
    // ↑ passing `true` for now to check ALL convs until we know the exact
    //   type strings GHL uses — will optimise once confirmed
    .map(c => c.id);

  // Fetch messages in batches to stay under rate limits
  for (const convId of callConvIds.slice(0, 200)) { // cap at 200 convs per rep
    const calls = await getCallMessages(convId, sinceMs);
    for (const { duration } of calls) {
      totalCalls++;
      totalSecs += duration;
      if (duration >= 30) calls30s++;
    }
  }

  return {
    calls:       totalCalls,
    avgDuration: totalCalls > 0 ? Math.round(totalSecs / totalCalls) : 0,
    calls30s,
  };
}

// Returns { [ghlName]: { callsToday, callsMTD, avgDurToday, avgDurMTD, calls30sToday, calls30sMTD } }
async function fetchCallStats(reps, locationId, now, monthStart) {
  const todayMs = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const mtdMs   = new Date(monthStart.getFullYear(), monthStart.getMonth(), 1).getTime();
  const stats   = {};

  for (const [ghlName, rep] of Object.entries(reps)) {
    try {
      // Run today + MTD sequentially per rep to avoid rate limits
      const today = await callStatsForUser(locationId, rep.ghlUserId, todayMs);
      const mtd   = await callStatsForUser(locationId, rep.ghlUserId, mtdMs);

      stats[ghlName] = {
        callsToday:   today.calls,
        calls30sToday: today.calls30s,
        avgDurToday:  today.calls > 0 ? fmtDuration(today.avgDuration) : '-',
        callsMTD:     mtd.calls,
        calls30sMTD:  mtd.calls30s,
        avgDurMTD:    mtd.calls > 0 ? fmtDuration(mtd.avgDuration) : '-',
      };
    } catch (err) {
      console.warn(`Call stats failed for ${ghlName}:`, err.message);
      stats[ghlName] = {
        callsToday: '-', calls30sToday: '-', avgDurToday: '-',
        callsMTD:   '-', calls30sMTD:   '-', avgDurMTD:   '-',
      };
    }
  }

  return stats;
}

module.exports = { fetchCallStats };
