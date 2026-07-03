// api/debug-calls.js — tests the /conversations/messages/export endpoint
//
// This is the bulk message export endpoint that lets us filter by channel
// (Call, SMS) for the entire location. Should be 1-2 API calls instead of
// scanning hundreds of conversations.

const GHL_BASE    = 'https://services.leadconnectorhq.com';
const GHL_VERSION = '2021-07-28';

async function ghlGet(path) {
  const res = await fetch(`${GHL_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${process.env.GHL_PRIVATE_TOKEN}`,
      Version: GHL_VERSION,
      'Content-Type': 'application/json',
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    return { _error: true, status: res.status, body };
  }
  return res.json();
}

module.exports = async (req, res) => {
  if (!req.query.secret || req.query.secret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const locationId = process.env.GHL_LOCATION_ID;
  const now        = new Date();
  const tomorrow    = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
const tomorrowISO = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, '0')}-${String(tomorrow.getDate()).padStart(2, '0')}`;

  const results = {};

  // Test 1: Export Call messages for today
  const callParams = new URLSearchParams({
    locationId,
    channel: 'Call',
    startDate: todayISO,
    endDate:   tomorrowISO,
    limit:     '50',
  });
  results.callExport = await ghlGet(`/conversations/messages/export?${callParams}`);

  // Test 2: Export SMS messages for today (just first page)
  const smsParams = new URLSearchParams({
    locationId,
    channel: 'SMS',
    startDate: todayISO,
    endDate:   tomorrowISO,
    limit:     '10',
  });
  results.smsExport = await ghlGet(`/conversations/messages/export?${smsParams}`);

  // Test 3: Try without channel filter (gets all non-email)
  const allParams = new URLSearchParams({
    locationId,
    startDate: todayISO,
    endDate:   tomorrowISO,
    limit:     '5',
  });
  results.allExport = await ghlGet(`/conversations/messages/export?${allParams}`);

  return res.status(200).json({
    today: todayISO,
    results,
  });
};
