// Vercel Serverless Real-time Cloud Sync API
let cloudMemoryStore = {};

export default async function handler(req, res) {
  // 设置 CORS 跨域允许，保证手机与电脑随时互通
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const syncKey = req.query.key || 'school_demo_2026';

  if (req.method === 'POST') {
    const data = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    cloudMemoryStore[syncKey] = data;
    return res.status(200).json({ success: true, updatedAt: data ? data.updatedAt : Date.now() });
  } else {
    return res.status(200).json(cloudMemoryStore[syncKey] || {});
  }
}
