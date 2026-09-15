// lib/fm-orders-sheet.ts
//
// Reads the "FM Orders" Google Sheet via a service account. This is the source
// of truth for quotas and previous-cycle balances; GHL supplies delivered
// counts. Server-only — never import into a client component.
//
// Required env vars (see SETUP-fm-report.md):
//   GOOGLE_SERVICE_ACCOUNT_EMAIL   the service account's email
//   GOOGLE_SERVICE_ACCOUNT_KEY     the private key (PEM, with \n escaped)
//   FM_ORDERS_SHEET_ID             the spreadsheet ID from its URL
//   FM_ORDERS_SHEET_RANGE          optional, defaults to "FM Orders!A:H"

import { google } from "googleapis";

export interface FmOrderRow {
  dealer: string;
  fm: string;
  fmTag: string;
  cycle: number;
  newQuota: number;
  prevBalance: number;
  orderDate: string; // YYYY-MM-DD
  active: boolean;
}

function getAuth() {
  // Use FM_-prefixed vars to avoid clashing with any existing Google Sheets
  // integration in this project. Fall back to the unprefixed names only if
  // the FM_-prefixed ones aren't set (so an existing setup still works).
  const email =
    process.env.FM_GOOGLE_SERVICE_ACCOUNT_EMAIL ||
    process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const rawKey =
    process.env.FM_GOOGLE_SERVICE_ACCOUNT_KEY ||
    process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!email || !rawKey) {
    throw new Error(
      "Missing FM_GOOGLE_SERVICE_ACCOUNT_EMAIL or FM_GOOGLE_SERVICE_ACCOUNT_KEY env vars."
    );
  }
  // Private keys stored in env vars have their newlines escaped as \n.
  const key = rawKey.replace(/\\n/g, "\n");
  return new google.auth.JWT({
    email,
    key,
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });
}

function toNum(v: any): number {
  const n = Number(String(v ?? "").replace(/[^0-9.\-]/g, ""));
  return isNaN(n) ? 0 : n;
}

function toBool(v: any): boolean {
  const s = String(v ?? "").trim().toLowerCase();
  return s === "true" || s === "yes" || s === "1" || s === "y";
}

/**
 * Reads all rows from the FM Orders sheet. Expects a header row; maps columns
 * by position: Dealer, FM, FM Tag, Cycle, New Order Quota, Prev Balance,
 * Order Date, Active.
 */
export async function readFmOrders(): Promise<FmOrderRow[]> {
  const sheetId = process.env.FM_ORDERS_SHEET_ID;
  if (!sheetId) throw new Error("Missing FM_ORDERS_SHEET_ID env var.");
  const range = process.env.FM_ORDERS_SHEET_RANGE || "FM Orders!A:H";

  const auth = getAuth();
  const sheets = google.sheets({ version: "v4", auth });
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range,
  });

  const rows = res.data.values ?? [];
  if (rows.length < 2) return []; // header only or empty

  // Skip the header row.
  const dataRows = rows.slice(1);
  const out: FmOrderRow[] = [];
  for (const r of dataRows) {
    const dealer = String(r[0] ?? "").trim();
    const fm = String(r[1] ?? "").trim();
    if (!dealer || !fm) continue; // skip blank rows
    out.push({
      dealer,
      fm,
      fmTag: String(r[2] ?? "").trim(),
      cycle: toNum(r[3]),
      newQuota: toNum(r[4]),
      prevBalance: toNum(r[5]),
      orderDate: String(r[6] ?? "").trim(),
      active: toBool(r[7]),
    });
  }
  return out;
}

/** Groups sheet rows by dealer, returning FM rows for that dealer. */
export function ordersForDealer(rows: FmOrderRow[], dealer: string): FmOrderRow[] {
  const norm = (s: string) => s.trim().toLowerCase();
  return rows.filter((r) => norm(r.dealer) === norm(dealer));
}
