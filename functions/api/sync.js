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
  const H = { Authorization: `Bearer ${up.token}` };

  if (request.method === 'POST') {
    const data = await request.json();
    const res = await fetch(
      `${up.url}/set/${encodeURIComponent(key)}/${encodeURIComponent(JSON.stringify(data))}`,
      { headers: H }
    );
    if (!res.ok) throw new Error(`upstash set failed: ${res.status}`);
    return new Response(
      JSON.stringify({ success: true, updatedAt: data ? data.updatedAt : Date.now() }),
      { status: 200, headers: { ...corsHeaders(), 'Content-Type': 'application/json' } }
    );
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
