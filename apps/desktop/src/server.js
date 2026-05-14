const express = require('express');
const cors = require('cors');
const path = require('path');
const { app: electronApp } = require('electron');
const { getDb } = require('./database');
const { analyzeItem } = require('./analysis');
const { startCrawler, stopCrawler, pauseCrawler, resumeCrawler, updateCookie, crawlMarketPage, crawlItemPrice } = require('./crawler');
const { sendWeChatNotification, sendNativeNotification, formatSignalMessage, setPushPlusToken } = require('./notification');
const Store = require('electron-store');

const store = new Store();
let server = null;

function startServer() {
  return new Promise((resolve, reject) => {
    const app = express();
    app.use(cors());
    app.use(express.json());

    const isDev = !electronApp.isPackaged;
    if (!isDev) {
      const webPath = path.join(process.resourcesPath, 'web');
      app.use(express.static(webPath));
    }

    // Health check
    app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));

    // Dashboard
    app.get('/api/dashboard', (_req, res) => {
      try {
        const db = getDb();
        const portfolio = db.prepare(`SELECT COUNT(*) as total_holdings, COALESCE(SUM(buy_price * quantity), 0) as total_invested FROM portfolio WHERE status = 'holding'`).get();
        const recentAlerts = db.prepare(`SELECT al.id, i.name as item_name, al.message, al.current_price, al.triggered_at FROM alert_logs al JOIN items i ON i.id = al.item_id ORDER BY al.triggered_at DESC LIMIT 10`).all();
        const watchedItems = db.prepare(`SELECT COUNT(*) as count FROM items WHERE watch_priority IN ('high', 'normal')`).get().count;
        res.json({ portfolio, recentAlerts, watchedItems });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    // Items
    app.get('/api/items', (req, res) => {
      try {
        const db = getDb();
        const { search, game, page = '1', limit = '50' } = req.query;
        const offset = (parseInt(page) - 1) * parseInt(limit);
        let sql = `SELECT * FROM items WHERE 1=1`;
        const params = [];
        if (game) { sql += ` AND game = ?`; params.push(game); }
        if (search) { sql += ` AND name LIKE ?`; params.push(`%${search}%`); }

        const countSql = sql.replace('SELECT *', 'SELECT COUNT(*) as count');
        const total = db.prepare(countSql).get(...params).count;

        sql += ` ORDER BY updated_at DESC LIMIT ? OFFSET ?`;
        params.push(parseInt(limit), offset);
        const items = db.prepare(sql).all(...params);

        res.json({ items, total, page: parseInt(page), limit: parseInt(limit) });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    app.get('/api/items/:id', (req, res) => {
      const db = getDb();
      const item = db.prepare('SELECT * FROM items WHERE id = ?').get(req.params.id);
      if (!item) return res.status(404).json({ error: 'Not found' });
      res.json(item);
    });

    app.get('/api/items/:id/prices', (req, res) => {
      const db = getDb();
      const days = parseInt(req.query.days) || 30;
      const records = db.prepare(`SELECT price, avg_price, volume, sell_count, recorded_at FROM price_records WHERE item_id = ? AND recorded_at > datetime('now', '-${days} days') ORDER BY recorded_at ASC`).all(req.params.id);
      res.json(records);
    });

    app.get('/api/items/:id/analysis', (req, res) => {
      const result = analyzeItem(parseInt(req.params.id));
      if (!result) return res.status(404).json({ error: 'Insufficient data' });
      res.json(result);
    });

    app.post('/api/items', async (req, res) => {
      try {
        const db = getDb();
        const { goods_id, name, game = 'csgo', category, watch_priority = 'normal' } = req.body;
        db.prepare(`INSERT INTO items (goods_id, name, game, category, watch_priority, buff_min_price) VALUES (?, ?, ?, ?, ?, 0) ON CONFLICT (goods_id) DO UPDATE SET watch_priority = excluded.watch_priority, updated_at = datetime('now')`)
          .run(goods_id, name, game, category, watch_priority);
        const item = db.prepare('SELECT * FROM items WHERE goods_id = ?').get(goods_id);
        crawlItemPrice(goods_id);
        res.status(201).json(item);
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    app.patch('/api/items/:id', (req, res) => {
      const db = getDb();
      const { watch_priority, category } = req.body;
      if (watch_priority) db.prepare('UPDATE items SET watch_priority = ?, updated_at = datetime(\'now\') WHERE id = ?').run(watch_priority, req.params.id);
      if (category) db.prepare('UPDATE items SET category = ?, updated_at = datetime(\'now\') WHERE id = ?').run(category, req.params.id);
      res.json(db.prepare('SELECT * FROM items WHERE id = ?').get(req.params.id));
    });

    app.delete('/api/items/:id', (req, res) => {
      const db = getDb();
      db.prepare('DELETE FROM items WHERE id = ?').run(req.params.id);
      res.json({ deleted: true });
    });

    app.post('/api/items/scan', async (req, res) => {
      const { game = 'csgo', pages = 5 } = req.body;
      for (let i = 1; i <= pages; i++) {
        crawlMarketPage(game, i);
      }
      res.json({ message: `Scan started: ${game}, ${pages} pages` });
    });

    // Portfolio
    app.get('/api/portfolio', (req, res) => {
      const db = getDb();
      const status = req.query.status || 'holding';
      const items = db.prepare(`
        SELECT p.*, i.name as item_name, i.image_url, i.goods_id, i.buff_min_price as current_price
        FROM portfolio p JOIN items i ON i.id = p.item_id WHERE p.status = ? ORDER BY p.created_at DESC
      `).all(status);

      const portfolioWithPnl = items.map((row) => {
        const breakEvenPrice = row.buy_price / (1 - 0.025);
        const unrealizedPnl = row.status === 'holding' ? (row.current_price * row.quantity * (1 - 0.025)) - (row.buy_price * row.quantity) : null;
        const profitRate = row.status === 'holding' ? (row.current_price - breakEvenPrice) / breakEvenPrice : null;
        return { ...row, breakEvenPrice, unrealizedPnl, profitRate };
      });

      const totalInvested = portfolioWithPnl.reduce((s, p) => s + p.buy_price * p.quantity, 0);
      const totalUnrealizedPnl = portfolioWithPnl.reduce((s, p) => s + (p.unrealizedPnl || 0), 0);

      res.json({
        items: portfolioWithPnl,
        summary: {
          totalItems: portfolioWithPnl.length,
          totalInvested: parseFloat(totalInvested.toFixed(2)),
          totalUnrealizedPnl: parseFloat(totalUnrealizedPnl.toFixed(2)),
          overallReturn: totalInvested > 0 ? parseFloat((totalUnrealizedPnl / totalInvested * 100).toFixed(2)) : 0,
        },
      });
    });

    app.post('/api/portfolio', (req, res) => {
      const db = getDb();
      const { item_id, buy_price, quantity = 1, buy_date, target_price, stop_loss_price, notes } = req.body;
      const result = db.prepare(`INSERT INTO portfolio (item_id, buy_price, quantity, buy_date, target_price, stop_loss_price, notes) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(item_id, buy_price, quantity, buy_date, target_price || null, stop_loss_price || null, notes || null);
      db.prepare(`UPDATE items SET watch_priority = 'high' WHERE id = ?`).run(item_id);
      res.status(201).json({ id: result.lastInsertRowid });
    });

    app.post('/api/portfolio/:id/sell', (req, res) => {
      const db = getDb();
      const { sold_price } = req.body;
      db.prepare(`UPDATE portfolio SET status = 'sold', sold_price = ?, sold_date = datetime('now'), updated_at = datetime('now') WHERE id = ? AND status = 'holding'`)
        .run(sold_price, req.params.id);
      res.json({ success: true });
    });

    app.patch('/api/portfolio/:id', (req, res) => {
      const db = getDb();
      const { target_price, stop_loss_price, notes } = req.body;
      if (target_price !== undefined) db.prepare('UPDATE portfolio SET target_price = ? WHERE id = ?').run(target_price, req.params.id);
      if (stop_loss_price !== undefined) db.prepare('UPDATE portfolio SET stop_loss_price = ? WHERE id = ?').run(stop_loss_price, req.params.id);
      if (notes !== undefined) db.prepare('UPDATE portfolio SET notes = ? WHERE id = ?').run(notes, req.params.id);
      res.json({ success: true });
    });

    app.delete('/api/portfolio/:id', (req, res) => {
      const db = getDb();
      db.prepare('DELETE FROM portfolio WHERE id = ?').run(req.params.id);
      res.json({ deleted: true });
    });

    // Alerts
    app.get('/api/alerts/rules', (_req, res) => {
      const db = getDb();
      const rules = db.prepare(`SELECT ar.*, i.name as item_name FROM alert_rules ar LEFT JOIN items i ON i.id = ar.item_id ORDER BY ar.created_at DESC`).all();
      res.json(rules);
    });

    app.post('/api/alerts/rules', (req, res) => {
      const db = getDb();
      const { item_id, type, condition, threshold, cooldown_minutes = 240 } = req.body;
      const result = db.prepare(`INSERT INTO alert_rules (item_id, type, condition, threshold, cooldown_minutes) VALUES (?, ?, ?, ?, ?)`)
        .run(item_id || null, type, condition, threshold, cooldown_minutes);
      res.status(201).json({ id: result.lastInsertRowid });
    });

    app.delete('/api/alerts/rules/:id', (req, res) => {
      const db = getDb();
      db.prepare('DELETE FROM alert_rules WHERE id = ?').run(req.params.id);
      res.json({ deleted: true });
    });

    app.get('/api/alerts/logs', (req, res) => {
      const db = getDb();
      const limit = parseInt(req.query.limit) || 50;
      const logs = db.prepare(`SELECT al.*, i.name as item_name FROM alert_logs al JOIN items i ON i.id = al.item_id ORDER BY al.triggered_at DESC LIMIT ?`).all(limit);
      res.json(logs);
    });

    app.post('/api/alerts/check', async (_req, res) => {
      try {
        await checkAlerts();
        res.json({ message: 'Check completed' });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    // Scheduler control
    app.post('/api/scheduler/pause', (_req, res) => { pauseCrawler(); res.json({ paused: true }); });
    app.post('/api/scheduler/resume', (_req, res) => { resumeCrawler(); res.json({ paused: false }); });

    // Config
    app.get('/api/config/:key', (req, res) => {
      res.json({ value: store.get(req.params.key) });
    });

    app.post('/api/config', (req, res) => {
      const { key, value } = req.body;
      store.set(key, value);
      if (key === 'buff_cookie') updateCookie(value);
      if (key === 'pushplus_token') setPushPlusToken(value);
      res.json({ success: true });
    });

    // Catch-all for SPA (production)
    if (!isDev) {
      app.get('*', (_req, res) => {
        res.sendFile(path.join(process.resourcesPath, 'web', 'index.html'));
      });
    }

    const port = 3001;
    server = app.listen(port, '127.0.0.1', () => {
      const cookie = store.get('buff_cookie');
      const token = store.get('pushplus_token');
      if (cookie) startCrawler(cookie);
      if (token) setPushPlusToken(token);

      resolve(port);
    });

    server.on('error', reject);
  });
}

async function checkAlerts() {
  const db = getDb();
  const items = db.prepare(`SELECT id, name, goods_id FROM items WHERE watch_priority IN ('high', 'normal')`).all();

  for (const item of items) {
    const analysis = analyzeItem(item.id);
    if (!analysis || analysis.signals.length === 0) continue;

    const actionable = analysis.signals.filter((s) => s.strength === 'strong' || s.strength === 'moderate');
    if (actionable.length === 0) continue;

    const recent = db.prepare(`SELECT id FROM alert_logs WHERE item_id = ? AND triggered_at > datetime('now', '-4 hours') LIMIT 1`).get(item.id);
    if (recent) continue;

    db.prepare(`INSERT INTO alert_logs (item_id, message, current_price, notified) VALUES (?, ?, ?, 1)`)
      .run(item.id, actionable.map((s) => `[${s.type}] ${s.message}`).join(' | '), analysis.currentPrice);

    sendNativeNotification(`BUFF: ${item.name}`, actionable[0].message);

    const content = formatSignalMessage(item.name, actionable, analysis.currentPrice);
    sendWeChatNotification(`[BUFF] ${item.name}`, content);
  }
}

function stopServer() {
  stopCrawler();
  if (server) server.close();
}

module.exports = { startServer, stopServer };
