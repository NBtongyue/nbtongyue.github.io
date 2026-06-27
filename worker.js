/**
 * Cloudflare Worker — 通跃检测内部系统 API
 *
 * 统一版本（合并了旧版 nbty-worker.js 的反向代理能力）
 *
 * 需要在 Cloudflare Dashboard 配置以下环境变量：
 *   FEISHU_APP_ID         飞书应用 ID
 *   FEISHU_APP_SECRET     飞书应用 Secret（重置后填新值）
 *   FEISHU_APP_TOKEN      多维表格 App Token
 *   FEISHU_TABLE_ID_CERT  证书订单表 ID
 *   FEISHU_TABLE_ID_LAB   实验室订单表 ID
 *   FEISHU_TABLE_ID_LEDGER 财务账本表 ID
 *   JWT_SECRET            任意随机字符串，用于签名登录令牌
 *   AUTH_USERS            JSON 字符串，例如：{"happy":"新密码","mindy":"新密码"}
 *   UPSTREAM             （可选）前端托管地址，默认 nbtongyue.github.io
 */

const FEISHU = 'https://open.feishu.cn/open-apis';

// ── JWT 工具 ──────────────────────────────────────────────────────────────────

function b64url(str) {
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function fromb64url(str) {
  return atob(str.replace(/-/g, '+').replace(/_/g, '/'));
}

async function signJWT(payload, secret) {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body   = b64url(JSON.stringify(payload));
  const data   = `${header}.${body}`;
  const key    = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  return `${data}.${b64url(String.fromCharCode(...new Uint8Array(sig)))}`;
}

async function verifyJWT(token, secret) {
  const parts = (token || '').split('.');
  if (parts.length !== 3) return null;
  const [header, payload, sig] = parts;
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']
  );
  const sigBytes = Uint8Array.from(fromb64url(sig), c => c.charCodeAt(0));
  const valid = await crypto.subtle.verify(
    'HMAC', key, sigBytes, new TextEncoder().encode(`${header}.${payload}`)
  );
  if (!valid) return null;
  const pl = JSON.parse(fromb64url(payload));
  if (pl.exp && Date.now() > pl.exp) return null;
  return pl;
}

// ── 响应工具 ──────────────────────────────────────────────────────────────────

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

// ── 飞书 tenant_access_token ──────────────────────────────────────────────────

async function getTenantToken(env) {
  const res = await fetch(`${FEISHU}/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: env.FEISHU_APP_ID, app_secret: env.FEISHU_APP_SECRET }),
  });
  const d = await res.json();
  return d.tenant_access_token;
}

// ── 多维表格增删改查 ───────────────────────────────────────────────────────────

async function handleTable(request, env, tableId) {
  const token  = await getTenantToken(env);
  const base   = `${FEISHU}/bitable/v1/apps/${env.FEISHU_APP_TOKEN}/tables/${tableId}/records`;
  const url    = new URL(request.url);
  const method = request.method;

  if (method === 'GET') {
    const pt = url.searchParams.get('page_token') || '';
    const r  = await fetch(`${base}?page_size=500${pt ? '&page_token=' + pt : ''}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return json(await r.json());
  }

  if (method === 'POST') {
    const body = await request.json();
    const r = await fetch(base, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return json(await r.json());
  }

  if (method === 'PATCH') {
    const { record_id, fields } = await request.json();
    const r = await fetch(`${base}/${record_id}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields }),
    });
    return json(await r.json());
  }

  if (method === 'DELETE') {
    const recordId = url.searchParams.get('record_id');
    const r = await fetch(`${base}/${recordId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    return json(await r.json());
  }

  return json({ error: 'not found' }, 404);
}

// ── 主入口 ────────────────────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    const url      = new URL(request.url);
    const { pathname } = url;
    const method   = request.method;

    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    // 登录接口（无需 JWT）
    if (pathname === '/api/login' && method === 'POST') {
      const { username, password } = await request.json().catch(() => ({}));
      const accounts = JSON.parse(env.AUTH_USERS || '{}');
      if (!username || !accounts[username] || accounts[username] !== password) {
        return json({ error: '用户名或密码错误' }, 401);
      }
      const token = await signJWT(
        { sub: username, exp: Date.now() + 8 * 60 * 60 * 1000 },
        env.JWT_SECRET
      );
      return json({ token, username });
    }

    // 数据接口（需要 JWT），兼容 /api/ 前缀
    if (pathname === '/records' || pathname === '/api/records' ||
        pathname === '/lab-records' || pathname === '/api/lab-records' ||
        pathname === '/ledger' || pathname === '/api/ledger') {
      const auth  = request.headers.get('Authorization') || '';
      const jwt   = auth.startsWith('Bearer ') ? auth.slice(7) : '';
      const user  = await verifyJWT(jwt, env.JWT_SECRET);
      if (!user) return json({ error: '未登录或登录已过期，请重新登录' }, 401);

      let tableId;
      if (pathname.includes('ledger')) {
        tableId = env.FEISHU_TABLE_ID_LEDGER;
      } else if (pathname.includes('lab')) {
        tableId = env.FEISHU_TABLE_ID_LAB;
      } else {
        tableId = env.FEISHU_TABLE_ID_CERT;
      }
      return handleTable(request, env, tableId);
    }

    // ── 其他路径：反向代理到前端托管（无需 JWT） ──
    const upstream = env.UPSTREAM || 'nbtongyue.github.io';
    const proxyUrl = `https://${upstream}${pathname}${url.search}`;
    const proxyHeaders = new Headers(request.headers);
    proxyHeaders.set('Host', upstream);
    ['cf-connecting-ip', 'cf-ipcountry', 'cf-ray', 'cf-visitor', 'x-forwarded-for'].forEach(h => proxyHeaders.delete(h));

    try {
      const proxyBody = method === 'GET' || method === 'HEAD' ? null : request.body;
      const upstreamResp = await fetch(proxyUrl, {
        method, headers: proxyHeaders, body: proxyBody, redirect: 'follow',
      });
      const outHeaders = new Headers(upstreamResp.headers);
      outHeaders.set('access-control-allow-origin', '*');
      outHeaders.delete('x-frame-options');
      outHeaders.delete('content-security-policy');
      return new Response(upstreamResp.body, {
        status: upstreamResp.status,
        statusText: upstreamResp.statusText,
        headers: outHeaders,
      });
    } catch (e) {
      return new Response(`Upstream error: ${e.message}`, { status: 502 });
    }
  },
};
