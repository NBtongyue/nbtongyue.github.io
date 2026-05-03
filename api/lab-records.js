const APP_ID     = 'cli_a97ef41dd9e11bdd';
const APP_SECRET = 'iYSnc5iLPuiXHsC6eHq0bfIugWiBvXGC';
const APP_TOKEN  = 'UXnub1zPSaHe9sszFOXcaVCvnrd';
// 在飞书多维表格中新建"实验室分包订单追踪"数据表后，将其 table_id 填入此处
const TABLE_ID   = 'LAB_TABLE_ID_PLACEHOLDER';

async function getToken() {
  const res = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: APP_ID, app_secret: APP_SECRET }),
  });
  const d = await res.json();
  return d.tenant_access_token;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const token = await getToken();

    if (req.method === 'GET') {
      const pt  = req.query.page_token || '';
      const url = 'https://open.feishu.cn/open-apis/bitable/v1/apps/' + APP_TOKEN + '/tables/' + TABLE_ID + '/records?page_size=500' + (pt ? '&page_token=' + pt : '');
      const r   = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
      return res.json(await r.json());
    }

    if (req.method === 'POST') {
      const r = await fetch(
        'https://open.feishu.cn/open-apis/bitable/v1/apps/' + APP_TOKEN + '/tables/' + TABLE_ID + '/records',
        { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify(req.body) }
      );
      return res.json(await r.json());
    }

    if (req.method === 'PATCH') {
      const { record_id, fields } = req.body;
      const r = await fetch(
        'https://open.feishu.cn/open-apis/bitable/v1/apps/' + APP_TOKEN + '/tables/' + TABLE_ID + '/records/' + record_id,
        { method: 'PUT', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify({ fields }) }
      );
      return res.json(await r.json());
    }

    if (req.method === 'DELETE') {
      const record_id = req.query.record_id;
      const r = await fetch(
        'https://open.feishu.cn/open-apis/bitable/v1/apps/' + APP_TOKEN + '/tables/' + TABLE_ID + '/records/' + record_id,
        { method: 'DELETE', headers: { Authorization: 'Bearer ' + token } }
      );
      return res.json(await r.json());
    }

    return res.status(404).json({ error: 'not found' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
