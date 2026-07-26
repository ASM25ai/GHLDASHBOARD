// lib/timezone.js — All date operations in Eastern Time (America/Toronto)
//
// Vercel runs in UTC. GHL stores dates in the location's timezone (EDT/EST).
// This module ensures all date math uses Eastern Time so daily bucketing,
// "today" logic, and month boundaries align with the CRM.

const TZ = 'America/Toronto';

// Get "now" in Eastern Time as a Date object.
// The Date object's UTC fields will actually hold ET values — this is
// intentional so getFullYear/getMonth/getDate return ET values.
function nowET() {
  const utcNow = new Date();
  const etStr = utcNow.toLocaleString('en-US', { timeZone: TZ });
  return new Date(etStr);
}

// Get the start of the current month in ET
function monthStartET() {
  const n = nowET();
  return new Date(n.getFullYear(), n.getMonth(), 1);
}

// Format a date as YYYY-MM-DD using its local (ET) values
function dateKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Month label like "July 2026"
function monthLabel(d) {
  return d.toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: TZ });
}

// Parse a date value (from GHL custom field) and return it as an ET Date.
// GHL stores dates in the location's timezone already, so we just parse.
function parseDate(value) {
  if (!value) return null;
  const d = new Date(value);
  if (isNaN(d.getTime())) return null;
  // Convert to ET
  const etStr = d.toLocaleString('en-US', { timeZone: TZ });
  return new Date(etStr);
}

// Check if two dates are the same calendar day in ET
function isSameDay(a, b) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth()    === b.getMonth()    &&
    a.getDate()     === b.getDate()
  );
}

module.exports = {
  TZ,
  nowET,
  monthStartET,
  dateKey,
  monthLabel,
  parseDate,
  isSameDay,
};
