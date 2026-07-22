// api/cron/sync-daily-leads.js
//
// Separate cron endpoint for the Daily Leads Breakdown tab.
// Split from sync-leads.js to stay within Vercel's function timeout.
// Queries GHL by created_date custom field, then builds the daily
// breakdown with source, province, and qualified/unqualified counts.

const {
  fetchCustomFieldIdToKeyMap,
  findFieldIdByKey,
  normalizeCustomFields,
  fetchNewLeadsDayByDay,
  detectLeadSource,
  normalizeProvince,
} = require('../../lib/ghl');
const {
  getSheetsClient,
  ensureTab,
  clearAndWrite,
} = require('../../lib/sheets');

// ── Helpers ──────────────────────────────────────────────────────────────────

function parseDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d;
}

function dateKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ── Main handler ──────────────────────────────────────────────────────────────

module.exports = async (req, res) => {
  const hasValidSecret = req.query.secret && req.query.secret === process.env.CRON_SECRET;
  if (!hasValidSecret) return res.status(401).json({ error: 'Unauthorized' });

  const locationId    = process.env.GHL_LOCATION_ID;
  const spreadsheetId = process.env.GOOGLE_SHEET_ID;

  try {
    // ── 1. GHL field map ───────────────────────────────────────────────────
    const fieldMap = await fetchCustomFieldIdToKeyMap(locationId);

    const createdDateFieldId = findFieldIdByKey(fieldMap, 'created_date');
    if (!createdDateFieldId) throw new Error('Could not find custom field "created_date".');

    const qualifiedDateFieldId = findFieldIdByKey(fieldMap, 'qualified_date');

    // ── 2. Date range ──────────────────────────────────────────────────────
    const now        = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    // ── 3. Pull all new leads by created_date ──────────────────────────────
    const newLeadContacts = await fetchNewLeadsDayByDay(
      locationId, createdDateFieldId, monthStart, now
    );

    // ── 4. Sheets client ──────────────────────────────────────────────────
    const sheets = await getSheetsClient();
    await ensureTab(sheets, spreadsheetId, 'Daily Leads Breakdown');

    // ── 5. Bucket leads by day ────────────────────────────────────────────
    const SOURCE_COLS = ['FB Webform', 'Google Webform', 'FB Lead Form', 'FB Messenger', 'Google Call', 'Other'];
    const dailyBuckets = {};
    const allProvinces = new Set();

    for (const contact of newLeadContacts) {
      const raw = normalizeCustomFields(contact, fieldMap);
      const createdDate = parseDate(raw.created_date);
      if (!createdDate || createdDate < monthStart || createdDate > now) continue;

      const dk = dateKey(createdDate);
      if (!dailyBuckets[dk]) {
        dailyBuckets[dk] = {
          total: 0,
          sources: {},
          provinces: {},
          qualified: 0,
          unqualified: 0,
        };
        for (const s of SOURCE_COLS) dailyBuckets[dk].sources[s] = 0;
      }

      const bucket = dailyBuckets[dk];
      bucket.total++;

      // Lead source from tags + UTM
      const source = detectLeadSource(contact, raw);
      bucket.sources[source] = (bucket.sources[source] || 0) + 1;

      // Province from state field
      const prov = normalizeProvince(contact.state || raw.state || '');
      allProvinces.add(prov);
      bucket.provinces[prov] = (bucket.provinces[prov] || 0) + 1;

      // Qualified = has a qualified_date custom field value set
      const qDate = raw.qualified_date;
      if (qDate) {
        bucket.qualified++;
      } else {
        bucket.unqualified++;
      }
    }

    // ── 6. Sort provinces (ON, QC, AB, BC first, then alpha) ──────────────
    const provPriority = { ON: 0, QC: 1, AB: 2, BC: 3 };
    const sortedProvinces = Array.from(allProvinces).sort((a, b) => {
      const pa = provPriority[a] ?? 99, pb = provPriority[b] ?? 99;
      return pa !== pb ? pa - pb : a.localeCompare(b);
    });

    // ── 7. Build sheet rows ───────────────────────────────────────────────
    const dailyDates = Object.keys(dailyBuckets).sort();
    const header = [
      'Date', 'Total New Leads',
      ...SOURCE_COLS,
      ...sortedProvinces,
      'Qualified', 'Unqualified',
    ];

    const rows = [header];
    const totals = {
      total: 0, qualified: 0, unqualified: 0,
      sources: {}, provinces: {},
    };
    for (const s of SOURCE_COLS) totals.sources[s] = 0;
    for (const p of sortedProvinces) totals.provinces[p] = 0;

    for (const dk of dailyDates) {
      const b = dailyBuckets[dk];
      totals.total       += b.total;
      totals.qualified   += b.qualified;
      totals.unqualified += b.unqualified;

      const sourceVals = SOURCE_COLS.map((s) => {
        const v = b.sources[s] || 0;
        totals.sources[s] += v;
        return v;
      });

      const provVals = sortedProvinces.map((p) => {
        const v = b.provinces[p] || 0;
        totals.provinces[p] += v;
        return v;
      });

      rows.push([
        dk, b.total,
        ...sourceVals,
        ...provVals,
        b.qualified, b.unqualified,
      ]);
    }

    // TOTAL row
    rows.push([
      'TOTAL', totals.total,
      ...SOURCE_COLS.map((s) => totals.sources[s]),
      ...sortedProvinces.map((p) => totals.provinces[p]),
      totals.qualified, totals.unqualified,
    ]);

    await clearAndWrite(sheets, spreadsheetId, 'Daily Leads Breakdown', rows);

    const syncedAt = now.toISOString();

    return res.status(200).json({
      ok:              true,
      newLeadsThisMonth: newLeadContacts.length,
      daysWithData:    dailyDates.length,
      totalQualified:  totals.qualified,
      totalUnqualified: totals.unqualified,
      provincesFound:  sortedProvinces,
      syncedAt,
    });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
};
