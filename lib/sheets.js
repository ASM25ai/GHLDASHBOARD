const { google } = require('googleapis');

function getAuth() {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const key = (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  if (!email || !key) {
    throw new Error('Missing GOOGLE_SERVICE_ACCOUNT_EMAIL or GOOGLE_PRIVATE_KEY env vars.');
  }
  return new google.auth.JWT(email, null, key, ['https://www.googleapis.com/auth/spreadsheets']);
}

async function getSheetsClient() {
  const auth = getAuth();
  await auth.authorize();
  return google.sheets({ version: 'v4', auth });
}

async function ensureTab(sheets, spreadsheetId, title) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const exists = (meta.data.sheets || []).some((s) => s.properties.title === title);
  if (!exists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: [{ addSheet: { properties: { title } } }] },
    });
  }
}

// Wipes an auto-generated tab and rewrites from scratch.
// NEVER called on the Settings tab — that is fully human-controlled.
async function clearAndWrite(sheets, spreadsheetId, tab, rows) {
  await sheets.spreadsheets.values.clear({ spreadsheetId, range: `${tab}!A1:ZZ20000` });
  if (!rows.length) return;
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${tab}!A1`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: rows },
  });
}

// ---------------------------------------------------------------------------
// Settings tab: read
// ---------------------------------------------------------------------------
//
// Expected layout (5 columns, rows grouped by dealer):
//
//   A          | B             | C                          | D        | E
//   Dealer     | Monthly Order | Aliases (comma-separated)  | FM Name  | FM Target
//   Rev        | 100           | rev, rev motor, REV        | Ali      | 30
//              |               |                            | Charbel  | 20
//              |               |                            | Vinny    | 50
//   Carizma    | 50            | Carizma auto sales         | John     | 50
//
// Rules:
//   - A new dealer group starts whenever Col A is non-empty.
//   - Blank Col A rows continue the current dealer group (for FM rows).
//   - The canonical name in Col A is ALWAYS added as its own alias
//     automatically — you don't need to list it in Col C.
//   - Alias matching is case-insensitive and whitespace-trimmed.
//   - Completely blank rows are skipped.
//
// Returns:
//   {
//     dealers:  ['Rev', 'Carizma', ...],      // ordered
//     orders:   { Rev: 100, Carizma: 50 },
//     aliasMap: { 'rev': 'Rev', 'rev motor': 'Rev', 'carizma auto sales': 'Carizma', ... },
//     fms:      { Rev: [{ name: 'Ali', target: 30 }, ...], Carizma: [...] }
//   }

async function readSettings(sheets, spreadsheetId) {
  let rows = [];
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: 'Settings!A2:E500',
    });
    rows = res.data.values || [];
  } catch {
    return { dealers: [], orders: {}, aliasMap: {}, fms: {} };
  }

  const dealers  = [];
  const orders   = {};
  const aliasMap = {};
  const fms      = {};

  let currentDealer = null;

  for (const row of rows) {
    const colA = (row[0] || '').trim();
    const colB = (row[1] || '').toString().trim();
    const colC = (row[2] || '').trim();
    const colD = (row[3] || '').trim();
    const colE = (row[4] || '').toString().trim();

    // Skip completely empty rows
    if (!colA && !colB && !colC && !colD && !colE) continue;

    // New dealer group
    if (colA) {
      currentDealer = colA;
      dealers.push(currentDealer);
      orders[currentDealer]   = parseInt(colB.replace(/,/g, ''), 10) || 0;
      fms[currentDealer]      = [];

      // Canonical name is always its own alias
      aliasMap[currentDealer.toLowerCase()] = currentDealer;

      // Comma-separated aliases from Col C
      if (colC) {
        for (const alias of colC.split(',')) {
          const t = alias.trim();
          if (t) aliasMap[t.toLowerCase()] = currentDealer;
        }
      }
    }

    // FM row (Col D present and we have a current dealer)
    if (colD && currentDealer) {
      const target = parseInt(colE.replace(/,/g, ''), 10) || 0;
      fms[currentDealer].push({ name: colD, target });
    }
  }

  return { dealers, orders, aliasMap, fms };
}

// ---------------------------------------------------------------------------
// Settings tab: init (first run only)
// ---------------------------------------------------------------------------
//
// Creates the Settings tab and seeds it with the dealer list from code.
// After the first run the user owns this tab — this function never overwrites
// existing data, so your manually-entered orders and aliases are always safe.

async function initSettingsTab(sheets, spreadsheetId, seedDealers) {
  const meta   = await sheets.spreadsheets.get({ spreadsheetId });
  const exists = (meta.data.sheets || []).some((s) => s.properties.title === 'Settings');

  if (exists) {
    // Tab already exists — check if it has any dealer data
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: 'Settings!A2:A3',
    });
    if ((res.data.values || []).length > 0) return; // already initialised, leave it alone
  } else {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: [{ addSheet: { properties: { title: 'Settings' } } }] },
    });
  }

  const rows = [
    ['Dealer', 'Monthly Order', 'Aliases (comma-separated — any of these in GHL count toward this dealer)', 'FM Name', 'FM Target'],
    ...seedDealers.map((d) => [d, 0, d, '', '']),
  ];

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range:            'Settings!A1',
    valueInputOption: 'USER_ENTERED',
    requestBody:      { values: rows },
  });
}

module.exports = {
  getSheetsClient,
  ensureTab,
  clearAndWrite,
  readSettings,
  initSettingsTab,
};
