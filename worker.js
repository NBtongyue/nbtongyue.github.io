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
  try {
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
  } catch {
    return null;
  }
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
    '资金账户': item.account || '公司银行账户',
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
    party: f['对方单位'] || '', order: f['关联订单'] || '', account: f['资金账户'] || '公司银行账户', memo: f['备注'] || '',
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

function canonicalTransaction(item) {
  return [
    String(item.id || ''), item.date || '', item.direction || '', item.nature || '', item.category || '',
    Number(item.allocationCode) === 0 ? 0 : 1, item.party || '', item.order || '', item.account || '公司银行账户', item.memo || '',
    Number(item.gross || 0), Number(item.rate || 0), Number(item.tax || 0), item.invoiceStatus || '',
    item.status || '', item.handler || '', item.importBatchId || '',
  ];
}

function canonicalInvoice(item) {
  return [
    String(item.number || ''), item.direction || '', item.type || '', item.date || '', item.party || '',
    Number(item.net || 0), Number(item.rate || 0), Number(item.tax || 0), Number(item.gross || 0),
    item.deductible || '', item.status || '', item.transactionId || '', item.importBatchId || '',
  ];
}

async function financeRevision(transactions, invoices) {
  const snapshot = {
    transactions: transactions.map(canonicalTransaction).sort((a, b) => a[0].localeCompare(b[0])),
    invoices: invoices.map(canonicalInvoice).sort((a, b) => a[0].localeCompare(b[0])),
  };
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(snapshot)));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

function validText(value, maxLength = 500) {
  return value === undefined || value === null || (typeof value === 'string' && value.length <= maxLength);
}

