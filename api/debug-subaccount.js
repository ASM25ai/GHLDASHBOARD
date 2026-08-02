// Debug endpoint — shows raw contact tag data from a sub-account
// Hit: /api/debug-subaccount?secret=...
// Returns sample contacts with their tags so we can see why FM matching fails

const { loadSubAccountConfigs, searchContactsByTag } = require('../lib/ghl-subaccounts');

module.exports = async (req, res) => {
  try {
    const configs = loadSubAccountConfigs();
    if (!configs.length) {
      return res.status(200).json({ error: 'No DEALER_SUBACCOUNTS configured' });
    }

    const config = configs[0]; // Just check the first sub-account
    const { locationId, apiKey, deliveredTag = 'qualified', fmTagMap = {} } = config;

    // Fetch first page of qualified contacts
    const GHL_BASE = 'https://services.leadconnectorhq.com';
    const body = {
      locationId,
      page: 1,
      pageLimit: 5, // Just 5 contacts for debugging
      filters: [
        { field: 'tags', operator: 'contains', value: deliveredTag },
      ],
    };

    const response = await fetch(`${GHL_BASE}/contacts/search`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Version: '2021-07-28',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    const data = await response.json();
    const contacts = data.contacts || [];

    // Show raw tag data for each contact
    const samples = contacts.map((c) => ({
      name: `${c.firstName || ''} ${c.lastName || ''}`.trim(),
      tags: c.tags,
      assignedTo: c.assignedTo,
      dateCreated: c.dateCreated,
      dateAdded: c.dateAdded,
    }));

    // Show all unique tags across these contacts
    const allTags = new Set();
    for (const c of contacts) {
      for (const t of (c.tags || [])) {
        allTags.add(t);
      }
    }

    return res.status(200).json({
      dealer: config.name,
      fmTagMapFromEnv: fmTagMap,
      totalContacts: data.total || contacts.length,
      sampleContacts: samples,
      uniqueTagsInSample: [...allTags].sort(),
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
