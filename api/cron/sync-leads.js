const {
  fetchCustomFieldIdToKeyMap,
  findFieldIdByKey,
  normalizeCustomFields,
  fetchQualifiedLeadsDayByDay,
  fetchNewLeadsDayByDay,
  detectLeadSource,
  normalizeProvince,
} = require('../../lib/ghl');
const {
  getSheetsClient,
  ensureTab,
  clearAndWrite,
  readSettings,
  initSettingsTab,
  initDealerViewTab,
  applyMTDRowGroups,
} = require('../../lib/sheets');
const {
  normalizeDealer,
  normalizeFMForDealer,
  normalizeSalesRep,
} = require('../../lib/aliases');
const {
  fetchHubstaffStats,
  fmtHours,
  fmtActivity,
} = require('../../lib/hubstaff');
const { fetchCallStats } = require('../../lib/calls');
const { fetchTwilioSpend } = require('../../lib/twilio');
const SEED_DEALERS = require('../../lib/dealers');
const REPS         = require('../../lib/reps');

// ── Helpers ──────────────────────────────────────────────────────────────────

function parseDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d;
}

function isSameDay(a, b) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth()    === b.getMonth()    &&
    a.getDate()     === b.getDate()
  );
}

function dateKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function monthLabel(d) {
  return d.toLocaleString('en-US', { month: 'long', year: 'numeric' });
}

