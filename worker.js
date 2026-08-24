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
 *   FEISHU_APP_TOKEN_FINANCE 独立财务多维表格 App Token
 *   FEISHU_TABLE_ID_FINANCE_TRANSACTIONS 资金流水表 ID
 *   FEISHU_TABLE_ID_FINANCE_INVOICES 发票表 ID
 *   FEISHU_TABLE_ID_FINANCE_ALLOCATIONS 发票分摊表 ID
 *   FEISHU_TABLE_ID_FINANCE_PERIODS 会计期间表 ID
 *   FEISHU_TABLE_ID_FINANCE_AUDIT 财务审计日志表 ID
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

function financeConfig(env) {
  return {
    appToken: env.FEISHU_APP_TOKEN_FINANCE,
    transactions: env.FEISHU_TABLE_ID_FINANCE_TRANSACTIONS,
    invoices: env.FEISHU_TABLE_ID_FINANCE_INVOICES,
    allocations: env.FEISHU_TABLE_ID_FINANCE_ALLOCATIONS,
    periods: env.FEISHU_TABLE_ID_FINANCE_PERIODS,
    audit: env.FEISHU_TABLE_ID_FINANCE_AUDIT,
  };
}

function requireFinanceConfig(env) {
  const config = financeConfig(env);
  const missing = Object.entries(config).filter(([, value]) => !value).map(([key]) => key);
  return missing.length ? { error: `财务数据库尚未完成配置：${missing.join(', ')}` } : config;
}

async function fetchAllFinanceRecords(env, token, tableId) {
  const records = [];
  let pageToken = '';
  do {
    const query = new URLSearchParams({ page_size: '500' });
    if (pageToken) query.set('page_token', pageToken);
    const url = `${FEISHU}/bitable/v1/apps/${env.FEISHU_APP_TOKEN_FINANCE}/tables/${tableId}/records?${query}`;
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const result = await response.json();
    if (!response.ok || result.code) throw new Error(result.msg || `飞书读取失败（${response.status}）`);
    records.push(...(result.data?.items || []));
    pageToken = result.data?.has_more ? result.data?.page_token || '' : '';
  } while (pageToken);
  return records;
}

async function batchCreateFinanceRecords(env, token, tableId, fieldsList) {
  let created = 0;
  for (let index = 0; index < fieldsList.length; index += 500) {
    const records = fieldsList.slice(index, index + 500).map(fields => ({ fields }));
    const url = `${FEISHU}/bitable/v1/apps/${env.FEISHU_APP_TOKEN_FINANCE}/tables/${tableId}/records/batch_create`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ records }),
    });
    const result = await response.json();
    if (!response.ok || result.code) throw new Error(result.msg || `飞书写入失败（${response.status}）`);
    created += result.data?.records?.length || records.length;
  }
  return created;
}

async function batchUpdateFinanceRecords(env, token, tableId, recordsList) {
  let updated = 0;
  for (let index = 0; index < recordsList.length; index += 500) {
    const records = recordsList.slice(index, index + 500);
    const url = `${FEISHU}/bitable/v1/apps/${env.FEISHU_APP_TOKEN_FINANCE}/tables/${tableId}/records/batch_update`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ records }),
    });
    const result = await response.json();
    if (!response.ok || result.code) throw new Error(result.msg || `飞书更新失败（${response.status}）`);
    updated += result.data?.records?.length || records.length;
  }
  return updated;
}

