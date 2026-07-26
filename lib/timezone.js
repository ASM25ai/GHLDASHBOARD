// lib/timezone.js — All date operations in Eastern Time (America/Toronto)
//
// Vercel runs in UTC. GHL stores custom field dates as ms timestamps.
// This module provides two things:
// 1. ET-aware "now" and "monthStart" for display (dateKey, monthLabel)
// 2. Proper UTC timestamps for GHL API queries that correspond to ET boundaries

const TZ = 'America/Toronto';

// Get current date/time components in Eastern Time
function getETComponents() {
  const now = new Date();
  const parts = {};
  // Use Intl to get the ET components
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  });
  for (const p of fmt.formatToParts(now)) {
    if (p.type === 'year')   parts.year   = Number(p.value);
    if (p.type === 'month')  parts.month  = Number(p.value);
    if (p.type === 'day')    parts.day    = Number(p.value);
    if (p.type === 'hour')   parts.hour   = Number(p.value);
    if (p.type === 'minute') parts.minute = Number(p.value);
    if (p.type === 'second') parts.second = Number(p.value);
  }
  return parts;
}

// Get "now" in Eastern Time — returns a Date whose getFullYear/getMonth/getDate
// reflect ET values. Use for display only (dateKey, monthLabel, comparisons).
function nowET() {
  const p = getETComponents();
  return new Date(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
}

// Get start of current month in ET, as a Date for display
function monthStartET() {
  const p = getETComponents();
  return new Date(p.year, p.month - 1, 1);
}

// Get the real UTC ms timestamp for the start of today in ET.
// E.g., "July 26 00:00 ET" = "July 26 04:00 UTC" during EDT.
function todayStartUTCms() {
  const p = getETComponents();
  // Build an ISO string for midnight ET, then let Date parse it
  const isoDate = `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
  // Use Intl to find the UTC offset for this date
  const midnightET = new Date(`${isoDate}T00:00:00`);
  // This is in server local time (UTC on Vercel), so we need the ET offset
  const utcStr = new Date().toLocaleString('en-US', { timeZone: 'UTC' });
  const etStr  = new Date().toLocaleString('en-US', { timeZone: TZ });
  const offsetMs = new Date(utcStr).getTime() - new Date(etStr).getTime();
  // midnight ET in UTC = midnight + offset
  const d = new Date(p.year, p.month - 1, p.day);
  return d.getTime() + offsetMs;
}

// Get the real UTC ms timestamp for the start of the current month in ET
function monthStartUTCms() {
  const p = getETComponents();
  const utcStr = new Date().toLocaleString('en-US', { timeZone: 'UTC' });
  const etStr  = new Date().toLocaleString('en-US', { timeZone: TZ });
  const offsetMs = new Date(utcStr).getTime() - new Date(etStr).getTime();
  const d = new Date(p.year, p.month - 1, 1);
  return d.getTime() + offsetMs;
}

// Current time as UTC ms (just Date.now(), but named for clarity)
function nowUTCms() {
  return Date.now();
}

// Format a date as YYYY-MM-DD using its local values
function dateKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Month label like "July 2026"
function monthLabel(d) {
  return d.toLocaleString('en-US', { month: 'long', year: 'numeric' });
}

// Parse a date value (from GHL custom field) and return as an ET display Date.
function parseDate(value) {
  if (!value) return null;
  const d = new Date(value);
  if (isNaN(d.getTime())) return null;
  const etStr = d.toLocaleString('en-US', { timeZone: TZ });
  return new Date(etStr);
}

// Check if two dates are the same calendar day
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
  monthStartUTCms,
  nowUTCms,
  dateKey,
  monthLabel,
  parseDate,
  isSameDay,
};
