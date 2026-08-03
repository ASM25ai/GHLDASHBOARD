// Debug endpoint — shows raw contact data from a sub-account
// Hit: /api/debug-subaccount?secret=...&dealer=0 (index in DEALER_SUBACCOUNTS)

const { loadSubAccountConfigs, searchContactsByTag } = require('../lib/ghl-subaccounts');

module.exports = async (req, res) => {
  try {
    const configs = loadSubAccountConfigs();
    if (!configs.length) {
      return res.status(200).json({ error: 'No DEALER_SUBACCOUNTS configured' });
    }

    const idx = parseInt(req.query.dealer || '0', 10);
    const config = configs[idx] || configs[0];
    const { locationId, apiKey, deliveredTag = 'qualified', fmTagMap = {} } = config;

    const GHL_BASE = 'https://services.leadconnectorhq.com';
    const body = {
      locationId,
      page: 1,
      pageLimit: 5,
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

    const samples = contacts.map((c) => ({
      name: `${c.firstName || ''} ${c.lastName || ''}`.trim(),
      tags: c.tags,
      assignedTo: c.assignedTo,
      dateCreated: c.dateCreated,
      dateAdded: c.dateAdded,
      customFields: c.customFields,
    }));

    const allTags = new Set();
    for (const c of contacts) {
      for (const t of (c.tags || [])) allTags.add(t);
    }

    // Also fetch the custom field definitions to find field IDs
    let customFieldDefs = [];
    try {
      const cfRes = await fetch(`${GHL_BASE}/locations/${locationId}/customFields`, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Version: '2021-07-28',
          'Content-Type': 'application/json',
        },
      });
      const cfData = await cfRes.json();
      customFieldDefs = (cfData.customFields || []).map((f) => ({
        id: f.id,
        name: f.name,
        fieldKey: f.fieldKey,
        dataType: f.dataType,
      }));
    } catch (err) {
      customFieldDefs = [{ error: err.message }];
    }

    return res.status(200).json({
      dealer: config.name,
      locationId: config.locationId,
      fmTagMapFromEnv: fmTagMap,
      splitFieldFromEnv: config.splitField || null,
      splitFieldIdFromEnv: config.splitFieldId || null,
      totalContacts: data.total || contacts.length,
      sampleContacts: samples,
      uniqueTagsInSample: [...allTags].sort(),
      customFieldDefinitions: customFieldDefs,
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
