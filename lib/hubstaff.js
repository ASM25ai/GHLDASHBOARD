// lib/hubstaff.js
//
// Hubstaff v2 API integration.
//
// IMPORTANT — How Hubstaff personal access tokens work:
// The token you generate at developer.hubstaff.com is a REFRESH TOKEN,
// not a usable access token. Before every API call we must exchange it
// for a short-lived access token (expires ~1 hour) by POST-ing to
// https://account.hubstaff.com/access_tokens.
// Since our sync runs every 30 minutes, we just exchange at the start
// of each run — simple and always fresh.
//
// Env vars required:
//   HUBSTAFF_TOKEN   — the personal access token (refresh token) from
//                      developer.hubstaff.com/account/personal-access-tokens
//   HUBSTAFF_ORG_ID  — defaults to 677673

const HUBSTAFF_BASE    = 'https://api.hubstaff.com';
const HUBSTAFF_AUTH    = 'https://account.hubstaff.com';
const DEFAULT_ORG      = '677673';

// Step 1: Exchange the personal access token (refresh token) for a
// short-lived access token. Called once at the start of each sync run.
async function getAccessToken() {
  const refreshToken = process.env.HUBSTAFF_TOKEN;
  if (!refreshToken) throw new Error('HUBSTAFF_TOKEN env var is not set.');

  // Per Hubstaff docs: personal access tokens do NOT require client_id or
  // client_secret — those are only needed for the standard OAuth flow.
  // Sending them with a personal access token causes a 400 error.
  // https://developer.hubstaff.com/authentication (Personal access tokens section)
  const body = new URLSearchParams({
    grant_type:    'refresh_token',
    refresh_token: refreshToken,
  });

  const res = await fetch(`${HUBSTAFF_AUTH}/access_tokens`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    body.toString(),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Hubstaff token exchange failed (${res.status}): ${body}`);
  }

  const data = await res.json();
  if (!data.access_token) {
    throw new Error(`Hubstaff token exchange returned no access_token: ${JSON.stringify(data)}`);
  }

  return data.access_token;
}

// Step 2: Use the access token for actual API calls
async function hubstaffFetch(path, accessToken) {
  const res = await fetch(`${HUBSTAFF_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Hubstaff API error ${res.status} on ${path}: ${body}`);
  }

  return res.json();
}

function toDateStr(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Fetch all daily activity records for a date range, handling pagination.
async function fetchDailyActivities(orgId, startDate, endDate, accessToken) {
  const all = [];
  let pageToken = null;

  while (true) {
    let url = `/v2/organizations/${orgId}/activities/daily?date[start]=${startDate}&date[stop]=${endDate}&page_limit=500`;
    if (pageToken) url += `&page_start_id=${pageToken}`;

    const data = await hubstaffFetch(url, accessToken);
    const rows = data.daily_activities || [];
    all.push(...rows);

    const next = data.pagination?.next_page_token || null;
    if (!next || rows.length === 0) break;
    pageToken = next;
  }

  return all;
}

// Aggregate daily activity rows by user.
// Returns: { [userId]: { tracked: seconds, active: seconds } }
function aggregateByUser(activities) {
  const stats = {};
  for (const a of activities) {
    const uid = String(a.user_id);
    if (!stats[uid]) stats[uid] = { tracked: 0, active: 0, keyboard: 0, mouse: 0, input_tracked: 0, _raw: null };
    stats[uid].tracked       += a.tracked       || 0;
    stats[uid].active        += a.active        || 0;
    stats[uid].keyboard      += a.keyboard      || 0;
    stats[uid].mouse         += a.mouse         || 0;
    stats[uid].input_tracked += a.input_tracked || 0;
    stats[uid].overall += a.overall || 0;
    // Store one raw sample row for debugging
    if (!stats[uid]._raw) stats[uid]._raw = a;
  }
  return stats;
}

// Main entry point — call this once per sync run.
// Returns { todayStats, mtdStats } both keyed by userId string.
async function fetchHubstaffStats(now, monthStart) {
  const accessToken = await getAccessToken();
  const orgId       = process.env.HUBSTAFF_ORG_ID || DEFAULT_ORG;
  const todayStr    = toDateStr(now);
  const startStr    = toDateStr(monthStart);

  // Fetch today and MTD in parallel (both use same access token)
  const [todayRows, mtdRows] = await Promise.all([
    fetchDailyActivities(orgId, todayStr, todayStr, accessToken),
    fetchDailyActivities(orgId, startStr, todayStr, accessToken),
  ]);

  const todayStats = aggregateByUser(todayRows);
  const mtdStats   = aggregateByUser(mtdRows);

  // rawSample: first user's raw API row — used to debug activity field names
  const rawSample = todayRows[0] || null;

  return { todayStats, mtdStats, rawSample };
}

// Format seconds → "4.5 hr"
function fmtHours(seconds) {
  if (!seconds) return '0.0 hr';
  return `${(seconds / 3600).toFixed(1)} hr`;
}

// Activity % — Hubstaff field meanings vary by account config.
// We try multiple fields in order of preference and pick the first
// that gives a value between 1-99% (to catch the "all zeroes" and
// "always 100%" issues we've seen).
function fmtActivityFromStats(stats, tracked) {
  if (!tracked) return '-';
  // Candidates in order of preference
  const candidates = [
    stats.keyboard,       // keyboard seconds only (most conservative)
    stats.active,         // general active field
    stats.input_tracked,  // all input-tracked time
  ];
  for (const val of candidates) {
    if (val > 0 && val < tracked) {
      return `${Math.round((val / tracked) * 100)}%`;
    }
  }
  // If keyboard+mouse combined is less than tracked, use that
  const combined = (stats.keyboard || 0) + (stats.mouse || 0);
  if (combined > 0 && combined < tracked) {
    return `${Math.round((combined / tracked) * 100)}%`;
  }
  return '-';
}

// Simple version for when we only have a single numerator value
function fmtActivity(activeSeconds, trackedSeconds) {
  if (!trackedSeconds) return '-';
  return `${Math.round((activeSeconds / trackedSeconds) * 100)}%`;
}

module.exports = {
  fetchHubstaffStats,
  fmtHours,
  fmtActivity,
};
