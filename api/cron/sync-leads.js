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
} = require('../../lib/sheets');
const {
  normalizeDealer,
  normalizeFMForDealer,
  normalizeSalesRep,
} = require('../../lib/aliases');
const SEED_DEALERS = require('../../lib/dealers');

// ── Helpers ─────────────────────────────────────────────────────────────────

function parseDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d;
}

function isSameDay(a, b) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
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

// ── Main handler ─────────────────────────────────────────────────────────────

module.exports = async (req, res) => {
  const hasValidSecret = req.query.secret && req.query.secret === process.env.CRON_SECRET;
  if (!hasValidSecret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const locationId   = process.env.GHL_LOCATION_ID;
  const spreadsheetId = process.env.GOOGLE_SHEET_ID;

  try {
    // ── 1. GHL field map ───────────────────────────────────────────────────
    const fieldMap = await fetchCustomFieldIdToKeyMap(locationId);
    const qualifiedDateFieldId = findFieldIdByKey(fieldMap, 'qualified_date');
    if (!qualifiedDateFieldId) {
      throw new Error('Could not find custom field "qualified_date" in this GHL location.');
    }

    // ── 2. Date range ──────────────────────────────────────────────────────
    const now        = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    // ── 3. Pull qualified leads day-by-day ────────────────────────────────
    const contacts = await fetchQualifiedLeadsDayByDay(
      locationId,
      qualifiedDateFieldId,
      monthStart,
      now
    );

    // ── 4. Sheets client + Settings tab ───────────────────────────────────
    const sheets = await getSheetsClient();
    await initSettingsTab(sheets, spreadsheetId, SEED_DEALERS);
    const settings = await readSettings(sheets, spreadsheetId);

    if (!settings.dealers.length) {
      return res.status(200).json({
        ok: false,
        message: 'Settings tab exists but has no dealer rows. Please add dealers to the Settings tab.',
      });
    }

    // ── 5. Normalize every lead through Settings alias map ────────────────
    const leads          = [];
    const unmappedDealers = new Set();

    for (const contact of contacts) {
      const raw    = normalizeCustomFields(contact, fieldMap);
      const qDate  = parseDate(raw.qualified_date);
      if (!qDate || qDate < monthStart || qDate > now) continue;

      const dealer   = normalizeDealer(raw.dealership, settings.aliasMap);
      const fmList   = settings.fms[dealer] || [];
      const fm       = normalizeFMForDealer(raw.fm, fmList);
      const salesRep = normalizeSalesRep(raw.sales_rep);
      const leadType = (raw.lead_type1 || Array.isArray(raw.lead_type1) ? (Array.isArray(raw.lead_type1) ? raw.lead_type1[0] : raw.lead_type1) : '') || '';

      if (!settings.dealers.includes(dealer) && dealer) {
        unmappedDealers.add(raw.dealership || '(blank)');
      }

      leads.push({ contact, qDate, dealer, fm, salesRep, leadType });
    }

    // ── 6. Aggregate stats ─────────────────────────────────────────────────
    // dealerStats[dealer] = { today, mtd, fms: { [fmName]: { today, mtd } } }
    const dealerStats = {};
    for (const dealer of settings.dealers) {
      dealerStats[dealer] = { today: 0, mtd: 0, fms: {} };
      for (const fm of (settings.fms[dealer] || [])) {
        dealerStats[dealer].fms[fm.name] = { today: 0, mtd: 0 };
      }
      dealerStats[dealer].fms['Unassigned'] = { today: 0, mtd: 0 };
    }

    for (const { qDate, dealer, fm } of leads) {
      if (!settings.dealers.includes(dealer)) continue;
      const isToday = isSameDay(qDate, now);

      dealerStats[dealer].mtd++;
      if (isToday) dealerStats[dealer].today++;

      // FM bucket (could be a known FM or 'Unassigned')
      if (!dealerStats[dealer].fms[fm]) {
        dealerStats[dealer].fms[fm] = { today: 0, mtd: 0 };
      }
      dealerStats[dealer].fms[fm].mtd++;
      if (isToday) dealerStats[dealer].fms[fm].today++;
    }

    const syncedAt = now.toISOString();

    // ── 7. Ensure all tabs exist ───────────────────────────────────────────
    const monthTabName = `Qualified Leads - ${monthLabel(now)}`;
    await ensureTab(sheets, spreadsheetId, monthTabName);
    await ensureTab(sheets, spreadsheetId, 'MTD Summary');
    await ensureTab(sheets, spreadsheetId, 'Daily Breakdown');
    await ensureTab(sheets, spreadsheetId, 'Lead Type Breakdown');

    // ── 8. Tab 1: Monthly raw log ──────────────────────────────────────────
    // Source of truth. Fully rebuilt every run so corrections/recalls show up.
    // A new tab is created each month — prior months are preserved untouched.
    const monthRows = [
      ['Contact ID', 'Qualified Date', 'Dealer', 'FM', 'Sales Rep', 'Lead Type', 'Contact Name', 'Phone', 'Email', 'Last Synced'],
      ...leads.map(({ contact, qDate, dealer, fm, salesRep, leadType }) => [
        contact.id,
        dateKey(qDate),
        dealer,
        fm,
        salesRep,
        leadType,
        `${contact.firstName || ''} ${contact.lastName || ''}`.trim(),
        contact.phone  || '',
        contact.email  || '',
        syncedAt,
      ]),
    ];
    await clearAndWrite(sheets, spreadsheetId, monthTabName, monthRows);

    // ── 9. Tab 2: MTD Summary (dealer rows + FM sub-rows) ─────────────────
    let totalOrder = 0, totalToday = 0, totalMtd = 0;

    const summaryRows = [
      ['Dealer / FM', 'Order / Target', "Today's Qualified", 'MTD Delivered', 'Remaining', '% Complete', 'Last Synced'],
    ];

    for (const dealer of settings.dealers) {
      const order  = settings.orders[dealer] || 0;
      const stats  = dealerStats[dealer] || { today: 0, mtd: 0, fms: {} };
      const remain = Math.max(0, order - stats.mtd);

      totalOrder += order;
      totalToday += stats.today;
      totalMtd   += stats.mtd;

      // Dealer row
      summaryRows.push([
        dealer, order, stats.today, stats.mtd, remain, pct(stats.mtd, order), syncedAt,
      ]);

      // FM sub-rows (defined in Settings)
      for (const fmDef of (settings.fms[dealer] || [])) {
        const fmStats  = stats.fms[fmDef.name] || { today: 0, mtd: 0 };
        const fmRemain = Math.max(0, fmDef.target - fmStats.mtd);
        summaryRows.push([
          `  → ${fmDef.name}`,
          fmDef.target,
          fmStats.today,
          fmStats.mtd,
          fmRemain,
          pct(fmStats.mtd, fmDef.target),
          '',
        ]);
      }

      // Unassigned sub-row (only shown if leads actually landed here)
      const unassigned = stats.fms['Unassigned'] || { today: 0, mtd: 0 };
      if (unassigned.mtd > 0) {
        summaryRows.push([`  → Unassigned`, '-', unassigned.today, unassigned.mtd, '-', '-', '']);
      }
    }

    // Grand total row
    summaryRows.push([
      'TOTAL',
      totalOrder,
      totalToday,
      totalMtd,
      Math.max(0, totalOrder - totalMtd),
      pct(totalMtd, totalOrder),
      syncedAt,
    ]);

    await clearAndWrite(sheets, spreadsheetId, 'MTD Summary', summaryRows);

    // ── 10. Tab 3: Daily Breakdown (date × sales rep × dealer) ────────────
    const byDateRep        = {};
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
        const counts = settings.dealers.map((d) => {
          const v = row[d] || 0;
          dealerDailyTotals[d] += v;
          return v;
        });
        grandDailyTotal += row.total;
        return [row.date, row.rep, ...counts, row.total];
      });

    await clearAndWrite(sheets, spreadsheetId, 'Daily Breakdown', [
      ['Qualified Date', 'Sales Rep', ...settings.dealers, 'Grand Total'],
      ...dailyDataRows,
      ['', 'TOTAL', ...settings.dealers.map((d) => dealerDailyTotals[d]), grandDailyTotal],
    ]);

    // ── 11. Tab 4: Lead Type Breakdown (dealer × lead type) ───────────────
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

    // ── Done ───────────────────────────────────────────────────────────────
    return res.status(200).json({
      ok:                      true,
      monthTab:                monthTabName,
      qualifiedLeadsThisMonth: leads.length,
      summaryTotals:           { totalToday, totalMtd, totalOrder },
      unmappedDealerValues:    Array.from(unmappedDealers),
      note:                    unmappedDealers.size
        ? 'Some GHL dealer values were not matched. Add them to the Aliases column in the Settings tab.'
        : 'All dealer values matched successfully.',
      syncedAt,
    });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
};
