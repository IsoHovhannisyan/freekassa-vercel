import { Pool } from 'pg';
import crypto from 'crypto';
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

  const {
    MERCHANT_ID,
    AMOUNT,
    MERCHANT_ORDER_ID,
    SIGN
  } = req.body;

  // Verify Freekassa signature
  const hashString = `${MERCHANT_ID}:${AMOUNT}:${process.env.FREEKASSA_SECRET}:${MERCHANT_ORDER_ID}`;
  const expectedSign = crypto.createHash('md5').update(hashString).digest('hex');

  if (expectedSign !== SIGN) {
    console.warn('❌ Invalid sign from Freekassa!', {
      received: SIGN,
      expected: expectedSign,
      hashString
    });
    return res.status(403).send('Invalid sign');
  }

  try {
    // Get order
    const result = await pool.query('SELECT * FROM orders WHERE id = $1', [MERCHANT_ORDER_ID]);
    const order = result.rows[0];

    if (!order) {
      console.warn(`❌ Order ${MERCHANT_ORDER_ID} not found`);
      return res.status(404).send('Order not found');
    }

    if (order.status === 'confirmed') {
      return res.send('Already confirmed');
    }

    // Parse products
    let products;
    try {
      products = Array.isArray(order.products) ? order.products : JSON.parse(order.products);
    } catch (e) {
      console.error('❌ Error parsing order.products:', e.message);
      return res.status(500).send('Order data error');
    }

    // Update order status to pending
    await pool.query('UPDATE orders SET status = $1 WHERE id = $2', ['pending', MERCHANT_ORDER_ID]);

    // Process each product
    const results = [];
    for (const product of products) {
      if (product.category === 'uc_by_id') {
        try {
          // Redeem code through SyNet API
          const redemption = await redeemCode(order.pubg_id, product.codeType || 'UC');
          
          if (redemption.success) {
            results.push({
              product: product.name,
              status: 'success',
              data: redemption.data
            });
          } else {
            results.push({
              product: product.name,
              status: 'error',
              error: redemption.error
            });
          }
        } catch (err) {
          console.error(`❌ Error redeeming code for product ${product.name}:`, err);
          results.push({
            product: product.name,
            status: 'error',
            error: err.message
          });
        }
      }
    }

    // Prepare notification message
    const userId = order.user_id;
    const pubgId = order.pubg_id;
    const itemsText = products.map(p =>
      `📦 ${p.name} x${p.qty} — ${p.price * p.qty} ₽`
    ).join('\n');

    // Add redemption results to message
    const redemptionResults = results
      .map(r => `${r.status === 'success' ? '✅' : '❌'} ${r.product}: ${r.status === 'success' ? 'Активирован' : r.error}`)
      .join('\n');

    await bot.telegram.sendMessage(userId, `
🧾 Заказ подтверждён:

🎮 PUBG ID: ${pubgId}
${itemsText}

💰 Сумма: ${AMOUNT} ₽
✅ Оплата получена.

Результаты активации:
${redemptionResults}
    `);

    // Update order status based on results
    const hasErrors = results.some(r => r.status === 'error');
    const newStatus = hasErrors ? 'error' : 'delivered';
    await pool.query('UPDATE orders SET status = $1 WHERE id = $2', [newStatus, MERCHANT_ORDER_ID]);

    return res.send('YES');
  } catch (err) {
    console.error('❌ Error in Freekassa callback:', err.message);
    return res.status(500).send('Internal Server Error');
  }
}

// Helper function to redeem codes
async function redeemCode(playerId, codeType) {
  // DEMO MODE: Always return a mock successful response
  if (process.env.DEMO_MODE === 'true') {
    console.log('✅ SyNet API mock response used (in demo mode) for playerId:', playerId, 'codeType:', codeType);
    return {
      success: true,
      data: {
        success: true,
        warning: false,
        took: 123,
        playerId: playerId,
        code: 'MOCK-UC-123',
        openid: 'mock_openid',
        name: 'DemoPlayer',
        region: 'EU',
        productName: codeType || '60uc',
        amount: 60,
        uid: 'mock_uid',
        email: 'demo@example.com',
        password: 'mockpassword'
      }
    };
  }

  try {
    const response = await fetch('https://synet.syntex-dev.ru/redeemDb', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.CHARACTER_API_TOKEN}`
      },
      body: JSON.stringify({
        codeType,
        playerId
      })
    });

    const data = await response.json();

    if (data.success) {
      return {
        success: true,
        data: data.data
      };
    } else {
      throw new Error(data.error || 'Unknown error');
    }
  } catch (error) {
    console.error('❌ SyNet API error:', error);
    return {
      success: false,
      error: error.message
    };
  }
} 