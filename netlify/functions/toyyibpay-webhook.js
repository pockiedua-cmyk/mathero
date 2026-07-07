/**
 * Netlify Function — TOYYIBPAY WEBHOOK/CALLBACK
 * ==============================================
 * Dipanggil ToyyibPay selepas pembayaran.
 * Guna Firebase REST API + Service Account OAuth2 (no npm dependencies).
 *
 * Environment variables:
 *   FIREBASE_SERVICE_ACCOUNT  — JSON string dari Service Account private key
 *                               (Firebase Console → Project Settings → Service Accounts)
 *   FIREBASE_DATABASE_URL     — https://PROJECT-default-rtdb.REGION.firebasedatabase.app
 */

const crypto = require('crypto');

const FB_URL = process.env.FIREBASE_DATABASE_URL;
let _cachedToken = null;
let _cachedTokenExpiry = 0;

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
    exp: now + 3600,
    iat: now,
  })).toString('base64url');

  const sig = crypto.sign('sha256', Buffer.from(`${header}.${payload}`), sa.private_key);
  const jwt = `${header}.${payload}.${sig.toString('base64url')}`;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });

  const data = await res.json();
  if (!data.access_token) throw new Error('OAuth2 failed: ' + JSON.stringify(data));

  _cachedToken = data.access_token;
  _cachedTokenExpiry = (data.expires_in || 3600) * 1000 + Date.now();
  return _cachedToken;
}

async function fbGet(path) {
  const token = await getAccessToken();
  const url = `${FB_URL}/${path}.json?access_token=${token}`;
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Firebase GET ${path}: ${res.status} ${body}`);
  }
  return res.json();
}

async function fbPut(path, data) {
  const token = await getAccessToken();
  const url = `${FB_URL}/${path}.json?access_token=${token}`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Firebase PUT ${path}: ${res.status} ${body}`);
  }
}

async function fbPatch(path, data) {
  const token = await getAccessToken();
  const url = `${FB_URL}/${path}.json?access_token=${token}`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Firebase PATCH ${path}: ${res.status} ${body}`);
  }
}

exports.handler = async (event) => {
  function parseForm(raw) {
    if (!raw) return {};
    const params = new URLSearchParams(raw);
    const obj = {};
    for (const [k, v] of params) obj[k] = v;
    return obj;
  }

  let body = {};
  if (event.httpMethod === 'GET') {
    body = event.queryStringParameters || {};
  } else if (event.httpMethod === 'POST') {
    const ct = (event.headers['content-type'] || event.headers['Content-Type'] || '').toLowerCase();
    const rawBody = typeof event.body === 'string' ? event.body : '';
    if (ct.includes('application/json')) {
      try { body = JSON.parse(rawBody); } catch (e) { body = {}; }
    } else {
      body = parseForm(rawBody);
    }
  }

  const refno    = body.refno    || '';
  const status   = body.status   || '';
  const billcode = body.billcode || '';
  const orderId  = body.order_id || '';
  const amount   = body.amount   || '';
  const paydate  = body.paydate  || '';

  if (!orderId || status === '') {
    return { statusCode: 400, body: 'FAIL: Missing parameters' };
  }

  try {
    const order = await fbGet('orders/' + orderId);

    if (!order || !order.username) {
      return { statusCode: 404, body: `FAIL: Order ${orderId} not found` };
    }

    if (order.status === 'completed' || order.status === 'paid') {
      return { statusCode: 200, body: `OK: Order ${orderId} already processed` };
    }

    if (status === '1') {
      const username = order.username;
      const qty = parseInt(order.qty) || 0;

      const currentCoin = await fbGet(`tracking/${username}/shop/rare_coin`);
      const newBalance = (currentCoin || 0) + qty;
      await fbPut(`tracking/${username}/shop/rare_coin`, newBalance);

      await fbPatch('orders/' + orderId, {
        status: 'completed',
        paidAt: paydate || new Date().toISOString(),
        refno, billcode,
        amount: parseInt(amount) || 0,
      });

      console.log(`Credited ${qty} Rare Coin to ${username} (Order ${orderId})`);
      return { statusCode: 200, body: `OK: ${qty} Rare Coin credited to ${username}` };
    } else {
      await fbPatch('orders/' + orderId, {
        status: 'failed', refno, billcode,
      });
      return { statusCode: 200, body: 'OK: Order marked as failed' };
    }
  } catch (err) {
    console.error('Webhook error:', err);
    return { statusCode: 500, body: 'FAIL: ' + err.message };
  }
};
