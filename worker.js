const APP_ID     = 'cli_a97ef41dd9e11bdd';
const APP_SECRET = 'iYSnc5iLPuiXHsC6eHq0bfIugWiBvXGC';
const APP_TOKEN  = 'UXnub1zPSaHe9sszFOXcaVCvnrd';
const TABLE_ID   = 'tblWB2WhG7qnkiWE';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

async function getToken() {
  const res = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: APP_ID, app_secret: APP_SECRET }),
  });
  const d = await res.json();
  return d.tenant_access_token;
}

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }
    const url = new URL(request.url);
    const token = await getToken();
    let response;

    if (url.pathname === '/records' && request.method === 'GET') {
      const pt = url.searchParams.get('page_token') || '';
      const api = 'https://open.feishu.cn/open-apis/bitable/v1/apps/' + APP_TOKEN + '/tables/' + TABLE_ID + '/records?page_size=500' + (pt ? '&page_token=' + pt : '');
      response = await fetch(api, { headers: { Authorization: 'Bearer ' + token } });
    } else if (url.pathname === '/records' && request.method === 'POST') {
      const body = await request.text();
      response = await fetch(
        'https://open.feishu.cn/open-apis/bitable/v1/apps/' + APP_TOKEN + '/tables/' + TABLE_ID + '/records',
        { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: body }
      );
    } else {
      return new Response('Not found', { status: 404, headers: CORS });
    }

    const data = await response.text();
    return new Response(data, { headers: { ...CORS, 'Content-Type': 'application/json' } });
  }
};
