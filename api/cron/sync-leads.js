const {
  fetchCustomFieldIdToKeyMap,
  findFieldIdByKey,
  normalizeCustomFields,
  fetchQualifiedLeadsDayByDay,
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
// Call stats moved to api/cron/sync-calls.js
const { fetchTwilioSpend } = require('../../lib/twilio');
const SEED_DEALERS = require('../../lib/dealers');
const REPS         = require('../../lib/reps');
const { nowET, monthStartET, dateKey, monthLabel, parseDate, isSameDay, monthStartUTCms, nowUTCms } = require('../../lib/timezone');

// ── Helpers ──────────────────────────────────────────────────────────────────

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
    const t0 = Date.now();
    // ── 1. GHL field map ───────────────────────────────────────────────────
    const fieldMap = await fetchCustomFieldIdToKeyMap(locationId);
    const qualifiedDateFieldId = findFieldIdByKey(fieldMap, 'qualified_date');
    if (!qualifiedDateFieldId) throw new Error('Could not find custom field "qualified_date".');
    console.log(`[TIMING] Field map: ${Date.now() - t0}ms`);

    // ── 2. Date range (Eastern Time) ──────────────────────────────────────
    const now        = nowET();         // for display (dateKey, monthLabel)
    const monthStart = monthStartET();  // for display

    // UTC ms timestamps for GHL API queries
    const ghlStartMs = monthStartUTCms();
    const ghlEndMs   = nowUTCms();

    // ── 3. Pull qualified leads from GHL ─────────────────────────────────
    const contacts = await fetchQualifiedLeadsDayByDay(
      locationId, qualifiedDateFieldId, ghlStartMs, ghlEndMs
    );
    console.log(`[TIMING] GHL qualified leads (${contacts.length}): ${Date.now() - t0}ms`);

    // ── 4. Sheets client + Settings ───────────────────────────────────────
    const sheets = await getSheetsClient();
    await initSettingsTab(sheets, spreadsheetId, SEED_DEALERS);
    const settings = await readSettings(sheets, spreadsheetId);
    console.log(`[TIMING] Sheets init: ${Date.now() - t0}ms`);

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

    // ── 7. Fetch Hubstaff + Twilio in parallel (call stats moved to sync-calls)
    let hubToday = {};
    let hubMTD   = {};
    let hubError = null;
    let hubRawSample = null;
    let callStats = {};
    let callError = null;
    let callDebug = null;
    let twilioData = null;
    let twilioError = null;

    const [hubResult, twilioResult] = await Promise.allSettled([
      fetchHubstaffStats(now, monthStart),
      fetchTwilioSpend(now, monthStart),
    ]);

    if (hubResult.status === 'fulfilled') {
      hubToday     = hubResult.value.todayStats;
      hubMTD       = hubResult.value.mtdStats;
      hubRawSample = hubResult.value.rawSample;
    } else {
      hubError = hubResult.reason?.message || 'Unknown error';
      console.warn('Hubstaff fetch failed:', hubError);
    }

    if (twilioResult.status === 'fulfilled') {
      twilioData = twilioResult.value;
    } else {
      twilioError = twilioResult.reason?.message || 'Unknown error';
      console.warn('Twilio spend fetch failed:', twilioError);
    }

    // ── 8. Ensure tabs exist (parallel) ───────────────────────────────────
    const monthTabName = `Qualified Leads - ${monthLabel(now)}`;
    await Promise.all([
      ensureTab(sheets, spreadsheetId, monthTabName),
      ensureTab(sheets, spreadsheetId, 'Current Month Data'),
      ensureTab(sheets, spreadsheetId, 'MTD Summary'),
      ensureTab(sheets, spreadsheetId, 'Sales Rep'),
      ensureTab(sheets, spreadsheetId, 'Daily Breakdown'),
      ensureTab(sheets, spreadsheetId, 'Lead Type Breakdown'),
    ]);

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

    // ── 10. MTD Summary ─────────────────────────────────────────────────
    let totalOrder = 0, totalToday = 0, totalMtd = 0;
    //
    // Three dealer types rendered in distinct sections:
    //   A) FM breakdown (e.g. Absolute Approval) — per-FM rows with Refunds
    //   B) Grouped branches (e.g. South Trail Kia) — sub-dealers under a parent
    //   C) Simple dealers — order + delivery (Leduc) or delivery-only (REV)
    //
    // Layout: consistent columns across all sections:
    //   Name | Order | Delivered | Refunds | After Refunds | Remaining | % Complete
    //
    // Dealers with FM rows in Settings → type A
    // Dealers with a Group value in Settings → type B (grouped under parent)
    // Everything else → type C

    const summaryRows = [];
    let grandOrder = 0, grandDelivered = 0, grandRefunds = 0;

    // ---- Categorize dealers ----
    const fmDealers    = [];  // type A: has FM rows
    const groupedMap   = {};  // type B: group name → [dealer, ...]
    const simpleDealers = []; // type C: everything else

    for (const dealer of settings.dealers) {
      const hasFMs   = (settings.fms[dealer] || []).length > 0;
      const groupName = settings.groups[dealer];

      if (hasFMs) {
        fmDealers.push(dealer);
      } else if (groupName) {
        if (!groupedMap[groupName]) groupedMap[groupName] = [];
        groupedMap[groupName].push(dealer);
      } else {
        simpleDealers.push(dealer);
      }
    }

    // ---- Helper: add a section header row ----
    function sectionHeader(title) {
      summaryRows.push([]);
      summaryRows.push([`═══ ${title} ═══`, 'Order', 'Delivered', 'Refunds', 'After Refunds', 'Remaining', '% Complete']);
    }

    // ---- Type A: FM breakdown dealers (e.g. Absolute Approval) ----
    for (const dealer of fmDealers) {
      sectionHeader(dealer);
      const fmList = settings.fms[dealer] || [];
      const stats  = dealerStats[dealer] || { today: 0, mtd: 0, fms: {} };

      let dealerOrder = 0, dealerDelivered = 0, dealerRefunds = 0;

      for (const fmDef of fmList) {
        const s = stats.fms[fmDef.name] || { today: 0, mtd: 0 };
        const ref     = settings.refunds[`${dealer}::${fmDef.name}`] || 0;
        const afterRef = s.mtd - ref;
        const remain   = fmDef.target - afterRef;

        dealerOrder     += fmDef.target;
        dealerDelivered += s.mtd;
        dealerRefunds   += ref;

        const status = remain < 0 ? 'over delivered' : '';
        summaryRows.push([
          fmDef.name, fmDef.target, s.mtd, ref, afterRef,
          remain < 0 ? remain : Math.max(0, remain),
          pct(afterRef, fmDef.target),
          status,
        ]);
      }

      // Unassigned FM row (if any leads have no FM match)
      const unassigned = stats.fms['Unassigned'] || { today: 0, mtd: 0 };
      if (unassigned.mtd > 0) {
        dealerDelivered += unassigned.mtd;
        summaryRows.push(['Unassigned', '-', unassigned.mtd, '-', unassigned.mtd, '-', '-']);
      }

      const totalAfterRef = dealerDelivered - dealerRefunds;
      const totalRemain   = dealerOrder - totalAfterRef;
      summaryRows.push([
        `TOTAL ${dealer}`, dealerOrder, dealerDelivered, dealerRefunds, totalAfterRef,
        totalRemain < 0 ? totalRemain : Math.max(0, totalRemain),
        pct(totalAfterRef, dealerOrder),
        totalRemain < 0 ? 'over delivered' : '',
      ]);

      grandOrder     += dealerOrder;
      grandDelivered += dealerDelivered;
      grandRefunds   += dealerRefunds;
    }

    // ---- Type B: Grouped branch dealers (e.g. South Trail Kia) ----
    for (const [groupName, members] of Object.entries(groupedMap)) {
      sectionHeader(groupName);
      let groupOrder = 0, groupDelivered = 0;

      for (const dealer of members) {
        const order = settings.orders[dealer] || 0;
        const stats = dealerStats[dealer] || { today: 0, mtd: 0 };
        const remain = order - stats.mtd;

        groupOrder     += order;
        groupDelivered += stats.mtd;

        summaryRows.push([
          dealer, order, stats.mtd, '', '', 
          remain < 0 ? remain : Math.max(0, remain),
          pct(stats.mtd, order),
        ]);
      }

      const groupRemain = groupOrder - groupDelivered;
      summaryRows.push([
        `TOTAL ${groupName}`, groupOrder, groupDelivered, '', '',
        groupRemain < 0 ? groupRemain : Math.max(0, groupRemain),
        pct(groupDelivered, groupOrder),
      ]);

      grandOrder     += groupOrder;
      grandDelivered += groupDelivered;
    }

    // ---- Type C: Simple dealers ----
    for (const dealer of simpleDealers) {
      const order = settings.orders[dealer] || 0;
      const stats = dealerStats[dealer] || { today: 0, mtd: 0 };
      const ref   = settings.refunds[dealer] || 0;

      if (order === 0) {
        // Delivery-only dealer (e.g. REV) — minimal row
        sectionHeader(dealer);
        summaryRows.push([dealer, '-', stats.mtd, '', '', '-', '-']);
        grandDelivered += stats.mtd;
      } else {
        // Standard order + delivery dealer (e.g. Leduc)
        sectionHeader(dealer);
        const afterRef = stats.mtd - ref;
        const remain   = order - afterRef;
        summaryRows.push([
          dealer, order, stats.mtd, ref || '', ref ? afterRef : '',
          remain < 0 ? remain : Math.max(0, remain),
          pct(ref ? afterRef : stats.mtd, order),
        ]);
        grandOrder   += order;
        grandDelivered += stats.mtd;
        grandRefunds += ref;
      }
    }

    // ---- Grand Total ----
    const grandAfterRef = grandDelivered - grandRefunds;
    const grandRemain   = grandOrder - grandAfterRef;
    summaryRows.push([]);
    summaryRows.push([
      'GRAND TOTAL', grandOrder, grandDelivered, grandRefunds, grandAfterRef,
      grandRemain < 0 ? grandRemain : Math.max(0, grandRemain),
      pct(grandAfterRef, grandOrder),
    ]);
    summaryRows.push([]);
    summaryRows.push([`Last synced: ${syncedAt}`]);

    // Track totals for the API response
    totalOrder = grandOrder;
    totalToday = Object.values(dealerStats).reduce((s, d) => s + d.today, 0);
    totalMtd   = grandDelivered;

    await clearAndWrite(sheets, spreadsheetId, 'MTD Summary', summaryRows);

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

    // ── 14. Dealer View tab (created once) ────────────────────────────────
    await initDealerViewTab(sheets, spreadsheetId);

    // ── Done ──────────────────────────────────────────────────────────────
    return res.status(200).json({
      ok:                      true,
      monthTab:                monthTabName,
      qualifiedLeadsThisMonth: leads.length,
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
