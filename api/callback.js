const crypto = require('crypto');
const { Pool } = require('pg');
const { Telegraf } = require('telegraf');

// Initialize database connection
const pool = new Pool({
  connectionString: process.env.DB_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

// Initialize bot
const bot = new Telegraf(process.env.BOT_TOKEN);

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
  const SECRET_2 = process.env.FREEKASSA_SECRET_2;

  if (!SECRET_2) {
    console.error('❌ FREEKASSA_SECRET_2 is not set');
    return res.status(500).send('Server configuration error');
  }

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

  try {
    // Get order details from database
    const result = await pool.query('SELECT * FROM orders WHERE id = $1', [MERCHANT_ORDER_ID]);
    const order = result.rows[0];

    if (!order) {
      console.warn(`❌ Order ${MERCHANT_ORDER_ID} not found`);
      return res.status(404).send('Order not found');
    }

    if (order.status === 'confirmed') {
      return res.send('Already confirmed');
    }

    // Update order status
    await pool.query('UPDATE orders SET status = $1 WHERE id = $2', ['confirmed', MERCHANT_ORDER_ID]);

    // DEMO MODE: Mark all UC_by_id products as paid and decrease their stock
    if (process.env.DEMO_MODE === 'true') {
      const products = JSON.parse(order.products);
      for (const p of products) {
        if (p.category === 'uc_by_id') {
          // Mark as paid (if you have a field for this, e.g., p.paid = true)
          // Decrease stock in the products table
          await pool.query('UPDATE products SET stock = stock - $1 WHERE id = $2', [p.qty, p.id]);
        }
      }
    }

    // Send notification to user
    const userId = order.user_id;
    const pubgId = order.pubg_id;
    const products = JSON.parse(order.products);

    const itemsText = products.map(p =>
      `📦 ${p.name} x${p.qty} — ${p.price * p.qty} ₽`
    ).join('\n');

    await bot.telegram.sendMessage(userId, `
🧾 Заказ подтверждён:

🎮 PUBG ID: ${pubgId}
${itemsText}

💰 Сумма: ${AMOUNT} ₽
✅ Оплата получена. Ваш заказ скоро будет выполнен.
    `);

    console.log('✅ Payment confirmed and order updated:', MERCHANT_ORDER_ID, AMOUNT);
    res.setHeader('Content-Type', 'text/plain');
    res.send('YES');
  } catch (err) {
    console.error('❌ Error processing payment:', err.message);
    return res.status(500).send('Internal Server Error');
  }
} 