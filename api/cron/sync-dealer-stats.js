// ---------------------------------------------------------------------------
// /api/cron/sync-dealer-stats
//
// Pulls delivered-lead counts from each dealer's GHL sub-account and writes
// two tabs:
//   "Dealer Stats - Monthly"  — this month, by FM, with order/remaining
//   "Dealer Stats - All Time" — lifetime delivered counts by FM
//
// Runs on a schedule (e.g. every 30 min via GitHub Actions / Vercel cron).
//
// Env vars required:
//   DEALER_SUBACCOUNTS — JSON array of sub-account configs (see lib/ghl-subaccounts.js)
//   GOOGLE_SHEETS_ID, GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_PRIVATE_KEY
// ---------------------------------------------------------------------------

const {
  getSheetsClient,
  ensureTab,
  clearAndWrite,
  readSettings,
  formatMTDSummary,
} = require('../../lib/sheets');

const {
  aggregateDealerStats,
  loadSubAccountConfigs,
} = require('../../lib/ghl-subaccounts');

const SEED_DEALERS = require('../../lib/dealers');

function pct(delivered, target) {
  if (!target) return '-';
  return `${Math.round((delivered / target) * 100)}%`;
}

function dateKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

module.exports = async (req, res) => {
  try {
    const configs = loadSubAccountConfigs();
    if (!configs.length) {
      return res.status(200).json({ ok: false, error: 'No DEALER_SUBACCOUNTS configured' });
    }

    const sheets        = await getSheetsClient();
    const spreadsheetId = process.env.GOOGLE_SHEETS_ID;
    const settings      = await readSettings(sheets, spreadsheetId);

    const now      = new Date();
    const syncedAt = now.toLocaleString('en-CA', { timeZone: 'America/Toronto' });

    // ── Fetch stats from all sub-accounts ──────────────────────────────
    const dealerResults = [];
    for (const config of configs) {
      try {
        const stats = await aggregateDealerStats(config);
        dealerResults.push({ config, stats });
      } catch (err) {
        console.error(`Failed to fetch ${config.name}:`, err.message);
        dealerResults.push({ config, stats: null, error: err.message });
      }
    }

    // ── Build "Dealer Stats - Monthly" tab ─────────────────────────────
    const monthlyRows = [];

    for (const { config, stats, error } of dealerResults) {
      if (error || !stats) {
        monthlyRows.push([]);
        monthlyRows.push([`═══ ${config.name} ═══`, 'ERROR', error || 'Unknown error']);
        continue;
      }

      const dealerName = stats.dealerName;
      const fmList     = settings.fms[dealerName] || [];
      const hasFMs     = fmList.length > 0;

      monthlyRows.push([]);
      monthlyRows.push([`═══ ${dealerName} ═══`, 'Order', 'Delivered', 'Refunds', 'After Refunds', 'Remaining', '% Complete']);

      if (hasFMs) {
        // FM breakdown — match FM names from Settings to Owner names from GHL
        let dealerOrder = 0, dealerDelivered = 0, dealerRefunds = 0;

        for (const fmDef of fmList) {
          // Find the GHL Owner name that matches this FM
          // Try exact match first, then partial match
          let delivered = 0;
          for (const [ownerName, count] of Object.entries(stats.thisMonth.byFM)) {
            if (
              ownerName === fmDef.name ||
              ownerName.toLowerCase().includes(fmDef.name.toLowerCase()) ||
              fmDef.name.toLowerCase().includes(ownerName.toLowerCase().split(' ')[0])
            ) {
              delivered += count;
            }
          }

          const ref      = settings.refunds[`${dealerName}::${fmDef.name}`] || 0;
          const afterRef = delivered - ref;
          const remain   = fmDef.target - afterRef;

          dealerOrder     += fmDef.target;
          dealerDelivered += delivered;
          dealerRefunds   += ref;

          monthlyRows.push([
            fmDef.name, fmDef.target, delivered, ref, afterRef,
            remain < 0 ? remain : Math.max(0, remain),
            pct(afterRef, fmDef.target),
            remain < 0 ? 'over delivered' : '',
          ]);
        }

        // Check for unmatched FM leads
        const matchedFMs = new Set(fmList.map((f) => f.name.toLowerCase()));
        for (const [ownerName, count] of Object.entries(stats.thisMonth.byFM)) {
          const isMatched = fmList.some((f) =>
            ownerName === f.name ||
            ownerName.toLowerCase().includes(f.name.toLowerCase()) ||
            f.name.toLowerCase().includes(ownerName.toLowerCase().split(' ')[0])
          );
          if (!isMatched && ownerName !== 'Unassigned') {
            dealerDelivered += count;
            monthlyRows.push([`⚠ ${ownerName} (unmapped)`, '-', count, '-', count, '-', '-']);
          }
        }

        // Unassigned
        const unassigned = stats.thisMonth.byFM['Unassigned'] || 0;
        if (unassigned > 0) {
          dealerDelivered += unassigned;
          monthlyRows.push(['Unassigned', '-', unassigned, '-', unassigned, '-', '-']);
        }

        // Total row
        const totalAfterRef = dealerDelivered - dealerRefunds;
        const totalRemain   = dealerOrder - totalAfterRef;
        monthlyRows.push([
          `TOTAL ${dealerName}`, dealerOrder, dealerDelivered, dealerRefunds, totalAfterRef,
          totalRemain < 0 ? totalRemain : Math.max(0, totalRemain),
          pct(totalAfterRef, dealerOrder),
          totalRemain < 0 ? 'over delivered' : '',
        ]);
      } else {
        // Simple dealer — just total counts
        const order     = settings.orders[dealerName] || 0;
        const delivered = stats.thisMonth.total;
        const ref       = settings.refunds[dealerName] || 0;

        if (order === 0) {
          // Delivery-only
          monthlyRows.push([dealerName, '-', delivered, '', '', '-', '-']);
        } else {
          const afterRef = delivered - ref;
          const remain   = order - afterRef;
          monthlyRows.push([
            dealerName, order, delivered, ref || '', ref ? afterRef : '',
            remain < 0 ? remain : Math.max(0, remain),
            pct(ref ? afterRef : delivered, order),
          ]);
        }
      }
    }

    // Grand total
    let grandOrder = 0, grandDelivered = 0, grandRefunds = 0;
    for (const { stats } of dealerResults) {
      if (!stats) continue;
      const dn = stats.dealerName;
      const fmList = settings.fms[dn] || [];
      if (fmList.length > 0) {
        grandOrder += fmList.reduce((s, f) => s + f.target, 0);
      } else {
        grandOrder += settings.orders[dn] || 0;
      }
      grandDelivered += stats.thisMonth.total;
      // Sum refunds
      for (const fmDef of fmList) {
        grandRefunds += settings.refunds[`${dn}::${fmDef.name}`] || 0;
      }
      if (!fmList.length) grandRefunds += settings.refunds[dn] || 0;
    }
    const grandAfterRef = grandDelivered - grandRefunds;
    const grandRemain   = grandOrder - grandAfterRef;

    monthlyRows.push([]);
    monthlyRows.push([
      'GRAND TOTAL', grandOrder, grandDelivered, grandRefunds, grandAfterRef,
      grandRemain < 0 ? grandRemain : Math.max(0, grandRemain),
      pct(grandAfterRef, grandOrder),
    ]);
    monthlyRows.push([]);
    monthlyRows.push([`Last synced: ${syncedAt}`]);

    await ensureTab(sheets, spreadsheetId, 'Dealer Stats - Monthly');
    await clearAndWrite(sheets, spreadsheetId, 'Dealer Stats - Monthly', monthlyRows);
    await formatMTDSummary(sheets, spreadsheetId, monthlyRows);

    // ── Build "Dealer Stats - All Time" tab ────────────────────────────
    const allTimeRows = [];

    for (const { config, stats, error } of dealerResults) {
      if (error || !stats) {
        allTimeRows.push([]);
        allTimeRows.push([`═══ ${config.name} ═══`, 'ERROR', error || 'Unknown error']);
        continue;
      }

      allTimeRows.push([]);
      allTimeRows.push([`═══ ${stats.dealerName} ═══`, 'All-Time Delivered']);

      // Sort by count descending
      const sorted = Object.entries(stats.allTime.byFM)
        .sort((a, b) => b[1] - a[1]);

      for (const [fmName, count] of sorted) {
        allTimeRows.push([fmName, count]);
      }

      allTimeRows.push([`TOTAL ${stats.dealerName}`, stats.allTime.total]);
    }

    allTimeRows.push([]);
    allTimeRows.push([`Last synced: ${syncedAt}`]);

    await ensureTab(sheets, spreadsheetId, 'Dealer Stats - All Time');
    await clearAndWrite(sheets, spreadsheetId, 'Dealer Stats - All Time', allTimeRows);

    // ── Response ───────────────────────────────────────────────────────
    return res.status(200).json({
      ok: true,
      syncedAt,
      dealers: dealerResults.map((d) => ({
        name: d.config.name,
        thisMonth: d.stats?.thisMonth.total ?? 'ERROR',
        allTime:   d.stats?.allTime.total ?? 'ERROR',
      })),
    });

  } catch (err) {
    console.error('sync-dealer-stats FATAL:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
};
