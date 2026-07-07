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
  // ToyyibPay hantar POST sebagai form-urlencoded (bukan JSON)
  // parse body ikut Content-Type
  function parseBody(raw, contentType) {
    if (!raw) return {};
    if (contentType && contentType.includes('application/json')) {
      return JSON.parse(raw);
    }
    // form-urlencoded: refno=xxx&status=1&billcode=yyy&order_id=ORD_123&amount=200&paydate=2024-01-01
    const params = new URLSearchParams(raw);
    const obj = {};
    for (const [k, v] of params) obj[k] = v;
    return obj;
  }

  const ct = (event.headers['content-type'] || event.headers['Content-Type'] || '').toLowerCase();
  const rawBody = typeof event.body === 'string' ? event.body : '';
  const body = (event.httpMethod === 'POST' || event.httpMethod === 'GET')
    ? parseBody(rawBody, ct)
    : {};

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
