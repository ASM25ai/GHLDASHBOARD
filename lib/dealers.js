// Edit this list to exactly match the values stored in the {{contact.dealership}}
// custom field in GHL (case-sensitive). Any qualified lead whose Dealer value
// isn't in this list will still appear in the monthly "Qualified Leads - <Month>"
// tab (so you never lose data), but will be excluded from "MTD Summary" and
// "Daily Breakdown". Each sync run reports any unmapped values it saw — add
// them here if you see them show up.

module.exports = [
  'Absolute Approval',
  'South Trail Kia',
  'Eastside Kia',
  'CHC',
  'CHF',
  'REV',
  'Leduc',
];