function dateValue(value) {
  if (!value) return null;
  if (typeof value === 'number') return new Date(value + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function transactionToFields(item, now, includeCreatedAt = true) {
  const fields = {
    '流水号': String(item.id || ''),
    '日期': Date.parse(`${item.date}T00:00:00+08:00`),
    '方向': item.direction,
    '资金性质': item.nature || '',
    '类目': item.category || '',
    '代码': String(item.allocationCode ?? 1),
    '对方单位': item.party || '',
    '关联订单': item.order || '',
    '备注': item.memo || '',
    '含税金额': Number(item.gross || 0) / 100,
    '税率': Number(item.rate || 0),
    '可抵扣税额': Number(item.tax || 0) / 100,
    '发票状态': item.invoiceStatus || '',
    '状态': item.status || '',
    '经办人': item.handler || '',
    '更新时间': now,
    '导入批次': item.importBatchId || '',
  };
  if (includeCreatedAt) fields['创建时间'] = now;
  return fields;
}

function invoiceToFields(item) {
  return {
    '发票号码': String(item.number || ''),
    '方向': item.direction || '',
    '发票类型': item.type || '',
    '开票日期': Date.parse(`${item.date}T00:00:00+08:00`),
    '对方单位': item.party || '',
    '不含税金额': Number(item.net || 0) / 100,
    '税率': Number(item.rate || 0),
    '税额': Number(item.tax || 0) / 100,
    '价税合计': Number(item.gross || 0) / 100,
    '抵扣状态': item.deductible || '',
    '状态': item.status || '',
    '关联流水号': item.transactionId || '',
    '导入批次': item.importBatchId || '',
  };
}

function transactionFromFields(record) {
  const f = record.fields || {};
  return {
    id: String(f['流水号'] || ''), date: dateValue(f['日期']), direction: f['方向'] || '',
    nature: f['资金性质'] || '', category: f['类目'] || '', allocationCode: Number(f['代码']) === 0 ? 0 : 1,
    party: f['对方单位'] || '', order: f['关联订单'] || '', memo: f['备注'] || '',
    gross: Math.round(Number(f['含税金额'] || 0) * 100), rate: Number(f['税率'] || 0),
    tax: Math.round(Number(f['可抵扣税额'] || 0) * 100), invoiceStatus: f['发票状态'] || '',
    status: f['状态'] || '', handler: f['经办人'] || '', importBatchId: f['导入批次'] || '',
    feishuRecordId: record.record_id,
  };
}

function invoiceFromFields(record) {
  const f = record.fields || {};
  return {
    number: String(f['发票号码'] || ''), direction: f['方向'] || '', type: f['发票类型'] || '',
    date: dateValue(f['开票日期']), party: f['对方单位'] || '',
    net: Math.round(Number(f['不含税金额'] || 0) * 100), rate: Number(f['税率'] || 0),
    tax: Math.round(Number(f['税额'] || 0) * 100), gross: Math.round(Number(f['价税合计'] || 0) * 100),
    deductible: f['抵扣状态'] || '', status: f['状态'] || '', transactionId: f['关联流水号'] || '',
    importBatchId: f['导入批次'] || '', feishuRecordId: record.record_id,
  };
}

async function handleFinanceState(request, env, actor) {
  const config = requireFinanceConfig(env);
  if (config.error) return json({ error: config.error }, 503);
  const token = await getTenantToken(env);

  if (request.method === 'GET') {
    const [transactions, invoices] = await Promise.all([
      fetchAllFinanceRecords(env, token, config.transactions),
      fetchAllFinanceRecords(env, token, config.invoices),
    ]);
    return json({
      transactions: transactions.map(transactionFromFields).filter(item => item.id),
      invoices: invoices.map(invoiceFromFields).filter(item => item.number),
    });
  }

  if (request.method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const transactions = Array.isArray(body.transactions) ? body.transactions : [];
    const invoices = Array.isArray(body.invoices) ? body.invoices : [];
    if (transactions.length > 10000 || invoices.length > 20000) return json({ error: '同步数据量超出限制' }, 413);

    const [existingTransactions, existingInvoices] = await Promise.all([
      fetchAllFinanceRecords(env, token, config.transactions),
      fetchAllFinanceRecords(env, token, config.invoices),
    ]);
    const transactionRecords = new Map(existingTransactions.map(record => [String(record.fields?.['流水号'] || ''), record.record_id]));
    const invoiceRecords = new Map(existingInvoices.map(record => [String(record.fields?.['发票号码'] || ''), record.record_id]));
    const now = Date.now();
    const newTransactions = transactions.filter(item => item?.id && !transactionRecords.has(String(item.id)));
    const changedTransactions = transactions.filter(item => item?.id && transactionRecords.has(String(item.id)));
    const newInvoices = invoices.filter(item => item?.number && !invoiceRecords.has(String(item.number)));
    const changedInvoices = invoices.filter(item => item?.number && invoiceRecords.has(String(item.number)));
    const createdTransactions = await batchCreateFinanceRecords(env, token, config.transactions, newTransactions.map(item => transactionToFields(item, now)));
    const createdInvoices = await batchCreateFinanceRecords(env, token, config.invoices, newInvoices.map(invoiceToFields));
    const updatedTransactions = await batchUpdateFinanceRecords(env, token, config.transactions, changedTransactions.map(item => ({ record_id: transactionRecords.get(String(item.id)), fields: transactionToFields(item, now, false) })));
    const updatedInvoices = await batchUpdateFinanceRecords(env, token, config.invoices, changedInvoices.map(item => ({ record_id: invoiceRecords.get(String(item.number)), fields: invoiceToFields(item) })));

    await batchCreateFinanceRecords(env, token, config.audit, [{
      '日志编号': `AUD${now}`,
      '操作时间': now,
      '操作人': actor,
      '操作类型': '同步新增/更新',
      '数据类型': '财务本地数据',
      '数据编号': body.batchId || '',
      '修改前': '',
      '修改后': JSON.stringify({ createdTransactions, createdInvoices, updatedTransactions, updatedInvoices }),
      '请求编号': request.headers.get('cf-ray') || crypto.randomUUID(),
    }]);
    return json({ ok: true, createdTransactions, createdInvoices, updatedTransactions, updatedInvoices });
  }

  return json({ error: 'method not allowed' }, 405);
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

    // 独立财务数据库接口（需要 JWT）
    if (pathname === '/api/finance/state') {
      const auth = request.headers.get('Authorization') || '';
      const jwt = auth.startsWith('Bearer ') ? auth.slice(7) : '';
      const user = await verifyJWT(jwt, env.JWT_SECRET);
      if (!user) return json({ error: '未登录或登录已过期，请重新登录' }, 401);
      try {
        return await handleFinanceState(request, env, user.sub || 'unknown');
      } catch (error) {
        return json({ error: error.message || '财务数据库操作失败' }, 502);
      }
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
