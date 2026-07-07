/**
 * Netlify Function — TOYYIBPAY WEBHOOK/CALLBACK
 * ==============================================
 * Dipanggil ToyyibPay selepas pembayaran.
 * Guna Firebase Admin SDK dengan Service Account (lebih selamat dari Database Secret).
 *
 * Environment variables:
 *   FIREBASE_SERVICE_ACCOUNT  — JSON string dari Service Account private key
 *                               (Firebase Console → Project Settings → Service Accounts → Generate new private key)
 *   FIREBASE_DATABASE_URL     — https://PROJECT-default-rtdb.REGION.firebasedatabase.app
 */

const admin = require('firebase-admin');

// Init Firebase Admin — sekali sahaja
if (!admin.apps.length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: process.env.FIREBASE_DATABASE_URL,
  });
}

const db = admin.database();

exports.handler = async (event) => {
  // ToyyibPay hantar callback sebagai form-urlencoded POST (jarang2 GET)
  // Parse body — sokong JSON, form-urlencoded, dan query params (GET)
  function parseForm(raw) {
    if (!raw) return {};
    const params = new URLSearchParams(raw);
    const obj = {};
    for (const [k, v] of params) obj[k] = v;
    return obj;
  }

  let body = {};
  if (event.httpMethod === 'GET') {
    // Callback via GET — data dalam query string
    body = event.queryStringParameters || {};
  } else if (event.httpMethod === 'POST') {
    const ct = (event.headers['content-type'] || event.headers['Content-Type'] || '').toLowerCase();
    const rawBody = typeof event.body === 'string' ? event.body : '';
    if (ct.includes('application/json')) {
      try { body = JSON.parse(rawBody); } catch (e) { body = {}; }
    } else {
      // form-urlencoded (default ToyyibPay)
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
    const orderSnap = await db.ref('orders/' + orderId).once('value');
    const order = orderSnap.val();

    if (!order || !order.username) {
      return { statusCode: 404, body: `FAIL: Order ${orderId} not found` };
    }

    // Elak double credit
    if (order.status === 'completed' || order.status === 'paid') {
      return { statusCode: 200, body: `OK: Order ${orderId} already processed` };
    }

    if (status === '1') {
      // ✅ Payment berjaya
      const username = order.username;
      const qty = parseInt(order.qty) || 0;

      // Credit Rare Coin guna transaction (atomic — takkan double credit)
      const coinRef = db.ref('tracking/' + username + '/shop/rare_coin');
      const result = await coinRef.transaction(current => (current || 0) + qty);

      // Update order status
      await orderSnap.ref.update({
        status: 'completed',
        paidAt: paydate || new Date().toISOString(),
        refno,
        billcode,
        amount: parseInt(amount) || 0,
      });

      console.log(`✅ Credited ${qty} Rare Coin to ${username} (Order ${orderId})`);
      return { statusCode: 200, body: `OK: ${qty} Rare Coin credited to ${username}` };
    } else {
      // ❌ Payment gagal
      await orderSnap.ref.update({
        status: 'failed', refno, billcode,
      });
      console.log(`❌ Order ${orderId} marked as failed`);
      return { statusCode: 200, body: 'OK: Order marked as failed' };
    }
  } catch (err) {
    console.error('Webhook error:', err);
    return { statusCode: 500, body: 'FAIL: ' + err.message };
  }
};
