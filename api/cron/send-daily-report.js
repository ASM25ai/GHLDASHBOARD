// ---------------------------------------------------------------------------
// /api/cron/send-daily-report
//
// Sends a daily email summary of dealer stats at 11 AM EST.
// Uses Resend API for email delivery.
//
// Env vars required:
//   RESEND_API_KEY — from resend.com
//   REPORT_EMAIL_TO — recipient email (jazzy@adscalesmedia.com)
//   DEALER_SUBACCOUNTS, GOOGLE_SHEET_ID, GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_PRIVATE_KEY
// ---------------------------------------------------------------------------

const {
  getSheetsClient,
  readSettings,
} = require('../../lib/sheets');

const {
  aggregateDealerStats,
  loadSubAccountConfigs,
} = require('../../lib/ghl-subaccounts');

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

    const resendKey = process.env.RESEND_API_KEY;
    const emailTo   = process.env.REPORT_EMAIL_TO || 'jazzy@adscalesmedia.com';
    if (!resendKey) {
      return res.status(200).json({ ok: false, error: 'No RESEND_API_KEY configured' });
    }

    const sheets        = await getSheetsClient();
    const spreadsheetId = process.env.GOOGLE_SHEET_ID;
    const settings      = await readSettings(sheets, spreadsheetId);

    const now  = new Date();
    const date = now.toLocaleDateString('en-CA', { timeZone: 'America/Toronto', year: 'numeric', month: 'long', day: 'numeric' });

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

    // ── Build HTML email ───────────────────────────────────────────────
    const tableStyle = `
      style="border-collapse: collapse; width: 100%; max-width: 600px; font-family: Arial, sans-serif; font-size: 14px;"
    `;
    const thStyle = `
      style="text-align: left; padding: 8px 12px; border-bottom: 2px solid #333; font-weight: bold; background: #f5f5f5;"
    `;
    const tdStyle = `
      style="text-align: left; padding: 6px 12px; border-bottom: 1px solid #ddd;"
    `;
    const tdNumStyle = `
      style="text-align: right; padding: 6px 12px; border-bottom: 1px solid #ddd;"
    `;
    const sectionStyle = `
      style="font-size: 16px; font-weight: bold; padding: 16px 0 8px 0; border-bottom: 2px solid #333;"
    `;

    let html = `
      <div style="font-family: Arial, sans-serif; max-width: 650px; margin: 0 auto;">
        <h2 style="margin-bottom: 4px;">Adscalesmedia — Daily Report</h2>
        <p style="color: #666; margin-top: 0;">${date}</p>
    `;

    for (const { config, stats, error } of dealerResults) {
      if (error || !stats) {
        html += `<p style="color: red;">═══ ${config.name}: ERROR — ${error || 'Unknown'}</p>`;
        continue;
      }

      const dealerName = stats.dealerName;
      const fmList     = settings.fms[dealerName] || [];
      const hasSplit   = stats.allTime.split !== null;

      if (hasSplit) {
        // ── Leduc-style: Order, Delivered, This Month, Paid ──────────
        const order     = settings.orders[dealerName] || 0;
        const delivered = stats.allTime.total;
        const thisMonth = stats.thisMonth.total;
        const paid      = stats.allTime.split.paid;

        html += `
          <p ${sectionStyle}>═══ ${dealerName} ═══</p>
          <table ${tableStyle}>
            <tr>
              <th ${thStyle}></th>
              <th ${thStyle}>Order</th>
              <th ${thStyle}>Delivered</th>
              <th ${thStyle}>This Month</th>
              <th ${thStyle}>Paid</th>
            </tr>
            <tr>
              <td ${tdStyle}>${dealerName}</td>
              <td ${tdNumStyle}>${order}</td>
              <td ${tdNumStyle}>${delivered}</td>
              <td ${tdNumStyle}>${thisMonth}</td>
              <td ${tdNumStyle}>${paid}</td>
            </tr>
          </table>
        `;

      } else if (fmList.length > 0) {
        // ── FM/Branch breakdown: Order, Delivered, Remaining, Refunds ─
        html += `
          <p ${sectionStyle}>═══ ${dealerName} ═══</p>
          <table ${tableStyle}>
            <tr>
              <th ${thStyle}></th>
              <th ${thStyle}>Order</th>
              <th ${thStyle}>Delivered</th>
              <th ${thStyle}>Remaining</th>
              <th ${thStyle}>Refunds</th>
            </tr>
        `;

        for (const fmDef of fmList) {
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
          const isFulfilled = remain <= 0;

          const deliveredColor = isFulfilled ? 'color: #2196F3;' : '';
          const remainColor    = isFulfilled ? 'color: #2196F3;' : 'color: #E53935;';
          const remainDisplay  = remain < 0 ? remain : Math.max(0, remain);

          html += `
            <tr>
              <td ${tdStyle}>${fmDef.name}</td>
              <td ${tdNumStyle}>${fmDef.target || '-'}</td>
              <td style="text-align: right; padding: 6px 12px; border-bottom: 1px solid #ddd; font-weight: bold; ${deliveredColor}">${delivered}</td>
              <td style="text-align: right; padding: 6px 12px; border-bottom: 1px solid #ddd; font-weight: bold; ${remainColor}">${remainDisplay}</td>
              <td ${tdNumStyle}>${ref}</td>
            </tr>
          `;
        }

        html += `</table>`;
      }
    }

    html += `
      </div>
    `;

    // ── Qualified Yesterday — per-rep per-dealer breakdown ─────────────
    // Read from "Current Month Data" tab, filter for yesterday's qualified leads,
    // group by Sales Rep × Dealer. For Leduc, split Paid/Free from sub-account.
    try {
      const now_est = new Date(now.toLocaleString('en-US', { timeZone: 'America/Toronto' }));
      const yesterday = new Date(now_est);
      yesterday.setDate(yesterday.getDate() - 1);
      const yestDateStr = `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, '0')}-${String(yesterday.getDate()).padStart(2, '0')}`;

      // Read the Current Month Data tab
      const cmdRes = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: 'Current Month Data!A1:L2000',
      });
      const cmdRows = cmdRes.data.values || [];

      // Use Settings aliasMap for dealer normalization
      const aliasMap = settings.aliasMap || {};

      // Fixed column list — all active dealers
      const splitConfig = configs.find((c) => c.splitField || c.splitFieldId);
      const splitDealerName = splitConfig ? splitConfig.name : null;

      // Columns in order: AA, Leduc (Paid), Leduc (Free), Eastside Kia, REV
      const columns = [];
      const allDealers = ['Absolute Approval', 'Leduc', 'Eastside Kia', 'REV'];
      for (const dn of allDealers) {
        if (dn === splitDealerName) {
          columns.push(`${dn} (Paid)`);
          columns.push(`${dn} (Free)`);
        } else {
          columns.push(dn);
        }
      }

      // Build a set of yesterday's Leduc contact IDs that are "Paid" from sub-account
      const paidContactIds = new Set();
      if (splitConfig && splitDealerName) {
        try {
          const GHL_BASE = 'https://services.leadconnectorhq.com';
          const body = {
            locationId: splitConfig.locationId,
            page: 1,
            pageLimit: 100,
            filters: [
              { field: 'tags', operator: 'contains', value: splitConfig.deliveredTag || 'qualified' },
            ],
          };

          const response = await fetch(`${GHL_BASE}/contacts/search`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${splitConfig.apiKey}`,
              Version: '2021-07-28',
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(body),
          });
          const data = await response.json();
          const contacts = data.contacts || [];

          const yestStart = new Date(yesterday.getFullYear(), yesterday.getMonth(), yesterday.getDate());
          const yestEnd   = new Date(yesterday.getFullYear(), yesterday.getMonth(), yesterday.getDate(), 23, 59, 59, 999);

          for (const c of contacts) {
            const created = new Date(c.dateCreated || c.dateAdded);
            if (created >= yestStart && created <= yestEnd) {
              const fields = c.customFields || [];
              for (const f of fields) {
                if (splitConfig.splitFieldId && f.id === splitConfig.splitFieldId) {
                  if (f.value && f.value.toLowerCase().includes('paid')) {
                    if (c.phone) paidContactIds.add(c.phone.replace(/\D/g, '').slice(-10));
                    if (c.email) paidContactIds.add(c.email.toLowerCase().trim());
                  }
                }
              }
            }
          }
        } catch (err) {
          console.warn('Failed to fetch Leduc paid contacts:', err.message);
        }
      }

      // Group yesterday's leads by Sales Rep × Dealer
      const repStats = {};
      const knownReps = ['Jess', 'Marsha', 'Jan', 'Rea'];
      for (const rn of knownReps) repStats[rn] = {};
      const repNames = [...knownReps];

      // FM names to exclude from Sales Rep (these are dealers/FMs, not ISA reps)
      const fmExclusions = ['ali', 'charbel', 'kayam', 'ali adnan'];

      let debugSkipped = [];

      for (let i = 1; i < cmdRows.length; i++) {
        const row = cmdRows[i];
        if (!row || !row[1]) continue;
        const qDate    = row[1];
        const rawDealer = (row[2] || '').trim();
        const fm       = (row[3] || '').trim();
        const salesRep = (row[4] || '').trim();
        const phone    = (row[9] || '').replace(/\D/g, '').slice(-10);
        const email    = (row[10] || '').toLowerCase().trim();

        if (qDate !== yestDateStr) continue;
        if (!salesRep) continue;

        // Skip if "Sales Rep" is actually an FM/dealer name, not an ISA
        if (fmExclusions.includes(salesRep.toLowerCase())) {
          debugSkipped.push(`${salesRep} (FM, not ISA — dealer: ${rawDealer})`);
          continue;
        }

        // Match rep name — try known reps first, otherwise add as new rep
        let repKey = knownReps.find((r) => salesRep.toLowerCase().includes(r.toLowerCase()));
        if (!repKey) {
          repKey = salesRep;
          if (!repStats[repKey]) {
            repStats[repKey] = {};
            repNames.push(repKey);
          }
        }

        // Normalize dealer using Settings aliases
        let dealerCol = aliasMap[rawDealer.toLowerCase()] || rawDealer;

        // Check dealer value AND FM for REV (Charbel, Ali Adnan, Ali → REV)
        const dealerLower = dealerCol.toLowerCase();
        const rawLower    = rawDealer.toLowerCase();
        if (dealerLower.includes('charbel') || dealerLower.includes('ali adnan') || dealerLower === 'ali' ||
            rawLower.includes('charbel') || rawLower.includes('ali adnan') || rawLower === 'ali') {
          dealerCol = 'REV';
        }

        // Map sub-dealer names to parent dealers
        // STK, ESK, CHC, CHF, South Trail Kia → Eastside Kia
        const eskBranches = ['south trail kia', 'eastside kia', 'stk', 'esk', 'chc', 'chf', 'chd'];
        if (eskBranches.includes(dealerCol.toLowerCase()) || eskBranches.includes(rawLower)) {
          dealerCol = 'Eastside Kia';
        }

        // Leduc aliases
        if (dealerLower === 'lag' || rawLower === 'lag') {
          dealerCol = 'Leduc';
        }

        // For the split dealer (Leduc), check paid/free
        if (dealerCol === splitDealerName) {
          const isPaid = paidContactIds.has(phone) || paidContactIds.has(email);
          const key = isPaid ? `${splitDealerName} (Paid)` : `${splitDealerName} (Free)`;
          repStats[repKey][key] = (repStats[repKey][key] || 0) + 1;
        } else if (allDealers.includes(dealerCol)) {
          repStats[repKey][dealerCol] = (repStats[repKey][dealerCol] || 0) + 1;
        } else {
          // Unknown dealer — still count it under its name
          repStats[repKey][dealerCol] = (repStats[repKey][dealerCol] || 0) + 1;
          if (!columns.includes(dealerCol) && dealerCol) columns.push(dealerCol);
        }
      }

      // Log skipped reps for debugging
      if (debugSkipped.length > 0) {
        console.log(`  Skipped ${debugSkipped.length} leads with unknown reps: ${debugSkipped.join(', ')}`);
      }
      console.log(`  Rep stats: ${JSON.stringify(repStats)}`);

      // Check if any data exists
      const hasData = repNames.some((rn) => Object.values(repStats[rn]).reduce((s, v) => s + v, 0) > 0);

      if (hasData) {
        const thS = 'style="text-align: right; padding: 8px 12px; border-bottom: 2px solid #333; font-weight: bold; background: #f5f5f5;"';
        const thL = 'style="text-align: left; padding: 8px 12px; border-bottom: 2px solid #333; font-weight: bold; background: #f5f5f5;"';
        const tdR = 'style="text-align: right; padding: 6px 12px; border-bottom: 1px solid #ddd;"';
        const tdL = 'style="text-align: left; padding: 6px 12px; border-bottom: 1px solid #ddd;"';
        const tdRGray = 'style="text-align: right; padding: 6px 12px; border-bottom: 1px solid #ddd; color: #999;"';
        const tdLGray = 'style="text-align: left; padding: 6px 12px; border-bottom: 1px solid #ddd; color: #999;"';

        html = html.replace('</div>', `
          <p style="font-size: 16px; font-weight: bold; padding: 16px 0 8px 0; border-bottom: 2px solid #333;">═══ Qualified Yesterday (${yestDateStr}) ═══</p>
          <table style="border-collapse: collapse; width: 100%; max-width: 700px; font-family: Arial, sans-serif; font-size: 14px;">
            <tr>
              <th ${thL}>Sales Rep</th>
              ${columns.map((c) => `<th ${thS}>${c}</th>`).join('')}
              <th ${thS}>Total</th>
            </tr>
            ${repNames.map((rn) => {
              const total = Object.values(repStats[rn]).reduce((s, v) => s + v, 0);
              const isZero = total === 0;
              const tl = isZero ? tdLGray : tdL;
              const tr = isZero ? tdRGray : tdR;
              return `<tr>
                <td ${tl}>${rn}</td>
                ${columns.map((c) => `<td ${tr}>${repStats[rn][c] || ''}</td>`).join('')}
                <td style="text-align: right; padding: 6px 12px; border-bottom: 1px solid #ddd; font-weight: bold; ${isZero ? 'color: #999;' : ''}">${total}</td>
              </tr>`;
            }).join('')}
          </table>
        </div>`);
      }
    } catch (err) {
      console.warn('Failed to build Qualified Yesterday section:', err.message);
    }

    // ── Send email via Resend ──────────────────────────────────────────
    const emailRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${resendKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'GHL Dashboard <reports@adscalesmedia.com>',
        to: [emailTo],
        subject: `Daily Report — ${date}`,
        html,
      }),
    });

    const emailData = await emailRes.json();

    if (!emailRes.ok) {
      console.error('Resend error:', emailData);
      return res.status(200).json({ ok: false, error: 'Email send failed', details: emailData });
    }

    return res.status(200).json({
      ok: true,
      emailId: emailData.id,
      sentTo: emailTo,
      date,
    });

  } catch (err) {
    console.error('send-daily-report FATAL:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
};
