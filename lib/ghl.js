const GHL_BASE = 'https://services.leadconnectorhq.com';
const GHL_API_VERSION = '2021-07-28';

async function ghlFetch(path, options = {}, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    const res = await fetch(`${GHL_BASE}${path}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${process.env.GHL_PRIVATE_TOKEN}`,
        Version: GHL_API_VERSION,
        'Content-Type': 'application/json',
        ...(options.headers || {}),
      },
    });

    if (res.ok) return res.json();

    // Retry on 5xx (server errors) and 429 (rate limit)
    if ((res.status >= 500 || res.status === 429) && attempt < retries) {
      const wait = attempt * 3000; // 3s, 6s
      console.warn(`GHL API ${res.status} on ${path} — retrying in ${wait / 1000}s (attempt ${attempt}/${retries})`);
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }

    const body = await res.text().catch(() => '');
    throw new Error(`GHL API error ${res.status} on ${path}: ${body}`);
  }
}

// Custom field VALUES on a contact only carry the field ID, not the readable
// key (e.g. "dealership"). Fetch the field definitions once per run and
// build an id -> key map to translate them. Confirmed working against the
// real account on 2026-06-30.
async function fetchCustomFieldIdToKeyMap(locationId) {
  const data = await ghlFetch(`/locations/${locationId}/customFields`);
  const map = {};
  for (const f of data.customFields || []) {
    const key = (f.fieldKey || '').replace(/^contact\./, '');
    if (key) map[f.id] = key;
  }
  return map;
}

function findFieldIdByKey(fieldIdToKeyMap, targetKey) {
  for (const [id, key] of Object.entries(fieldIdToKeyMap)) {
    if (key === targetKey) return id;
  }
  return null;
}

function normalizeCustomFields(contact, fieldIdToKeyMap) {
  const out = {};
  for (const cf of contact.customFields || []) {
    const key = fieldIdToKeyMap[cf.id];
    if (key) out[key] = cf.value;
  }
  return out;
}

// CONFIRMED WORKING SYNTAX (tested 2026-06-30 against the real Direct Finance
// location). Critical details that were NOT obvious from public docs:
//   - operator must be "range" (an "eq" operator on a DATE field returns a
//     422 "Invalid Operator" error)
//   - the field must be referenced as "customFields.<fieldId>", NOT the
//     readable key name (referencing by key returns a 400 "Invalid field")
//   - value.gte / value.lte MUST be millisecond epoch timestamps. ISO date
//     strings are silently accepted (200 OK) but match ZERO contacts, even
//     when matching data exists. This is the gotcha that would have made a
//     naive implementation fail silently.
async function searchContactsByDateFieldRange(locationId, fieldId, gteMs, lteMs, pageLimit = 100) {
  const body = {
    locationId,
    page: 1,
    pageLimit,
    filters: [
      {
        field: `customFields.${fieldId}`,
        operator: 'range',
        value: { gte: gteMs, lte: lteMs },
      },
    ],
  };
  const data = await ghlFetch('/contacts/search', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return data.contacts || [];
}

// Paginated search across the full date range — fetches all pages.
// Much faster than day-by-day: 1-3 API calls instead of 25+.
async function searchAllContactsByDateRange(locationId, fieldId, gteMs, lteMs) {
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
          field: `customFields.${fieldId}`,
          operator: 'range',
          value: { gte: gteMs, lte: lteMs },
        },
      ],
    };

    const data = await ghlFetch('/contacts/search', {
      method: 'POST',
      body: JSON.stringify(body),
    });

    const contacts = data.contacts || [];
    allContacts.push(...contacts);

    // If we got fewer than pageLimit, we've reached the last page
    if (contacts.length < pageLimit) break;

    page++;

    // Safety: don't loop forever (max 50 pages = 5000 contacts)
    if (page > 50) {
      console.warn(`WARNING: hit 50-page limit (${allContacts.length} contacts). Some may be missing.`);
      break;
    }
  }

  return allContacts;
}

// Fetches all qualified leads for a date range using paginated single query.
// Falls back to day-by-day only if needed.
async function fetchQualifiedLeadsDayByDay(locationId, fieldId, rangeStart, rangeEndExclusive) {
  const gteMs = rangeStart.getTime();
  const lteMs = rangeEndExclusive.getTime() - 1;

  const allContacts = await searchAllContactsByDateRange(locationId, fieldId, gteMs, lteMs);

  // Deduplicate by ID
  const seenIds = new Set();
  const unique = [];
  for (const c of allContacts) {
    if (!seenIds.has(c.id)) {
      seenIds.add(c.id);
      unique.push(c);
    }
  }

  return unique;
}

// ── Lead source detection ─────────────────────────────────────────────────
//
// Tags in GHL come as an array of strings on the contact object.
// UTM source is a standard field: contact.attributionSource?.utmSource
// or sometimes in a custom field. We check both.

