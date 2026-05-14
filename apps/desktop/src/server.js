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
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:#0f0f1a;color:#e2e8f0;min-height:100vh}
.header{background:linear-gradient(135deg,#1a1a2e,#16213e);padding:20px 30px;-webkit-app-region:drag;display:flex;align-items:center;gap:12px}
.header h1{font-size:20px;background:linear-gradient(135deg,#667eea,#764ba2);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.container{padding:30px;max-width:1200px;margin:0 auto}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:20px;margin-bottom:30px}
.card{background:#1a1a2e;border-radius:12px;padding:24px;border:1px solid #2d2d44}
.card h3{font-size:13px;color:#8b8fa3;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px}
.card .value{font-size:28px;font-weight:700}
.section{background:#1a1a2e;border-radius:12px;padding:24px;border:1px solid #2d2d44;margin-bottom:20px}
.section h2{font-size:16px;margin-bottom:16px;color:#a78bfa}
.alert-item{padding:12px 0;border-bottom:1px solid #2d2d44;display:flex;justify-content:space-between;align-items:center}
.alert-item:last-child{border:none}
.setup-form{display:flex;flex-direction:column;gap:12px;max-width:500px}
.setup-form input{background:#16213e;border:1px solid #2d2d44;border-radius:8px;padding:12px;color:#e2e8f0;font-size:14px}
.setup-form button{background:linear-gradient(135deg,#667eea,#764ba2);border:none;border-radius:8px;padding:12px;color:white;font-weight:600;cursor:pointer}
.setup-form button:hover{opacity:0.9}
.status{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:8px}
.status.ok{background:#10b981}.status.warn{background:#f59e0b}.status.err{background:#ef4444}
.empty{color:#8b8fa3;text-align:center;padding:40px}
#tab-bar{display:flex;gap:4px;margin-bottom:24px}
#tab-bar button{background:transparent;border:1px solid #2d2d44;border-radius:8px;padding:8px 16px;color:#8b8fa3;cursor:pointer}
#tab-bar button.active{background:#667eea33;border-color:#667eea;color:#e2e8f0}
</style>
</head>
<body>
<div class="header"><h1>BUFF Monitor</h1><span style="color:#8b8fa3;font-size:13px">v1.0</span></div>
<div class="container">
<div id="tab-bar">
<button class="active" onclick="showTab('dashboard')">仪表盘</button>
<button onclick="showTab('items')">监控列表</button>
<button onclick="showTab('portfolio')">持仓</button>
<button onclick="showTab('settings')">设置</button>
</div>
<div id="content"><div class="empty">加载中...</div></div>
</div>
<script>
const API='http://localhost:3001/api';
let currentTab='dashboard';
function showTab(t){currentTab=t;document.querySelectorAll('#tab-bar button').forEach(b=>b.classList.remove('active'));document.querySelectorAll('#tab-bar button')[['dashboard','items','portfolio','settings'].indexOf(t)].classList.add('active');render();}
async function render(){const c=document.getElementById('content');try{if(currentTab==='dashboard'){const r=await fetch(API+'/dashboard').then(r=>r.json());c.innerHTML=\`
<div class="stats"><div class="card"><h3>监控物品</h3><div class="value">\${r.watchedItems}</div></div><div class="card"><h3>持仓数量</h3><div class="value">\${r.portfolio.total_holdings}</div></div><div class="card"><h3>总投入</h3><div class="value">¥\${Number(r.portfolio.total_invested).toFixed(2)}</div></div></div>
<div class="section"><h2>最近告警</h2>\${r.recentAlerts.length?r.recentAlerts.map(a=>\`<div class="alert-item"><span>\${a.item_name}: \${a.message}</span><span style="color:#8b8fa3;font-size:12px">\${new Date(a.triggered_at).toLocaleString()}</span></div>\`).join(''):'<div class="empty">暂无告警</div>'}</div>\`;}
else if(currentTab==='items'){const r=await fetch(API+'/items').then(r=>r.json());c.innerHTML=\`<div class="section"><h2>监控列表 (\${r.total})</h2>\${r.items.length?r.items.map(i=>\`<div class="alert-item"><span><span class="status \${i.watch_priority==='high'?'ok':'warn'}"></span>\${i.name}</span><span>¥\${i.buff_min_price||'-'}</span></div>\`).join(''):'<div class="empty">暂无监控物品，请在设置中配置 Cookie 后添加</div>'}</div>\`;}
else if(currentTab==='portfolio'){const r=await fetch(API+'/portfolio').then(r=>r.json());c.innerHTML=\`<div class="stats"><div class="card"><h3>总投入</h3><div class="value">¥\${r.summary.totalInvested}</div></div><div class="card"><h3>未实现盈亏</h3><div class="value" style="color:\${r.summary.totalUnrealizedPnl>=0?'#10b981':'#ef4444'}">¥\${r.summary.totalUnrealizedPnl}</div></div><div class="card"><h3>收益率</h3><div class="value">\${r.summary.overallReturn}%</div></div></div>
<div class="section"><h2>持仓明细</h2>\${r.items.length?r.items.map(i=>\`<div class="alert-item"><span>\${i.item_name} x\${i.quantity}</span><span>买入 ¥\${i.buy_price} | 现价 ¥\${i.current_price||'-'}</span></div>\`).join(''):'<div class="empty">暂无持仓</div>'}</div>\`;}
else if(currentTab==='settings'){const cookie=await fetch(API+'/config/buff_cookie').then(r=>r.json());const token=await fetch(API+'/config/pushplus_token').then(r=>r.json());c.innerHTML=\`<div class="section"><h2>基础配置</h2><div class="setup-form"><input id="cookie" placeholder="BUFF Cookie (登录后从浏览器复制)" value="\${cookie.value||''}"><input id="token" placeholder="PushPlus Token (微信通知)" value="\${token.value||''}"><button onclick="saveConfig()">保存配置</button></div></div>\`;}
}catch(e){c.innerHTML='<div class="empty">连接失败: '+e.message+'</div>';}}
async function saveConfig(){const cookie=document.getElementById('cookie').value;const token=document.getElementById('token').value;if(cookie)await fetch(API+'/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key:'buff_cookie',value:cookie})});if(token)await fetch(API+'/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key:'pushplus_token',value:token})});alert('配置已保存');render();}
render();setInterval(()=>{if(currentTab==='dashboard')render();},30000);
</script>
</body></html>`;
}

function stopServer() {
  stopCrawler();
  if (server) server.close();
}

module.exports = { startServer, stopServer };
