const GHL_BASE = 'https://services.leadconnectorhq.com';
const GHL_API_VERSION = '2021-07-28';

async function ghlFetch(path, options = {}) {
  const res = await fetch(`${GHL_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${process.env.GHL_PRIVATE_TOKEN}`,
      Version: GHL_API_VERSION,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`GHL API error ${res.status} on ${path}: ${body}`);
  }

  return res.json();
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

// Queries day-by-day across a date range instead of one big multi-page
// query. This deliberately avoids relying on /contacts/search's pagination
// beyond page 1, which wasn't verified during testing. Daily qualified-lead
// volume is comfortably under the 100-per-page limit (per the dashboard
// screenshot this is sourced from), so each individual day's query is
// guaranteed to fit on a single page.
async function fetchQualifiedLeadsDayByDay(locationId, fieldId, rangeStart, rangeEndExclusive) {
  const allContacts = [];
  const seenIds = new Set();

  for (
    let day = new Date(rangeStart);
    day < rangeEndExclusive;
    day.setDate(day.getDate() + 1)
  ) {
    const dayStart = new Date(day.getFullYear(), day.getMonth(), day.getDate());
    const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000 - 1);

    const contacts = await searchContactsByDateFieldRange(
      locationId,
      fieldId,
      dayStart.getTime(),
      dayEnd.getTime()
    );

    for (const c of contacts) {
      if (!seenIds.has(c.id)) {
        seenIds.add(c.id);
        allContacts.push(c);
      }
    }

    // Safety net: if a single day somehow has >100 qualified leads (would
    // require pagination we haven't verified), this surfaces loudly in the
    // sync response instead of silently dropping data.
    if (contacts.length >= 100) {
      console.warn(
        `WARNING: day ${dayStart.toISOString().slice(0, 10)} returned ${contacts.length} contacts (page limit). ` +
          `Some may be missing — pagination beyond page 1 is unverified. Flag this for review.`
      );
    }
  }

  return allContacts;
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

  if (tags.includes('src-call'))                           return 'Google Call';
  if (tags.includes('fbm'))                                return 'FB Messenger';
  if (tags.includes('fb'))                                 return 'FB Lead Form';
  if (tags.includes('dform') && utmSource === 'google')    return 'Google Webform';
  if (tags.includes('dform'))                              return 'FB Webform';
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
  const allContacts = [];
  const seenIds = new Set();

  for (
    let day = new Date(rangeStart);
    day < rangeEndExclusive;
    day.setDate(day.getDate() + 1)
  ) {
    const dayStart = new Date(day.getFullYear(), day.getMonth(), day.getDate());
    const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000 - 1);

    const contacts = await searchContactsByDateFieldRange(
      locationId,
      createdDateFieldId,
      dayStart.getTime(),
      dayEnd.getTime()
    );

    for (const c of contacts) {
      if (!seenIds.has(c.id)) {
        seenIds.add(c.id);
        allContacts.push(c);
      }
    }

    if (contacts.length >= 100) {
      console.warn(
        `WARNING: created_date day ${dayStart.toISOString().slice(0, 10)} returned ${contacts.length} contacts (page limit). ` +
          `Some may be missing.`
      );
    }
  }

  return allContacts;
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
