// ---------------------------------------------------------------------------
// GHL Sub-Account API — pulls contacts from individual dealer sub-accounts
// ---------------------------------------------------------------------------
//
// Each dealer sub-account has its own API key (private integration token).
//
// FM attribution uses TAGS on the contact (e.g. "aa-jamie" → "Jamie Pacaud").
// The fmTagMap in config maps tag prefixes to Settings FM names.
//
// Sub-account config comes from env var DEALER_SUBACCOUNTS, e.g.:
// [
//   {
//     "name": "Absolute Approval",
//     "locationId": "BEmUBi3TXKZVFsI55TcM",
//     "apiKey": "...",
//     "deliveredTag": "qualified",
//     "fmTagMap": {
//       "aa-jamie": "Jamie Pacaud",
//       "aa-jeff": "Jeff Ouimet",
//       "aa-raph": "Raphael Arancibia",
//       "aa-jesse": "Jesse",
//       "aa-dylan": "Dylan Sousa"
//     }
//   }
// ]

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

// ── Search contacts with tag filter (paginated) ─────────────────────────────

async function searchContactsByTag(locationId, apiKey, tag) {
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

// ── Resolve FM name from contact tags using fmTagMap ────────────────────────

function resolveFMFromTags(contact, fmTagMap) {
  if (!fmTagMap || Object.keys(fmTagMap).length === 0) return 'Unassigned';

  const tags = (contact.tags || []).map((t) => t.toLowerCase().trim());

  for (const [tagKey, fmName] of Object.entries(fmTagMap)) {
    if (tags.includes(tagKey.toLowerCase().trim())) {
      return fmName;
    }
  }

  return 'Unassigned';
}

// ── Extract custom field value from a contact ───────────────────────────────
// GHL returns customFields as: [{ id: "xxx", value: "paid" }, ...]
// We match by id (the GHL internal field ID) or by key if available.
// Config can specify either splitField (key name) or splitFieldId (field ID).

function getCustomFieldValue(contact, fieldKey, fieldId) {
  const fields = contact.customFields || contact.customField || [];
  for (const f of fields) {
    // Match by explicit field ID first (most reliable)
    if (fieldId && f.id === fieldId) {
      return f.value || '';
    }
    // Fallback: match by key name
    if (fieldKey && f.key && f.key.toLowerCase() === fieldKey.toLowerCase()) {
      return f.value || '';
    }
    if (fieldKey && f.field_key && f.field_key.toLowerCase() === fieldKey.toLowerCase()) {
      return f.value || '';
    }
  }
  return '';
}

// ── Aggregate dealer stats from sub-account ─────────────────────────────────
//
// Returns: {
//   dealerName, 
//   allTime:   { total, byFM, refundsByFM, totalRefunds, split },
//   thisMonth: { total, byFM, refundsByFM, totalRefunds, byDay, split }
// }
//
// When config.splitField is set (e.g. "lead_tier"), the `split` object
// tracks counts by that field's value:
//   split: { paid: 5, free: 12 }  (where "free" = everything not matching splitPaidValue)

async function aggregateDealerStats(config) {
  const {
    name, locationId, apiKey,
    deliveredTag = 'qualified',
    fmTagMap = {},
    splitField = null,           // custom field key, e.g. "lead_tier"
    splitFieldId = null,         // custom field ID, e.g. "abc123" (more reliable)
    splitPaidValue = 'paid',     // value that counts as "paid"
  } = config;

  const hasSplitConfig = splitField || splitFieldId;

  console.log(`\n── Fetching stats for ${name} (${locationId}) ──`);
  console.log(`  FM tag map: ${JSON.stringify(fmTagMap)}`);
  if (hasSplitConfig) console.log(`  Split field: ${splitField || splitFieldId} (paid value: "${splitPaidValue}")`);

  // Date range for this month
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const monthEnd   = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);

  // Fetch ALL contacts with the delivered tag (all time)
  console.log(`  Fetching all-time contacts with tag "${deliveredTag}"...`);
  const allTimeContacts = await searchContactsByTag(locationId, apiKey, deliveredTag);
  console.log(`  All-time delivered: ${allTimeContacts.length}`);

  // Split into this-month vs all-time, attribute FM from tags, count refunds
  const thisMonthContacts = [];
  const byFMAllTime       = {};
  const byFMMonth         = {};
  const byDayMonth        = {};
  const refundsByFMAllTime = {};
  const refundsByFMMonth   = {};
  let   totalRefundsAllTime = 0;
  let   totalRefundsMonth   = 0;

  // Custom field split counters
  const splitAllTime = { paid: 0, free: 0 };
  const splitMonth   = { paid: 0, free: 0 };

  for (const c of allTimeContacts) {
    const created = new Date(c.dateCreated || c.dateAdded);
    const fmName  = resolveFMFromTags(c, fmTagMap);
    const tags    = (c.tags || []).map((t) => t.toLowerCase().trim());
    const isRefund = tags.includes('refund');

    // Check custom field split
    let isPaid = false;
    if (hasSplitConfig) {
      const cfValue = getCustomFieldValue(c, splitField, splitFieldId);
      isPaid = cfValue && cfValue.toLowerCase().trim().includes(splitPaidValue.toLowerCase());
    }

    // All time FM count
    byFMAllTime[fmName] = (byFMAllTime[fmName] || 0) + 1;
    if (isRefund) {
      refundsByFMAllTime[fmName] = (refundsByFMAllTime[fmName] || 0) + 1;
      totalRefundsAllTime++;
    }
    if (hasSplitConfig) {
      if (isPaid) splitAllTime.paid++;
      else splitAllTime.free++;
    }

    // This month?
    if (created >= monthStart && created <= monthEnd) {
      thisMonthContacts.push(c);
      byFMMonth[fmName] = (byFMMonth[fmName] || 0) + 1;
      if (isRefund) {
        refundsByFMMonth[fmName] = (refundsByFMMonth[fmName] || 0) + 1;
        totalRefundsMonth++;
      }
      if (hasSplitConfig) {
        if (isPaid) splitMonth.paid++;
        else splitMonth.free++;
      }

      const dayKey = `${created.getFullYear()}-${String(created.getMonth() + 1).padStart(2, '0')}-${String(created.getDate()).padStart(2, '0')}`;
      byDayMonth[dayKey] = (byDayMonth[dayKey] || 0) + 1;
    }
  }

  console.log(`  This month delivered: ${thisMonthContacts.length}`);
  console.log(`  By FM (all-time): ${JSON.stringify(byFMAllTime)}`);
  console.log(`  Refunds (all-time): ${totalRefundsAllTime} → ${JSON.stringify(refundsByFMAllTime)}`);
  console.log(`  By FM (month):    ${JSON.stringify(byFMMonth)}`);
  console.log(`  Refunds (month):  ${totalRefundsMonth} → ${JSON.stringify(refundsByFMMonth)}`);
  if (hasSplitConfig) {
    console.log(`  Split (all-time): ${JSON.stringify(splitAllTime)}`);
    console.log(`  Split (month):    ${JSON.stringify(splitMonth)}`);
  }

  return {
    dealerName: name,
    allTime: {
      total: allTimeContacts.length,
      byFM: byFMAllTime,
      refundsByFM: refundsByFMAllTime,
      totalRefunds: totalRefundsAllTime,
      split: hasSplitConfig ? splitAllTime : null,
    },
    thisMonth: {
      total: thisMonthContacts.length,
      byFM: byFMMonth,
      refundsByFM: refundsByFMMonth,
      totalRefunds: totalRefundsMonth,
      byDay: byDayMonth,
      split: hasSplitConfig ? splitMonth : null,
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
  searchContactsByTag,
  resolveFMFromTags,
  aggregateDealerStats,
  loadSubAccountConfigs,
};
