// ---------------------------------------------------------------------------
// /api/cron/sync-dealer-stats
//
// Pulls delivered-lead counts from each dealer's GHL sub-account and writes
// two tabs:
//   "Dealer Stats - All Time"  — full report: Order, Delivered, Refunds,
//                                 After Refunds, Remaining, % Complete (per FM)
//   "Dealer Stats - Monthly"   — simple: FM name + this month's delivered count
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

function pct(delivered, target) {
  if (!target) return '-';
  return `${Math.round((delivered / target) * 100)}%`;
}

// Match a GHL Owner name to a Settings FM name (flexible partial matching)
function matchFM(ownerName, fmList) {
  for (const fmDef of fmList) {
    if (
      ownerName === fmDef.name ||
      ownerName.toLowerCase().includes(fmDef.name.toLowerCase()) ||
      fmDef.name.toLowerCase().includes(ownerName.toLowerCase().split(' ')[0])
    ) {
      return fmDef;
    }
  }
  return null;
}

module.exports = async (req, res) => {
  try {
    const configs = loadSubAccountConfigs();
    if (!configs.length) {
      return res.status(200).json({ ok: false, error: 'No DEALER_SUBACCOUNTS configured' });
    }

    const sheets        = await getSheetsClient();
    const spreadsheetId = process.env.GOOGLE_SHEET_ID;
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

    // ════════════════════════════════════════════════════════════════════
    // Dealer Stats - All Time (FULL REPORT)
    // Order | Delivered | Refunds | After Refunds | Remaining | % Complete
    // ════════════════════════════════════════════════════════════════════

    const allTimeRows = [];
    let atGrandOrder = 0, atGrandDelivered = 0, atGrandRefunds = 0;

    for (const { config, stats, error } of dealerResults) {
      if (error || !stats) {
        allTimeRows.push([]);
        allTimeRows.push([`═══ ${config.name} ═══`, 'ERROR', error || 'Unknown error']);
        continue;
      }

      const dealerName = stats.dealerName;
      const fmList     = settings.fms[dealerName] || [];
      const hasSplit   = stats.allTime.split !== null;

      allTimeRows.push([]);

      if (hasSplit) {
        // ── Split-field dealer (e.g. Leduc: Paid vs Free) ──────────────
        const order     = settings.orders[dealerName] || 0;
        const delivered = stats.allTime.total;
        const paid      = stats.allTime.split.paid;
        const free      = stats.allTime.split.free;
        const thisMonth = stats.thisMonth.total;
        const remain    = order > 0 ? order - paid : 0;

        allTimeRows.push([`═══ ${dealerName} ═══`, 'Order', 'Delivered', 'Paid', 'Free', 'This Month', 'Remaining', '% Complete']);
        allTimeRows.push([
          dealerName, order || '-', delivered, paid, free, thisMonth,
          order > 0 ? (remain < 0 ? remain : Math.max(0, remain)) : '-',
          order > 0 ? pct(paid, order) : '-',
        ]);
        allTimeRows.push([
          `TOTAL ${dealerName}`, order || '-', delivered, paid, free, thisMonth,
          order > 0 ? (remain < 0 ? remain : Math.max(0, remain)) : '-',
          order > 0 ? pct(paid, order) : '-',
        ]);

        atGrandOrder     += order;
        atGrandDelivered += delivered;

      } else if (fmList.length > 0) {
        // ── FM breakdown dealer (e.g. Absolute Approval) ───────────────
        allTimeRows.push([`═══ ${dealerName} ═══`, 'Order', 'Delivered', 'Refunds', 'After Refunds', 'Remaining', '% Complete']);
        let dOrder = 0, dDelivered = 0, dRefunds = 0;

        for (const fmDef of fmList) {
          // Sum all-time delivered for this FM from sub-account
          let delivered = 0;
          let ref = 0;
          for (const [ownerName, count] of Object.entries(stats.allTime.byFM)) {
            if (matchFM(ownerName, [fmDef])) {
              delivered += count;
              ref += stats.allTime.refundsByFM[ownerName] || 0;
            }
          }

          const afterRef = delivered - ref;
          const remain   = fmDef.target > 0 ? fmDef.target - afterRef : 0;

          dOrder     += fmDef.target;
          dDelivered += delivered;
          dRefunds   += ref;

          if (fmDef.target > 0) {
            allTimeRows.push([
              fmDef.name, fmDef.target, delivered, ref, afterRef,
              remain < 0 ? remain : Math.max(0, remain),
              pct(afterRef, fmDef.target),
              remain < 0 ? 'over delivered' : '',
            ]);
          } else {
            allTimeRows.push([
              fmDef.name, '-', delivered, ref || '', ref ? afterRef : delivered, '-', '-',
            ]);
          }
        }

        // Unmapped FMs from sub-account
        for (const [ownerName, count] of Object.entries(stats.allTime.byFM)) {
          if (ownerName === 'Unassigned') continue;
          if (!matchFM(ownerName, fmList)) {
            const unmappedRef = stats.allTime.refundsByFM[ownerName] || 0;
            dDelivered += count;
            dRefunds   += unmappedRef;
            allTimeRows.push([`⚠ ${ownerName} (unmapped)`, '-', count, unmappedRef, count - unmappedRef, '-', '-']);
          }
        }

        // Unassigned
        const unassigned = stats.allTime.byFM['Unassigned'] || 0;
        if (unassigned > 0) {
          dDelivered += unassigned;
          allTimeRows.push(['Unassigned', '-', unassigned, '-', unassigned, '-', '-']);
        }

        // Total
        const totalAfterRef = dDelivered - dRefunds;
        const totalRemain   = dOrder - totalAfterRef;
        allTimeRows.push([
          `TOTAL ${dealerName}`, dOrder, dDelivered, dRefunds, totalAfterRef,
          totalRemain < 0 ? totalRemain : Math.max(0, totalRemain),
          pct(totalAfterRef, dOrder),
          totalRemain < 0 ? 'over delivered' : '',
        ]);

        atGrandOrder     += dOrder;
        atGrandDelivered += dDelivered;
        atGrandRefunds   += dRefunds;
      } else {
        // Simple dealer
        const order     = settings.orders[dealerName] || 0;
        const delivered = stats.allTime.total;
        const ref       = stats.allTime.totalRefunds || 0;
        const afterRef  = delivered - ref;
        const remain    = order - afterRef;

        allTimeRows.push([
          dealerName,
          order || '-',
          delivered,
          ref || '',
          ref ? afterRef : '',
          order ? (remain < 0 ? remain : Math.max(0, remain)) : '-',
          order ? pct(ref ? afterRef : delivered, order) : '-',
        ]);

        atGrandOrder     += order;
        atGrandDelivered += delivered;
        atGrandRefunds   += ref;
      }
    }

    // Grand total
    const atGrandAfterRef = atGrandDelivered - atGrandRefunds;
    const atGrandRemain   = atGrandOrder - atGrandAfterRef;
    allTimeRows.push([]);
    allTimeRows.push([
      'GRAND TOTAL', atGrandOrder, atGrandDelivered, atGrandRefunds, atGrandAfterRef,
      atGrandRemain < 0 ? atGrandRemain : Math.max(0, atGrandRemain),
      pct(atGrandAfterRef, atGrandOrder),
    ]);
    allTimeRows.push([]);
    allTimeRows.push([`Last synced: ${syncedAt}`]);

    await ensureTab(sheets, spreadsheetId, 'Dealer Stats - All Time');
    await clearAndWrite(sheets, spreadsheetId, 'Dealer Stats - All Time', allTimeRows);
    await formatMTDSummary(sheets, spreadsheetId, allTimeRows);

    // ════════════════════════════════════════════════════════════════════
    // Dealer Stats - Monthly (SIMPLE VIEW)
    // Just FM name + this month's delivered count
    // ════════════════════════════════════════════════════════════════════

    const monthlyRows = [];

    for (const { config, stats, error } of dealerResults) {
      if (error || !stats) {
        monthlyRows.push([]);
        monthlyRows.push([`═══ ${config.name} ═══`, 'ERROR', error || 'Unknown error']);
        continue;
      }

      const dealerName = stats.dealerName;
      const fmList     = settings.fms[dealerName] || [];
      const hasSplit   = stats.thisMonth.split !== null;

      monthlyRows.push([]);

      if (hasSplit) {
        // Split dealer (Leduc) — show this month's paid/free
        const thisMonth = stats.thisMonth.total;
        const paid      = stats.thisMonth.split.paid;
        const free      = stats.thisMonth.split.free;
        monthlyRows.push([`═══ ${dealerName} ═══`, 'This Month Delivered', 'Paid', 'Free']);
        monthlyRows.push([dealerName, thisMonth, paid, free]);
        monthlyRows.push([`TOTAL ${dealerName}`, thisMonth, paid, free]);
      } else if (fmList.length > 0) {
        monthlyRows.push([`═══ ${dealerName} ═══`, 'This Month Delivered']);
        let dealerTotal = 0;

        for (const fmDef of fmList) {
          let delivered = 0;
          for (const [ownerName, count] of Object.entries(stats.thisMonth.byFM)) {
            if (matchFM(ownerName, [fmDef])) {
              delivered += count;
            }
          }
          dealerTotal += delivered;
          monthlyRows.push([fmDef.name, delivered]);
        }

        // Unmapped
        for (const [ownerName, count] of Object.entries(stats.thisMonth.byFM)) {
          if (ownerName === 'Unassigned') continue;
          if (!matchFM(ownerName, fmList)) {
            dealerTotal += count;
            monthlyRows.push([`⚠ ${ownerName} (unmapped)`, count]);
          }
        }

        // Unassigned
        const unassigned = stats.thisMonth.byFM['Unassigned'] || 0;
        if (unassigned > 0) {
          dealerTotal += unassigned;
          monthlyRows.push(['Unassigned', unassigned]);
        }

        monthlyRows.push([`TOTAL ${dealerName}`, dealerTotal]);
      } else {
        monthlyRows.push([`═══ ${dealerName} ═══`, 'This Month Delivered']);
        monthlyRows.push([dealerName, stats.thisMonth.total]);
      }
    }

    monthlyRows.push([]);
    monthlyRows.push([`Last synced: ${syncedAt}`]);

    await ensureTab(sheets, spreadsheetId, 'Dealer Stats - Monthly');
    await clearAndWrite(sheets, spreadsheetId, 'Dealer Stats - Monthly', monthlyRows);

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
