// lib/aliases.js
//
// Alias maps now live in the Settings tab in Google Sheets — not in code.
// This file just exports the runtime utility functions that apply those maps.
// No hardcoded values here means you never need to touch code or redeploy
// just to add a new alias or FM name.

/**
 * Normalizes a raw dealer value from GHL to its canonical name.
 * The aliasMap comes from readSettings() which reads the Settings tab.
 * Matching is case-insensitive and whitespace-trimmed.
 *
 * @param {string} raw       - raw value from GHL's dealership field
 * @param {object} aliasMap  - { 'lowercased alias': 'Canonical Dealer Name' }
 * @returns {string}
 */
function normalizeDealer(raw, aliasMap) {
  if (!raw || typeof raw !== 'string') return '';
  const trimmed = raw.trim();
  return aliasMap[trimmed.toLowerCase()] ?? trimmed;
}

/**
 * Normalizes a raw FM value from GHL against a dealer's defined FM list.
 * Case-insensitive match. Returns 'Unassigned' if blank or not found.
 *
 * @param {string} raw      - raw value from GHL's fm field
 * @param {Array}  fmList   - [{ name: 'Ali Adnan', target: 50 }, ...]
 * @returns {string}
 */
function normalizeFMForDealer(raw, fmList) {
  if (!raw || !raw.trim()) return 'Unassigned';
  const lower = raw.trim().toLowerCase();
  for (const fm of fmList) {
    if (fm.name.trim().toLowerCase() === lower) return fm.name;
  }
  return 'Unassigned';
}

/**
 * Trims a raw sales rep value. No alias map needed for reps for now —
 * add one here if spelling variants become a problem.
 */
function normalizeSalesRep(raw) {
  if (!raw || typeof raw !== 'string') return '';
  return raw.trim();
}

module.exports = { normalizeDealer, normalizeFMForDealer, normalizeSalesRep };
