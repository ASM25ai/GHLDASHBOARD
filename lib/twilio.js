// lib/twilio.js
//
// Fetches daily usage/spend from Twilio's Usage Records API.
// Uses Basic Auth with Account SID + Auth Token.
//
// Env vars: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN

async function fetchTwilioSpend(now, monthStart) {
  const sid   = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) throw new Error('TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN not set.');

  const auth = Buffer.from(`${sid}:${token}`).toString('base64');

  function dateStr(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  const todayStr    = dateStr(now);
  const mtdStartStr = dateStr(monthStart);

  // Fetch daily usage records for the current month
  const url = `https://api.twilio.com/2010-04-01/Accounts/${sid}/Usage/Records/Daily.json?StartDate=${mtdStartStr}&EndDate=${todayStr}&PageSize=200`;

  const res = await fetch(url, {
    headers: { Authorization: `Basic ${auth}` },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Twilio API ${res.status}: ${body.slice(0, 200)}`);
  }

  const data = await res.json();
  const records = data.usage_records || [];

  // Group by date, sum price across all usage categories
  const byDate = {};
  let mtdTotal = 0;

  for (const rec of records) {
    const date  = rec.start_date;
    const price = parseFloat(rec.price || '0');

    if (!byDate[date]) {
      byDate[date] = { date, total: 0, categories: {} };
    }
    byDate[date].total += price;
    mtdTotal += price;

    // Track category breakdown (calls, sms, phone numbers, etc)
    const cat = rec.category || 'other';
    byDate[date].categories[cat] = (byDate[date].categories[cat] || 0) + price;
  }

  // Sort by date
  const daily = Object.values(byDate).sort((a, b) => a.date.localeCompare(b.date));

  return { daily, mtdTotal };
}

module.exports = { fetchTwilioSpend };
