// Cloudflare Pages Function — 云端同步（唯一真源）
// 阶段一（当前）：反向代理到 Netlify 的同名函数（Upstash 凭据留在 Netlify 环境变量里，零迁移）
// 阶段二（可选）：拿到 UPSTASH_REST_URL / UPSTASH_REST_TOKEN 环境变量后直连 Upstash
// 接口契约与 Netlify 版完全一致：GET/POST /api/sync?key=xxx

const UPSTREAM = 'https://lesson-mate.netlify.app/.netlify/functions/sync';

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  };
}

async function proxyToUpstash(request, env) {
  // 阶段二：配置了 Upstash 凭据时直连
  const url = env.UPSTASH_REST_URL;
  const token = env.UPSTASH_REST_TOKEN;
  if (url && token) {
    return upstashDirect(request, { url: url.replace(/\/+$/, ''), token });
  }
  // 阶段一：转发给 Netlify（保持 query）
  const incoming = new URL(request.url);
  const target = UPSTREAM + incoming.search;
  const init = {
    method: request.method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (request.method === 'POST') init.body = await request.text();
  const res = await fetch(target, init);
  return new Response(await res.text(), {
    status: res.status,
    headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
  });
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
  const { request } = context;
  if (request.method === 'OPTIONS') {
    return new Response('', { status: 200, headers: corsHeaders() });
  }
  try {
    return await proxyToUpstash(request, context.env);
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
    });
  }
}
