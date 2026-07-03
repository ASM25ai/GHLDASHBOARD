// api/debug-calls.js
//
// TEMPORARY diagnostic endpoint — visits one conversation with a call
// and dumps the raw GHL messages response so we can see the exact
// field structure. Delete this file once calls are working.
//
// Usage: https://your-app.vercel.app/api/debug-calls?secret=YOUR_CRON_SECRET

const GHL_BASE    = 'https://services.leadconnectorhq.com';
const GHL_VERSION = '2021-07-28';

async function ghlGet(path) {
  const res = await fetch(`${GHL_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${process.env.GHL_PRIVATE_TOKEN}`,
      Version: GHL_VERSION,
      'Content-Type': 'application/json',
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`GHL ${res.status} on ${path}: ${body}`);
  }
  return res.json();
}

module.exports = async (req, res) => {
  if (!req.query.secret || req.query.secret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const locationId = process.env.GHL_LOCATION_ID;

  try {
    // Get today's conversations (1 page only — fast)
    const now     = new Date();
    const todayMs = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();

    const params = new URLSearchParams({
      locationId,
      startAfterDate: String(todayMs),
      limit:          '100',
    });

    let data;
    try {
      data = await ghlGet(`/conversations/search?${params}`);
    } catch {
      data = await ghlGet(`/conversations/?${params}`);
    }

    const convs = Array.isArray(data.conversations) ? data.conversations
                : Array.isArray(data.data)          ? data.data
                : [];

    // Find a conversation whose last message is a call
    const callConv = convs.find(c =>
      String(c.lastMessageType || '').toLowerCase().includes('call')
    );

    // Summary of what types we see across today's conversations
    const typeCounts = {};
    for (const c of convs) {
      const t = c.lastMessageType || 'NONE';
      typeCounts[t] = (typeCounts[t] || 0) + 1;
    }

    if (!callConv) {
      return res.status(200).json({
        note: 'No conversation with a call lastMessageType found in the first 100 of today',
        convsChecked: convs.length,
        lastMessageTypeCounts: typeCounts,
      });
    }

    // Fetch this conversation's raw messages — the whole point
    const rawMessages = await ghlGet(`/conversations/${callConv.id}/messages?limit=10`);

    return res.status(200).json({
      convId:                callConv.id,
      convLastMessageType:   callConv.lastMessageType,
      convsChecked:          convs.length,
      lastMessageTypeCounts: typeCounts,
      RAW_MESSAGES_RESPONSE: rawMessages, // full untruncated structure
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
