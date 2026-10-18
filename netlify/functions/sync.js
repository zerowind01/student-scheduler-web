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

  const qs = event.queryStringParameters || {};
  const key = qs.key || 'school_demo_2026';
  const wantMeta = qs.meta === '1';
  const verKey = key + ':ver';
  const up = upstashConf();

  // ---- 版本号探测（GET ?meta=1）----
  // 前端每 15 秒只问这一句（几十字节），远端没变就不拉全量。
  // 旧版前端每 2 秒 GET 整份快照（含历史流水近 300 KB）→ 单标签页 ≈ 490 MB/小时，
  // 2026-10 就是这样把 Upstash 免费额度 10 GB/月 打满并停库的。
  if (wantMeta && event.httpMethod !== 'POST') {
    try {
      let ver = '';
      if (up) {
        const res = await fetch(`${up.url}/get/${encodeURIComponent(verKey)}`, {
          headers: { Authorization: `Bearer ${up.token}` },
        });
        if (res.ok) {
          const j = await res.json();
          ver = (j && j.result) || '';
        }
        // 自愈：老数据只有快照、没有 ver → 读一次全量取出 updatedAt 再把 ver 补上（仅发生一次）
        if (!ver) {
          const full = await fetch(`${up.url}/get/${encodeURIComponent(key)}`, {
            headers: { Authorization: `Bearer ${up.token}` },
          });
          if (full.ok) {
            const fj = await full.json();
            let payload = fj && fj.result;
            try {
              payload = typeof payload === 'string' ? JSON.parse(payload) : payload;
            } catch (e) {}
            if (payload && payload.updatedAt) {
              ver = String(payload.updatedAt);
              await fetch(`${up.url}/set/${encodeURIComponent(verKey)}`, {
                method: 'POST',
                headers: { Authorization: `Bearer ${up.token}`, 'Content-Type': 'text/plain' },
                body: ver,
              });
            }
          }
        }
      } else {
        ver = memoryStore[verKey] || '';
      }
      return { statusCode: 200, headers, body: JSON.stringify({ v: String(ver || '') }) };
    } catch (e) {
      // 探测失败按「没变化」处理，别把错误抛给轮询
      return { statusCode: 200, headers, body: JSON.stringify({ v: '' }) };
    }
  }

  try {
    // ---- 写入 ----
    if (event.httpMethod === 'POST') {
      const data =
        typeof event.body === 'string' ? JSON.parse(event.body) : event.body;

      if (up) {
        // value 放请求体（POST /set/{key} + body），避免 URL 路径超长触发 Upstash 431
        const res = await fetch(`${up.url}/set/${encodeURIComponent(key)}`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${up.token}`, 'Content-Type': 'text/plain' },
          body: JSON.stringify(data),
        });
        if (!res.ok) throw new Error(`upstash set failed: ${res.status}`);
        // 每次写入同步刷新版本号（几十字节），供 ?meta=1 探测
        const ver = String((data && data.updatedAt) || Date.now());
        await fetch(`${up.url}/set/${encodeURIComponent(verKey)}`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${up.token}`, 'Content-Type': 'text/plain' },
          body: ver,
        });
      } else {
        memoryStore[key] = data;
        memoryStore[verKey] = String((data && data.updatedAt) || Date.now());
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
