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

console.log('>>> Entered callback.js handler');

export default async function handler(req, res) {
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
    // Set order status to unpaid if order exists
    try {
      const result = await pool.query('SELECT * FROM orders WHERE id = $1', [MERCHANT_ORDER_ID]);
      if (result.rows.length > 0) {
        await pool.query('UPDATE orders SET status = $1 WHERE id = $2', ['unpaid', MERCHANT_ORDER_ID]);
      }
    } catch (e) { /* ignore */ }
    return res.status(400).send('Payment verification failed: missing secret');
  }

  // Verify required fields
  if (
    typeof MERCHANT_ORDER_ID === 'undefined' ||
    typeof AMOUNT === 'undefined' ||
    typeof SIGN === 'undefined'
  ) {
    console.log('>>> Returning early at missing required fields');
    // Set order status to unpaid if order exists
    try {
      const result = await pool.query('SELECT * FROM orders WHERE id = $1', [MERCHANT_ORDER_ID]);
      if (result.rows.length > 0) {
        await pool.query('UPDATE orders SET status = $1 WHERE id = $2', ['unpaid', MERCHANT_ORDER_ID]);
      }
    } catch (e) { /* ignore */ }
    return res.status(400).send('Payment verification failed: missing required fields');
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
    return res.status(403).send('Payment verification failed: invalid signature');
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

    // Update order status
    await pool.query('UPDATE orders SET status = $1 WHERE id = $2', ['pending', MERCHANT_ORDER_ID]);

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

    // DEMO_MODE: Mock activation step
    if (process.env.DEMO_MODE === 'true') {
      let activationSuccess = true;
      let activationError = null;
      console.log('🔔 [DEMO_MODE] Running mock activation for order', MERCHANT_ORDER_ID);
      try {
        // Simulate activation logic (90% success rate)
        if (Math.random() < 0.9) {
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

        // Send delivery notification to user
        try {
          const deliveryMessage = `✅ <b>Ваш заказ доставлен!</b>\n\n` +
            `🎮 PUBG ID: <code>${order.pubg_id}</code>\n` +
            `${order.nickname ? `👤 Никнейм: ${order.nickname}\n` : ''}` +
            `${itemsText}\n\n` +
            `💰 Сумма: ${AMOUNT} ₽\n\n` +
            `Спасибо за покупку! 🎉\n\n` +
            `💬 Оставьте отзыв о нашем сервисе: @Isohovhannisyan`;

          await bot.telegram.sendMessage(order.user_id, deliveryMessage, { parse_mode: 'HTML' });
          console.log(`✅ Sent delivery notification to user ${order.user_id}`);
        } catch (err) {
          console.error(`❌ Failed to send delivery notification to user ${order.user_id}:`, err.message);
        }
      } else {
        await pool.query('UPDATE orders SET status = $1 WHERE id = $2', ['error', MERCHANT_ORDER_ID]);
        console.log(`🛑 Order ${MERCHANT_ORDER_ID} status set to error.`);

        // --- MANAGER NOTIFICATION ON UC ACTIVATION ERROR ---
        if (products.some(p => p.category === 'uc_by_id')) {
          // Get manager IDs from env
          let managerIds = [];
          if (process.env.MANAGER_CHAT_ID) managerIds.push(process.env.MANAGER_CHAT_ID);
          if (process.env.MANAGER_IDS) managerIds = managerIds.concat(process.env.MANAGER_IDS.split(','));
          managerIds = [...new Set(managerIds.filter(Boolean))];

          // Fetch user info (if available)
          let userInfo = null;
          try {
            const userRes = await pool.query('SELECT username FROM users WHERE telegram_id = $1', [order.user_id]);
            userInfo = userRes.rows[0];
          } catch (e) { userInfo = null; }

          const itemsText = products.map(p =>
            `📦 ${p.name || p.title} x${p.qty} — ${p.price * p.qty} ₽`
          ).join('\n');

          const managerMessage = `❌ <b>Ошибка активации заказа (UC)</b>\n\n` +
            `ID заказа: <b>${order.id}</b>\n` +
            `🎮 PUBG ID: <code>${order.pubg_id}</code>\n` +
            `${order.nickname ? `👤 Никнейм: ${order.nickname}\n` : ''}` +
            `${userInfo ? `🆔 Telegram: <b>${order.user_id}</b> ${userInfo.username ? `(@${userInfo.username})` : ''}\n` : ''}` +
            `${itemsText}\n\n` +
            `💰 Сумма: ${AMOUNT} ₽\n` +
            `⚠️ <b>Ошибка активации:</b>\n${activationError}`;

          for (const managerId of managerIds) {
            try {
              await bot.telegram.sendMessage(managerId, managerMessage, { parse_mode: 'HTML' });
              console.log(`✅ Sent UC activation error notification to manager ${managerId}`);
            } catch (err) {
              console.error(`❌ Failed to send UC activation error to manager ${managerId}:`, err.message);
            }
          }
        }
      }
    }

    console.log('>>> About to set status to pending and run activation');
    console.log('✅ Payment confirmed and order updated:', MERCHANT_ORDER_ID, AMOUNT);
    res.setHeader('Content-Type', 'text/plain');
    console.log('>>> Finished activation block, about to parse products and send notification');
    res.send('YES');
  } catch (err) {
    console.log('>>> Returning at catch block');
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
} 