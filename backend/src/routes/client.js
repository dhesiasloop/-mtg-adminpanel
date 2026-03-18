const express = require('express');
const router = express.Router();
const db = require('../db');
const auth = require('../auth-customer');
const mailer = require('../mailer');
const yookassa = require('../yookassa');
const ssh = require('../ssh');

// ── Rate limiting (simple in-memory) ──────────────────────
const rateLimits = {};
function rateLimit(key, maxAttempts, windowMs) {
  const now = Date.now();
  if (!rateLimits[key]) rateLimits[key] = [];
  rateLimits[key] = rateLimits[key].filter(t => t > now - windowMs);
  if (rateLimits[key].length >= maxAttempts) return false;
  rateLimits[key].push(now);
  return true;
}

// ═══════════════════════════════════════════════════════════
// PUBLIC CONFIG
// ═══════════════════════════════════════════════════════════

router.get('/config', (req, res) => {
  res.json({
    telegram_bot_username: process.env.TELEGRAM_BOT_USERNAME || null,
  });
});

// ═══════════════════════════════════════════════════════════
// AUTH
// ═══════════════════════════════════════════════════════════

router.post('/auth/register', async (req, res) => {
  try {
    const { email, password, name } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email и пароль обязательны' });
    if (password.length < 6) return res.status(400).json({ error: 'Пароль минимум 6 символов' });

    const ip = req.ip || 'unknown';
    if (!rateLimit(`reg:${ip}`, 5, 3600000)) {
      return res.status(429).json({ error: 'Слишком много попыток. Попробуйте позже.' });
    }

    const existing = db.prepare('SELECT id FROM customers WHERE email = ?').get(email.toLowerCase().trim());
    if (existing) return res.status(409).json({ error: 'Email уже зарегистрирован' });

    const passwordHash = await auth.hashPassword(password);
    const verifyToken = auth.generateEmailToken();
    const verifyExpires = new Date(Date.now() + 86400000).toISOString(); // 24h

    const result = db.prepare(
      `INSERT INTO customers (email, password_hash, name, email_verify_token, email_verify_expires)
       VALUES (?, ?, ?, ?, ?)`
    ).run(email.toLowerCase().trim(), passwordHash, name || null, verifyToken, verifyExpires);

    await mailer.sendVerificationEmail(email, verifyToken);
    res.json({ ok: true, message: 'Проверьте почту для подтверждения email' });
  } catch (e) {
    console.error('Register error:', e);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

router.get('/auth/verify-email', (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(400).json({ error: 'Токен не указан' });

  const customer = db.prepare(
    'SELECT * FROM customers WHERE email_verify_token = ? AND email_verify_expires > datetime(?)'
  ).get(token, new Date().toISOString());

  if (!customer) return res.status(400).json({ error: 'Токен истёк или невалиден' });

  db.prepare(
    'UPDATE customers SET email_verified = 1, email_verify_token = NULL, email_verify_expires = NULL WHERE id = ?'
  ).run(customer.id);

  res.json({ ok: true, message: 'Email подтверждён! Можете войти.' });
});

router.post('/auth/resend-verification', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email обязателен' });

  const ip = req.ip || 'unknown';
  if (!rateLimit(`resend:${ip}`, 3, 3600000)) {
    return res.status(429).json({ error: 'Слишком много попыток' });
  }

  const customer = db.prepare('SELECT * FROM customers WHERE email = ? AND email_verified = 0').get(email.toLowerCase().trim());
  if (!customer) return res.json({ ok: true }); // don't reveal if exists

  const verifyToken = auth.generateEmailToken();
  const verifyExpires = new Date(Date.now() + 86400000).toISOString();

  db.prepare('UPDATE customers SET email_verify_token = ?, email_verify_expires = ? WHERE id = ?')
    .run(verifyToken, verifyExpires, customer.id);

  await mailer.sendVerificationEmail(email, verifyToken);
  res.json({ ok: true });
});

router.post('/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email и пароль обязательны' });

    const ip = req.ip || 'unknown';
    if (!rateLimit(`login:${ip}`, 10, 900000)) {
      return res.status(429).json({ error: 'Слишком много попыток. Подождите 15 минут.' });
    }

    const customer = db.prepare('SELECT * FROM customers WHERE email = ?').get(email.toLowerCase().trim());
    if (!customer || !customer.password_hash) {
      return res.status(401).json({ error: 'Неверный email или пароль' });
    }

    if (!customer.email_verified) {
      return res.status(403).json({ error: 'Email не подтверждён. Проверьте почту.', code: 'EMAIL_NOT_VERIFIED' });
    }

    const valid = await auth.verifyPassword(password, customer.password_hash);
    if (!valid) return res.status(401).json({ error: 'Неверный email или пароль' });

    if (customer.status !== 'active') {
      return res.status(403).json({ error: 'Аккаунт заблокирован' });
    }

    const accessToken = auth.signAccessToken(customer);
    const refresh = auth.signRefreshToken(customer);

    db.prepare("UPDATE customers SET last_login_at = datetime('now') WHERE id = ?").run(customer.id);

    res.json({
      accessToken,
      refreshToken: refresh.token,
      customer: sanitizeCustomer(customer),
    });
  } catch (e) {
    console.error('Login error:', e);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

router.post('/auth/telegram', (req, res) => {
  try {
    const data = req.body;
    if (!auth.verifyTelegramAuth(data)) {
      return res.status(401).json({ error: 'Невалидные данные Telegram' });
    }

    const telegramId = String(data.id);
    let customer = db.prepare('SELECT * FROM customers WHERE telegram_id = ?').get(telegramId);

    if (!customer) {
      // Register new customer via Telegram (no email required)
      const result = db.prepare(
        `INSERT INTO customers (telegram_id, telegram_username, name, email_verified, status)
         VALUES (?, ?, ?, 1, 'active')`
      ).run(telegramId, data.username || null, data.first_name || data.username || null);
      customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(result.lastInsertRowid);
    }

    if (customer.status !== 'active') {
      return res.status(403).json({ error: 'Аккаунт заблокирован' });
    }

    const accessToken = auth.signAccessToken(customer);
    const refresh = auth.signRefreshToken(customer);

    db.prepare("UPDATE customers SET last_login_at = datetime('now') WHERE id = ?").run(customer.id);

    res.json({
      accessToken,
      refreshToken: refresh.token,
      customer: sanitizeCustomer(customer),
    });
  } catch (e) {
    console.error('Telegram auth error:', e);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

router.post('/auth/refresh', (req, res) => {
  const { refreshToken } = req.body;
  if (!refreshToken) return res.status(400).json({ error: 'Refresh token обязателен' });

  const result = auth.verifyRefreshToken(refreshToken);
  if (!result) return res.status(401).json({ error: 'Невалидный refresh token' });

  const customer = db.prepare('SELECT * FROM customers WHERE id = ? AND status = ?').get(result.payload.sub, 'active');
  if (!customer) return res.status(401).json({ error: 'Аккаунт не найден' });

  // Rotate: revoke old, issue new
  auth.revokeRefreshToken(refreshToken);
  const accessToken = auth.signAccessToken(customer);
  const refresh = auth.signRefreshToken(customer);

  res.json({ accessToken, refreshToken: refresh.token });
});

router.post('/auth/logout', (req, res) => {
  const { refreshToken } = req.body;
  if (refreshToken) auth.revokeRefreshToken(refreshToken);
  res.json({ ok: true });
});

router.post('/auth/forgot-password', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email обязателен' });

  const ip = req.ip || 'unknown';
  if (!rateLimit(`forgot:${ip}`, 3, 3600000)) {
    return res.status(429).json({ error: 'Слишком много попыток' });
  }

  const customer = db.prepare('SELECT * FROM customers WHERE email = ?').get(email.toLowerCase().trim());
  if (customer) {
    const token = auth.generateEmailToken();
    const expires = new Date(Date.now() + 3600000).toISOString(); // 1h
    db.prepare('UPDATE customers SET email_verify_token = ?, email_verify_expires = ? WHERE id = ?')
      .run(token, expires, customer.id);
    await mailer.sendPasswordResetEmail(email, token);
  }
  // Don't reveal if email exists
  res.json({ ok: true, message: 'Если email зарегистрирован, вы получите письмо' });
});

router.post('/auth/reset-password', async (req, res) => {
  const { token, password } = req.body;
  if (!token || !password) return res.status(400).json({ error: 'Токен и пароль обязательны' });
  if (password.length < 6) return res.status(400).json({ error: 'Пароль минимум 6 символов' });

  const customer = db.prepare(
    'SELECT * FROM customers WHERE email_verify_token = ? AND email_verify_expires > datetime(?)'
  ).get(token, new Date().toISOString());
  if (!customer) return res.status(400).json({ error: 'Токен истёк или невалиден' });

  const hash = await auth.hashPassword(password);
  db.prepare('UPDATE customers SET password_hash = ?, email_verify_token = NULL, email_verify_expires = NULL WHERE id = ?')
    .run(hash, customer.id);

  res.json({ ok: true, message: 'Пароль изменён. Можете войти.' });
});

// ═══════════════════════════════════════════════════════════
// PROFILE (auth required)
// ═══════════════════════════════════════════════════════════

router.get('/profile', auth.authCustomer, (req, res) => {
  res.json(sanitizeCustomer(req.customer));
});

router.put('/profile', auth.authCustomer, (req, res) => {
  const { name } = req.body;
  db.prepare('UPDATE customers SET name = ? WHERE id = ?').run(name || req.customer.name, req.customer.id);
  res.json({ ok: true });
});

router.put('/profile/password', auth.authCustomer, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!newPassword || newPassword.length < 6) {
    return res.status(400).json({ error: 'Новый пароль минимум 6 символов' });
  }

  if (req.customer.password_hash) {
    if (!currentPassword) return res.status(400).json({ error: 'Текущий пароль обязателен' });
    const valid = await auth.verifyPassword(currentPassword, req.customer.password_hash);
    if (!valid) return res.status(400).json({ error: 'Неверный текущий пароль' });
  }

  const hash = await auth.hashPassword(newPassword);
  db.prepare('UPDATE customers SET password_hash = ? WHERE id = ?').run(hash, req.customer.id);
  res.json({ ok: true });
});

router.post('/profile/link-email', auth.authCustomer, async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email обязателен' });

  if (req.customer.email && req.customer.email_verified) {
    return res.status(400).json({ error: 'Email уже привязан' });
  }

  const existing = db.prepare('SELECT id FROM customers WHERE email = ? AND id != ?')
    .get(email.toLowerCase().trim(), req.customer.id);
  if (existing) return res.status(409).json({ error: 'Этот email уже занят' });

  const token = auth.generateEmailToken();
  const expires = new Date(Date.now() + 86400000).toISOString();

  db.prepare(
    'UPDATE customers SET email = ?, email_verified = 0, email_verify_token = ?, email_verify_expires = ? WHERE id = ?'
  ).run(email.toLowerCase().trim(), token, expires, req.customer.id);

  await mailer.sendLinkEmailVerification(email, token);
  res.json({ ok: true, message: 'Проверьте почту для подтверждения' });
});

