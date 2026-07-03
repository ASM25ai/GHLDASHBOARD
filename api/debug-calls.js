const GHL_BASE = 'https://services.leadconnectorhq.com';
const GHL_VERSION = '2021-07-28';

async function ghlGet(path) {
  const res = await fetch(GHL_BASE + path, {
    headers: {
      Authorization: 'Bearer ' + process.env.GHL_PRIVATE_TOKEN,
      Version: GHL_VERSION,
      'Content-Type': 'application/json',
    },
  });
  if (!res.ok) {
    var body = '';
    try { body = await res.text(); } catch(e) {}
    return { _error: true, status: res.status, body: body };
  }
  return res.json();
}

module.exports = async function(req, res) {
  if (!req.query.secret || req.query.secret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  var locationId = process.env.GHL_LOCATION_ID;
  var now = new Date();
  var y = now.getFullYear();
  var m = String(now.getMonth() + 1).padStart(2, '0');
  var d = String(now.getDate()).padStart(2, '0');
  var todayISO = y + '-' + m + '-' + d;

  var tom = new Date(y, now.getMonth(), now.getDate() + 1);
  var tomorrowISO = tom.getFullYear() + '-' + String(tom.getMonth() + 1).padStart(2, '0') + '-' + String(tom.getDate()).padStart(2, '0');

  var results = {};

  results.callExport = await ghlGet('/conversations/messages/export?locationId=' + locationId + '&channel=Call&startDate=' + todayISO + '&endDate=' + tomorrowISO + '&limit=50');
  results.smsExport = await ghlGet('/conversations/messages/export?locationId=' + locationId + '&channel=SMS&startDate=' + todayISO + '&endDate=' + tomorrowISO + '&limit=10');

  return res.status(200).json({ today: todayISO, tomorrow: tomorrowISO, results: results });
};
