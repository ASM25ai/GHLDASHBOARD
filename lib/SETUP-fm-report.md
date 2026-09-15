# FM Cycle Report — Setup (Step 1: Google Sheet + service account)

This lets the dashboard read your "FM Orders" sheet live via a Google service
account. Do these once.

## 1. Create the Google Sheet

Create a new Google Sheet. Name the first tab exactly **FM Orders**. Put these
headers in row 1, columns A–H:

| A | B | C | D | E | F | G | H |
|---|---|---|---|---|---|---|---|
| Dealer | FM | FM Tag | Cycle | New Order Quota | Prev Balance | Order Date | Active |

Then one row per FM per cycle. Example (matching your mockup):

| Dealer | FM | FM Tag | Cycle | New Order Quota | Prev Balance | Order Date | Active |
|---|---|---|---|---|---|---|---|
| Absolute Approval | Jamie Pacaud | aa-jamie | 2 | 30 | 20 | 2026-06-01 | TRUE |
| Absolute Approval | Jesse | aa-jesse | 2 | 0 | -7 | 2026-06-01 | TRUE |
| Absolute Approval | Jeff Ouimet | aa-jeff | 2 | 30 | 8 | 2026-06-01 | TRUE |
| Absolute Approval | Dylan Sousa | aa-dylan | 2 | 30 | 7 | 2026-06-01 | TRUE |
| Absolute Approval | Raph | aa-raph | 2 | 30 | 10 | 2026-06-01 | TRUE |

Column meaning:
- **FM Tag** — the GHL tag used to count that FM's leads (e.g. `aa-jamie`).
- **New Order Quota** — this cycle's fresh order.
- **Prev Balance** — enter it exactly as in your mockup: **positive** when they
  had credit/were ahead (reduces remaining), **negative** when they were shorted
  (increases remaining). Remaining = New Quota − Prev Balance − Delivered.
- **Order Date** — delivered counts leads qualified on/after this date.
- **Active** — TRUE for the current cycle row (shown on the dashboard). Set old
  cycles to FALSE, but keep them — the all-time dropdown sums every row.

Get the **spreadsheet ID** from its URL:
`https://docs.google.com/spreadsheets/d/THIS_IS_THE_ID/edit`

## 2. Create a Google service account

1. Go to console.cloud.google.com → create a project (or reuse one).
2. APIs & Services → Library → enable **Google Sheets API**.
3. APIs & Services → Credentials → Create Credentials → **Service account**.
4. Name it (e.g. `fm-report-reader`), create, and open it.
5. Keys tab → Add Key → Create new key → **JSON** → download the file.

From that JSON file you need two values:
- `client_email` → this is `GOOGLE_SERVICE_ACCOUNT_EMAIL`
- `private_key` → this is `GOOGLE_SERVICE_ACCOUNT_KEY`

## 3. Share the sheet with the service account

Open your FM Orders sheet → Share → paste the service account's `client_email`
→ give it **Viewer** access. (The dashboard only reads.)

## 4. Add env vars in Vercel

Settings → Environment Variables (all environments):

| Key | Value |
|---|---|
| `FM_ORDERS_SHEET_ID` | the spreadsheet ID from the URL |
| `FM_GOOGLE_SERVICE_ACCOUNT_EMAIL` | the `client_email` |
| `FM_GOOGLE_SERVICE_ACCOUNT_KEY` | the `private_key` — paste the whole thing including `-----BEGIN…` and `-----END…`; keep the `\n` sequences as-is |
| `FM_ORDERS_SHEET_RANGE` | optional; defaults to `FM Orders!A:H` |

Note: these use an `FM_` prefix to avoid colliding with any existing Google
Sheets integration already in the project (which uses the unprefixed
`GOOGLE_SERVICE_ACCOUNT_*` names). The code also falls back to the unprefixed
names if the FM-prefixed ones aren't set.

Note on the key: when you paste the `private_key` value from the JSON, it
contains literal `\n` sequences. Paste it exactly as it appears in the JSON.
The code converts `\n` back into real newlines.

## 5. Add the package

The reader uses the official Google API client. Add to package.json dependencies:

```
"googleapis": "^144.0.0"
```

(or run `npm install googleapis`.) Commit package.json + lock file.

## Next

Once the sheet exists, the service account can read it, and the env vars are
set, tell me — I'll build Step 2 (the delivered/refund/remaining math per FM)
and wire it to the dealer dashboard, then the web + email report views.
