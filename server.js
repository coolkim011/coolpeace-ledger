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

// ── 네이버 요청은 고정 IP 프록시(Fixie)를 거쳐서 보냄 ──────────────
// Render 무료 서버는 나가는 IP가 바뀌어서 네이버 IP 등록이 풀릴 수 있음.
// FIXIE_URL 환경변수가 있으면 고정 IP로, 없으면 그냥 바로 요청함.
const https = require('https');
const tls = require('tls');
const PROXY_URL = process.env.FIXIE_URL || '';

function openProxyTunnel(targetHost, targetPort) {
  return new Promise((resolve, reject) => {
    const proxy = new URL(PROXY_URL);
    const headers = { Host: `${targetHost}:${targetPort}` };
    if (proxy.username) {
      const cred = `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`;
      headers['Proxy-Authorization'] = 'Basic ' + Buffer.from(cred).toString('base64');
    }
    const req = http.request({
      host: proxy.hostname,
      port: proxy.port || 80,
      method: 'CONNECT',
      path: `${targetHost}:${targetPort}`,
      headers,
      timeout: 15000
    });
    req.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        reject(new Error(`고정 IP 프록시 연결 실패 (${res.statusCode})`));
        return;
      }
      resolve(socket);
    });
    req.on('timeout', () => req.destroy(new Error('고정 IP 프록시 응답 시간 초과')));
    req.on('error', reject);
    req.end();
  });
}

async function naverFetch(url, options = {}) {
  if (!PROXY_URL) return fetch(url, options);

  const target = new URL(url);
  const tunnel = await openProxyTunnel(target.hostname, target.port || 443);
  const body = options.body === undefined ? undefined : String(options.body);

  return new Promise((resolve, reject) => {
    const headers = { ...(options.headers || {}) };
    if (body !== undefined) headers['Content-Length'] = Buffer.byteLength(body);
    const req = https.request({
      host: target.hostname,
      path: target.pathname + target.search,
      method: options.method || 'GET',
      headers,
      createConnection: () => tls.connect({ socket: tunnel, servername: target.hostname }),
      timeout: 30000
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf-8');
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          json: async () => JSON.parse(text || '{}')
        });
      });
    });
    req.on('timeout', () => req.destroy(new Error('네이버 응답 시간 초과')));
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

// 네이버 인증 토큰을 잠시 보관해서, 여러 달을 연속 조회할 때 매번 새로 받지 않도록 함
let cachedToken = null;
let cachedTokenExp = 0;

async function getNaverToken() {
  if (cachedToken && Date.now() < cachedTokenExp) return cachedToken;

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

  const res = await naverFetch('https://api.commerce.naver.com/external/v1/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params
  });
  const data = await res.json();
  if (!res.ok) {
    const code = data.code || '';
    if (String(code).includes('IP_NOT_ALLOWED')) {
      throw new Error(PROXY_URL
        ? '네이버가 서버 IP를 막았습니다. [고정 IP 사용 중] → 커머스API센터에 Fixie IP 2개가 등록·저장됐는지 확인하세요.'
        : '네이버가 서버 IP를 막았습니다. [고정 IP 미사용] → Render Environment에 FIXIE_URL이 없습니다.');
    }
    throw new Error(`네이버 인증 실패 (${res.status}): ${data.message || code}`);
  }
  cachedToken = data.access_token;
  // 만료 10분 전에 새로 받도록 여유를 둠 (정보가 없으면 30분)
  const lifeSec = Number(data.expires_in) > 900 ? Number(data.expires_in) - 600 : 1800;
  cachedTokenExp = Date.now() + lifeSec * 1000;
  return cachedToken;
}

async function fetchOrdersForMonth(token, year, month) {
  const padM = String(month).padStart(2, '0');
  const lastDay = new Date(year, month, 0).getDate();
  const startDate = `${year}-${padM}-01`;
  const endDate = `${year}-${padM}-${String(lastDay).padStart(2, '0')}`;

  const dailyUrl = `https://api.commerce.naver.com/external/v1/pay-settle/settle/daily?startDate=${startDate}&endDate=${endDate}&size=1000`;

  const res = await naverFetch(dailyUrl, {
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }
  });
  const data = await res.json();
  if (!res.ok) {
    if (res.status === 401) { cachedToken = null; cachedTokenExp = 0; }
    throw new Error(`정산 조회 실패 (${res.status}): ${data.message || data.code || ''}`);
  }
  return Array.isArray(data.elements) ? data.elements : [];
}

console.log(PROXY_URL ? '✔ 네이버 요청: 고정 IP 프록시 사용' : '⚠ 네이버 요청: 프록시 없이 직접 연결 (FIXIE_URL 미설정)');

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
