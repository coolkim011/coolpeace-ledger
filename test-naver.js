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
    throw new Error(`토큰 발급 실패 (${res.status}): ${JSON.stringify(data)}`);
  }
  return data.access_token;
}

async function testFetchCommissionDetails() {
  try {
    console.log('1. 네이버 인증 토큰 요청 중...');
    const token = await getNaverToken();
    console.log('✔ 토큰 발급 성공!');

    // 정산 입금이 일어났던 날짜 하루 테스트 (예: 2026-09-11)
    const testDate = '2026-09-11';
    console.log(`2. [${testDate}] 정산완료일 기준 개별 주문/수수료 건별 상세 조회 중...`);

    // 네이버 공식 규격: 정산완료일 기준
    const apiUrl = `https://api.commerce.naver.com/external/v1/pay-settle/settle/commission-details?searchDate=${testDate}&periodType=SETTLE_CASEBYCASE_SETTLE_COMPLETE_DATE&page=1&size=100`;

    const res = await fetch(apiUrl, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    });

    const result = await res.json();
    console.log('✔ 네이버 응답 결과:');

    if (result.elements && result.elements.length > 0) {
      console.log(`\n🎉 드디어 찾았습니다! [${testDate}] 하루에만 총 ${result.elements.length}건의 개별 거래 수신`);
      console.log('첫 번째 개별 주문 상세:', {
        주문번호: result.elements[0].orderNo,
        상품명: result.elements[0].productName,
        구매자: result.elements[0].purchaserName,
        결제금액: result.elements[0].productPayAmount,
        정산금액: result.elements[0].settleAmount,
        수수료: result.elements[0].commissionAmount
      });
    } else {
      console.log('결과: 해당 날짜에는 정산 완료 건이 없습니다.', result);
    }
  } catch (err) {
    console.error('오류 발생:', err.message);
  }
}

testFetchCommissionDetails();