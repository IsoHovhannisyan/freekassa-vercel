const crypto = require('crypto');

export default async function handler(req, res) {
  // Set CORS headers to allow Freekassa servers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Handle preflight requests
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Handle GET requests (merchant verification)
  if (req.method === 'GET') {
    res.setHeader('Content-Type', 'text/plain');
    return res.status(200).send('YES');
  }

  if (req.method !== 'POST') {
    return res.status(405).send('Method Not Allowed');
  }

  // Parse form data (Vercel parses JSON by default, so we need to handle form data)
  let body = req.body;
  if (typeof body === 'string') {
    body = Object.fromEntries(new URLSearchParams(body));
  }

  console.log('📥 Received data:', body);

  // Handle status check requests
  if (body.status_check === '1') {
    res.setHeader('Content-Type', 'text/plain');
    return res.status(200).send('YES');
  }

  const { MERCHANT_ORDER_ID, AMOUNT, SIGN } = body;
  const SECRET_2 = process.env.FREEKASSA_SECRET_2 || 'changeme';

  // Verify required fields
  if (!MERCHANT_ORDER_ID || !AMOUNT || !SIGN) {
    console.log('❌ Missing required fields');
    return res.status(400).send('Missing required fields');
  }

  const expectedSign = crypto
    .createHash('md5')
    .update(`${MERCHANT_ORDER_ID}:${AMOUNT}:${SECRET_2}`)
    .digest('hex');

  if (SIGN !== expectedSign) {
    console.log('❌ Invalid signature!');
    return res.status(403).send('Invalid signature');
  }

  console.log('✅ Payment confirmed:', MERCHANT_ORDER_ID, AMOUNT);
  res.setHeader('Content-Type', 'text/plain');
  res.send('YES');
} 