function detectLeadSource(contact, normalizedCustomFields) {
  const tags = (contact.tags || []).map((t) => t.toLowerCase().trim());
  const utmSource = (
    contact.attributionSource?.utmSource ||
    normalizedCustomFields.utm_source ||
    ''
  ).toLowerCase().trim();

  // dform takes priority — even if src-call is also present
  if (tags.includes('dform') && utmSource === 'google')    return 'Google Webform';
  if (tags.includes('dform'))                              return 'FB Webform';
  if (tags.includes('src-call'))                           return 'Google Call';
  if (tags.includes('fbm'))                                return 'FB Messenger';
  if (tags.includes('fb'))                                 return 'FB Lead Form';
  return 'Other';
}

// ── Province normalization ────────────────────────────────────────────────
//
// GHL state field can be full name or abbreviation. Normalize to abbreviation.

const PROVINCE_ALIASES = {
  // Ontario — catch all misspellings
  'ontario':              'ON',  'on': 'ON',  'on.': 'ON',
  'onterio':              'ON',  'ontairo': 'ON',  'ontaro': 'ON',
  'ont':                  'ON',  'ont.': 'ON',

  // Quebec
  'quebec':               'QC',  'qc': 'QC',  'québec': 'QC',
  'que':                  'QC',  'que.': 'QC',

  // Alberta
  'alberta':              'AB',  'ab': 'AB',  'alta': 'AB',  'alta.': 'AB',

  // British Columbia
  'british columbia':     'BC',  'bc': 'BC',  'b.c.': 'BC',

  // Saskatchewan
  'saskatchewan':         'SK',  'sk': 'SK',  'sask': 'SK',  'sask.': 'SK',

  // Manitoba
  'manitoba':             'MB',  'mb': 'MB',  'man': 'MB',  'man.': 'MB',

  // Nova Scotia
  'nova scotia':          'NS',  'ns': 'NS',

  // New Brunswick
  'new brunswick':        'NB',  'nb': 'NB',

  // Newfoundland and Labrador
  'newfoundland and labrador': 'NL', 'newfoundland': 'NL', 'nl': 'NL', 'nfld': 'NL',

  // Prince Edward Island
  'prince edward island': 'PE',  'prince edward island (ca)': 'PE',
  'pe': 'PE',  'pei': 'PE',  'p.e.i.': 'PE',

  // Territories
  'northwest territories':'NT',  'nt': 'NT',  'nwt': 'NT',
  'nunavut':              'NU',  'nu': 'NU',
  'yukon':                'YT',  'yt': 'YT',
};

// Group smaller provinces into "Atlantic" for the daily breakdown
const PROVINCE_GROUPS = {
  'ON': 'Ontario',
  'QC': 'Quebec',
  'AB': 'Alberta',
  'BC': 'BC',
  'SK': 'Atlantic/Other',
  'MB': 'Atlantic/Other',
  'NB': 'Atlantic/Other',
  'NL': 'Atlantic/Other',
  'NS': 'Atlantic/Other',
  'PE': 'Atlantic/Other',
  'NT': 'Atlantic/Other',
  'NU': 'Atlantic/Other',
  'YT': 'Atlantic/Other',
  'Unknown': 'Unknown',
};

function normalizeProvince(raw) {
  if (!raw || typeof raw !== 'string') return 'Unknown';
  const lower = raw.trim().toLowerCase();
  if (lower === '0' || lower === '') return 'Unknown';
  return PROVINCE_ALIASES[lower] || 'Unknown';
}

function getProvinceGroup(provinceCode) {
  return PROVINCE_GROUPS[provinceCode] || 'Atlantic/Other';
}

// ── Fetch new leads by created_date custom field ──────────────────────────
//
// Same day-by-day pattern as fetchQualifiedLeadsDayByDay, but queries on
// the created_date custom field instead of qualified_date.

async function fetchNewLeadsDayByDay(locationId, createdDateFieldId, rangeStart, rangeEndExclusive) {
  const gteMs = rangeStart.getTime();
  const lteMs = rangeEndExclusive.getTime() - 1;

  const allContacts = await searchAllContactsByDateRange(locationId, createdDateFieldId, gteMs, lteMs);

  // Deduplicate by ID
  const seenIds = new Set();
  const unique = [];
  for (const c of allContacts) {
    if (!seenIds.has(c.id)) {
      seenIds.add(c.id);
      unique.push(c);
    }
  }

  return unique;
}

module.exports = {
  ghlFetch,
  fetchCustomFieldIdToKeyMap,
  findFieldIdByKey,
  normalizeCustomFields,
  fetchQualifiedLeadsDayByDay,
  fetchNewLeadsDayByDay,
  detectLeadSource,
  normalizeProvince,
  getProvinceGroup,
};
