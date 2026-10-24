// Cloudflare Pages Function — 云端同步（唯一后端，2026-10-24 已切断 Netlify 反向代理）
// 直连 Upstash Redis：凭据在 CF Pages 环境变量 UPSTASH_REST_URL / UPSTASH_REST_TOKEN
// 接口契约：GET /api/sync?key=xxx  取整份快照；GET ?meta=1 只取版本号；POST 写入
// ⚠️ 这里不再有"没有 env 就转发到 Netlify"的回退分支 —— Netlify 站点与函数已于 2026-10-24 下线。

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  };
}

async function upstashDirect(request, up) {
  const incoming = new URL(request.url);
  const key = incoming.searchParams.get('key') || 'school_demo_2026';
  const wantMeta = incoming.searchParams.get('meta') === '1';
  const verKey = key + ':ver';
  const H = { Authorization: `Bearer ${up.token}` };

  // 版本号探测：只回 updatedAt（几十字节），前端没变化就不拉全量
  if (wantMeta && request.method !== 'POST') {
    try {
      let ver = '';
      const res = await fetch(`${up.url}/get/${encodeURIComponent(verKey)}`, { headers: H });
      if (res.ok) {
        const j = await res.json();
        ver = (j && j.result) || '';
      }
      // 老数据没有 ver → 读一次全量补上（仅一次）
      if (!ver) {
        const full = await fetch(`${up.url}/get/${encodeURIComponent(key)}`, { headers: H });
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
      return new Response(JSON.stringify({ v: String(ver || '') }), {
        status: 200,
        headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
      });
    } catch (e) {
      return new Response(JSON.stringify({ v: '' }), {
        status: 200,
        headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
      });
    }
  }

  if (request.method === 'POST') {
    const data = await request.json();
    // value 放请求体（POST /set/{key} + body），避免 URL 路径超长触发 Upstash 431
    const res = await fetch(`${up.url}/set/${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${up.token}`, 'Content-Type': 'text/plain' },
      body: JSON.stringify(data),
    });
    if (!res.ok) throw new Error(`upstash set failed: ${res.status}`);
    const ver = String((data && data.updatedAt) || Date.now());
    await fetch(`${up.url}/set/${encodeURIComponent(verKey)}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${up.token}`, 'Content-Type': 'text/plain' },
      body: ver,
    });
    return new Response(JSON.stringify({ success: true, updatedAt: ver }), {
      status: 200,
      headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
    });
  }

  const res = await fetch(`${up.url}/get/${encodeURIComponent(key)}`, { headers: H });
  if (!res.ok) return new Response('{}', { status: 200, headers: corsHeaders() });
  const j = await res.json();
  if (!j || !j.result) return new Response('{}', { status: 200, headers: corsHeaders() });
  let payload = j.result;
  try {
    payload = JSON.parse(j.result);
  } catch (e) {
    /* result 本身就是对象 */
  }
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
  });
}

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method === 'OPTIONS') {
    return new Response('', { status: 200, headers: corsHeaders() });
  }
  const url = env && env.UPSTASH_REST_URL;
  const token = env && env.UPSTASH_REST_TOKEN;
  if (!url || !token) {
    // 配错了要一眼看出来，别再静默退化成内存/转发（那个坑 2026-09 踩过）
    return new Response(JSON.stringify({
      error: 'UPSTASH_REST_URL / UPSTASH_REST_TOKEN 未配置',
      hint: 'Cloudflare Pages → lesson-mate → Settings → Environment variables',
    }), { status: 500, headers: { ...corsHeaders(), 'Content-Type': 'application/json' } });
  }
  try {
    return await upstashDirect(request, { url: String(url).replace(/\/+$/, ''), token });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
    });
  }
}