router.post('/profile/link-telegram', auth.authCustomer, (req, res) => {
  try {
    const data = req.body;
    if (!auth.verifyTelegramAuth(data)) {
      return res.status(401).json({ error: 'Невалидные данные Telegram' });
    }

    if (req.customer.telegram_id) {
      return res.status(400).json({ error: 'Telegram уже привязан' });
    }

    const telegramId = String(data.id);
    const existing = db.prepare('SELECT id FROM customers WHERE telegram_id = ? AND id != ?')
      .get(telegramId, req.customer.id);
    if (existing) return res.status(409).json({ error: 'Этот Telegram уже привязан к другому аккаунту' });

    db.prepare(
      'UPDATE customers SET telegram_id = ?, telegram_username = ? WHERE id = ?'
    ).run(telegramId, data.username || null, req.customer.id);

    const updated = db.prepare('SELECT * FROM customers WHERE id = ?').get(req.customer.id);
    res.json({ ok: true, customer: sanitizeCustomer(updated) });
  } catch (e) {
    console.error('Link telegram error:', e);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

router.post('/profile/unlink-telegram', auth.authCustomer, (req, res) => {
  if (!req.customer.telegram_id) {
    return res.status(400).json({ error: 'Telegram не привязан' });
  }
  // Require email+password to exist (so user doesn't lose access)
  if (!req.customer.email || !req.customer.password_hash) {
    return res.status(400).json({ error: 'Сначала привяжите email и установите пароль, чтобы не потерять доступ' });
  }
  db.prepare('UPDATE customers SET telegram_id = NULL, telegram_username = NULL WHERE id = ?').run(req.customer.id);
  const updated = db.prepare('SELECT * FROM customers WHERE id = ?').get(req.customer.id);
  res.json({ ok: true, customer: sanitizeCustomer(updated) });
});

router.get('/profile/verify-link-email', (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(400).json({ error: 'Токен не указан' });

  const customer = db.prepare(
    'SELECT * FROM customers WHERE email_verify_token = ? AND email_verify_expires > datetime(?)'
  ).get(token, new Date().toISOString());

  if (!customer) return res.status(400).json({ error: 'Токен истёк или невалиден' });

  db.prepare(
    'UPDATE customers SET email_verified = 1, email_verify_token = NULL, email_verify_expires = NULL WHERE id = ?'
  ).run(customer.id);

  res.json({ ok: true, message: 'Email успешно привязан!' });
});

// ═══════════════════════════════════════════════════════════
// PLANS & LOCATIONS
// ═══════════════════════════════════════════════════════════

router.get('/plans', (req, res) => {
  const plans = db.prepare('SELECT * FROM plans WHERE is_active = 1 ORDER BY sort_order, price').all();
  res.json(plans);
});

router.get('/locations', (req, res) => {
  const nodes = db.prepare('SELECT id, name, host, flag FROM nodes').all();
  // Group by flag (country) for display
  const locations = {};
  for (const n of nodes) {
    const key = n.flag || '🌍';
    if (!locations[key]) locations[key] = { flag: key, name: n.name, node_ids: [] };
    locations[key].node_ids.push(n.id);
  }
  res.json(Object.values(locations));
});

// ═══════════════════════════════════════════════════════════
// ORDERS
// ═══════════════════════════════════════════════════════════

router.get('/orders', auth.authCustomer, (req, res) => {
  const orders = db.prepare(
    `SELECT o.*, p.name as plan_name, n.name as node_name, n.host as node_host, n.flag as node_flag
     FROM orders o
     LEFT JOIN plans p ON o.plan_id = p.id
     LEFT JOIN nodes n ON o.node_id = n.id
     WHERE o.customer_id = ? ORDER BY o.created_at DESC`
  ).all(req.customer.id);
  res.json(orders);
});

router.get('/orders/:id', auth.authCustomer, (req, res) => {
  const order = db.prepare(
    `SELECT o.*, p.name as plan_name, n.name as node_name, n.host as node_host, n.flag as node_flag
     FROM orders o
     LEFT JOIN plans p ON o.plan_id = p.id
     LEFT JOIN nodes n ON o.node_id = n.id
     WHERE o.id = ? AND o.customer_id = ?`
  ).get(req.params.id, req.customer.id);
  if (!order) return res.status(404).json({ error: 'Заказ не найден' });
  res.json(order);
});

router.post('/orders', auth.authCustomer, (req, res) => {
  const { plan_id, location_flag } = req.body;
  if (!plan_id) return res.status(400).json({ error: 'plan_id обязателен' });

  const plan = db.prepare('SELECT * FROM plans WHERE id = ? AND is_active = 1').get(plan_id);
  if (!plan) return res.status(404).json({ error: 'Тариф не найден' });

  const result = db.prepare(
    `INSERT INTO orders (customer_id, plan_id, status, config, price, currency, period)
     VALUES (?, ?, 'pending', ?, ?, ?, ?)`
  ).run(
    req.customer.id, plan.id,
    JSON.stringify({ location_flag: location_flag || null }),
    plan.price, plan.currency, plan.period
  );

  res.json({ id: result.lastInsertRowid, status: 'pending', price: plan.price, currency: plan.currency });
});

router.put('/orders/:id/auto-renew', auth.authCustomer, (req, res) => {
  const { enabled } = req.body;
  const order = db.prepare('SELECT * FROM orders WHERE id = ? AND customer_id = ?')
    .get(req.params.id, req.customer.id);
  if (!order) return res.status(404).json({ error: 'Заказ не найден' });

  db.prepare('UPDATE orders SET auto_renew = ? WHERE id = ?').run(enabled ? 1 : 0, order.id);
  res.json({ ok: true, auto_renew: enabled ? 1 : 0 });
});

// ═══════════════════════════════════════════════════════════
// PROXIES (customer's active connections)
// ═══════════════════════════════════════════════════════════

router.get('/proxies', auth.authCustomer, (req, res) => {
  const orders = db.prepare(
    `SELECT o.id as order_id, o.status as order_status, o.expires_at, o.auto_renew,
            o.node_id, o.user_name, o.price, o.currency, o.period,
            p.name as plan_name, p.max_devices,
            n.name as node_name, n.host as node_host, n.flag as node_flag,
            u.port, u.secret, u.status as proxy_status, u.last_seen_at,
            u.traffic_rx_snap, u.traffic_tx_snap
     FROM orders o
     LEFT JOIN plans p ON o.plan_id = p.id
     LEFT JOIN nodes n ON o.node_id = n.id
     LEFT JOIN users u ON u.node_id = o.node_id AND u.name = o.user_name
     WHERE o.customer_id = ? AND o.status = 'active'
     ORDER BY o.created_at DESC`
  ).all(req.customer.id);

  res.json(orders.map(o => ({
    ...o,
    link: o.node_host && o.port && o.secret
      ? `tg://proxy?server=${o.node_host}&port=${o.port}&secret=${o.secret}`
      : null,
    expired: o.expires_at ? new Date(o.expires_at) < new Date() : false,
  })));
});

router.get('/proxies/:orderId/stats', auth.authCustomer, async (req, res) => {
  const order = db.prepare('SELECT * FROM orders WHERE id = ? AND customer_id = ? AND status = ?')
    .get(req.params.orderId, req.customer.id, 'active');
  if (!order || !order.node_id || !order.user_name) {
    return res.status(404).json({ error: 'Прокси не найден' });
  }

  const node = db.prepare('SELECT * FROM nodes WHERE id = ?').get(order.node_id);
  if (!node) return res.status(404).json({ error: 'Сервер не найден' });

  try {
    const remoteUsers = await ssh.getRemoteUsers(node);
    const remote = remoteUsers.find(u => u.name === order.user_name);
    const traffic = await ssh.getTraffic(node).catch(() => ({}));
    const t = traffic[order.user_name] || {};

    res.json({
      connections: remote ? remote.connections : 0,
      running: remote ? !remote.status.includes('stopped') : false,
      rx: t.rx || '0B',
      tx: t.tx || '0B',
    });
  } catch {
    res.json({ connections: 0, running: false, rx: '0B', tx: '0B' });
  }
});

router.get('/proxies/:orderId/history', auth.authCustomer, (req, res) => {
  const order = db.prepare('SELECT * FROM orders WHERE id = ? AND customer_id = ?')
    .get(req.params.orderId, req.customer.id);
  if (!order || !order.user_name) return res.status(404).json({ error: 'Не найдено' });

  const rows = db.prepare(
    'SELECT connections, recorded_at FROM connections_history WHERE node_id = ? AND user_name = ? ORDER BY recorded_at DESC LIMIT 48'
  ).all(order.node_id, order.user_name);
  res.json(rows.reverse());
});

router.get('/proxies/:orderId/ping', auth.authCustomer, async (req, res) => {
  const order = db.prepare('SELECT * FROM orders WHERE id = ? AND customer_id = ? AND status = ?')
    .get(req.params.orderId, req.customer.id, 'active');
  if (!order || !order.node_id) return res.status(404).json({ error: 'Прокси не найден' });

  const node = db.prepare('SELECT * FROM nodes WHERE id = ?').get(order.node_id);
  if (!node) return res.status(404).json({ error: 'Сервер не найден' });

  try {
    const start = Date.now();
    await new Promise((resolve, reject) => {
      const net = require('net');
      const sock = net.createConnection({ host: node.host, port: node.port || 22, timeout: 5000 }, () => {
        sock.destroy();
        resolve();
      });
      sock.on('error', reject);
      sock.on('timeout', () => { sock.destroy(); reject(new Error('timeout')); });
    });
    res.json({ ping: Date.now() - start });
  } catch {
    res.json({ ping: -1 });
  }
});

// ═══════════════════════════════════════════════════════════
// PAYMENTS
// ═══════════════════════════════════════════════════════════

router.post('/payments/create', auth.authCustomer, async (req, res) => {
  const { order_id } = req.body;
  if (!order_id) return res.status(400).json({ error: 'order_id обязателен' });

  const order = db.prepare('SELECT * FROM orders WHERE id = ? AND customer_id = ?')
    .get(order_id, req.customer.id);
  if (!order) return res.status(404).json({ error: 'Заказ не найден' });
  if (order.status !== 'pending') return res.status(400).json({ error: 'Заказ уже оплачен или отменён' });

  try {
    const plan = db.prepare('SELECT * FROM plans WHERE id = ?').get(order.plan_id);
    const payment = await yookassa.createPayment({
      amount: order.price,
      currency: order.currency,
      description: plan ? `${plan.name} — ST VILLAGE PROXY` : `Заказ #${order.id}`,
      orderId: order.id,
      customerId: req.customer.id,
    });

    db.prepare(
      'INSERT INTO payments (customer_id, order_id, yookassa_payment_id, amount, currency, status, description) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(req.customer.id, order.id, payment.id, order.price, order.currency, 'pending',
      plan ? plan.name : `Заказ #${order.id}`);

    res.json({
      payment_id: payment.id,
      confirmation_url: payment.confirmation?.confirmation_url,
      status: payment.status,
    });
  } catch (e) {
    console.error('Payment create error:', e);
    res.status(500).json({ error: 'Ошибка при создании платежа: ' + e.message });
  }
});

router.get('/payments', auth.authCustomer, (req, res) => {
  const payments = db.prepare(
    `SELECT p.*, o.id as order_id FROM payments p
     LEFT JOIN orders o ON p.order_id = o.id
     WHERE p.customer_id = ? ORDER BY p.created_at DESC`
  ).all(req.customer.id);
  res.json(payments);
});

// ── Manual payment check (client) ─────────────────────────
router.post('/payments/:id/check', auth.authCustomer, async (req, res) => {
  const payment = db.prepare(
    'SELECT * FROM payments WHERE id = ? AND customer_id = ?'
  ).get(req.params.id, req.customer.id);
  if (!payment) return res.status(404).json({ error: 'Платёж не найден' });
  if (payment.status !== 'pending') return res.json({ status: payment.status, changed: false });

  try {
    const ykPayment = await yookassa.getPayment(payment.yookassa_payment_id);
    const result = await processPaymentStatus(payment, ykPayment);
    res.json(result);
  } catch (e) {
    console.error(`Manual payment check error #${payment.id}:`, e.message);
    res.status(500).json({ error: 'Ошибка проверки платежа' });
  }
});

// ═══════════════════════════════════════════════════════════
// CHANGELOG
// ═══════════════════════════════════════════════════════════

function semverCmp(a, b) {
  const pa = a.replace(/^v/, '').split('.').map(Number);
  const pb = b.replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] || 0, nb = pb[i] || 0;
    if (na !== nb) return nb - na;
  }
  return 0;
}

router.get('/changelog', (req, res) => {
  const rows = db.prepare('SELECT * FROM changelog').all();
  rows.sort((a, b) => semverCmp(a.version, b.version));
  res.json(rows.map(r => ({ ...r, changes: JSON.parse(r.changes) })));
});

router.get('/changelog/unseen', auth.authCustomer, (req, res) => {
  const rows = db.prepare(`
    SELECT c.* FROM changelog c
    WHERE c.version NOT IN (
      SELECT version FROM customer_changelog_seen WHERE customer_id = ?
    )
  `).all(req.customer.id);
  rows.sort((a, b) => semverCmp(a.version, b.version));
  res.json(rows.map(r => ({ ...r, changes: JSON.parse(r.changes) })));
});

router.post('/changelog/:version/seen', auth.authCustomer, (req, res) => {
  try {
    db.prepare(
      'INSERT OR IGNORE INTO customer_changelog_seen (customer_id, version) VALUES (?, ?)'
    ).run(req.customer.id, req.params.version);
    res.json({ ok: true });
  } catch { res.json({ ok: true }); }
});

// ═══════════════════════════════════════════════════════════
// ANNOUNCEMENTS (public)
// ═══════════════════════════════════════════════════════════

router.get('/announcements', (req, res) => {
  const rows = db.prepare('SELECT * FROM announcements WHERE is_active = 1 ORDER BY created_at DESC').all();
  res.json(rows);
});

// ═══════════════════════════════════════════════════════════
// YOOKASSA WEBHOOK (no auth — IP-verified)
// ═══════════════════════════════════════════════════════════

router.post('/webhook/yookassa', async (req, res) => {
  const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';
  if (!yookassa.isWebhookTrusted(clientIp)) {
    console.warn(`⚠️ Untrusted webhook IP: ${clientIp}`);
    return res.status(403).json({ error: 'Forbidden' });
  }

  try {
    const { event, object } = req.body;
    if (!object || !object.id) return res.status(400).json({ error: 'Invalid payload' });

    const paymentId = object.id;
    const dbPayment = db.prepare('SELECT * FROM payments WHERE yookassa_payment_id = ?').get(paymentId);
    if (!dbPayment) {
      console.warn(`Webhook for unknown payment: ${paymentId}`);
      return res.json({ ok: true }); // acknowledge to prevent retries
    }

    if (event === 'payment.succeeded') {
      db.prepare(
        "UPDATE payments SET status = 'succeeded', method = ?, confirmed_at = datetime('now') WHERE id = ?"
      ).run(object.payment_method?.type || 'unknown', dbPayment.id);

      // Activate order
      const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(dbPayment.order_id);
      if (order && order.status === 'pending') {
        await activateOrder(order);
      }

      // Send receipt email
      const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(dbPayment.customer_id);
      if (customer && customer.email && customer.email_verified) {
        mailer.sendPaymentReceiptEmail(customer.email, {
          amount: dbPayment.amount,
          currency: dbPayment.currency,
          description: dbPayment.description,
          orderId: dbPayment.order_id,
        }).catch(e => console.error('Receipt email error:', e));
      }
    } else if (event === 'payment.canceled') {
      db.prepare("UPDATE payments SET status = 'cancelled' WHERE id = ?").run(dbPayment.id);
    }

    res.json({ ok: true });
  } catch (e) {
    console.error('Webhook error:', e);
    res.status(500).json({ error: 'Internal error' });
  }
});

// ═══════════════════════════════════════════════════════════
// ORDER ACTIVATION (provision proxy)
// ═══════════════════════════════════════════════════════════

async function activateOrder(order) {
  try {
    const plan = db.prepare('SELECT * FROM plans WHERE id = ?').get(order.plan_id);
    const config = order.config ? JSON.parse(order.config) : {};

    // Choose node: prefer client's selected location, else least loaded
    let node = null;
    const allNodes = db.prepare('SELECT * FROM nodes').all();

    if (config.location_flag) {
      const candidates = allNodes.filter(n => n.flag === config.location_flag);
      node = candidates.length ? await pickLeastLoadedNode(candidates) : null;
    }
    if (!node) {
      // If plan has location_ids restriction
      if (plan && plan.location_ids && plan.location_ids !== '[]') {
        try {
          const ids = JSON.parse(plan.location_ids);
          if (Array.isArray(ids) && ids.length) {
            const candidates = allNodes.filter(n => ids.includes(n.id));
            node = candidates.length ? await pickLeastLoadedNode(candidates) : null;
          }
        } catch { /* malformed location_ids — skip */ }
      }
    }
    if (!node) {
      node = await pickLeastLoadedNode(allNodes);
    }
    if (!node) throw new Error('Нет доступных серверов');

    // Generate unique username
    const userName = `c${order.customer_id}_${order.id}`;

    // Create proxy via SSH (reuse existing logic)
    const { port, secret } = await ssh.createRemoteUser(node, userName);

    // Calculate expiry
    let expiresAt = new Date();
    const period = plan ? plan.period : order.period;
    if (period === 'daily') expiresAt.setDate(expiresAt.getDate() + 1);
    else if (period === 'monthly') expiresAt.setMonth(expiresAt.getMonth() + 1);
    else if (period === 'yearly') expiresAt.setFullYear(expiresAt.getFullYear() + 1);
    else expiresAt.setMonth(expiresAt.getMonth() + 1); // default monthly

    // Insert into users table (admin panel's existing table)
    db.prepare(
      `INSERT INTO users (node_id, name, port, secret, status, max_devices, traffic_reset_interval, next_reset_at, expires_at)
       VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?)`
    ).run(
      node.id, userName, port, secret,
      plan ? plan.max_devices : 3,
      plan ? plan.traffic_reset_interval : 'monthly',
      calcNextReset(plan ? plan.traffic_reset_interval : 'monthly'),
      expiresAt.toISOString()
    );

    // Update order
    db.prepare(
      `UPDATE orders SET status = 'active', node_id = ?, user_name = ?,
       paid_at = datetime('now'), expires_at = ? WHERE id = ?`
    ).run(node.id, userName, expiresAt.toISOString(), order.id);

    console.log(`✅ Order #${order.id} activated: ${userName} on node ${node.name} (${node.host})`);
  } catch (e) {
    console.error(`❌ Failed to activate order #${order.id}:`, e.message);
    db.prepare("UPDATE orders SET status = 'error' WHERE id = ?").run(order.id);
  }
}

async function pickLeastLoadedNode(nodes) {
  if (!nodes.length) return null;
  if (nodes.length === 1) return nodes[0];

  let best = nodes[0];
  let bestCount = Infinity;
  for (const node of nodes) {
    const count = db.prepare('SELECT COUNT(*) as c FROM users WHERE node_id = ? AND status = ?')
      .get(node.id, 'active').c;
    if (count < bestCount) {
      bestCount = count;
      best = node;
    }
  }
  return best;
}

function calcNextReset(interval) {
  if (!interval || interval === 'never') return null;
  const now = new Date();
  if (interval === 'daily') { now.setDate(now.getDate() + 1); now.setHours(0,0,0,0); }
  if (interval === 'monthly') { now.setMonth(now.getMonth() + 1); now.setDate(1); now.setHours(0,0,0,0); }
  if (interval === 'yearly') { now.setFullYear(now.getFullYear() + 1); now.setMonth(0); now.setDate(1); now.setHours(0,0,0,0); }
  return now.toISOString().replace('T',' ').slice(0,19);
}

// ── Helper ────────────────────────────────────────────────
function sanitizeCustomer(c) {
  return {
    id: c.id,
    email: c.email,
    email_verified: !!c.email_verified,
    telegram_id: c.telegram_id,
    telegram_username: c.telegram_username,
    name: c.name,
    balance: c.balance || 0,
    status: c.status,
    created_at: c.created_at,
  };
}

// ── Process payment status from YooKassa ──────────────────
async function processPaymentStatus(dbPayment, ykPayment) {
  if (ykPayment.status === 'succeeded' && dbPayment.status === 'pending') {
    db.prepare(
      "UPDATE payments SET status = 'succeeded', method = ?, confirmed_at = datetime('now') WHERE id = ?"
    ).run(ykPayment.payment_method?.type || 'unknown', dbPayment.id);

    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(dbPayment.order_id);
    if (order && order.status === 'pending') {
      await activateOrder(order);
    }

    const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(dbPayment.customer_id);
    if (customer && customer.email && customer.email_verified) {
      mailer.sendPaymentReceiptEmail(customer.email, {
        amount: dbPayment.amount,
        currency: dbPayment.currency,
        description: dbPayment.description,
        orderId: dbPayment.order_id,
      }).catch(e => console.error('Receipt email error:', e));
    }

    return { status: 'succeeded', changed: true };
  } else if (ykPayment.status === 'canceled' && dbPayment.status === 'pending') {
    db.prepare("UPDATE payments SET status = 'cancelled' WHERE id = ?").run(dbPayment.id);
    return { status: 'cancelled', changed: true };
  }
  return { status: dbPayment.status, changed: false };
}

// ── Auto-check pending payments (background job) ──────────
async function checkPendingPayments() {
  const pending = db.prepare("SELECT * FROM payments WHERE status = 'pending'").all();
  if (!pending.length) return;

  console.log(`🔄 Checking ${pending.length} pending payment(s)...`);
  for (const payment of pending) {
    try {
      const ykPayment = await yookassa.getPayment(payment.yookassa_payment_id);
      const result = await processPaymentStatus(payment, ykPayment);
      if (result.changed) {
        console.log(`  💰 Payment #${payment.id} → ${result.status}`);
      }
    } catch (e) {
      console.error(`  ⚠️ Failed to check payment #${payment.id}:`, e.message);
    }
  }
}

// ── Auto-renewal background job ───────────────────────────
async function processAutoRenewals() {
  const soon = new Date(Date.now() + 86400000).toISOString(); // 24h from now
  const orders = db.prepare(
    `SELECT o.*, c.email, c.email_verified FROM orders o
     JOIN customers c ON o.customer_id = c.id
     WHERE o.auto_renew = 1 AND o.status = 'active'
     AND o.expires_at IS NOT NULL AND o.expires_at < datetime(?)`
  ).all(soon);

  for (const order of orders) {
    try {
      // Send reminder email with payment link
      if (order.email && order.email_verified) {
        const daysLeft = Math.max(0, Math.ceil((new Date(order.expires_at) - Date.now()) / 86400000));
        await mailer.sendSubscriptionExpiringEmail(order.email, {
          daysLeft,
          orderName: order.user_name || `Заказ #${order.id}`,
        });
        console.log(`📧 Auto-renewal reminder sent for order #${order.id}`);
      }
    } catch (e) {
      console.error(`Auto-renewal error for order #${order.id}:`, e.message);
    }
  }
}

// Export for use in app.js
router.processAutoRenewals = processAutoRenewals;
router.checkPendingPayments = checkPendingPayments;

module.exports = router;
