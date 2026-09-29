const http = require('http');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');

const CLIENT_ID = '4VzAP3FHmhTfW5uzwjYI2T';
const CLIENT_SECRET = '$2a$04$9nejwz1DKzR1C.cOI6nAh.';

async function getNaverToken() {
  const timestamp = Date.now();
  const password = `${CLIENT_ID}_${timestamp}`;
  const hashed = bcrypt.hashSync(password, CLIENT_SECRET);
  const clientSecretSign = Buffer.from(hashed, 'utf-8').toString('base64');

  const params = new URLSearchParams();
  params.append('client_id', CLIENT_ID);
  params.append('timestamp', timestamp);
  params.append('client_secret_sign', clientSecretSign);
  params.append('grant_type', 'client_credentials');
  params.append('type', 'SELF');

  const res = await fetch('https://api.commerce.naver.com/external/v1/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(JSON.stringify(data));
  }
  return data.access_token;
}

async function fetchOrdersForMonth(token, year, month) {
  const padM = String(month).padStart(2, '0');
  const lastDay = new Date(year, month, 0).getDate();
  const startDate = `${year}-${padM}-01`;
  const endDate = `${year}-${padM}-${String(lastDay).padStart(2, '0')}`;

  const dailyUrl = `https://api.commerce.naver.com/external/v1/pay-settle/settle/daily?startDate=${startDate}&endDate=${endDate}&size=1000`;

  let items = [];
  try {
    const res = await fetch(dailyUrl, {
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }
    });
    const data = await res.json();
    if (data && data.elements && Array.isArray(data.elements)) {
      items = data.elements;
    }
  } catch (err) {
    console.error('조회 오류:', err.message);
  }
  return items;
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png'
};

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const reqUrl = new URL(req.url, `http://${req.headers.host}`);

  // 1. 서버 IP 확인용 주소
  if (reqUrl.pathname === '/api/check-ip') {
    try {
      const ipRes = await fetch('https://api.ipify.org?format=json');
      const ipData = await ipRes.json();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(ipData));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // 2. 네이버 동기화 API
  if (reqUrl.pathname === '/api/naver-orders-month') {
    const year = parseInt(reqUrl.searchParams.get('year') || '2026', 10);
    const month = parseInt(reqUrl.searchParams.get('month') || '9', 10);

    try {
      const token = await getNaverToken();
      const orders = await fetchOrdersForMonth(token, year, month);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ elements: orders }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // 3. 웹 화면 서빙
  let filePath = reqUrl.pathname === '/' ? '/index.html' : reqUrl.pathname;
  const fullPath = path.join(__dirname, filePath);
  const ext = path.extname(fullPath).toLowerCase();

  fs.readFile(fullPath, (err, content) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
    } else {
      res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
      res.end(content);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`✔ 통합 서버 가동 완료 (포트: ${PORT})`);
});