import { Pool } from 'pg';
import callbackHandler from './callback.js';
import crypto from 'crypto';

const pool = new Pool({
  connectionString: process.env.DB_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

export default async function handler(req, res) {
  if (process.env.DEMO_MODE !== 'true') {
    return res.status(403).send('Demo mode is not enabled.');
  }

  const { orderId } = req.query;
  if (!orderId) {
    return res.status(400).send('Order ID is required.');
  }

  if (req.method === 'GET') {
    // Show confirmation page
    return res.send(`
      <html>
        <head><title>Demo Payment</title></head>
        <body style="font-family:sans-serif;text-align:center;padding-top:40px;">
          <h2>Демо-оплата</h2>
          <p>Нажмите кнопку ниже, чтобы подтвердить оплату заказа #${orderId}.</p>
          <form method="POST">
            <button type="submit" style="font-size:1.2em;padding:10px 30px;">Подтвердить оплату</button>
          </form>
        </body>
      </html>
    `);
  }

  if (req.method !== 'POST') {
    return res.status(405).send('Method Not Allowed');
  }

  try {
    // Get order
    const result = await pool.query('SELECT * FROM orders WHERE id = $1', [orderId]);
    const order = result.rows[0];
    if (!order) {
      return res.status(404).send('Order not found.');
    }

    if (order.status === 'confirmed') {
      return res.send('<h2>Order already marked as paid!</h2>');
    }

    // Parse products robustly
    let products;
    if (Array.isArray(order.products)) {
      products = order.products;
    } else if (typeof order.products === 'string') {
      try {
        products = JSON.parse(order.products);
      } catch (e) {
        await pool.query('UPDATE orders SET status = $1 WHERE id = $2', ['error', orderId]);
        return res.status(500).send('Order products data error.');
      }
    } else if (typeof order.products === 'object' && order.products !== null) {
      products = Object.values(order.products);
    } else {
      await pool.query('UPDATE orders SET status = $1 WHERE id = $2', ['error', orderId]);
      return res.status(500).send('Order products data error.');
    }

    // Update order status
    await pool.query('UPDATE orders SET status = $1 WHERE id = $2', ['pending', orderId]);

    // Decrease stock for UC_by_id products
    for (const p of products) {
      if (p.category === 'uc_by_id') {
        try {
          await pool.query('UPDATE products SET stock = stock - $1 WHERE id = $2', [p.qty, p.id]);
        } catch (e) {
          await pool.query('UPDATE orders SET status = $1 WHERE id = $2', ['error', orderId]);
          return res.status(500).send('Stock update error.');
        }
      }
    }

    // --- Call Freekassa callback logic to trigger code activation and notification ---
    console.log('🟡 Calling Freekassa callback for demo order:', orderId);
    const fakeReq = {
      method: 'POST',
      body: {
        MERCHANT_ORDER_ID: orderId,
        AMOUNT: order.total || 0,
        SIGN: crypto.createHash('md5').update(`${orderId}:${order.total || 0}:${process.env.FREEKASSA_SECRET_2}`).digest('hex')
      }
    };
    const fakeRes = {
      setHeader: () => {},
      status: () => ({ send: () => {} }),
      send: () => {}
    };
    await callbackHandler(fakeReq, fakeRes);
    console.log('🟢 Freekassa callback finished for demo order:', orderId);
    // --- End Freekassa callback logic ---

    res.send('<h2>✅ Order marked as paid!<br>Stock updated for UC_by_id products.<br>Code activation and notification triggered.<br>You can check the admin panel now.</h2>');
  } catch (err) {
    console.error('Demo pay error:', err.message);
    try {
      await pool.query('UPDATE orders SET status = $1 WHERE id = $2', ['error', orderId]);
    } catch (e) { /* ignore */ }
    res.status(500).send('Internal Server Error');
  }
} 