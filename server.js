const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

// 비밀값은 코드에 쓰지 않고 Render의 Environment 메뉴에서 불러옵니다.
const CLIENT_ID = process.env.NAVER_CLIENT_ID;
const CLIENT_SECRET = process.env.NAVER_CLIENT_SECRET;
const APP_PASSWORD = process.env.APP_PASSWORD;

if (!CLIENT_ID || !CLIENT_SECRET || !APP_PASSWORD) {
  console.error('⚠ 환경변수(NAVER_CLIENT_ID, NAVER_CLIENT_SECRET, APP_PASSWORD)가 설정되지 않았습니다.');
}

// 외부에 보여줘도 되는 파일만 목록으로 허용합니다. (server.js 등은 절대 노출되지 않음)
const PUBLIC_FILES = {
  '/index.html': 'text/html; charset=utf-8',
  '/manifest.json': 'application/json; charset=utf-8',
  '/sw.js': 'application/javascript; charset=utf-8',
  '/icon-192.png': 'image/png'
};

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function isPasswordOk(req) {
  if (!APP_PASSWORD) return false;
  const given = Buffer.from(String(req.headers['x-app-password'] || ''));
  const expected = Buffer.from(APP_PASSWORD);
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

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
    throw new Error(`네이버 인증 실패 (${res.status}): ${data.message || data.code || ''}`);
  }
  return data.access_token;
}

async function fetchOrdersForMonth(token, year, month) {
  const padM = String(month).padStart(2, '0');
  const lastDay = new Date(year, month, 0).getDate();
  const startDate = `${year}-${padM}-01`;
  const endDate = `${year}-${padM}-${String(lastDay).padStart(2, '0')}`;

  const dailyUrl = `https://api.commerce.naver.com/external/v1/pay-settle/settle/daily?startDate=${startDate}&endDate=${endDate}&size=1000`;

  const res = await fetch(dailyUrl, {
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(`정산 조회 실패 (${res.status}): ${data.message || data.code || ''}`);
  }
  return Array.isArray(data.elements) ? data.elements : [];
}

const server = http.createServer(async (req, res) => {
  const reqUrl = new URL(req.url, 'http://localhost');

  // 1. 네이버 정산 동기화 API (비밀번호 필요)
  if (reqUrl.pathname === '/api/naver-orders-month') {
    if (!isPasswordOk(req)) {
      sendJson(res, 401, { error: '비밀번호가 맞지 않습니다.' });
      return;
    }

    const now = new Date();
    const year = parseInt(reqUrl.searchParams.get('year') || now.getFullYear(), 10);
    const month = parseInt(reqUrl.searchParams.get('month') || now.getMonth() + 1, 10);
    if (!(year >= 2020 && year <= 2100 && month >= 1 && month <= 12)) {
      sendJson(res, 400, { error: '연도/월 값이 올바르지 않습니다.' });
      return;
    }

    try {
      const token = await getNaverToken();
      const orders = await fetchOrdersForMonth(token, year, month);
      sendJson(res, 200, { elements: orders });
    } catch (err) {
      console.error('네이버 동기화 오류:', err.message);
      sendJson(res, 500, { error: err.message });
    }
    return;
  }

  // 2. 웹 화면 서빙 (허용 목록에 있는 파일만)
  const filePath = reqUrl.pathname === '/' ? '/index.html' : reqUrl.pathname;
  const contentType = PUBLIC_FILES[filePath];
  if (!contentType) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found');
    return;
  }

  fs.readFile(path.join(__dirname, filePath), (err, content) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
      return;
    }
    const headers = { 'Content-Type': contentType };
    // 화면과 서비스워커는 항상 최신 버전을 받도록 캐시하지 않음
    if (filePath === '/index.html' || filePath === '/sw.js') headers['Cache-Control'] = 'no-cache';
    res.writeHead(200, headers);
    res.end(content);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`✔ 통합 서버 가동 완료 (포트: ${PORT})`);
});
