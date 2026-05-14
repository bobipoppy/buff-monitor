const express = require('express');
const cors = require('cors');
const path = require('path');
const { app: electronApp } = require('electron');
const { getDb } = require('./database');
const { analyzeItem } = require('./analysis');
const { startCrawler, stopCrawler, pauseCrawler, resumeCrawler, updateCookie, crawlMarketPage, crawlItemPrice } = require('./crawler');
const { sendWeChatNotification, sendNativeNotification, formatSignalMessage, setPushPlusToken } = require('./notification');
const { buffAPI } = require('./buff-api');
const { pricingEngine } = require('./pricing');
const { autoTrader } = require('./auto-trader');
const { checkForUpdates, downloadAndInstall, getState: getUpdateState, CURRENT_VERSION } = require('./updater');
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
      const fs = require('fs');
      if (fs.existsSync(webPath)) {
        app.use(express.static(webPath));
      }
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

    // ============= Trading API =============

    // BUFF account info
    app.get('/api/trading/account', async (_req, res) => {
      try {
        const [userInfo, balance] = await Promise.all([buffAPI.getUserInfo(), buffAPI.getBalance()]);
        res.json({ userInfo, balance });
      } catch (err) {
        res.status(err.message === 'BUFF_AUTH_EXPIRED' ? 401 : 500).json({ error: err.message });
      }
    });

    app.get('/api/trading/session-check', async (_req, res) => {
      const result = await buffAPI.checkSession();
      res.json(result);
    });

    // Search BUFF market
    app.get('/api/trading/search', async (req, res) => {
      try {
        const { keyword, game = 'csgo' } = req.query;
        if (!keyword) return res.status(400).json({ error: 'keyword required' });
        const data = await buffAPI.searchGoods(keyword, game);
        res.json(data);
      } catch (err) { res.status(500).json({ error: err.message }); }
    });

    // Get pricing analysis for an item
    app.get('/api/trading/pricing/:goodsId', async (req, res) => {
      try {
        const market = await pricingEngine.getMarketFairPrice(req.params.goodsId);
        if (!market) return res.status(404).json({ error: 'No data' });
        const buyAdvice = pricingEngine.calculateBuyPrice(market.fairPrice);
        res.json({ market, buyAdvice });
      } catch (err) { res.status(500).json({ error: err.message }); }
    });

    // Get sell pricing suggestion for portfolio item
    app.get('/api/trading/sell-advice/:portfolioId', async (req, res) => {
      try {
        const db = getDb();
        const h = db.prepare(`
          SELECT p.*, i.goods_id, i.name FROM portfolio p JOIN items i ON i.id = p.item_id WHERE p.id = ?
        `).get(req.params.portfolioId);
        if (!h) return res.status(404).json({ error: 'Not found' });
        const market = await pricingEngine.getMarketFairPrice(h.goods_id);
        if (!market) return res.status(404).json({ error: 'No market data' });
        const sellAdvice = pricingEngine.calculateSellPrice(market.fairPrice, h.buy_price, h.quantity);
        const stopLoss = pricingEngine.evaluateStopLoss(market.fairPrice, h.buy_price);
        res.json({ holding: h, market, sellAdvice, stopLoss });
      } catch (err) { res.status(500).json({ error: err.message }); }
    });

    // Portfolio pricing analysis
    app.get('/api/trading/portfolio-analysis', async (_req, res) => {
      try {
        const results = await pricingEngine.analyzePortfolioPricing();
        res.json(results);
      } catch (err) { res.status(500).json({ error: err.message }); }
    });

    // Manual buy
    app.post('/api/trading/buy', async (req, res) => {
      try {
        const { goodsId, maxPrice } = req.body;
        const result = await autoTrader.manualBuy(goodsId, maxPrice);
        res.json(result);
      } catch (err) { res.status(500).json({ error: err.message }); }
    });

    // Manual sell/list
    app.post('/api/trading/sell', async (req, res) => {
      try {
        const { goodsId, price } = req.body;
        const result = await autoTrader.manualSell(goodsId, price);
        res.json(result);
      } catch (err) { res.status(500).json({ error: err.message }); }
    });

    // My on-sale items
    app.get('/api/trading/on-sale', async (_req, res) => {
      try {
        const data = await buffAPI.getMyOnSale();
        res.json(data);
      } catch (err) { res.status(500).json({ error: err.message }); }
    });

    // Trade history
    app.get('/api/trading/history', (_req, res) => {
      const db = getDb();
      const logs = db.prepare('SELECT * FROM trade_logs ORDER BY created_at DESC LIMIT 100').all();
      res.json(logs);
    });

    // Auto-trader status & control
    app.get('/api/trading/auto-status', (_req, res) => {
      res.json(autoTrader.getStatus());
    });

    app.post('/api/trading/auto-config', (req, res) => {
      autoTrader.updateConfig(req.body);
      store.set('autoTraderConfig', autoTrader.config);
      res.json({ success: true, config: autoTrader.config });
    });

    app.post('/api/trading/auto-start', (_req, res) => {
      autoTrader.start();
      res.json({ enabled: true });
    });

    app.post('/api/trading/auto-stop', (_req, res) => {
      autoTrader.stop();
      res.json({ enabled: false });
    });

    app.post('/api/trading/auto-run', async (_req, res) => {
      try {
        await autoTrader.runCycle();
        res.json({ success: true });
      } catch (err) { res.status(500).json({ error: err.message }); }
    });

    // Pricing config
    app.get('/api/trading/pricing-config', (_req, res) => {
      res.json(pricingEngine.config);
    });

    app.post('/api/trading/pricing-config', (req, res) => {
      pricingEngine.updateConfig(req.body);
      store.set('pricingConfig', pricingEngine.config);
      res.json({ success: true, config: pricingEngine.config });
    });

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

    // ============= Update API =============
    app.get('/api/update/status', (_req, res) => {
      res.json(getUpdateState());
    });

    app.post('/api/update/check', async (_req, res) => {
      try {
        const state = await checkForUpdates(true);
        res.json(state);
      } catch (err) { res.status(500).json({ error: err.message }); }
    });

    app.post('/api/update/download', async (_req, res) => {
      try {
        await downloadAndInstall();
        res.json({ success: true });
      } catch (err) { res.status(500).json({ error: err.message }); }
    });

    // Catch-all: serve embedded dashboard
    app.get('*', (_req, res) => {
      const fs = require('fs');
      if (!isDev) {
        const indexPath = path.join(process.resourcesPath, 'web', 'index.html');
        if (fs.existsSync(indexPath)) {
          return res.sendFile(indexPath);
        }
      }
      res.send(getEmbeddedDashboard());
    });

    const port = 3001;
    server = app.listen(port, '127.0.0.1', () => {
      const cookie = store.get('buff_cookie');
      const token = store.get('pushplus_token');
      if (cookie) startCrawler(cookie);
      if (token) setPushPlusToken(token);

      const savedPricingConfig = store.get('pricingConfig');
      if (savedPricingConfig) pricingEngine.updateConfig(savedPricingConfig);
      const savedTraderConfig = store.get('autoTraderConfig');
      if (savedTraderConfig) autoTrader.updateConfig(savedTraderConfig);

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

function getEmbeddedDashboard() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>BUFF Monitor</title>
<style>
:root{--bg-primary:#0c0c16;--bg-secondary:#12121f;--bg-card:#181828;--bg-card-hover:#1e1e32;--border:#252540;--border-active:#6366f1;--text-primary:#f1f5f9;--text-secondary:#94a3b8;--text-muted:#64748b;--accent:#6366f1;--accent-light:#818cf8;--accent-glow:rgba(99,102,241,0.15);--green:#10b981;--green-bg:rgba(16,185,129,0.1);--red:#ef4444;--red-bg:rgba(239,68,68,0.1);--yellow:#f59e0b;--yellow-bg:rgba(245,158,11,0.1);--radius:14px;--radius-sm:10px}
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,"SF Pro Display","SF Pro Text",sans-serif;background:var(--bg-primary);color:var(--text-primary);min-height:100vh;overflow-x:hidden}
::-webkit-scrollbar{width:6px}
::-webkit-scrollbar-track{background:transparent}
::-webkit-scrollbar-thumb{background:#333;border-radius:3px}

.titlebar{height:52px;background:var(--bg-secondary);-webkit-app-region:drag;display:flex;align-items:center;padding:0 90px;border-bottom:1px solid var(--border);position:sticky;top:0;z-index:100;backdrop-filter:blur(20px)}
.titlebar-title{font-size:13px;font-weight:600;color:var(--text-secondary);letter-spacing:0.3px}

.layout{display:flex;height:calc(100vh - 52px)}
.sidebar{width:220px;background:var(--bg-secondary);border-right:1px solid var(--border);padding:20px 12px;display:flex;flex-direction:column;gap:4px;flex-shrink:0}
.nav-item{display:flex;align-items:center;gap:10px;padding:10px 14px;border-radius:var(--radius-sm);cursor:pointer;color:var(--text-secondary);font-size:13px;font-weight:500;transition:all 0.15s ease;border:1px solid transparent}
.nav-item:hover{background:var(--bg-card);color:var(--text-primary)}
.nav-item.active{background:var(--accent-glow);color:var(--accent-light);border-color:rgba(99,102,241,0.2)}
.nav-item svg{width:18px;height:18px;flex-shrink:0}
.nav-section{font-size:11px;color:var(--text-muted);text-transform:uppercase;letter-spacing:1.2px;padding:16px 14px 6px;font-weight:600}

.main{flex:1;overflow-y:auto;padding:28px 32px}
.page-title{font-size:22px;font-weight:700;margin-bottom:24px;display:flex;align-items:center;gap:10px}
.page-title .badge{font-size:12px;background:var(--accent-glow);color:var(--accent-light);padding:4px 10px;border-radius:20px;font-weight:500}

.stats-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:16px;margin-bottom:28px}
.stat-card{background:var(--bg-card);border-radius:var(--radius);padding:22px;border:1px solid var(--border);transition:all 0.2s ease;position:relative;overflow:hidden}
.stat-card:hover{border-color:var(--border-active);transform:translateY(-1px);box-shadow:0 8px 24px rgba(0,0,0,0.3)}
.stat-card::before{content:'';position:absolute;top:0;left:0;right:0;height:2px;background:linear-gradient(90deg,var(--accent),var(--accent-light));opacity:0;transition:opacity 0.2s}
.stat-card:hover::before{opacity:1}
.stat-label{font-size:12px;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.8px;margin-bottom:8px;font-weight:600}
.stat-value{font-size:26px;font-weight:700;letter-spacing:-0.5px}
.stat-sub{font-size:12px;color:var(--text-muted);margin-top:6px}

.panel{background:var(--bg-card);border-radius:var(--radius);border:1px solid var(--border);margin-bottom:20px;overflow:hidden}
.panel-header{padding:18px 22px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between}
.panel-title{font-size:14px;font-weight:600;color:var(--text-primary)}
.panel-badge{font-size:11px;background:var(--accent-glow);color:var(--accent-light);padding:3px 8px;border-radius:12px}
.panel-body{padding:6px 0}
.panel-empty{padding:48px 22px;text-align:center;color:var(--text-muted);font-size:14px}
.panel-empty svg{width:48px;height:48px;margin-bottom:12px;opacity:0.3}

.list-item{display:flex;align-items:center;justify-content:space-between;padding:14px 22px;border-bottom:1px solid var(--border);transition:background 0.15s}
.list-item:last-child{border-bottom:none}
.list-item:hover{background:var(--bg-card-hover)}
.list-item-left{display:flex;align-items:center;gap:12px}
.list-item-dot{width:8px;height:8px;border-radius:50%;flex-shrink:0}
.list-item-dot.high{background:var(--green);box-shadow:0 0 8px var(--green)}
.list-item-dot.normal{background:var(--yellow)}
.list-item-dot.low{background:var(--text-muted)}
.list-item-name{font-size:13px;font-weight:500}
.list-item-meta{font-size:12px;color:var(--text-muted)}
.list-item-right{text-align:right}
.list-item-price{font-size:14px;font-weight:600}
.list-item-change{font-size:12px;margin-top:2px}
.list-item-change.up{color:var(--green)}.list-item-change.down{color:var(--red)}
.list-item-time{font-size:11px;color:var(--text-muted)}

.form-group{margin-bottom:16px}
.form-label{font-size:12px;color:var(--text-secondary);margin-bottom:6px;display:block;font-weight:500}
.form-input{width:100%;background:var(--bg-secondary);border:1px solid var(--border);border-radius:var(--radius-sm);padding:12px 14px;color:var(--text-primary);font-size:13px;transition:border-color 0.2s;outline:none}
.form-input:focus{border-color:var(--accent)}
.form-input::placeholder{color:var(--text-muted)}
.form-hint{font-size:11px;color:var(--text-muted);margin-top:4px}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;padding:10px 20px;border-radius:var(--radius-sm);font-size:13px;font-weight:600;cursor:pointer;transition:all 0.15s;border:none}
.btn-primary{background:var(--accent);color:white}
.btn-primary:hover{background:var(--accent-light);transform:translateY(-1px);box-shadow:0 4px 12px rgba(99,102,241,0.3)}
.btn-ghost{background:transparent;border:1px solid var(--border);color:var(--text-secondary)}
.btn-ghost:hover{border-color:var(--text-muted);color:var(--text-primary)}

.toast{position:fixed;bottom:24px;right:24px;background:var(--bg-card);border:1px solid var(--green);border-radius:var(--radius-sm);padding:12px 18px;color:var(--green);font-size:13px;font-weight:500;opacity:0;transform:translateY(10px);transition:all 0.3s;pointer-events:none;z-index:999}
.toast.show{opacity:1;transform:translateY(0)}

.welcome{text-align:center;padding:60px 40px}
.welcome-icon{width:80px;height:80px;margin:0 auto 20px;background:var(--accent-glow);border-radius:50%;display:flex;align-items:center;justify-content:center}
.welcome-icon svg{width:36px;height:36px;color:var(--accent-light)}
.welcome h2{font-size:18px;margin-bottom:8px}
.welcome p{color:var(--text-muted);font-size:14px;line-height:1.6;max-width:400px;margin:0 auto}
</style>
</head>
<body>
<div class="titlebar"><span class="titlebar-title">BUFF Monitor</span></div>
<div class="layout">
<div class="sidebar">
<div class="nav-section">概览</div>
<div class="nav-item active" data-tab="dashboard">
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>
仪表盘</div>
<div class="nav-item" data-tab="items">
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/><path d="M9 12l2 2 4-4"/></svg>
监控列表</div>
<div class="nav-item" data-tab="portfolio">
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>
持仓管理</div>
<div class="nav-item" data-tab="trading">
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20V10"/><path d="M18 20V4"/><path d="M6 20v-4"/></svg>
交易</div>
<div class="nav-section">系统</div>
<div class="nav-item" data-tab="settings">
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06A1.65 1.65 0 009 4.6a1.65 1.65 0 001-1.51V3a2 2 0 114 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/></svg>
设置</div>
</div>
<div class="main" id="content"></div>
</div>
<div class="toast" id="toast"></div>

<script>
const API='http://localhost:3001/api';
let currentTab='dashboard';

document.querySelectorAll('.nav-item').forEach(item=>{
  item.addEventListener('click',()=>{
    document.querySelectorAll('.nav-item').forEach(n=>n.classList.remove('active'));
    item.classList.add('active');
    currentTab=item.dataset.tab;
    render();
  });
});

function showToast(msg){
  const t=document.getElementById('toast');
  t.textContent=msg;t.classList.add('show');
  setTimeout(()=>t.classList.remove('show'),2500);
}

async function render(){
  const c=document.getElementById('content');
  try{
    if(currentTab==='dashboard'){
      const r=await fetch(API+'/dashboard').then(r=>r.json());
      c.innerHTML=\`
        <div class="page-title">仪表盘 <span class="badge">实时</span></div>
        <div class="stats-grid">
          <div class="stat-card">
            <div class="stat-label">监控物品</div>
            <div class="stat-value">\${r.watchedItems}</div>
            <div class="stat-sub">活跃监控中</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">持仓数量</div>
            <div class="stat-value">\${r.portfolio.total_holdings}</div>
            <div class="stat-sub">当前持有</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">总投入</div>
            <div class="stat-value" style="color:var(--accent-light)">¥\${Number(r.portfolio.total_invested).toFixed(2)}</div>
            <div class="stat-sub">累计投入金额</div>
          </div>
        </div>
        <div class="panel">
          <div class="panel-header">
            <span class="panel-title">最近告警</span>
            \${r.recentAlerts.length?'<span class="panel-badge">'+r.recentAlerts.length+'</span>':''}
          </div>
          <div class="panel-body">
            \${r.recentAlerts.length?r.recentAlerts.map(a=>\`
              <div class="list-item">
                <div class="list-item-left">
                  <div class="list-item-dot high"></div>
                  <div><div class="list-item-name">\${a.item_name}</div><div class="list-item-meta">\${a.message}</div></div>
                </div>
                <div class="list-item-right"><div class="list-item-price">¥\${a.current_price||'-'}</div><div class="list-item-time">\${new Date(a.triggered_at).toLocaleString('zh-CN',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'})}</div></div>
              </div>\`).join(''):'<div class="panel-empty"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M18.364 5.636a9 9 0 11-12.728 0M12 9v4m0 4h.01"/></svg><div>暂无告警通知</div></div>'}
          </div>
        </div>\`;
    }
    else if(currentTab==='items'){
      const r=await fetch(API+'/items').then(r=>r.json());
      c.innerHTML=\`
        <div class="page-title">监控列表 <span class="badge">\${r.total} 项</span></div>
        \${r.items.length?\`<div class="panel"><div class="panel-body">\${r.items.map(i=>\`
          <div class="list-item">
            <div class="list-item-left">
              <div class="list-item-dot \${i.watch_priority}"></div>
              <div><div class="list-item-name">\${i.name}</div><div class="list-item-meta">\${i.game} · \${i.watch_priority==='high'?'高优先':'普通'}</div></div>
            </div>
            <div class="list-item-right"><div class="list-item-price">¥\${i.buff_min_price||'--'}</div></div>
          </div>\`).join('')}</div></div>\`:\`
        <div class="welcome">
          <div class="welcome-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"/></svg></div>
          <h2>开始监控</h2>
          <p>前往「设置」配置你的 BUFF Cookie，然后添加想要监控的饰品。系统会自动追踪价格变化并发送通知。</p>
        </div>\`}\`;
    }
    else if(currentTab==='portfolio'){
      const r=await fetch(API+'/portfolio').then(r=>r.json());
      c.innerHTML=\`
        <div class="page-title">持仓管理</div>
        <div class="stats-grid">
          <div class="stat-card">
            <div class="stat-label">总投入</div>
            <div class="stat-value">¥\${r.summary.totalInvested}</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">未实现盈亏</div>
            <div class="stat-value" style="color:\${r.summary.totalUnrealizedPnl>=0?'var(--green)':'var(--red)'}">
              \${r.summary.totalUnrealizedPnl>=0?'+':''}¥\${r.summary.totalUnrealizedPnl}
            </div>
          </div>
          <div class="stat-card">
            <div class="stat-label">总收益率</div>
            <div class="stat-value" style="color:\${r.summary.overallReturn>=0?'var(--green)':'var(--red)'}">
              \${r.summary.overallReturn>=0?'+':''}\${r.summary.overallReturn}%
            </div>
          </div>
        </div>
        <div class="panel">
          <div class="panel-header"><span class="panel-title">持仓明细</span><span class="panel-badge">\${r.items.length} 件</span></div>
          <div class="panel-body">
            \${r.items.length?r.items.map(i=>{
              const pnlPct=i.profitRate?((i.profitRate*100).toFixed(1)):'0';
              const isUp=parseFloat(pnlPct)>=0;
              return \`<div class="list-item">
                <div class="list-item-left">
                  <div class="list-item-dot \${isUp?'high':''}"></div>
                  <div><div class="list-item-name">\${i.item_name}</div><div class="list-item-meta">x\${i.quantity} · 买入 ¥\${i.buy_price}</div></div>
                </div>
                <div class="list-item-right">
                  <div class="list-item-price">¥\${i.current_price||'--'}</div>
                  <div class="list-item-change \${isUp?'up':'down'}">\${isUp?'+':''}\${pnlPct}%</div>
                </div>
              </div>\`;}).join(''):'<div class="panel-empty"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M20 12V8H6a2 2 0 01-2-2c0-1.1.9-2 2-2h12v4"/><path d="M4 6v12c0 1.1.9 2 2 2h14v-4"/><path d="M18 12a2 2 0 000 4h4v-4h-4z"/></svg><div>暂无持仓记录</div></div>'}
          </div>
        </div>\`;
    }
    else if(currentTab==='trading'){
      const [status, history]=await Promise.all([
        fetch(API+'/trading/auto-status').then(r=>r.json()),
        fetch(API+'/trading/history').then(r=>r.json()),
      ]);
      c.innerHTML=\`
        <div class="page-title">交易中心</div>
        <div class="stats-grid">
          <div class="stat-card">
            <div class="stat-label">自动交易</div>
            <div class="stat-value" style="color:\${status.enabled?'var(--green)':'var(--text-muted)'}">\${status.enabled?'运行中':'已停止'}</div>
            <div class="stat-sub">\${status.config.dryRun?'模拟模式（不实际交易）':'实盘模式'}</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">今日交易</div>
            <div class="stat-value">\${status.todayCount}</div>
            <div class="stat-sub">上限 \${status.config.maxDailyTrades} 笔/天</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">单笔上限</div>
            <div class="stat-value">¥\${status.config.maxBuyAmount}</div>
            <div class="stat-sub">最大自动买入金额</div>
          </div>
        </div>
        <div class="panel">
          <div class="panel-header">
            <span class="panel-title">自动交易控制</span>
            <button class="btn \${status.enabled?'btn-ghost':'btn-primary'}" onclick="toggleAutoTrader(\${!status.enabled})">\${status.enabled?'停止':'启动'}</button>
          </div>
          <div style="padding:22px">
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px">
              <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
                <input type="checkbox" id="cfg-dryRun" \${status.config.dryRun?'checked':''} onchange="updateTraderConfig()">
                <span style="font-size:13px">模拟模式（仅发通知不下单）</span>
              </label>
              <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
                <input type="checkbox" id="cfg-autoBuy" \${status.config.autoBuy?'checked':''} onchange="updateTraderConfig()">
                <span style="font-size:13px">自动买入（信号触发）</span>
              </label>
              <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
                <input type="checkbox" id="cfg-autoSell" \${status.config.autoSell?'checked':''} onchange="updateTraderConfig()">
                <span style="font-size:13px">自动卖出（止盈/止损）</span>
              </label>
              <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
                <input type="checkbox" id="cfg-autoReprice" \${status.config.autoReprice?'checked':''} onchange="updateTraderConfig()">
                <span style="font-size:13px">自动改价（跟踪最低价）</span>
              </label>
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin-top:16px">
              <div class="form-group"><label class="form-label">最大买入金额</label><input class="form-input" id="cfg-maxBuy" type="number" value="\${status.config.maxBuyAmount}" onchange="updateTraderConfig()"></div>
              <div class="form-group"><label class="form-label">每日交易上限</label><input class="form-input" id="cfg-maxDaily" type="number" value="\${status.config.maxDailyTrades}" onchange="updateTraderConfig()"></div>
              <div class="form-group"><label class="form-label">冷却时间(分钟)</label><input class="form-input" id="cfg-cooldown" type="number" value="\${status.config.cooldownMinutes}" onchange="updateTraderConfig()"></div>
            </div>
            <button class="btn btn-ghost" style="margin-top:12px" onclick="runCycleNow()">立即执行一轮检查</button>
          </div>
        </div>
        <div class="panel">
          <div class="panel-header"><span class="panel-title">交易日志</span><span class="panel-badge">\${history.length}</span></div>
          <div class="panel-body">
            \${history.length?history.slice(0,20).map(l=>{
              const icon=l.type.includes('buy')?'var(--green)':l.type.includes('stop_loss')?'var(--red)':'var(--yellow)';
              return \`<div class="list-item"><div class="list-item-left"><div class="list-item-dot" style="background:\${icon}"></div><div><div class="list-item-name">\${l.message}</div><div class="list-item-meta">\${l.type}</div></div></div><div class="list-item-time">\${new Date(l.created_at).toLocaleString('zh-CN',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'})}</div></div>\`;
            }).join(''):'<div class="panel-empty"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 20V10"/><path d="M18 20V4"/><path d="M6 20v-4"/></svg><div>暂无交易记录</div></div>'}
          </div>
        </div>\`;
    }
    else if(currentTab==='settings'){
      const cookie=await fetch(API+'/config/buff_cookie').then(r=>r.json());
      const token=await fetch(API+'/config/pushplus_token').then(r=>r.json());
      c.innerHTML=\`
        <div class="page-title">设置</div>
        <div class="panel">
          <div class="panel-header"><span class="panel-title">BUFF 连接配置</span></div>
          <div style="padding:22px">
            <div class="form-group">
              <label class="form-label">BUFF Cookie</label>
              <input class="form-input" id="cookie" placeholder="从浏览器登录 BUFF 后复制 Cookie" value="\${cookie.value||''}">
              <div class="form-hint">打开 buff.163.com → F12 开发者工具 → Application → Cookies → 复制 session 值</div>
            </div>
            <div class="form-group">
              <label class="form-label">PushPlus Token（微信推送）</label>
              <input class="form-input" id="token" placeholder="从 pushplus.plus 获取 Token" value="\${token.value||''}">
              <div class="form-hint">访问 pushplus.plus 注册并获取 Token，用于接收微信通知</div>
            </div>
            <div style="display:flex;gap:10px;margin-top:8px">
              <button class="btn btn-primary" onclick="saveConfig()">保存配置</button>
              <button class="btn btn-ghost" onclick="testConfig()">测试连接</button>
            </div>
          </div>
        </div>
        <div class="panel" style="margin-top:16px">
          <div class="panel-header"><span class="panel-title">软件更新</span></div>
          <div style="padding:22px">
            <div style="display:flex;align-items:center;justify-content:space-between">
              <div>
                <div style="font-size:14px;font-weight:500">当前版本: v${CURRENT_VERSION}</div>
                <div id="update-status" style="font-size:12px;color:var(--text-muted);margin-top:4px">点击检查是否有新版本</div>
              </div>
              <div style="display:flex;gap:8px">
                <button class="btn btn-primary" id="btn-check-update" onclick="checkUpdate()">检查更新</button>
                <button class="btn btn-ghost" id="btn-download-update" style="display:none" onclick="downloadUpdate()">下载安装</button>
              </div>
            </div>
            <div id="update-progress" style="display:none;margin-top:12px">
              <div style="height:4px;background:var(--border);border-radius:2px;overflow:hidden">
                <div id="progress-bar" style="height:100%;background:var(--accent);width:0%;transition:width 0.3s"></div>
              </div>
              <div id="progress-text" style="font-size:11px;color:var(--text-muted);margin-top:4px">下载中...</div>
            </div>
          </div>
        </div>
        <div class="panel" style="margin-top:16px">
          <div class="panel-header"><span class="panel-title">关于</span></div>
          <div style="padding:22px;color:var(--text-muted);font-size:13px;line-height:1.8">
            <div>BUFF Monitor v${CURRENT_VERSION}</div>
            <div>网易 BUFF 饰品价格监控与交易信号分析工具</div>
            <div style="margin-top:8px">技术栈：Electron + Express + SQLite + 技术分析算法</div>
          </div>
        </div>\`;
    }
  }catch(e){
    c.innerHTML='<div class="welcome"><div class="welcome-icon" style="background:var(--red-bg)"><svg viewBox="0 0 24 24" fill="none" stroke="var(--red)" stroke-width="1.5" style="width:36px;height:36px"><circle cx="12" cy="12" r="10"/><path d="M12 8v4m0 4h.01"/></svg></div><h2>连接失败</h2><p>'+e.message+'</p></div>';
  }
}

async function saveConfig(){
  const cookie=document.getElementById('cookie').value;
  const token=document.getElementById('token').value;
  if(cookie)await fetch(API+'/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key:'buff_cookie',value:cookie})});
  if(token)await fetch(API+'/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key:'pushplus_token',value:token})});
  showToast('配置已保存');
}

async function testConfig(){
  try{
    const r=await fetch(API+'/health');
    if(r.ok)showToast('连接正常');
    else showToast('连接异常');
  }catch(e){showToast('连接失败: '+e.message);}
}

async function checkUpdate(){
  const btn=document.getElementById('btn-check-update');
  const status=document.getElementById('update-status');
  btn.textContent='检查中...';btn.disabled=true;
  try{
    const r=await fetch(API+'/update/check',{method:'POST'}).then(r=>r.json());
    if(r.available){
      status.innerHTML='<span style="color:var(--green)">发现新版本 v'+r.latestVersion+'</span>';
      document.getElementById('btn-download-update').style.display='inline-flex';
      btn.textContent='检查更新';btn.disabled=false;
    }else{
      status.textContent='已是最新版本 (v'+(r.latestVersion||r.currentVersion)+')';
      btn.textContent='检查更新';btn.disabled=false;
    }
  }catch(e){status.textContent='检查失败: '+e.message;btn.textContent='重试';btn.disabled=false;}
}
async function downloadUpdate(){
  const btn=document.getElementById('btn-download-update');
  const prog=document.getElementById('update-progress');
  const bar=document.getElementById('progress-bar');
  const txt=document.getElementById('progress-text');
  btn.style.display='none';prog.style.display='block';
  try{
    const poll=setInterval(async()=>{
      const s=await fetch(API+'/update/status').then(r=>r.json());
      bar.style.width=s.progress+'%';
      txt.textContent=s.progress>=100?'下载完成，准备安装...':'下载中 '+s.progress+'%';
      if(!s.downloading&&s.progress>=100)clearInterval(poll);
    },500);
    await fetch(API+'/update/download',{method:'POST'});
  }catch(e){txt.textContent='下载失败: '+e.message;btn.style.display='inline-flex';}
}

async function toggleAutoTrader(enable){
  await fetch(API+'/trading/auto-'+(enable?'start':'stop'),{method:'POST'});
  showToast(enable?'自动交易已启动':'自动交易已停止');
  render();
}
async function updateTraderConfig(){
  const cfg={
    dryRun:document.getElementById('cfg-dryRun')?.checked??true,
    autoBuy:document.getElementById('cfg-autoBuy')?.checked??false,
    autoSell:document.getElementById('cfg-autoSell')?.checked??false,
    autoReprice:document.getElementById('cfg-autoReprice')?.checked??false,
    maxBuyAmount:parseFloat(document.getElementById('cfg-maxBuy')?.value)||200,
    maxDailyTrades:parseInt(document.getElementById('cfg-maxDaily')?.value)||10,
    cooldownMinutes:parseInt(document.getElementById('cfg-cooldown')?.value)||60,
  };
  await fetch(API+'/trading/auto-config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(cfg)});
  showToast('配置已更新');
}
async function runCycleNow(){
  showToast('正在执行...');
  await fetch(API+'/trading/auto-run',{method:'POST'});
  showToast('检查完成');
  render();
}

render();
setInterval(()=>{if(currentTab==='dashboard')render();},30000);
</script>
</body></html>`;
}

function stopServer() {
  stopCrawler();
  if (server) server.close();
}

module.exports = { startServer, stopServer };
