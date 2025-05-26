import crypto from 'crypto';
import { Pool } from 'pg';
import { Telegraf } from 'telegraf';

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
  console.log('>>> Entered callback.js handler');
  // Set CORS headers to allow Freekassa servers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Handle preflight requests
  if (req.method === 'OPTIONS') {
    console.log('>>> Returning early at OPTIONS');
    return res.status(200).end();
  }

  // Handle GET requests (merchant verification)
  if (req.method === 'GET') {
    console.log('>>> Returning early at GET');
    res.setHeader('Content-Type', 'text/plain');
    return res.status(200).send('YES');
  }

  if (req.method !== 'POST') {
    console.log('>>> Returning early at not POST');
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
    console.log('>>> Returning early at status_check');
    res.setHeader('Content-Type', 'text/plain');
    return res.status(200).send('YES');
  }

  const { MERCHANT_ORDER_ID, AMOUNT, SIGN } = body;
  const SECRET_2 = process.env.FREEKASSA_SECRET_2;

  if (!SECRET_2) {
    console.log('>>> Returning early at missing SECRET_2');
    return res.status(500).send('Server configuration error');
  }

  // Verify required fields
  if (!MERCHANT_ORDER_ID || !AMOUNT || !SIGN) {
    console.log('>>> Returning early at missing required fields');
    return res.status(400).send('Missing required fields');
  }

  const expectedSign = crypto
    .createHash('md5')
    .update(`${MERCHANT_ORDER_ID}:${AMOUNT}:${SECRET_2}`)
    .digest('hex');

  if (SIGN !== expectedSign) {
    console.log('>>> Returning early at invalid signature');
    // Set order status to unpaid if order exists
    try {
      const result = await pool.query('SELECT * FROM orders WHERE id = $1', [MERCHANT_ORDER_ID]);
      if (result.rows.length > 0) {
        await pool.query('UPDATE orders SET status = $1 WHERE id = $2', ['unpaid', MERCHANT_ORDER_ID]);
      }
    } catch (e) { /* ignore */ }
    return res.status(403).send('Invalid signature');
  }

  try {
    // Get order details from database
    const result = await pool.query('SELECT * FROM orders WHERE id = $1', [MERCHANT_ORDER_ID]);
    const order = result.rows[0];

    if (!order) {
      console.log('>>> Returning early at order not found');
      return res.status(404).send('Order not found');
    }

    if (order.status === 'delivered' || order.status === 'error') {
      console.log(`⏩ Order ${MERCHANT_ORDER_ID} already ${order.status}, skipping activation.`);
      return res.send(`Order already ${order.status}`);
    }

    // Update order status to pending (even if already pending, for demo)
    await pool.query('UPDATE orders SET status = $1 WHERE id = $2', ['pending', MERCHANT_ORDER_ID]);
    console.log(`🔄 Order ${MERCHANT_ORDER_ID} status set to pending.`);

    // --- DEMO_MODE: Mock activation step ---
    let activationSuccess = true;
    let activationError = null;
    if (process.env.DEMO_MODE === 'true') {
      console.log('🔔 [DEMO_MODE] Running mock activation for order', MERCHANT_ORDER_ID);
      try {
        // Simulate activation logic (randomly fail for demonstration)
        if (Math.random() < 0.9) { // 90% success rate
          activationSuccess = true;
          console.log('✅ [DEMO_MODE] Activation successful for order', MERCHANT_ORDER_ID);
        } else {
          activationSuccess = false;
          activationError = 'Mock activation failed';
          console.log('❌ [DEMO_MODE] Activation failed for order', MERCHANT_ORDER_ID);
        }
      } catch (e) {
        activationSuccess = false;
        activationError = e.message;
        console.log('❌ [DEMO_MODE] Activation error for order', MERCHANT_ORDER_ID, e.message);
      }
      // Update order status based on activation result
      if (activationSuccess) {
        await pool.query('UPDATE orders SET status = $1 WHERE id = $2', ['delivered', MERCHANT_ORDER_ID]);
        console.log(`🚚 Order ${MERCHANT_ORDER_ID} status set to delivered.`);
      } else {
        await pool.query('UPDATE orders SET status = $1 WHERE id = $2', ['error', MERCHANT_ORDER_ID]);
        console.log(`🛑 Order ${MERCHANT_ORDER_ID} status set to error.`);
      }
    }
    // --- END DEMO_MODE activation ---

    let products;
    try {
      products = Array.isArray(order.products) ? order.products : JSON.parse(order.products);
    } catch (e) {
      console.error('❌ Error parsing order.products:', e.message, order.products);
      return res.status(500).send('Order data error');
    }

    // DEMO MODE: Mark all UC_by_id products as paid and decrease their stock
    if (process.env.DEMO_MODE === 'true') {
      for (const p of products) {
        if (p.category === 'uc_by_id') {
          try {
            await pool.query('UPDATE products SET stock = stock - $1 WHERE id = $2', [p.qty, p.id]);
          } catch (e) {
            console.error('❌ Error updating stock in DEMO_MODE:', e.message);
          }
        }
      }
    }

    // Send notification to user
    const userId = order.user_id;
    const pubgId = order.pubg_id;
    const itemsText = products.map(p =>
      `📦 ${p.name || p.title} x${p.qty} — ${p.price * p.qty} ₽`
    ).join('\n');

    try {
      await bot.telegram.sendMessage(userId, `\n🧾 Заказ подтверждён:\n\n🎮 PUBG ID: ${pubgId}\n${itemsText}\n\n💰 Сумма: ${AMOUNT} ₽\n✅ Оплата получена. Ваш заказ скоро будет выполнен.\n    `);
    } catch (botError) {
      // Handle specific Telegram bot errors gracefully
      if (botError.message.includes('chat not found') || 
          botError.message.includes('bot was blocked') ||
          botError.message.includes('user is deactivated')) {
        console.warn('⚠️ Telegram bot could not notify user:', botError.message);
        // Do not return 500, just log and continue
      } else {
        console.error('❌ Telegram bot error:', botError.message);
        return res.status(500).send('Internal Server Error (bot)');
      }
    }

    console.log('✅ Payment confirmed and order updated:', MERCHANT_ORDER_ID, AMOUNT);
    res.setHeader('Content-Type', 'text/plain');
    res.send('YES');
  } catch (err) {
    console.error('❌ Error processing payment:', err.message);
    // Set order status to unpaid if order exists
    try {
      const result = await pool.query('SELECT * FROM orders WHERE id = $1', [MERCHANT_ORDER_ID]);
      if (result.rows.length > 0) {
        await pool.query('UPDATE orders SET status = $1 WHERE id = $2', ['unpaid', MERCHANT_ORDER_ID]);
      }
    } catch (e) { /* ignore */ }
    return res.status(500).send('Internal Server Error');
  }
  console.log('>>> End of callback.js handler');
} 