// Netlify Serverless Function — 云端同步（唯一真源）
// 有 UPSTASH_REST_URL / UPSTASH_REST_TOKEN 环境变量时：代理到 Upstash Redis（持久化，跨设备实时同步）
// 没有时：退化为内存存储（仅本地开发调试用，函数实例之间不共享！）

const memoryStore = {};

function upstashConf() {
  const url = process.env.UPSTASH_REST_URL;
  const token = process.env.UPSTASH_REST_TOKEN;
  if (!url || !token) return null;
  return { url: url.replace(/\/+$/, ''), token };
}

exports.handler = async function (event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  const key =
    (event.queryStringParameters && event.queryStringParameters.key) ||
    'school_demo_2026';
  const up = upstashConf();

  try {
    // ---- 写入 ----
    if (event.httpMethod === 'POST') {
      const data =
        typeof event.body === 'string' ? JSON.parse(event.body) : event.body;

      if (up) {
        const res = await fetch(
          `${up.url}/set/${encodeURIComponent(key)}/${encodeURIComponent(JSON.stringify(data))}`,
          { headers: { Authorization: `Bearer ${up.token}` } }
        );
        if (!res.ok) throw new Error(`upstash set failed: ${res.status}`);
      } else {
        memoryStore[key] = data;
      }
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          success: true,
          updatedAt: data ? data.updatedAt : Date.now(),
        }),
      };
    }

    // ---- 读取 ----
    if (up) {
      const res = await fetch(`${up.url}/get/${encodeURIComponent(key)}`, {
        headers: { Authorization: `Bearer ${up.token}` },
      });
      if (!res.ok) {
        return { statusCode: 200, headers, body: '{}' };
      }
      const j = await res.json();
      if (!j || !j.result) {
        return { statusCode: 200, headers, body: '{}' };
      }
      let payload = j.result;
      try {
        payload = JSON.parse(j.result);
      } catch (e) {
        /* result 本身就是对象 */
      }
      return { statusCode: 200, headers, body: JSON.stringify(payload) };
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(memoryStore[key] || {}),
    };
  } catch (e) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: e.message }),
    };
  }
};
