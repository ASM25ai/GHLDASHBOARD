// ---------------------------------------------------------------------------
// GHL Sub-Account API — pulls contacts from individual dealer sub-accounts
// ---------------------------------------------------------------------------
//
// Each dealer sub-account has its own API key (private integration token).
// We query contacts using the Search Contacts (advanced) endpoint:
//   POST /contacts/search
//
// For each sub-account we:
//   1. Search all contacts with the "qualified" tag → these are delivered leads
//   2. Use the Owner (assignedTo) field to attribute to FM
//   3. Use dateCreated for date filtering (this month vs all time)
//
// Sub-account config comes from env vars:
//   DEALER_SUBACCOUNTS = JSON array, e.g.:
//   [
//     {
//       "name": "Absolute Approval",
//       "locationId": "BEmUBi3TXKZVFsI55TcM",
//       "apiKey": "...",
//       "deliveredTag": "qualified",
//       "fmField": "assignedTo",
//       "countType": "delivered_only"
//     }
//   ]

const GHL_BASE = 'https://services.leadconnectorhq.com';
const GHL_API_VERSION = '2021-07-28';

// ── Core fetch with retry ───────────────────────────────────────────────────

async function subAccountFetch(path, apiKey, options = {}, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    const start = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    try {
      const res = await fetch(`${GHL_BASE}${path}`, {
        ...options,
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Version: GHL_API_VERSION,
          'Content-Type': 'application/json',
          ...(options.headers || {}),
        },
      });
      clearTimeout(timeout);

      const elapsed = Date.now() - start;
      console.log(`GHL-Sub ${path} → ${res.status} (${elapsed}ms)`);

      if (res.ok) return res.json();

      if ((res.status >= 500 || res.status === 429) && attempt < retries) {
        const wait = attempt * 2000;
        console.warn(`GHL-Sub ${res.status} on ${path} — retry in ${wait / 1000}s`);
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }

      const body = await res.text().catch(() => '');
      throw new Error(`GHL-Sub API ${res.status} on ${path}: ${body.slice(0, 200)}`);
    } catch (err) {
      clearTimeout(timeout);
      if (err.name === 'AbortError') {
        console.warn(`GHL-Sub ${path} timeout (attempt ${attempt}/${retries})`);
        if (attempt < retries) {
          await new Promise((r) => setTimeout(r, attempt * 2000));
          continue;
        }
        throw new Error(`GHL-Sub timeout on ${path} after ${retries} attempts`);
      }
      throw err;
    }
  }
}

// ── Fetch users (for Owner → name mapping) ──────────────────────────────────

async function fetchUsers(locationId, apiKey) {
  const data = await subAccountFetch(
    `/users/search?companyId=${locationId}&locationId=${locationId}`,
    apiKey,
  );
  // Try the /users/location endpoint instead, which is more reliable
  // for sub-account user listing
  const users = data.users || [];
  const map = {};
  for (const u of users) {
    const name = [u.firstName || '', u.lastName || ''].join(' ').trim();
    if (u.id && name) map[u.id] = name;
  }
  return map;
}

// Try a simpler users endpoint
async function fetchLocationUsers(locationId, apiKey) {
  try {
    const data = await subAccountFetch(`/users/?locationId=${locationId}`, apiKey);
    const users = data.users || [];
    const map = {};
    for (const u of users) {
      const name = [u.firstName || '', u.lastName || ''].join(' ').trim();
      if (u.id && name) map[u.id] = name;
    }
    return map;
  } catch (err) {
    console.warn('fetchLocationUsers failed, trying search endpoint:', err.message);
    return fetchUsers(locationId, apiKey);
  }
}

// ── Search contacts with tag filter (paginated) ─────────────────────────────

