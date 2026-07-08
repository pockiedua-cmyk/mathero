/**
 * Netlify Function — TOYYIBPAY CREATE BILL (proxy)
 * ================================================
 * Front-end POST ke sini: { orderId, billName, billDescription, billAmount, billTo, billEmail, billPhone }
 * Fungsi panggil ToyyibPay API, return { success, paymentUrl }
 *
 * Environment variables (set in Netlify Dashboard):
 *   TOYYIBPAY_SECRET_KEY     — dari dashboard ToyyibPay
 *   TOYYIBPAY_CATEGORY_CODE  — dari Product → Category
 *   TOYYIBPAY_BASE_URL       — https://toyyibpay.com (atau https://dev.toyyibpay.com)
 *   GAME_URL                 — URL game utama (contoh: https://heromath.netlify.app)
 *   PAYMENT_URL              — URL site payment functions (contoh: https://heromathpay.netlify.app)
 */

const TOYYIBPAY_SECRET_KEY    = process.env.TOYYIBPAY_SECRET_KEY;
const TOYYIBPAY_CATEGORY_CODE = process.env.TOYYIBPAY_CATEGORY_CODE;
const TOYYIBPAY_BASE_URL      = process.env.TOYYIBPAY_BASE_URL || 'https://toyyibpay.com';
const GAME_URL                = process.env.GAME_URL;
const PAYMENT_URL             = process.env.PAYMENT_URL;

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'POST required' }) };
  }

  try {
    const { orderId, billName, billDescription, billAmount, billTo, billEmail, billPhone } = JSON.parse(event.body);

    if (!orderId || !billAmount || !billTo || !billEmail) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing required fields' }) };
    }

    const webhookUrl = PAYMENT_URL + '/.netlify/functions/toyyibpay-webhook';
    const returnUrl  = GAME_URL + '?payment_return=1';

    const params = new URLSearchParams();
    params.append('userSecretKey',           TOYYIBPAY_SECRET_KEY);
    params.append('categoryCode',            TOYYIBPAY_CATEGORY_CODE);
    params.append('billName',               billName || 'HeroMath Package');
    params.append('billDescription',         billDescription || '');
    params.append('billPriceSetting',        '1');
    params.append('billPayorInfo',           '1');
    params.append('billAmount',              String(billAmount));
    params.append('billReturnUrl',           returnUrl);
    params.append('billCallbackUrl',         webhookUrl);
    params.append('billExternalReferenceNo', orderId);
    params.append('billTo',                  billTo);
    params.append('billEmail',               billEmail);
    params.append('billPhone',               billPhone || '');

    const response = await fetch(TOYYIBPAY_BASE_URL + '/index.php/api/createBill', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });

    const data = await response.json();
    console.log('ToyyibPay response:', JSON.stringify(data));

    if (data && data.length && data[0].BillCode) {
      const paymentUrl = TOYYIBPAY_BASE_URL + '/' + data[0].BillCode;
      return { statusCode: 200, headers, body: JSON.stringify({ success: true, paymentUrl, billCode: data[0].BillCode }) };
    } else {
      const errMsg = data[0]?.error_msg || 'ToyyibPay API error';
      console.error('ToyyibPay error:', errMsg);
      return { statusCode: 500, headers, body: JSON.stringify({ error: errMsg }) };
    }
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
