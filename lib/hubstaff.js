// lib/hubstaff.js
//
// Fetches daily activity data from the Hubstaff v2 API.
// Uses the /activities/daily endpoint which returns pre-aggregated
// tracked time and activity per user per day — much faster than
// pulling raw time entries and summing them ourselves.
//
// Required env var: HUBSTAFF_TOKEN (Personal Access Token)
// Org ID is hardcoded to 677673 but can be overridden via HUBSTAFF_ORG_ID.

const HUBSTAFF_BASE = 'https://api.hubstaff.com';
const DEFAULT_ORG   = '677673';

async function hubstaffFetch(path) {
  const token = process.env.HUBSTAFF_TOKEN;
  if (!token) throw new Error('HUBSTAFF_TOKEN env var is not set.');

  const res = await fetch(`${HUBSTAFF_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
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
// Returns raw array of daily_activity objects from the API.
async function fetchDailyActivities(orgId, startDate, endDate) {
  const all = [];
  let pageToken = null;

  while (true) {
    let url = `/v2/organizations/${orgId}/activities/daily?date[start]=${startDate}&date[end]=${endDate}&page_limit=500`;
    if (pageToken) url += `&page_start_id=${pageToken}`;

    const data = await hubstaffFetch(url);
    const rows = data.daily_activities || [];
    all.push(...rows);

    // Stop when there are no more pages
    const next = data.pagination?.next_page_token || null;
    if (!next || rows.length === 0) break;
    pageToken = next;
  }

  return all;
}

// Aggregate daily activity rows into a per-user summary.
// Returns: { [userId]: { tracked: seconds, active: seconds } }
function aggregateByUser(activities) {
  const stats = {};
  for (const a of activities) {
    const uid = String(a.user_id);
    if (!stats[uid]) stats[uid] = { tracked: 0, active: 0 };
    stats[uid].tracked += a.tracked  || 0;
    stats[uid].active  += a.active   || 0;
  }
  return stats;
}

// Today's stats — { [userId]: { tracked, active } }
async function fetchTodayStats(today) {
  const orgId   = process.env.HUBSTAFF_ORG_ID || DEFAULT_ORG;
  const dateStr = toDateStr(today);
  const rows    = await fetchDailyActivities(orgId, dateStr, dateStr);
  return aggregateByUser(rows);
}

// Month-to-date stats — { [userId]: { tracked, active } }
async function fetchMTDStats(monthStart, today) {
  const orgId    = process.env.HUBSTAFF_ORG_ID || DEFAULT_ORG;
  const startStr = toDateStr(monthStart);
  const endStr   = toDateStr(today);
  const rows     = await fetchDailyActivities(orgId, startStr, endStr);
  return aggregateByUser(rows);
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
  fetchTodayStats,
  fetchMTDStats,
  fmtHours,
  fmtActivity,
};
