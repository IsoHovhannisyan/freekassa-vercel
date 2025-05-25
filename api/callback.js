const crypto = require('crypto');

export default async function handler(req, res) {
  if (req.method === 'GET') {
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

  console.log('📥 Получены данные:', body);

  if (body.status_check === '1') {
    return res.status(200).send('YES');
  }

  const { MERCHANT_ORDER_ID, AMOUNT, SIGN } = body;
  const SECRET_2 = process.env.FREEKASSA_SECRET_2 || 'changeme';

  const expectedSign = crypto
    .createHash('md5')
    .update(`${MERCHANT_ORDER_ID}:${AMOUNT}:${SECRET_2}`)
    .digest('hex');

  if (SIGN !== expectedSign) {
    console.log('❌ Неверная подпись!');
    return res.status(403).send('Invalid signature');
  }

  console.log('✅ Платеж подтвержден:', MERCHANT_ORDER_ID, AMOUNT);
  res.send('YES');
} 