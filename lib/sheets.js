const { google } = require('googleapis');

function getAuth() {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  let key = process.env.GOOGLE_PRIVATE_KEY || '';
  key = key
    .replace(/\\n/g, '\n')
    .replace(/^["']|["']$/g, '')
    .trim();
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
// Row grouping for MTD Summary — collapses FM sub-rows under each dealer
// ---------------------------------------------------------------------------
//
// fmGroups: [{ startIndex, endIndex }] — 0-based row indices, end exclusive.
// These are the FM sub-row ranges to collapse. Dealer rows and the TOTAL row
// are never grouped.
//
// Each run: delete all existing row groups on MTD Summary (since the row
// structure rebuilds from scratch), then add + collapse the new groups.

async function applyMTDRowGroups(sheets, spreadsheetId, fmGroups) {
  if (!fmGroups.length) return;

  // Get the MTD Summary sheetId and any existing row groups
  const meta     = await sheets.spreadsheets.get({ spreadsheetId });
  const mtdSheet = (meta.data.sheets || []).find((s) => s.properties.title === 'MTD Summary');
  if (!mtdSheet) return;

  const sheetId       = mtdSheet.properties.sheetId;
  const existingGroups = mtdSheet.rowGroups || [];

  const requests = [];

  // Delete all existing row groups first (safe to do — sheet content was
  // already rebuilt by clearAndWrite before this function is called)
  for (const g of existingGroups) {
    requests.push({
      deleteDimensionGroup: {
        range: {
          sheetId,
          dimension: 'ROWS',
          startIndex: g.range.startIndex,
          endIndex:   g.range.endIndex,
        },
      },
    });
  }

  // Add new groups for each dealer's FM sub-rows
  for (const { startIndex, endIndex } of fmGroups) {
    requests.push({
      addDimensionGroup: {
        range: { sheetId, dimension: 'ROWS', startIndex, endIndex },
      },
    });
  }

  // Collapse all the new groups (so they start hidden — user clicks + to expand)
  for (const { startIndex, endIndex } of fmGroups) {
    requests.push({
      updateDimensionGroup: {
        dimensionGroup: {
          range:     { sheetId, dimension: 'ROWS', startIndex, endIndex },
          depth:     1,
          collapsed: true,
        },
        fields: 'collapsed',
      },
    });
  }

  if (requests.length) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests },
    });
  }
}

// ---------------------------------------------------------------------------
// Settings tab
// ---------------------------------------------------------------------------

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

    if (!colA && !colB && !colC && !colD && !colE) continue;

    if (colA) {
      currentDealer = colA;
      dealers.push(currentDealer);
      orders[currentDealer]  = parseInt(colB.replace(/,/g, ''), 10) || 0;
      fms[currentDealer]     = [];
      aliasMap[currentDealer.toLowerCase()] = currentDealer;
      if (colC) {
        for (const alias of colC.split(',')) {
          const t = alias.trim();
          if (t) aliasMap[t.toLowerCase()] = currentDealer;
        }
      }
    }

    if (colD && currentDealer) {
      const target = parseInt(colE.replace(/,/g, ''), 10) || 0;
      fms[currentDealer].push({ name: colD, target });
    }
  }

  return { dealers, orders, aliasMap, fms };
}

async function initSettingsTab(sheets, spreadsheetId, seedDealers) {
  const meta   = await sheets.spreadsheets.get({ spreadsheetId });
  const exists = (meta.data.sheets || []).some((s) => s.properties.title === 'Settings');

  if (exists) {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: 'Settings!A2:A3',
    });
    if ((res.data.values || []).length > 0) return;
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
    range: 'Settings!A1',
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: rows },
  });
}

// ---------------------------------------------------------------------------
// Dealer View tab — created ONCE, never overwritten
// ---------------------------------------------------------------------------

async function initDealerViewTab(sheets, spreadsheetId) {
  const meta     = await sheets.spreadsheets.get({ spreadsheetId });
  const existing = (meta.data.sheets || []).find((s) => s.properties.title === 'Dealer View');
  if (existing) return;

  const addRes = await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: { requests: [{ addSheet: { properties: { title: 'Dealer View' } } }] },
  });
  const sheetId = addRes.data.replies[0].addSheet.properties.sheetId;

  const orderFormula  = `=IFERROR(VLOOKUP(B1,Settings!$A:$B,2,FALSE),0)`;
  const mtdFormula    = `=COUNTIF('Current Month Data'!C:C,B1)`;
  const todayFormula  = `=COUNTIFS('Current Month Data'!C:C,B1,'Current Month Data'!B:B,TEXT(TODAY(),"YYYY-MM-DD"))`;
  const remainFormula = `=MAX(0,B3-E3)`;
  const pctFormula    = `=IFERROR(TEXT(E3/B3,"0%"),"-")`;
  const fmQuery       = `=IFERROR(QUERY('Current Month Data'!A:L,"SELECT D, COUNT(A) WHERE C='"&B1&"' GROUP BY D ORDER BY COUNT(A) DESC LABEL D 'FM Name', COUNT(A) 'Leads This Month'",0),"⬆ Select a dealer from the dropdown above")`;
  const leadsQuery    = `=IFERROR(QUERY('Current Month Data'!A:L,"SELECT B,E,D,F,G,H,I WHERE C='"&B1&"' ORDER BY B LABEL B 'Date', E 'Sales Rep', D 'FM', F 'Lead Type', G 'Lead Source', H 'Province', I 'Contact Name' FORMAT B 'yyyy-mm-dd'",0),"Select a dealer above")`;

  const buffer = Array.from({ length: 21 }, () => []);

  const rows = [
    ['Select Dealer →', ''],
    [],
    ['Monthly Order', orderFormula, '', 'MTD Delivered', mtdFormula, '', 'Today', todayFormula, '', 'Remaining', remainFormula, '', '% Complete', pctFormula],
    [],
    ['── FM Breakdown ──'],
    [fmQuery],
    ...buffer,
    ['── Lead Details (this month) ──'],
    [leadsQuery],
  ];

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: 'Dealer View!A1',
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: rows },
  });

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [{
        setDataValidation: {
          range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 1, endColumnIndex: 2 },
          rule: {
            condition: { type: 'ONE_OF_RANGE', values: [{ userEnteredValue: '=Settings!$A$2:$A$500' }] },
            showCustomUi: true,
            strict: true,
          },
        },
      }],
    },
  });
}

module.exports = {
  getSheetsClient,
  ensureTab,
  clearAndWrite,
  readSettings,
  initSettingsTab,
  initDealerViewTab,
  applyMTDRowGroups,
};