function validateFinancePayload(transactions, invoices) {
  const transactionIds = new Set();
  for (const item of transactions) {
    if (!item || typeof item.id !== 'string' || !item.id || item.id.length > 80 || transactionIds.has(item.id)) return '资金流水编号无效或重复';
    transactionIds.add(item.id);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(item.date || '') || !['收入', '支出'].includes(item.direction)) return `资金流水 ${item.id} 的日期或方向无效`;
    if (![0, 1].includes(Number(item.allocationCode)) || ![0, 0.06, 0.13].includes(Number(item.rate))) return `资金流水 ${item.id} 的代码或税率无效`;
    if (!Number.isInteger(item.gross) || item.gross <= 0 || !Number.isInteger(item.tax) || item.tax < 0 || item.tax > item.gross) return `资金流水 ${item.id} 的金额无效`;
    if (![item.nature, item.category, item.party, item.order, item.account, item.memo, item.invoiceStatus, item.status, item.handler, item.importBatchId].every((value, index) => validText(value, index === 5 ? 2000 : 500))) return `资金流水 ${item.id} 的文本内容过长或格式无效`;
  }
  const invoiceNumbers = new Set();
  for (const item of invoices) {
    if (!item || typeof item.number !== 'string' || !item.number || item.number.length > 120 || invoiceNumbers.has(item.number)) return '发票号码无效或重复';
    invoiceNumbers.add(item.number);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(item.date || '') || !['进项', '销项'].includes(item.direction)) return `发票 ${item.number} 的日期或方向无效`;
    if (![0, 0.06, 0.13].includes(Number(item.rate))) return `发票 ${item.number} 的税率无效`;
    if (![item.net, item.tax, item.gross].every(value => Number.isInteger(value) && value >= 0) || item.tax > item.gross) return `发票 ${item.number} 的金额无效`;
    if (item.transactionId && !transactionIds.has(String(item.transactionId))) return `发票 ${item.number} 关联了不存在的流水`;
    if (![item.type, item.party, item.deductible, item.status, item.transactionId, item.importBatchId].every(value => validText(value))) return `发票 ${item.number} 的文本内容过长或格式无效`;
  }
  return '';
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
    const transactionItems = transactions.map(transactionFromFields).filter(item => item.id);
    const invoiceItems = invoices.map(invoiceFromFields).filter(item => item.number);
    return json({ transactions: transactionItems, invoices: invoiceItems, revision: await financeRevision(transactionItems, invoiceItems) });
  }

  if (request.method === 'POST') {
    const contentLength = Number(request.headers.get('content-length') || 0);
    if (contentLength > 5 * 1024 * 1024) return json({ error: '同步请求不能超过 5MB' }, 413);
    const body = await request.json().catch(() => ({}));
    const transactions = Array.isArray(body.transactions) ? body.transactions : [];
    const invoices = Array.isArray(body.invoices) ? body.invoices : [];
    if (transactions.length > 10000 || invoices.length > 20000) return json({ error: '同步数据量超出限制' }, 413);
    const validationError = validateFinancePayload(transactions, invoices);
    if (validationError) return json({ error: validationError }, 400);

    const [existingTransactions, existingInvoices] = await Promise.all([
      fetchAllFinanceRecords(env, token, config.transactions),
      fetchAllFinanceRecords(env, token, config.invoices),
    ]);
    const existingTransactionItems = existingTransactions.map(transactionFromFields).filter(item => item.id);
    const existingInvoiceItems = existingInvoices.map(invoiceFromFields).filter(item => item.number);
    const currentRevision = await financeRevision(existingTransactionItems, existingInvoiceItems);
    if (typeof body.baseRevision !== 'string' || !body.baseRevision) return json({ error: '同步版本缺失，请刷新财务页面后重试', currentRevision }, 428);
    if (body.baseRevision !== currentRevision) return json({ error: '飞书数据已被其他页面更新，请先重新加载云端数据', currentRevision }, 409);
    const transactionRecords = new Map(existingTransactions.map(record => [String(record.fields?.['流水号'] || ''), record.record_id]));
    const invoiceRecords = new Map(existingInvoices.map(record => [String(record.fields?.['发票号码'] || ''), record.record_id]));
    const transactionItemsById = new Map(existingTransactionItems.map(item => [item.id, item]));
    const invoiceItemsByNumber = new Map(existingInvoiceItems.map(item => [item.number, item]));
    const now = Date.now();
    const newTransactions = transactions.filter(item => item?.id && !transactionRecords.has(String(item.id)));
    const changedTransactions = transactions.filter(item => item?.id && transactionRecords.has(String(item.id)) && JSON.stringify(canonicalTransaction(item)) !== JSON.stringify(canonicalTransaction(transactionItemsById.get(String(item.id)))));
    const newInvoices = invoices.filter(item => item?.number && !invoiceRecords.has(String(item.number)));
    const changedInvoices = invoices.filter(item => item?.number && invoiceRecords.has(String(item.number)) && JSON.stringify(canonicalInvoice(item)) !== JSON.stringify(canonicalInvoice(invoiceItemsByNumber.get(String(item.number)))));
    let createdTransactions = 0;
    let createdInvoices = 0;
    let updatedTransactions = 0;
    let updatedInvoices = 0;
    try {
      createdTransactions = await batchCreateFinanceRecords(env, token, config.transactions, newTransactions.map(item => transactionToFields(item, now)));
      createdInvoices = await batchCreateFinanceRecords(env, token, config.invoices, newInvoices.map(invoiceToFields));
      updatedTransactions = await batchUpdateFinanceRecords(env, token, config.transactions, changedTransactions.map(item => ({ record_id: transactionRecords.get(String(item.id)), fields: transactionToFields(item, now, false) })));
      updatedInvoices = await batchUpdateFinanceRecords(env, token, config.invoices, changedInvoices.map(item => ({ record_id: invoiceRecords.get(String(item.number)), fields: invoiceToFields(item) })));
      await batchCreateFinanceRecords(env, token, config.audit, [{
        '日志编号': `AUD${now}`,
        '操作时间': now,
        '操作人': actor,
        '操作类型': newTransactions.length || newInvoices.length || changedTransactions.length || changedInvoices.length ? '同步新增/更新' : '同步检查',
        '数据类型': '财务本地数据',
        '数据编号': body.batchId || '',
        '修改前': '',
        '修改后': JSON.stringify({ createdTransactions, createdInvoices, updatedTransactions, updatedInvoices }),
        '请求编号': request.headers.get('cf-ray') || crypto.randomUUID(),
      }]);
    } catch (error) {
      try {
        const [recoveryTransactions, recoveryInvoices] = await Promise.all([
          fetchAllFinanceRecords(env, token, config.transactions),
          fetchAllFinanceRecords(env, token, config.invoices),
        ]);
        const recoveryRevision = await financeRevision(
          recoveryTransactions.map(transactionFromFields).filter(item => item.id),
          recoveryInvoices.map(invoiceFromFields).filter(item => item.number),
        );
        return json({ error: `同步未完整完成：${error.message || '飞书写入失败'}。本地数据已保留，可直接重试`, partial: true, currentRevision: recoveryRevision }, 502);
      } catch {
        throw error;
      }
    }
    const mergedTransactions = new Map(existingTransactionItems.map(item => [item.id, item]));
    const mergedInvoices = new Map(existingInvoiceItems.map(item => [item.number, item]));
    transactions.forEach(item => mergedTransactions.set(item.id, item));
    invoices.forEach(item => mergedInvoices.set(item.number, item));
    const revision = await financeRevision([...mergedTransactions.values()], [...mergedInvoices.values()]);
    return json({ ok: true, createdTransactions, createdInvoices, updatedTransactions, updatedInvoices, revision });
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
      let accounts;
      try {
        accounts = JSON.parse(env.AUTH_USERS || '{}');
      } catch {
        console.error(JSON.stringify({ message: 'AUTH_USERS configuration is invalid' }));
        return json({ error: '登录服务配置异常' }, 503);
      }
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
        console.error(JSON.stringify({ message: 'finance operation failed', error: error.message || String(error), path: pathname }));
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
      console.error(JSON.stringify({ message: 'upstream proxy failed', error: e.message || String(e), path: pathname }));
      return new Response(`Upstream error: ${e.message}`, { status: 502 });
    }
  },
};
