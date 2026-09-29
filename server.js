const http = require('http');
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
  if (!res.ok) throw new Error('토큰 발급 실패');
  return data.access_token;
}

// 해당 월의 실제 통장 입금(정산) 내역 전체 조회
async function fetchOrdersForMonth(token, year, month) {
  const padM = String(month).padStart(2, '0');
  const lastDay = new Date(year, month, 0).getDate();
  const startDate = `${year}-${padM}-01`;
  const endDate = `${year}-${padM}-${String(lastDay).padStart(2, '0')}`;

  console.log(`\n▶ [${year}년 ${padM}월] 실제 정산 입금 내역 조회 (${startDate} ~ ${endDate})...`);

  // 네이버 일별 정산 API (실제 통장 입금 기준)
  const dailyUrl = `https://api.commerce.naver.com/external/v1/pay-settle/settle/daily?startDate=${startDate}&endDate=${endDate}&size=1000`;

  let items = [];
  try {
    const res = await fetch(dailyUrl, {
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }
    });
    const data = await res.json();
    
    if (data && data.elements && Array.isArray(data.elements)) {
      console.log(`✔ 네이버 응답 수신: 총 ${data.elements.length}건의 정산 입금 데이터 확인!`);
      items = data.elements;
      if (items.length > 0) {
        console.log('--- 실제 정산 데이터 샘플 ---');
        console.log(items[0]);
        console.log('---------------------------');
      }
    } else {
      console.log('응답 내용:', data);
    }
  } catch (err) {
    console.error('조회 오류:', err.message);
  }

  return items;
}

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
  
  if (reqUrl.pathname === '/api/naver-orders-month') {
    const year = parseInt(reqUrl.searchParams.get('year') || '2026', 10);
    const month = parseInt(reqUrl.searchParams.get('month') || '9', 10);

    try {
      const token = await getNaverToken();
      const orders = await fetchOrdersForMonth(token, year, month);

      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ elements: orders }));
    } catch (err) {
      console.error('에러:', err);
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: err.message }));
    }
  } else {
    res.writeHead(404);
    res.end();
  }
});

const PORT = 3000;
server.listen(PORT, () => {
  console.log(`✔ 통장 입금 정산 서버 실행 중: http://localhost:${PORT}`);
});