import { Router } from 'express';
import { createClient } from '@supabase/supabase-js';
import { Resend } from 'resend';
import { validate, createOrderSchema } from '../middleware/validate.js';
import rateLimit from 'express-rate-limit';

const router = Router();

const orderLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: 'Too many order attempts. Please try again later.' },
});

function getSupabase() {
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );
}

function getShippingFee(subtotal) {
  const threshold = Number(process.env.FREE_SHIPPING_THRESHOLD || 15000);
  const fee = Number(process.env.DEFAULT_SHIPPING_FEE || 250);
  return subtotal >= threshold ? 0 : fee;
}

async function sendAdminNotification(order, items) {
  const apiKey = process.env.RESEND_API_KEY;
  const adminEmail = process.env.ADMIN_EMAIL;
  const from = process.env.EMAIL_FROM || 'orders@watchstore.local';

  if (!apiKey || !adminEmail) {
    console.warn('[Email] RESEND_API_KEY or ADMIN_EMAIL not configured — skipping notification');
    return { sent: false, reason: 'not_configured' };
  }

  const resend = new Resend(apiKey);
  const itemLines = items
    .map((i) => `• ${i.product_name} × ${i.quantity} — PKR ${Number(i.line_total).toLocaleString()}`)
    .join('\n');

  const subject = `New Watch Order Received — ${order.order_number}`;
  const body = `
A new order has been placed.

Order Number: ${order.order_number}
Customer: ${order.customer_name}
Email: ${order.customer_email}
Phone: ${order.customer_phone || 'N/A'}

Items:
${itemLines}

Subtotal: PKR ${Number(order.subtotal).toLocaleString()}
Shipping: PKR ${Number(order.shipping_fee).toLocaleString()}
Total: PKR ${Number(order.total_amount).toLocaleString()}
Payment: ${order.payment_method.toUpperCase()}
City: ${order.city}
Created: ${new Date(order.created_at).toLocaleString()}

View in admin dashboard: ${process.env.ADMIN_FRONTEND_URL || 'http://localhost:5174'}/orders/${order.id}
`.trim();

  const supabase = getSupabase();
  try {
    const { data, error } = await resend.emails.send({
      from,
      to: adminEmail,
      subject,
      text: body,
    });

    await supabase.from('watch-email-log').insert({
      order_id: order.id,
      recipient: adminEmail,
      subject,
      status: error ? 'failed' : 'sent',
      provider_response: error || data,
      attempts: 1,
    });

    if (error) {
      console.error('[Email] Failed:', error);
      return { sent: false, error };
    }

    await supabase
      .from('watch-orders')
      .update({ email_notified: true })
      .eq('id', order.id);

    return { sent: true, id: data?.id };
  } catch (err) {
    console.error('[Email] Exception:', err.message);
    await supabase.from('watch-email-log').insert({
      order_id: order.id,
      recipient: adminEmail,
      subject,
      status: 'failed',
      provider_response: { message: err.message },
      attempts: 1,
    });
    return { sent: false, error: err.message };
  }
}

// POST /api/orders — create order (server calculates prices)
router.post('/', orderLimiter, validate(createOrderSchema), async (req, res, next) => {
  try {
    const supabase = getSupabase();
    const body = req.validated;

    // Fetch current product prices server-side (never trust client)
    const productIds = body.items.map((i) => i.product_id);
    const { data: products, error: prodErr } = await supabase
      .from('watch-products')
      .select('id, name, price, stock_quantity, sku, is_active')
      .in('id', productIds)
      .eq('is_active', true);

    if (prodErr) throw prodErr;
    if (!products || products.length !== productIds.length) {
      return res.status(400).json({ error: 'One or more products are unavailable' });
    }

    const productMap = Object.fromEntries(products.map((p) => [p.id, p]));
    let subtotal = 0;
    for (const item of body.items) {
      const p = productMap[item.product_id];
      if (!p) return res.status(400).json({ error: `Product not found: ${item.product_id}` });
      if (p.stock_quantity < item.quantity) {
        return res.status(409).json({
          error: `Insufficient stock for ${p.name}. Available: ${p.stock_quantity}`,
        });
      }
      subtotal += Number(p.price) * item.quantity;
    }

    const shipping_fee = getShippingFee(subtotal);
    const discount_amount = 0; // extend later with real promo codes
    const itemsJson = body.items.map((i) => ({
      product_id: i.product_id,
      quantity: i.quantity,
    }));

    const { data: result, error: orderErr } = await supabase.rpc('create_watch_order', {
      p_customer_name: body.customer_name,
      p_customer_email: body.customer_email,
      p_customer_phone: body.customer_phone || null,
      p_shipping_address: body.shipping_address,
      p_city: body.city,
      p_postal_code: body.postal_code || null,
      p_country: body.country || 'Pakistan',
      p_shipping_fee: shipping_fee,
      p_discount_amount: discount_amount,
      p_payment_method: body.payment_method || 'cod',
      p_idempotency_key: body.idempotency_key || null,
      p_items: itemsJson,
    });

    if (orderErr) {
      console.error('[Order RPC]', orderErr);
      return res.status(400).json({ error: orderErr.message || 'Failed to create order' });
    }

    if (!result?.success) {
      return res.status(400).json({ error: 'Order creation failed' });
    }

    // Fetch full order + items for response and email
    const { data: order } = await supabase
      .from('watch-orders')
      .select('*')
      .eq('id', result.order_id)
      .single();

    const { data: orderItems } = await supabase
      .from('watch-order-items')
      .select('*')
      .eq('order_id', result.order_id);

    // Fire-and-forget email (order already persisted)
    if (!result.duplicate && order) {
      sendAdminNotification(order, orderItems || []).catch(console.error);
    }

    res.status(result.duplicate ? 200 : 201).json({
      success: true,
      duplicate: !!result.duplicate,
      order: {
        id: order.id,
        order_number: order.order_number,
        total_amount: order.total_amount,
        subtotal: order.subtotal,
        shipping_fee: order.shipping_fee,
        payment_method: order.payment_method,
        order_status: order.order_status,
        created_at: order.created_at,
      },
      items: orderItems || [],
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/orders/:orderNumber — track order (email verification required)
router.get('/:orderNumber', async (req, res, next) => {
  try {
    const supabase = getSupabase();
    const { orderNumber } = req.params;
    const email = (req.query.email || '').toString().trim().toLowerCase();

    if (!email) {
      return res.status(400).json({ error: 'Email is required to track this order' });
    }

    const { data: order, error } = await supabase
      .from('watch-orders')
      .select('id, order_number, customer_name, order_status, payment_status, total_amount, created_at, city, country')
      .eq('order_number', orderNumber)
      .ilike('customer_email', email)
      .maybeSingle();

    if (error) throw error;
    if (!order) return res.status(404).json({ error: 'Order not found or email does not match' });

    const { data: items } = await supabase
      .from('watch-order-items')
      .select('product_name, quantity, unit_price, line_total')
      .eq('order_id', order.id);

    res.json({ order, items: items || [] });
  } catch (err) {
    next(err);
  }
});

export default router;
