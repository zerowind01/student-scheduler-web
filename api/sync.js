// Vercel Serverless Function — 云端同步（与 netlify/functions/sync.js 保持同一逻辑）
// 有 UPSTASH_REST_URL / UPSTASH_REST_TOKEN 环境变量时：代理到 Upstash Redis（持久化）
// 没有时：退化为内存存储（仅本地开发调试用）

let cloudMemoryStore = {};

function upstashConf() {
  const url = process.env.UPSTASH_REST_URL;
  const token = process.env.UPSTASH_REST_TOKEN;
  if (!url || !token) return null;
  return { url: url.replace(/\/+$/, ''), token };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const syncKey = req.query.key || 'school_demo_2026';
  const up = upstashConf();

  try {
    if (req.method === 'POST') {
      const data = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;

      if (up) {
        const r = await fetch(
          `${up.url}/set/${encodeURIComponent(syncKey)}/${encodeURIComponent(JSON.stringify(data))}`,
          { headers: { Authorization: `Bearer ${up.token}` } }
        );
        if (!r.ok) throw new Error(`upstash set failed: ${r.status}`);
      } else {
        cloudMemoryStore[syncKey] = data;
      }
      return res.status(200).json({
        success: true,
        updatedAt: data ? data.updatedAt : Date.now(),
      });
    }

    // GET
    if (up) {
      const r = await fetch(`${up.url}/get/${encodeURIComponent(syncKey)}`, {
        headers: { Authorization: `Bearer ${up.token}` },
      });
      if (!r.ok) return res.status(200).json({});
      const j = await r.json();
      if (!j || !j.result) return res.status(200).json({});
      let payload = j.result;
      try {
        payload = JSON.parse(j.result);
      } catch (e) {
        /* result 本身就是对象 */
      }
      return res.status(200).json(payload);
    }

    return res.status(200).json(cloudMemoryStore[syncKey] || {});
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
