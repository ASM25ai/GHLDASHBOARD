// lib/reps.js
//
// Maps the GHL sales_rep field value (what your team types in GHL)
// to the corresponding Hubstaff user ID and display name.
//
// Keys must exactly match what appears in the {{contact.sales_rep}}
// field in GHL after normalization (trimmed, as-is).
// Hubstaff user IDs come from the member URLs in your org:
//   app.hubstaff.com/organizations/677673/members/<ID>

module.exports = {
  'Jess': {
    hubstaffId: 2627985,
    displayName: 'Jess Arrojo',
  },
  'Marsha': {
    hubstaffId: 3326074,
    displayName: 'Marshaliza Delfin',
  },
  'Jan': {
    hubstaffId: 4018777,
    displayName: 'Jann Armalyn Frias',
  },
  'Rea': {
    hubstaffId: 2570305,
    displayName: 'Rea Magtalas',
  },
};
