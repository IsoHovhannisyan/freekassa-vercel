const { Pool } = require('pg');

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

    // Update order status
    await pool.query('UPDATE orders SET status = $1 WHERE id = $2', ['confirmed', orderId]);

    // Decrease stock for UC_by_id products
    const products = JSON.parse(order.products);
    for (const p of products) {
      if (p.category === 'uc_by_id') {
        await pool.query('UPDATE products SET stock = stock - $1 WHERE id = $2', [p.qty, p.id]);
      }
    }

    res.send('<h2>✅ Order marked as paid!<br>Stock updated for UC_by_id products.<br>You can check the admin panel now.</h2>');
  } catch (err) {
    console.error('Demo pay error:', err.message);
    res.status(500).send('Internal Server Error');
  }
} 