function pct(delivered, target) {
  if (!target) return '-';
  return `${Math.round((delivered / target) * 100)}%`;
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
    const qualifiedDateFieldId = findFieldIdByKey(fieldMap, 'qualified_date');
    if (!qualifiedDateFieldId) throw new Error('Could not find custom field "qualified_date".');

    const createdDateFieldId = findFieldIdByKey(fieldMap, 'created_date');
    if (!createdDateFieldId) throw new Error('Could not find custom field "created_date".');

    // ── 2. Date range ──────────────────────────────────────────────────────
    const now        = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    // ── 3. Pull qualified leads day-by-day from GHL ───────────────────────
    const contacts = await fetchQualifiedLeadsDayByDay(
      locationId, qualifiedDateFieldId, monthStart, now
    );

    // ── 3b. Pull ALL new leads by created_date custom field ──────────────
    const newLeadContacts = await fetchNewLeadsDayByDay(
      locationId, createdDateFieldId, monthStart, now
    );

    // ── 4. Sheets client + Settings ───────────────────────────────────────
    const sheets = await getSheetsClient();
    await initSettingsTab(sheets, spreadsheetId, SEED_DEALERS);
    const settings = await readSettings(sheets, spreadsheetId);

    if (!settings.dealers.length) {
      return res.status(200).json({ ok: false, message: 'No dealers found in Settings tab.' });
    }

    // ── 5. Normalize leads ────────────────────────────────────────────────
    const leads           = [];
    const unmappedDealers = new Set();

    for (const contact of contacts) {
      const raw   = normalizeCustomFields(contact, fieldMap);
      const qDate = parseDate(raw.qualified_date);
      if (!qDate || qDate < monthStart || qDate > now) continue;

      const dealer   = normalizeDealer(raw.dealership, settings.aliasMap);
      const fmList   = settings.fms[dealer] || [];
      const fm       = normalizeFMForDealer(raw.fm, fmList);
      const salesRep = normalizeSalesRep(raw.sales_rep);
      const rawType  = raw.lead_type1;
      const leadType = Array.isArray(rawType) ? (rawType[0] || '') : (rawType || '');

      const leadSource = detectLeadSource(contact, raw);
      const province   = normalizeProvince(contact.state || raw.state || '');

      if (!settings.dealers.includes(dealer) && dealer) {
        unmappedDealers.add(raw.dealership || '(blank)');
      }
      leads.push({ contact, qDate, dealer, fm, salesRep, leadType, leadSource, province });
    }

    // ── 6. Aggregate dealer + FM stats ────────────────────────────────────
    const dealerStats = {};
    for (const dealer of settings.dealers) {
      dealerStats[dealer] = { today: 0, mtd: 0, fms: {} };
      for (const fm of (settings.fms[dealer] || [])) {
        dealerStats[dealer].fms[fm.name] = { today: 0, mtd: 0 };
      }
      dealerStats[dealer].fms['Unassigned'] = { today: 0, mtd: 0 };
    }

    // Aggregate sales rep lead stats separately for the Sales Rep tab
    const repLeadStats = {}; // ghlName → { today, mtd }
    for (const ghlName of Object.keys(REPS)) {
      repLeadStats[ghlName] = { today: 0, mtd: 0 };
    }

    for (const { qDate, dealer, fm, salesRep } of leads) {
      const isToday = isSameDay(qDate, now);

      // Dealer stats
      if (settings.dealers.includes(dealer)) {
        dealerStats[dealer].mtd++;
        if (isToday) dealerStats[dealer].today++;
        if (!dealerStats[dealer].fms[fm]) dealerStats[dealer].fms[fm] = { today: 0, mtd: 0 };
        dealerStats[dealer].fms[fm].mtd++;
        if (isToday) dealerStats[dealer].fms[fm].today++;
      }

      // Sales rep lead stats
      if (repLeadStats[salesRep]) {
        repLeadStats[salesRep].mtd++;
        if (isToday) repLeadStats[salesRep].today++;
      }
    }

    const syncedAt = now.toISOString();

    // ── 7. Fetch Hubstaff stats (non-blocking — graceful fallback if it fails)
    // The personal access token is a refresh token — fetchHubstaffStats
    // exchanges it for a short-lived access token before making API calls.
    let hubToday = {};
    let hubMTD   = {};
    let hubError = null;

    let hubRawSample = null;
    try {
      const hubStats = await fetchHubstaffStats(now, monthStart);
      hubToday     = hubStats.todayStats;
      hubMTD       = hubStats.mtdStats;
      hubRawSample = hubStats.rawSample; // for debugging activity % field
    } catch (err) {
      hubError = err.message;
      console.warn('Hubstaff fetch failed (GHL sync will still complete):', err.message);
    }

    // ── 7b. Fetch GHL call counts per rep (non-blocking) ─────────────────
    let callStats = {};
    let callError = null;
    let callDebug = null;

    try {
      callStats = await fetchCallStats(REPS, locationId, now, monthStart);
      callDebug  = callStats._debug || null;
      delete callStats._debug;
    } catch (err) {
      callError = err.message;
      console.warn('GHL call count fetch failed:', err.message);
    }

    // ── 7c. Fetch Twilio spend (non-blocking) ──────────────────────────────
    let twilioData = null;
    let twilioError = null;

    try {
      twilioData = await fetchTwilioSpend(now, monthStart);
    } catch (err) {
      twilioError = err.message;
      console.warn('Twilio spend fetch failed:', err.message);
    }

    // ── 8. Ensure tabs exist ──────────────────────────────────────────────
    const monthTabName = `Qualified Leads - ${monthLabel(now)}`;
    await ensureTab(sheets, spreadsheetId, monthTabName);
    await ensureTab(sheets, spreadsheetId, 'Current Month Data');
    await ensureTab(sheets, spreadsheetId, 'MTD Summary');
    await ensureTab(sheets, spreadsheetId, 'Sales Rep');
    await ensureTab(sheets, spreadsheetId, 'Daily Breakdown');
    await ensureTab(sheets, spreadsheetId, 'Lead Type Breakdown');
    await ensureTab(sheets, spreadsheetId, 'Daily Leads Breakdown');

    // ── 9. Raw data tabs ──────────────────────────────────────────────────
    const rawHeaders = [
      'Contact ID', 'Qualified Date', 'Dealer', 'FM',
      'Sales Rep', 'Lead Type', 'Lead Source', 'Province', 'Contact Name', 'Phone', 'Email', 'Last Synced',
    ];
    const rawDataRows = leads.map(({ contact, qDate, dealer, fm, salesRep, leadType, leadSource, province }) => [
      contact.id, dateKey(qDate), dealer, fm, salesRep, leadType, leadSource, province,
      `${contact.firstName || ''} ${contact.lastName || ''}`.trim(),
      contact.phone || '', contact.email || '', syncedAt,
    ]);

    await clearAndWrite(sheets, spreadsheetId, monthTabName,         [rawHeaders, ...rawDataRows]);
    await clearAndWrite(sheets, spreadsheetId, 'Current Month Data', [rawHeaders, ...rawDataRows]);

    // ── 10. MTD Summary (dealer rows + collapsible FM sub-rows) ───────────
    let rowIdx = 1;
    const fmGroups  = [];
    let totalOrder  = 0, totalToday = 0, totalMtd = 0;

    const summaryRows = [
      ['Dealer / FM', 'Order / Target', "Today's Qualified", 'MTD Delivered', 'Remaining', '% Complete', 'Last Synced'],
    ];

    for (const dealer of settings.dealers) {
      const order = settings.orders[dealer] || 0;
      const stats = dealerStats[dealer] || { today: 0, mtd: 0, fms: {} };
      totalOrder += order; totalToday += stats.today; totalMtd += stats.mtd;

      summaryRows.push([dealer, order, stats.today, stats.mtd, Math.max(0, order - stats.mtd), pct(stats.mtd, order), syncedAt]);
      rowIdx++;

      const fmStartIdx = rowIdx;

      for (const fmDef of (settings.fms[dealer] || [])) {
        const s = stats.fms[fmDef.name] || { today: 0, mtd: 0 };
        summaryRows.push([`  → ${fmDef.name}`, fmDef.target, s.today, s.mtd, Math.max(0, fmDef.target - s.mtd), pct(s.mtd, fmDef.target), '']);
        rowIdx++;
      }

      const unassigned = stats.fms['Unassigned'] || { today: 0, mtd: 0 };
      if (unassigned.mtd > 0) {
        summaryRows.push([`  → Unassigned`, '-', unassigned.today, unassigned.mtd, '-', '-', '']);
        rowIdx++;
      }

      if (rowIdx > fmStartIdx) fmGroups.push({ startIndex: fmStartIdx, endIndex: rowIdx });
    }

    summaryRows.push(['TOTAL', totalOrder, totalToday, totalMtd, Math.max(0, totalOrder - totalMtd), pct(totalMtd, totalOrder), syncedAt]);

    await clearAndWrite(sheets, spreadsheetId, 'MTD Summary', summaryRows);
    await applyMTDRowGroups(sheets, spreadsheetId, fmGroups);

    // ── 11. Sales Rep tab (leads + Hubstaff hours, two sections) ─────────
    const repNames = Object.keys(REPS);

    // --- TODAY section ---
    const salesTodayRows = [
      [`TODAY — ${dateKey(now)}`],
      ['Sales Rep', 'Leads', 'Calls', '>30s', 'Avg Dur', 'SMS', 'Hours', 'Activity %', 'Calls/Hr', 'Connect %', 'SMS/Hr', 'Leads/Hr', 'Calls/Lead'],
    ];

    let totLeadsToday = 0, totCallsToday = 0, totTrackedToday = 0, totActiveToday = 0;

    for (const ghlName of repNames) {
      const rep    = REPS[ghlName];
      const leads_ = repLeadStats[ghlName] || { today: 0 };
      const hub    = hubToday[String(rep.hubstaffId)] || { tracked: 0, active: 0 };
      const calls  = callStats[ghlName] || { callsToday: '-', callsMTD: '-' };

      totLeadsToday   += leads_.today;
      if (typeof calls.callsToday === 'number') totCallsToday += calls.callsToday;
      totTrackedToday += hub.tracked;
      totActiveToday  += hub.active;

      // Use the smarter activity calculation across all Hubstaff fields
      const actPct = hub.tracked
        ? (() => {
            for (const v of [hub.keyboard, hub.active, hub.input_tracked]) {
              if (v > 0 && v < hub.tracked) return `${Math.round((v / hub.tracked) * 100)}%`;
            }
            const combined = (hub.keyboard || 0) + (hub.mouse || 0);
            if (combined > 0 && combined < hub.tracked) return `${Math.round((combined / hub.tracked) * 100)}%`;
            return '-';
          })()
        : '-';

      const hrs = hub.tracked / 3600; // decimal hours for math
      const callsPerHr  = hrs > 0 ? (calls.callsToday / hrs).toFixed(1) : '-';
      const connectPct  = calls.callsToday > 0 ? `${Math.round((calls.calls30sToday / calls.callsToday) * 100)}%` : '-';
      const smsPerHr    = hrs > 0 ? (calls.smsToday / hrs).toFixed(1) : '-';
      const leadsPerHr  = hrs > 0 ? (leads_.today / hrs).toFixed(2) : '-';
      const callsPerLead = leads_.today > 0 ? Math.round(calls.callsToday / leads_.today) : '-';

      salesTodayRows.push([
        `${ghlName} (${rep.displayName})`,
        leads_.today,
        calls.callsToday,
        calls.calls30sToday,
        calls.avgDurToday,
        calls.smsToday,
        fmtHours(hub.tracked),
        actPct,
        callsPerHr,
        connectPct,
        smsPerHr,
        leadsPerHr,
        callsPerLead,
      ]);
    }

    let totSmsToday = 0, totCalls30sToday = 0;
    for (const ghlName of repNames) {
      const c = callStats[ghlName] || {};
      if (typeof c.smsToday === 'number') totSmsToday += c.smsToday;
      if (typeof c.calls30sToday === 'number') totCalls30sToday += c.calls30sToday;
    }
    const totHrsToday = totTrackedToday / 3600;
    salesTodayRows.push([
      'TOTAL',
      totLeadsToday,
      totCallsToday,
      totCalls30sToday,
      '',
      totSmsToday,
      fmtHours(totTrackedToday),
      '-',
      totHrsToday > 0 ? (totCallsToday / totHrsToday).toFixed(1) : '-',
      totCallsToday > 0 ? `${Math.round((totCalls30sToday / totCallsToday) * 100)}%` : '-',
      totHrsToday > 0 ? (totSmsToday / totHrsToday).toFixed(1) : '-',
      totHrsToday > 0 ? (totLeadsToday / totHrsToday).toFixed(2) : '-',
      totLeadsToday > 0 ? Math.round(totCallsToday / totLeadsToday) : '-',
    ]);

    // --- MTD section (2 blank rows gap) ---
    const salesMTDRows = [
      [],
      [],
      [`MTD — ${monthLabel(now)}`],
      ['Sales Rep', 'Leads', 'Calls', '>30s', 'Avg Dur', 'SMS', 'Hours', 'Activity %', 'Calls/Hr', 'Connect %', 'SMS/Hr', 'Leads/Hr', 'Calls/Lead'],
    ];

    let totLeadsMTD = 0, totCallsMTD = 0, totTrackedMTD = 0, totActiveMTD = 0;

    for (const ghlName of repNames) {
      const rep    = REPS[ghlName];
      const leads_ = repLeadStats[ghlName] || { mtd: 0 };
      const hub    = hubMTD[String(rep.hubstaffId)] || { tracked: 0, active: 0 };
      const calls  = callStats[ghlName] || { callsToday: '-', callsMTD: '-' };

      totLeadsMTD   += leads_.mtd;
      if (typeof calls.callsMTD === 'number') totCallsMTD += calls.callsMTD;
      totTrackedMTD += hub.tracked;
      totActiveMTD  += hub.active;

      const actPctMTD = hub.tracked
        ? (() => {
            for (const v of [hub.keyboard, hub.active, hub.input_tracked]) {
              if (v > 0 && v < hub.tracked) return `${Math.round((v / hub.tracked) * 100)}%`;
            }
            const combined = (hub.keyboard || 0) + (hub.mouse || 0);
            if (combined > 0 && combined < hub.tracked) return `${Math.round((combined / hub.tracked) * 100)}%`;
            return '-';
          })()
        : '-';

      const hrsM = hub.tracked / 3600;
      const callsPerHrM  = hrsM > 0 ? (calls.callsMTD / hrsM).toFixed(1) : '-';
      const connectPctM  = calls.callsMTD > 0 ? `${Math.round((calls.calls30sMTD / calls.callsMTD) * 100)}%` : '-';
      const smsPerHrM    = hrsM > 0 ? (calls.smsMTD / hrsM).toFixed(1) : '-';
      const leadsPerHrM  = hrsM > 0 ? (leads_.mtd / hrsM).toFixed(2) : '-';
      const callsPerLeadM = leads_.mtd > 0 ? Math.round(calls.callsMTD / leads_.mtd) : '-';

      salesMTDRows.push([
        `${ghlName} (${rep.displayName})`,
        leads_.mtd,
        calls.callsMTD,
        calls.calls30sMTD,
        calls.avgDurMTD,
        calls.smsMTD,
        fmtHours(hub.tracked),
        actPctMTD,
        callsPerHrM,
        connectPctM,
        smsPerHrM,
        leadsPerHrM,
        callsPerLeadM,
      ]);
    }

    let totSmsMTD = 0, totCalls30sMTD = 0;
    for (const ghlName of repNames) {
      const c = callStats[ghlName] || {};
      if (typeof c.smsMTD === 'number') totSmsMTD += c.smsMTD;
      if (typeof c.calls30sMTD === 'number') totCalls30sMTD += c.calls30sMTD;
    }
    const totHrsMTD = totTrackedMTD / 3600;
    salesMTDRows.push([
      'TOTAL',
      totLeadsMTD,
      totCallsMTD,
      totCalls30sMTD,
      '',
      totSmsMTD,
      fmtHours(totTrackedMTD),
      '-',
      totHrsMTD > 0 ? (totCallsMTD / totHrsMTD).toFixed(1) : '-',
      totCallsMTD > 0 ? `${Math.round((totCalls30sMTD / totCallsMTD) * 100)}%` : '-',
      totHrsMTD > 0 ? (totSmsMTD / totHrsMTD).toFixed(1) : '-',
      totHrsMTD > 0 ? (totLeadsMTD / totHrsMTD).toFixed(2) : '-',
      totLeadsMTD > 0 ? Math.round(totCallsMTD / totLeadsMTD) : '-',
    ]);

    if (hubError) {
      salesMTDRows.push([]);
      salesMTDRows.push([`⚠ Hubstaff fetch failed: ${hubError}. Hours show 0 until resolved.`]);
    }
    if (callError) {
      salesMTDRows.push([]);
      salesMTDRows.push([`⚠ GHL call count failed: ${callError}. Calls show - until resolved.`]);
    }

    await clearAndWrite(sheets, spreadsheetId, 'Sales Rep', [
      ...salesTodayRows,
      ...salesMTDRows,
      [],
      [`Last synced: ${syncedAt}`],
    ]);

    // ── 12. Daily Breakdown ───────────────────────────────────────────────
    const byDateRep         = {};
    const dealerDailyTotals = {};
    for (const d of settings.dealers) dealerDailyTotals[d] = 0;
    let grandDailyTotal = 0;

    for (const { qDate, dealer, salesRep } of leads) {
      if (!settings.dealers.includes(dealer)) continue;
      const dk  = dateKey(qDate);
      const rep = salesRep || '(unassigned)';
      const key = `${dk}|${rep}`;
      if (!byDateRep[key]) byDateRep[key] = { date: dk, rep, total: 0 };
      byDateRep[key][dealer] = (byDateRep[key][dealer] || 0) + 1;
      byDateRep[key].total++;
    }

    const dailyDataRows = Object.values(byDateRep)
      .sort((a, b) => a.date === b.date ? a.rep.localeCompare(b.rep) : a.date.localeCompare(b.date))
      .map((row) => {
        const counts = settings.dealers.map((d) => { const v = row[d] || 0; dealerDailyTotals[d] += v; return v; });
        grandDailyTotal += row.total;
        return [row.date, row.rep, ...counts, row.total];
      });

    await clearAndWrite(sheets, spreadsheetId, 'Daily Breakdown', [
      ['Qualified Date', 'Sales Rep', ...settings.dealers, 'Grand Total'],
      ...dailyDataRows,
      ['', 'TOTAL', ...settings.dealers.map((d) => dealerDailyTotals[d]), grandDailyTotal],
    ]);

    // ── 13. Lead Type Breakdown ───────────────────────────────────────────
    const typeByDealer = {};
    const allTypes     = new Set();

    for (const { dealer, leadType } of leads) {
      if (!settings.dealers.includes(dealer)) continue;
      const type = leadType || '(unknown)';
      allTypes.add(type);
      if (!typeByDealer[dealer]) typeByDealer[dealer] = {};
      typeByDealer[dealer][type] = (typeByDealer[dealer][type] || 0) + 1;
    }

    const sortedTypes    = Array.from(allTypes).sort();
    const ltColumnTotals = sortedTypes.map((t) =>
      settings.dealers.reduce((sum, d) => sum + ((typeByDealer[d] || {})[t] || 0), 0)
    );

    await clearAndWrite(sheets, spreadsheetId, 'Lead Type Breakdown', [
      ['Dealer', ...sortedTypes, 'Total'],
      ...settings.dealers.map((d) => {
        const row    = typeByDealer[d] || {};
        const counts = sortedTypes.map((t) => row[t] || 0);
        return [d, ...counts, counts.reduce((a, b) => a + b, 0)];
      }),
      ['TOTAL', ...ltColumnTotals, ltColumnTotals.reduce((a, b) => a + b, 0)],
    ]);

    // ── 14. Daily Leads Breakdown ────────────────────────────────────────
    //
    // Counts ALL new leads created per day (using the created_date custom
    // field query). For each day: total, source breakdown, province breakdown,
    // qualified vs unqualified.
    //
    // A lead is "truly new" if created_date falls on that day AND the
    // standard dateAdded also falls on the same day. If created_date is
    // older than dateAdded, it's a resubmit — we still count it under
    // created_date's day since that's when the contact was first created.

    // Build a set of qualified contact IDs for quick lookup
    const qualifiedContactIds = new Set(leads.map((l) => l.contact.id));

    // Normalize new leads and bucket by day
    const SOURCE_COLS = ['FB Webform', 'Google Webform', 'FB Lead Form', 'FB Messenger', 'Google Call', 'Other'];
    const dailyBuckets = {}; // dateKey → { total, sources: {}, provinces: {}, qualified, unqualified }
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

      // Lead source
      const source = detectLeadSource(contact, raw);
      bucket.sources[source] = (bucket.sources[source] || 0) + 1;

      // Province
      const prov = normalizeProvince(contact.state || raw.state || '');
      allProvinces.add(prov);
      bucket.provinces[prov] = (bucket.provinces[prov] || 0) + 1;

      // Qualified check — does this contact have a qualified_date set?
      if (qualifiedContactIds.has(contact.id)) {
        bucket.qualified++;
      } else {
        bucket.unqualified++;
      }
    }

    // Sort provinces for consistent column order (ON, QC first, then alpha)
    const provPriority = { ON: 0, QC: 1, AB: 2, BC: 3 };
    const sortedProvinces = Array.from(allProvinces).sort((a, b) => {
      const pa = provPriority[a] ?? 99, pb = provPriority[b] ?? 99;
      return pa !== pb ? pa - pb : a.localeCompare(b);
    });

    // Build rows sorted by date
    const dailyDates = Object.keys(dailyBuckets).sort();
    const dailyLeadsHeader = [
      'Date', 'Total New Leads',
      ...SOURCE_COLS,
      ...sortedProvinces,
      'Qualified', 'Unqualified',
    ];

    const dailyLeadsRows = [dailyLeadsHeader];
    const dailyTotals = {
      total: 0, qualified: 0, unqualified: 0,
      sources: {}, provinces: {},
    };
    for (const s of SOURCE_COLS) dailyTotals.sources[s] = 0;
    for (const p of sortedProvinces) dailyTotals.provinces[p] = 0;

    for (const dk of dailyDates) {
      const b = dailyBuckets[dk];
      dailyTotals.total       += b.total;
      dailyTotals.qualified   += b.qualified;
      dailyTotals.unqualified += b.unqualified;

      const sourceVals = SOURCE_COLS.map((s) => {
        const v = b.sources[s] || 0;
        dailyTotals.sources[s] += v;
        return v;
      });

      const provVals = sortedProvinces.map((p) => {
        const v = b.provinces[p] || 0;
        dailyTotals.provinces[p] += v;
        return v;
      });

      dailyLeadsRows.push([
        dk, b.total,
        ...sourceVals,
        ...provVals,
        b.qualified, b.unqualified,
      ]);
    }

    // TOTAL row
    dailyLeadsRows.push([
      'TOTAL', dailyTotals.total,
      ...SOURCE_COLS.map((s) => dailyTotals.sources[s]),
      ...sortedProvinces.map((p) => dailyTotals.provinces[p]),
      dailyTotals.qualified, dailyTotals.unqualified,
    ]);

    await clearAndWrite(sheets, spreadsheetId, 'Daily Leads Breakdown', dailyLeadsRows);

    // ── 15. Dealer View tab (created once) ────────────────────────────────
    await initDealerViewTab(sheets, spreadsheetId);

    // ── Done ──────────────────────────────────────────────────────────────
    return res.status(200).json({
      ok:                      true,
      monthTab:                monthTabName,
      qualifiedLeadsThisMonth: leads.length,
      newLeadsThisMonth:       newLeadContacts.length,
      summaryTotals:           { totalToday, totalMtd, totalOrder },
      hubstaffStatus:          hubError ? `failed: ${hubError}` : 'ok',
      callCountStatus:         callError ? `failed: ${callError}` : 'ok',
      twilioStatus:            twilioError ? `failed: ${twilioError}` : (twilioData ? 'ok' : 'skipped'),
      callDebug,               // shows convs found + msg types — use to debug call counts
      hubstaffRawSample:       hubRawSample,
      unmappedDealerValues:    Array.from(unmappedDealers),
      note: unmappedDealers.size
        ? 'Some GHL dealer values were not matched. Add them to Aliases in the Settings tab.'
        : 'All dealer values matched successfully.',
      syncedAt,
    });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
};
