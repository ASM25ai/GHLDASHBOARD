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

  const clientId = process.env.HUBSTAFF_CLIENT_ID;
  if (!clientId) throw new Error('HUBSTAFF_CLIENT_ID env var is not set.');

  const res = await fetch(`${HUBSTAFF_AUTH}/access_tokens`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type:    'refresh_token',
      refresh_token: refreshToken,
      client_id:     clientId,
    }),
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
    let url = `/v2/organizations/${orgId}/activities/daily?date[start]=${startDate}&date[end]=${endDate}&page_limit=500`;
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
    if (!stats[uid]) stats[uid] = { tracked: 0, active: 0 };
    stats[uid].tracked += a.tracked || 0;
    stats[uid].active  += a.active  || 0;
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

  return {
    todayStats: aggregateByUser(todayRows),
    mtdStats:   aggregateByUser(mtdRows),
  };
}

// Format seconds → "4.5 hr"
function fmtHours(seconds) {
  if (!seconds) return '0.0 hr';
  return `${(seconds / 3600).toFixed(1)} hr`;
}

// Activity % = active / tracked * 100
function fmtActivity(activeSeconds, trackedSeconds) {
  if (!trackedSeconds) return '-';
  return `${Math.round((activeSeconds / trackedSeconds) * 100)}%`;
}

module.exports = {
  fetchHubstaffStats,
  fmtHours,
  fmtActivity,
};
