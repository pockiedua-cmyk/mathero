/**
 * Netlify Function — TOYYIBPAY VERIFY PAYMENT
 * =============================================
 * Dipanggil front-end lepas redirect dari ToyyibPay.
 * Guna ToyyibPay API checkBillTransactions/checkBillStatus untuk verify payment.
 * Kalau dah bayar, credit Rare Coin & update order status.
 *
 * Environment variables:
 *   TOYYIBPAY_SECRET_KEY     — dari dashboard ToyyibPay
 *   TOYYIBPAY_BASE_URL       — https://toyyibpay.com
 *   FIREBASE_SERVICE_ACCOUNT  — JSON string dari Service Account
 *   FIREBASE_DATABASE_URL     — Firebase Realtime Database URL
 */

const crypto = require('crypto');

const TOYYIBPAY_SECRET_KEY = process.env.TOYYIBPAY_SECRET_KEY;
const TOYYIBPAY_BASE_URL   = process.env.TOYYIBPAY_BASE_URL || 'https://toyyibpay.com';
const FB_URL               = process.env.FIREBASE_DATABASE_URL;

let _cachedToken = null;
let _cachedTokenExpiry = 0;

console.log('VERIFY ENV — SECRET_KEY:', TOYYIBPAY_SECRET_KEY ? 'SET (len:' + TOYYIBPAY_SECRET_KEY.length + ')' : 'UNDEFINED');
console.log('VERIFY ENV — BASE_URL:', TOYYIBPAY_BASE_URL);
console.log('VERIFY ENV — FB_URL:', FB_URL ? 'SET' : 'UNDEFINED');
console.log('VERIFY ENV — SERVICE_ACCOUNT:', process.env.FIREBASE_SERVICE_ACCOUNT ? 'SET' : 'UNDEFINED');

async function getAccessToken() {
  if (_cachedToken && Date.now() < _cachedTokenExpiry - 60000) {
    return _cachedToken;
  }
  const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/firebase.database',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600, iat: now,
  })).toString('base64url');
  const sig = crypto.sign('sha256', Buffer.from(`${header}.${payload}`), sa.private_key);
  const jwt = `${header}.${payload}.${sig.toString('base64url')}`;
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error('OAuth2 failed: ' + JSON.stringify(data));
  _cachedToken = data.access_token;
  _cachedTokenExpiry = (data.expires_in || 3600) * 1000 + Date.now();
  return _cachedToken;
}

async function fbGet(path) {
  const token = await getAccessToken();
  const res = await fetch(`${FB_URL}/${path}.json?access_token=${token}`);
  if (!res.ok) { const b = await res.text(); throw new Error(`FB GET ${path}: ${res.status} ${b}`); }
  return res.json();
}

async function fbPut(path, data) {
  const token = await getAccessToken();
  const res = await fetch(`${FB_URL}/${path}.json?access_token=${token}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
  });
  if (!res.ok) { const b = await res.text(); throw new Error(`FB PUT ${path}: ${res.status} ${b}`); }
}

async function fbPatch(path, data) {
  const token = await getAccessToken();
  const res = await fetch(`${FB_URL}/${path}.json?access_token=${token}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
  });
  if (!res.ok) { const b = await res.text(); throw new Error(`FB PATCH ${path}: ${res.status} ${b}`); }
}

async function checkToyyibpayBill(billCode) {
  const params = new URLSearchParams();
  params.append('userSecretKey', TOYYIBPAY_SECRET_KEY);
  params.append('billCode', billCode);

  const res = await fetch(TOYYIBPAY_BASE_URL + '/index.php/api/getBillTransactions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  const text = await res.text();
  console.log('ToyyibPay verify response:', text);
  let data;
  try { data = JSON.parse(text); } catch (e) { throw new Error('Invalid JSON from ToyyibPay verify: ' + text); }

  // Response format: [{ billCode, billpaymentStatus, ... }]
  if (data && data.length) {
    const bill = data[0];
    return {
      paid: bill.billpaymentStatus === '1',
      status: bill.billpaymentStatus,
      refno: bill.transaction_id || bill.refno || '',
      amount: bill.billAmount || '',
      paydate: bill.billPaidDate || bill.paydate || '',
    };
  }
  return { paid: false, status: '0' };
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'POST required' }) };

  try {
    const { orderId } = JSON.parse(event.body);
    if (!orderId) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing orderId' }) };

    console.log('VERIFY order:', orderId);
    const order = await fbGet('orders/' + orderId);
    console.log('VERIFY order data:', JSON.stringify(order));

    if (!order) return { statusCode: 404, headers, body: JSON.stringify({ error: 'Order not found' }) };
    if (order.status === 'completed' || order.status === 'paid') {
      return { statusCode: 200, headers, body: JSON.stringify({ success: true, message: 'Already completed' }) };
    }

    const billCode = order.billCode;
    if (!billCode) return { statusCode: 400, headers, body: JSON.stringify({ error: 'No billCode in order' }) };

    const result = await checkToyyibpayBill(billCode);
    console.log('VERIFY result:', JSON.stringify(result));

    if (result.paid) {
      const username = order.username;
      const qty = parseInt(order.qty) || 0;

      const currentCoin = await fbGet(`tracking/${username}/shop/rare_coin`);
      const newBalance = (currentCoin || 0) + qty;
      await fbPut(`tracking/${username}/shop/rare_coin`, newBalance);

      await fbPatch('orders/' + orderId, {
        status: 'completed',
        paidAt: result.paydate || new Date().toISOString(),
        refno: result.refno || '',
        billcode: billCode,
        amount: parseInt(result.amount) || 0,
      });

      console.log(`Credited ${qty} Rare Coin to ${username} (Order ${orderId})`);
      return { statusCode: 200, headers, body: JSON.stringify({ success: true, qty, username }) };
    } else {
      return { statusCode: 200, headers, body: JSON.stringify({ success: false, message: 'Payment not yet confirmed', status: result.status }) };
    }
  } catch (err) {
    console.error('VERIFY error:', err.message, err.stack);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
