const {
  fetchCustomFieldIdToKeyMap,
  findFieldIdByKey,
  normalizeCustomFields,
  fetchQualifiedLeadsDayByDay,
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

    // ── 2. Date range ──────────────────────────────────────────────────────
    const now        = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    // ── 3. Pull qualified leads day-by-day from GHL ───────────────────────
    const contacts = await fetchQualifiedLeadsDayByDay(
      locationId, qualifiedDateFieldId, monthStart, now
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

      if (!settings.dealers.includes(dealer) && dealer) {
        unmappedDealers.add(raw.dealership || '(blank)');
      }
      leads.push({ contact, qDate, dealer, fm, salesRep, leadType });
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

    try {
      callStats = await fetchCallStats(REPS, locationId, now, monthStart);
    } catch (err) {
      callError = err.message;
      console.warn('GHL call count fetch failed:', err.message);
    }

    // ── 8. Ensure tabs exist ──────────────────────────────────────────────
    const monthTabName = `Qualified Leads - ${monthLabel(now)}`;
    await ensureTab(sheets, spreadsheetId, monthTabName);
    await ensureTab(sheets, spreadsheetId, 'Current Month Data');
    await ensureTab(sheets, spreadsheetId, 'MTD Summary');
    await ensureTab(sheets, spreadsheetId, 'Sales Rep');
    await ensureTab(sheets, spreadsheetId, 'Daily Breakdown');
    await ensureTab(sheets, spreadsheetId, 'Lead Type Breakdown');

    // ── 9. Raw data tabs ──────────────────────────────────────────────────
    const rawHeaders = [
      'Contact ID', 'Qualified Date', 'Dealer', 'FM',
      'Sales Rep', 'Lead Type', 'Contact Name', 'Phone', 'Email', 'Last Synced',
    ];
    const rawDataRows = leads.map(({ contact, qDate, dealer, fm, salesRep, leadType }) => [
      contact.id, dateKey(qDate), dealer, fm, salesRep, leadType,
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
      ['Sales Rep', 'Leads Today', 'Calls Today', 'Calls >30s', 'Avg Call Duration', 'Hours Today', 'Activity %'],
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
            for (const v of [hub.overall, hub.keyboard, hub.active]) {
              if (v > 0 && v < hub.tracked) return `${Math.round((v / hub.tracked) * 100)}%`;
            }
            const combined = (hub.keyboard || 0) + (hub.mouse || 0);
            if (combined > 0 && combined < hub.tracked) return `${Math.round((combined / hub.tracked) * 100)}%`;
            return '-';
          })()
        : '-';

      salesTodayRows.push([
        `${ghlName} (${rep.displayName})`,
        leads_.today,
        calls.callsToday,
        calls.calls30sToday,
        calls.avgDurToday,
        fmtHours(hub.tracked),
        actPct,
      ]);
    }

    salesTodayRows.push([
      'TOTAL',
      totLeadsToday,
      totCallsToday,
      '', '', // calls30s and avgDur totals not meaningful to sum
      fmtHours(totTrackedToday),
      '-',
    ]);

    // --- MTD section (2 blank rows gap) ---
    const salesMTDRows = [
      [],
      [],
      [`MTD — ${monthLabel(now)}`],
      ['Sales Rep', 'MTD Leads', 'MTD Calls', 'MTD Calls >30s', 'Avg Call Duration', 'MTD Hours', 'Avg Activity %'],
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
            for (const v of [hub.overall, hub.keyboard, hub.active]) {
              if (v > 0 && v < hub.tracked) return `${Math.round((v / hub.tracked) * 100)}%`;
            }
            const combined = (hub.keyboard || 0) + (hub.mouse || 0);
            if (combined > 0 && combined < hub.tracked) return `${Math.round((combined / hub.tracked) * 100)}%`;
            return '-';
          })()
        : '-';

      salesMTDRows.push([
        `${ghlName} (${rep.displayName})`,
        leads_.mtd,
        calls.callsMTD,
        calls.calls30sMTD,
        calls.avgDurMTD,
        fmtHours(hub.tracked),
        actPctMTD,
      ]);
    }

    salesMTDRows.push([
      'TOTAL',
      totLeadsMTD,
      totCallsMTD,
      '', '',
      fmtHours(totTrackedMTD),
      '-',
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
      hubstaffRawSample:       hubRawSample, // shows raw field names/values — use to debug activity %
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
