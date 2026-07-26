// api/cron/sync-calls.js
//
// Separate cron endpoint for call/SMS stats.
// Fetches GHL message exports (Call + SMS) and updates the Sales Rep tab
// with call counts, duration, SMS counts. Has a full 60-second budget
// since it runs independently from the leads sync.

const { fetchCallStats } = require('../../lib/calls');
const { getSheetsClient, clearAndWrite, ensureTab } = require('../../lib/sheets');
const { fetchHubstaffStats, fmtHours } = require('../../lib/hubstaff');
const { nowET, monthStartET, monthLabel, dateKey, isSameDay, parseDate } = require('../../lib/timezone');
const {
  fetchCustomFieldIdToKeyMap,
  findFieldIdByKey,
  normalizeCustomFields,
  fetchQualifiedLeadsDayByDay,
} = require('../../lib/ghl');
const { normalizeDealer, normalizeFMForDealer, normalizeSalesRep } = require('../../lib/aliases');
const {
  readSettings,
} = require('../../lib/sheets');
const { monthStartUTCms, nowUTCms } = require('../../lib/timezone');
const REPS = require('../../lib/reps');

module.exports = async (req, res) => {
  const hasValidSecret = req.query.secret && req.query.secret === process.env.CRON_SECRET;
  if (!hasValidSecret) return res.status(401).json({ error: 'Unauthorized' });

  const locationId    = process.env.GHL_LOCATION_ID;
  const spreadsheetId = process.env.GOOGLE_SHEET_ID;

  try {
    const t0 = Date.now();
    const now = nowET();
    const monthStart = monthStartET();

    // ── 1. Fetch call stats (full 60s budget) ────────────────────────────
    const callStats = await fetchCallStats(REPS, locationId, now, monthStart);
    const callDebug = callStats._debug || null;
    delete callStats._debug;
    console.log(`[TIMING] Call stats: ${Date.now() - t0}ms`);

    // ── 2. Fetch Hubstaff stats ──────────────────────────────────────────
    let hubToday = {}, hubMTD = {}, hubError = null;
    try {
      const hubStats = await fetchHubstaffStats(now, monthStart);
      hubToday = hubStats.todayStats;
      hubMTD   = hubStats.mtdStats;
    } catch (err) {
      hubError = err.message;
      console.warn('Hubstaff fetch failed:', err.message);
    }
    console.log(`[TIMING] Hubstaff: ${Date.now() - t0}ms`);

    // ── 3. Get qualified lead counts per rep ─────────────────────────────
    const fieldMap = await fetchCustomFieldIdToKeyMap(locationId);
    const qualifiedDateFieldId = findFieldIdByKey(fieldMap, 'qualified_date');
    const contacts = await fetchQualifiedLeadsDayByDay(
      locationId, qualifiedDateFieldId, monthStartUTCms(), nowUTCms()
    );

    const sheets = await getSheetsClient();
    const settings = await readSettings(sheets, spreadsheetId);

    // Count leads per rep
    const repLeadStats = {};
    for (const ghlName of Object.keys(REPS)) {
      repLeadStats[ghlName] = { today: 0, mtd: 0 };
    }

    for (const contact of contacts) {
      const raw = normalizeCustomFields(contact, fieldMap);
      const qDate = parseDate(raw.qualified_date);
      if (!qDate || qDate < monthStart || qDate > now) continue;

      const salesRep = normalizeSalesRep(raw.sales_rep);
      const isToday = isSameDay(qDate, now);

      if (repLeadStats[salesRep]) {
        repLeadStats[salesRep].mtd++;
        if (isToday) repLeadStats[salesRep].today++;
      }
    }

    console.log(`[TIMING] Lead counts: ${Date.now() - t0}ms`);

    // ── 4. Build Sales Rep tab ───────────────────────────────────────────
    await ensureTab(sheets, spreadsheetId, 'Sales Rep');

    const repNames = Object.keys(REPS);

    // --- TODAY section ---
    const salesTodayRows = [
      [`TODAY — ${dateKey(now)}`],
      ['Sales Rep', 'Leads', 'Calls', '>30s', 'Avg Dur', 'SMS', 'Hours', 'Activity %', 'Calls/Hr', 'Connect %', 'SMS/Hr', 'Leads/Hr', 'Calls/Lead'],
    ];

    let totLeadsToday = 0, totCallsToday = 0, totCalls30sToday = 0, totSmsToday = 0;
    let totHrsToday = 0;

    for (const ghlName of repNames) {
      const rep    = REPS[ghlName];
      const leads_ = repLeadStats[ghlName] || { today: 0, mtd: 0 };
      const hub    = hubToday[String(rep.hubstaffId)] || { tracked: 0, active: 0 };
      const calls  = callStats[ghlName] || {};

      totLeadsToday += leads_.today;
      totCallsToday += calls.callsToday || 0;
      totCalls30sToday += calls.calls30sToday || 0;
      totSmsToday += calls.smsToday || 0;
      totHrsToday += hub.tracked / 3600;

      const actPct = hub.tracked
        ? (() => {
            for (const v of [hub.keyboard, hub.active, hub.input_tracked]) {
              if (v > 0 && v < hub.tracked) return `${Math.round((v / hub.tracked) * 100)}%`;
            }
            return '-';
          })()
        : '-';

      const hrs = hub.tracked / 3600;
      salesTodayRows.push([
        `${ghlName} (${rep.displayName})`,
        leads_.today,
        calls.callsToday || 0,
        calls.calls30sToday || 0,
        calls.avgDurToday || '-',
        calls.smsToday || 0,
        fmtHours(hub.tracked),
        actPct,
        hrs > 0 ? (calls.callsToday / hrs).toFixed(1) : '-',
        calls.callsToday > 0 ? `${Math.round(((calls.calls30sToday || 0) / calls.callsToday) * 100)}%` : '-',
        hrs > 0 ? ((calls.smsToday || 0) / hrs).toFixed(1) : '-',
        hrs > 0 ? (leads_.today / hrs).toFixed(2) : '-',
        leads_.today > 0 ? Math.round((calls.callsToday || 0) / leads_.today) : '-',
      ]);
    }

    salesTodayRows.push([
      'TOTAL', totLeadsToday, totCallsToday, totCalls30sToday, '',
      totSmsToday, fmtHours(totHrsToday * 3600), '-',
      totHrsToday > 0 ? (totCallsToday / totHrsToday).toFixed(1) : '-',
      totCallsToday > 0 ? `${Math.round((totCalls30sToday / totCallsToday) * 100)}%` : '-',
      totHrsToday > 0 ? (totSmsToday / totHrsToday).toFixed(1) : '-',
      totHrsToday > 0 ? (totLeadsToday / totHrsToday).toFixed(2) : '-',
      totLeadsToday > 0 ? Math.round(totCallsToday / totLeadsToday) : '-',
    ]);

    // --- MTD section ---
    const salesMTDRows = [[], [],
      [`MTD — ${monthLabel(now)}`],
      ['Sales Rep', 'Leads', 'Calls', '>30s', 'Avg Dur', 'SMS', 'Hours', 'Activity %', 'Calls/Hr', 'Connect %', 'SMS/Hr', 'Leads/Hr', 'Calls/Lead'],
    ];

    let totLeadsMTD = 0, totCallsMTD = 0, totSmsMTD = 0, totCalls30sMTD = 0;
    let totTrackedMTD = 0;

    for (const ghlName of repNames) {
      const rep    = REPS[ghlName];
      const leads_ = repLeadStats[ghlName] || { mtd: 0 };
      const hub    = hubMTD[String(rep.hubstaffId)] || { tracked: 0, active: 0 };
      const calls  = callStats[ghlName] || {};

      totLeadsMTD += leads_.mtd;
      totCallsMTD += calls.callsMTD || 0;
      totSmsMTD += calls.smsMTD || 0;
      totCalls30sMTD += calls.calls30sMTD || 0;
      totTrackedMTD += hub.tracked;

      const actPct = hub.tracked
        ? (() => {
            for (const v of [hub.keyboard, hub.active, hub.input_tracked]) {
              if (v > 0 && v < hub.tracked) return `${Math.round((v / hub.tracked) * 100)}%`;
            }
            return '-';
          })()
        : '-';

      const hrs = hub.tracked / 3600;
      salesMTDRows.push([
        `${ghlName} (${rep.displayName})`,
        leads_.mtd,
        calls.callsMTD || 0,
        calls.calls30sMTD || 0,
        calls.avgDurMTD || '-',
        calls.smsMTD || 0,
        fmtHours(hub.tracked),
        actPct,
        hrs > 0 ? ((calls.callsMTD || 0) / hrs).toFixed(1) : '-',
        (calls.callsMTD || 0) > 0 ? `${Math.round(((calls.calls30sMTD || 0) / (calls.callsMTD || 1)) * 100)}%` : '-',
        hrs > 0 ? ((calls.smsMTD || 0) / hrs).toFixed(1) : '-',
        hrs > 0 ? (leads_.mtd / hrs).toFixed(2) : '-',
        leads_.mtd > 0 ? Math.round((calls.callsMTD || 0) / leads_.mtd) : '-',
      ]);
    }

    const totHrsMTD = totTrackedMTD / 3600;
    salesMTDRows.push([
      'TOTAL', totLeadsMTD, totCallsMTD, totCalls30sMTD, '', totSmsMTD,
      fmtHours(totTrackedMTD), '-',
      totHrsMTD > 0 ? (totCallsMTD / totHrsMTD).toFixed(1) : '-',
      totCallsMTD > 0 ? `${Math.round((totCalls30sMTD / totCallsMTD) * 100)}%` : '-',
      totHrsMTD > 0 ? (totSmsMTD / totHrsMTD).toFixed(1) : '-',
      totHrsMTD > 0 ? (totLeadsMTD / totHrsMTD).toFixed(2) : '-',
      totLeadsMTD > 0 ? Math.round(totCallsMTD / totLeadsMTD) : '-',
    ]);

    if (hubError) {
      salesMTDRows.push([], [`⚠ Hubstaff failed: ${hubError}`]);
    }

    await clearAndWrite(sheets, spreadsheetId, 'Sales Rep', [
      ...salesTodayRows,
      ...salesMTDRows,
      [],
      [`Last synced: ${now.toISOString()}`],
    ]);

    console.log(`[TIMING] Total: ${Date.now() - t0}ms`);

    return res.status(200).json({
      ok: true,
      callDebug,
      syncedAt: now.toISOString(),
    });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
};
