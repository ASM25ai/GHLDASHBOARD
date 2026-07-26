// api/cron/sync-daily-leads.js
//
// Separate cron endpoint for the Daily Leads Breakdown tab.
// Queries GHL by created_date custom field, then builds the daily
// breakdown with source, province (grouped), and qualified/unqualified counts.
// Applies color formatting to visually separate sections.

const {
  fetchCustomFieldIdToKeyMap,
  findFieldIdByKey,
  normalizeCustomFields,
  fetchNewLeadsDayByDay,
  detectLeadSource,
  normalizeProvince,
  getProvinceGroup,
} = require('../../lib/ghl');
const {
  getSheetsClient,
  ensureTab,
  clearAndWrite,
  readSettings,
  applyColumnColors,
  boldRow,
} = require('../../lib/sheets');
const { normalizeDealer } = require('../../lib/aliases');
const { nowET, monthStartET, dateKey, parseDate } = require('../../lib/timezone');

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

    // ── 2. Date range (Eastern Time) ──────────────────────────────────────
    const now        = nowET();
    const monthStart = monthStartET();

    // ── 3. Pull all new leads by created_date ──────────────────────────────
    const newLeadContacts = await fetchNewLeadsDayByDay(
      locationId, createdDateFieldId, monthStart, now
    );

    // ── 4. Sheets client ──────────────────────────────────────────────────
    const sheets = await getSheetsClient();
    await ensureTab(sheets, spreadsheetId, 'Daily Leads Breakdown');
    await ensureTab(sheets, spreadsheetId, 'Dealer Source Breakdown');

    // Read dealer alias settings for normalization
    const settings = await readSettings(sheets, spreadsheetId);

    // ── 5. Bucket leads by day ────────────────────────────────────────────
    const SOURCE_COLS = ['FB Webform', 'Google Webform', 'FB Lead Form', 'FB Messenger', 'Google Call', 'Other'];
    const PROVINCE_GROUPS = ['Ontario', 'Quebec', 'Alberta', 'BC', 'Atlantic/Other', 'Unknown'];

    const dailyBuckets = {};
    // Dealer × Source matrix for qualified leads
    const dealerSourceMap = {}; // dealer → { source → count }

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
          qualifiedBySource: {},
        };
        for (const s of SOURCE_COLS) {
          dailyBuckets[dk].sources[s] = 0;
          dailyBuckets[dk].qualifiedBySource[s] = 0;
        }
        for (const p of PROVINCE_GROUPS) dailyBuckets[dk].provinces[p] = 0;
      }

      const bucket = dailyBuckets[dk];
      bucket.total++;

      // Lead source from tags + UTM
      const source = detectLeadSource(contact, raw);
      bucket.sources[source] = (bucket.sources[source] || 0) + 1;

      // Province — normalize then group
      const provCode = normalizeProvince(contact.state || raw.state || '');
      const provGroup = getProvinceGroup(provCode);
      bucket.provinces[provGroup] = (bucket.provinces[provGroup] || 0) + 1;

      // Qualified check — qualified_date must fall within current month
      const qDate = parseDate(raw.qualified_date);
      if (qDate && qDate >= monthStart && qDate <= now) {
        bucket.qualified++;
        bucket.qualifiedBySource[source] = (bucket.qualifiedBySource[source] || 0) + 1;

        // Track dealer × source for qualified leads
        const dealer = normalizeDealer(raw.dealership, settings.aliasMap) || raw.dealership || 'Unassigned';
        if (!dealerSourceMap[dealer]) {
          dealerSourceMap[dealer] = {};
          for (const s of SOURCE_COLS) dealerSourceMap[dealer][s] = 0;
        }
        dealerSourceMap[dealer][source] = (dealerSourceMap[dealer][source] || 0) + 1;
      } else {
        bucket.unqualified++;
      }
    }

    // ── 6. Build sheet rows ───────────────────────────────────────────────
    //
    // Layout with visual sections:
    //   A: Date  |  B: Total
    //   C-H: Lead Sources (blue)
    //   I-N: Provinces (green)
    //   O: Total Qualified | P-U: Qualified by Source | V: Unqualified (orange)
    //
    const QUAL_SOURCE_COLS = SOURCE_COLS.map((s) => `Q: ${s}`);

    const dailyDates = Object.keys(dailyBuckets).sort();

    const header = [
      'Date', 'Total New Leads',
      // ── Sources (blue) ──
      ...SOURCE_COLS,
      // ── Provinces (green) ──
      ...PROVINCE_GROUPS,
      // ── Qualified breakdown (orange) ──
      'Total Qualified', ...QUAL_SOURCE_COLS, 'Unqualified',
    ];

    const rows = [header];
    const totals = {
      total: 0, qualified: 0, unqualified: 0,
      sources: {}, provinces: {}, qualifiedBySource: {},
    };
    for (const s of SOURCE_COLS) {
      totals.sources[s] = 0;
      totals.qualifiedBySource[s] = 0;
    }
    for (const p of PROVINCE_GROUPS) totals.provinces[p] = 0;

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

      const provVals = PROVINCE_GROUPS.map((p) => {
        const v = b.provinces[p] || 0;
        totals.provinces[p] += v;
        return v;
      });

      const qualSourceVals = SOURCE_COLS.map((s) => {
        const v = b.qualifiedBySource[s] || 0;
        totals.qualifiedBySource[s] += v;
        return v;
      });

      rows.push([
        dk, b.total,
        ...sourceVals,
        ...provVals,
        b.qualified, ...qualSourceVals, b.unqualified,
      ]);
    }

    // TOTAL row
    rows.push([
      'TOTAL', totals.total,
      ...SOURCE_COLS.map((s) => totals.sources[s]),
      ...PROVINCE_GROUPS.map((p) => totals.provinces[p]),
      totals.qualified,
      ...SOURCE_COLS.map((s) => totals.qualifiedBySource[s]),
      totals.unqualified,
    ]);

    await clearAndWrite(sheets, spreadsheetId, 'Daily Leads Breakdown', rows);

    // ── 7. Apply color formatting ─────────────────────────────────────────
    const sourceStart = 2;
    const sourceEnd   = sourceStart + SOURCE_COLS.length;                // 8
    const provStart   = sourceEnd;
    const provEnd     = provStart + PROVINCE_GROUPS.length;              // 14
    const statusStart = provEnd;
    const statusEnd   = statusStart + 1 + SOURCE_COLS.length + 1;       // Total Qual + 6 Q:source + Unqualified = 8

    await applyColumnColors(sheets, spreadsheetId, 'Daily Leads Breakdown', [
      // Date + Total — light gray header
      {
        startCol: 0, endCol: 2,
        color:       { red: 0.95, green: 0.95, blue: 0.95 },
        headerColor: { red: 0.85, green: 0.85, blue: 0.85 },
      },
      // Sources — light blue
      {
        startCol: sourceStart, endCol: sourceEnd,
        color:       { red: 0.87, green: 0.92, blue: 1.0 },
        headerColor: { red: 0.62, green: 0.77, blue: 0.91 },
      },
      // Provinces — light green
      {
        startCol: provStart, endCol: provEnd,
        color:       { red: 0.85, green: 0.94, blue: 0.85 },
        headerColor: { red: 0.6,  green: 0.8,  blue: 0.6  },
      },
      // Qualified breakdown — light orange
      {
        startCol: statusStart, endCol: statusEnd,
        color:       { red: 1.0,  green: 0.93, blue: 0.82 },
        headerColor: { red: 0.96, green: 0.79, blue: 0.55 },
      },
    ]);

    // Bold the TOTAL row (header is row 0, data rows, then TOTAL)
    const totalRowIndex = rows.length - 1; // 0-based row index in the sheet
    await boldRow(sheets, spreadsheetId, 'Daily Leads Breakdown', totalRowIndex);

    // ── 8. Dealer Source Breakdown tab ────────────────────────────────────
    //
    // Rows = dealers (sorted by total qualified desc)
    // Cols = FB Webform | Google Webform | FB Lead Form | FB Messenger | Google Call | Other | Total
    //
    const dealerSourceHeader = ['Dealer', ...SOURCE_COLS, 'Total Qualified'];

    const dealerRows = Object.entries(dealerSourceMap)
      .map(([dealer, sources]) => {
        const sourceVals = SOURCE_COLS.map((s) => sources[s] || 0);
        const total = sourceVals.reduce((a, b) => a + b, 0);
        return { dealer, sourceVals, total };
      })
      .sort((a, b) => b.total - a.total); // highest total first

    const dealerSheetRows = [dealerSourceHeader];

    // Grand totals
    const dealerGrandTotals = {};
    for (const s of SOURCE_COLS) dealerGrandTotals[s] = 0;
    let grandTotal = 0;

    for (const { dealer, sourceVals, total } of dealerRows) {
      dealerSheetRows.push([dealer, ...sourceVals, total]);
      SOURCE_COLS.forEach((s, i) => { dealerGrandTotals[s] += sourceVals[i]; });
      grandTotal += total;
    }

    // TOTAL row
    dealerSheetRows.push([
      'TOTAL',
      ...SOURCE_COLS.map((s) => dealerGrandTotals[s]),
      grandTotal,
    ]);

    await clearAndWrite(sheets, spreadsheetId, 'Dealer Source Breakdown', dealerSheetRows);

    // Color formatting for Dealer Source Breakdown
    const dsSourceStart = 1;
    const dsSourceEnd   = dsSourceStart + SOURCE_COLS.length; // 7
    const dsTotalStart  = dsSourceEnd;
    const dsTotalEnd    = dsTotalStart + 1;                   // 8

    await applyColumnColors(sheets, spreadsheetId, 'Dealer Source Breakdown', [
      // Dealer name — light gray
      {
        startCol: 0, endCol: 1,
        color:       { red: 0.95, green: 0.95, blue: 0.95 },
        headerColor: { red: 0.85, green: 0.85, blue: 0.85 },
      },
      // Source columns — light blue
      {
        startCol: dsSourceStart, endCol: dsSourceEnd,
        color:       { red: 0.87, green: 0.92, blue: 1.0 },
        headerColor: { red: 0.62, green: 0.77, blue: 0.91 },
      },
      // Total — light orange
      {
        startCol: dsTotalStart, endCol: dsTotalEnd,
        color:       { red: 1.0,  green: 0.93, blue: 0.82 },
        headerColor: { red: 0.96, green: 0.79, blue: 0.55 },
      },
    ]);

    // Bold header and TOTAL row
    await boldRow(sheets, spreadsheetId, 'Dealer Source Breakdown', 0);
    await boldRow(sheets, spreadsheetId, 'Dealer Source Breakdown', dealerSheetRows.length - 1);

    const syncedAt = now.toISOString();

    return res.status(200).json({
      ok:               true,
      newLeadsThisMonth: newLeadContacts.length,
      daysWithData:     dailyDates.length,
      totalQualified:   totals.qualified,
      totalUnqualified: totals.unqualified,
      syncedAt,
    });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
};
