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

          html += `
            <tr>
              <td ${tdStyle}>${fmDef.name}</td>
              <td ${tdNumStyle}>${fmDef.target || '-'}</td>
              <td ${tdNumStyle}>${delivered}</td>
              <td ${tdNumStyle}>${remain < 0 ? remain : Math.max(0, remain)}</td>
              <td ${tdNumStyle}>${ref}</td>
            </tr>
          `;
        }

        html += `</table>`;
      }
    }

    html += `
        <br>
        <p style="color: #999; font-size: 12px;">Auto-generated by GHL Dashboard</p>
      </div>
    `;

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