async function searchContactsByTag(locationId, apiKey, tag, startMs, endMs) {
  const allContacts = [];
  let page = 1;
  const pageLimit = 100;

  while (true) {
    const body = {
      locationId,
      page,
      pageLimit,
      filters: [
        {
          field: 'tags',
          operator: 'contains',
          value: tag,
        },
      ],
    };

    // Add date filter if provided (for "this month" queries)
    if (startMs && endMs) {
      body.filters.push({
        field: 'dateCreated',
        operator: 'range',
        value: { gte: startMs, lte: endMs },
      });
    }

    const data = await subAccountFetch('/contacts/search', apiKey, {
      method: 'POST',
      body: JSON.stringify(body),
    });

    const contacts = data.contacts || [];
    allContacts.push(...contacts);

    if (contacts.length < pageLimit) break;
    page++;
    if (page > 50) {
      console.warn(`WARNING: 50-page limit hit (${allContacts.length} contacts)`);
      break;
    }
  }

  // Deduplicate
  const seen = new Set();
  return allContacts.filter((c) => {
    if (seen.has(c.id)) return false;
    seen.add(c.id);
    return true;
  });
}

// ── Aggregate dealer stats from sub-account ─────────────────────────────────
//
// Returns: {
//   allTime: { total, byFM: { 'Jamie Pacaud': count, ... } },
//   thisMonth: { total, byFM: { ... }, byDay: { '2026-08-01': count, ... } }
// }

async function aggregateDealerStats(config) {
  const { name, locationId, apiKey, deliveredTag = 'qualified' } = config;

  console.log(`\n── Fetching stats for ${name} (${locationId}) ──`);

  // 1. Get user map for Owner → name resolution
  const userMap = await fetchLocationUsers(locationId, apiKey);
  console.log(`  Users found: ${Object.keys(userMap).length} → ${JSON.stringify(userMap)}`);

  // 2. Date range for this month
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const monthEnd   = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);

  // 3. Fetch ALL contacts with the delivered tag (all time)
  console.log(`  Fetching all-time contacts with tag "${deliveredTag}"...`);
  const allTimeContacts = await searchContactsByTag(locationId, apiKey, deliveredTag);
  console.log(`  All-time delivered: ${allTimeContacts.length}`);

  // 4. Split into this-month vs all-time
  const thisMonthContacts = [];
  const byFMAllTime  = {};
  const byFMMonth    = {};
  const byDayMonth   = {};

  for (const c of allTimeContacts) {
    const created = new Date(c.dateCreated || c.dateAdded);
    const owner   = c.assignedTo || '';
    const fmName  = userMap[owner] || 'Unassigned';

    // All time FM count
    byFMAllTime[fmName] = (byFMAllTime[fmName] || 0) + 1;

    // This month?
    if (created >= monthStart && created <= monthEnd) {
      thisMonthContacts.push(c);
      byFMMonth[fmName] = (byFMMonth[fmName] || 0) + 1;

      const dayKey = `${created.getFullYear()}-${String(created.getMonth() + 1).padStart(2, '0')}-${String(created.getDate()).padStart(2, '0')}`;
      byDayMonth[dayKey] = (byDayMonth[dayKey] || 0) + 1;
    }
  }

  console.log(`  This month delivered: ${thisMonthContacts.length}`);
  console.log(`  By FM (all-time): ${JSON.stringify(byFMAllTime)}`);
  console.log(`  By FM (month):    ${JSON.stringify(byFMMonth)}`);

  return {
    dealerName: name,
    allTime: {
      total: allTimeContacts.length,
      byFM: byFMAllTime,
    },
    thisMonth: {
      total: thisMonthContacts.length,
      byFM: byFMMonth,
      byDay: byDayMonth,
    },
  };
}

// ── Load sub-account configs from env ───────────────────────────────────────

function loadSubAccountConfigs() {
  const raw = process.env.DEALER_SUBACCOUNTS;
  if (!raw) return [];
  try {
    return JSON.parse(raw);
  } catch (err) {
    console.error('Failed to parse DEALER_SUBACCOUNTS:', err.message);
    return [];
  }
}

module.exports = {
  subAccountFetch,
  fetchLocationUsers,
  searchContactsByTag,
  aggregateDealerStats,
  loadSubAccountConfigs,
};
