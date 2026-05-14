const { getDb } = require('./database');
const { Notification } = require('electron');
const { buffAPI, BUFF_FEE_RATE } = require('./buff-api');

let crawlerPaused = false;
let crawlerInterval = null;
let watchlistInterval = null;
let fullScanInterval = null;
let cookieCheckInterval = null;

async function crawlItemPrice(goodsId) {
  if (crawlerPaused) return;

  const db = getDb();
  const item = db.prepare('SELECT id, name FROM items WHERE goods_id = ?').get(goodsId);
  if (!item) return;

  try {
    const data = await buffAPI.getSellOrders(goodsId);
    if (!data.items || data.items.length === 0) return;

    const prices = data.items.map((o) => parseFloat(o.price));
    const minPrice = Math.min(...prices);
    const avgPrice = prices.reduce((a, b) => a + b, 0) / prices.length;

    db.prepare(`UPDATE items SET buff_min_price = ?, sell_count = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(minPrice, data.total_count || 0, item.id);

    db.prepare(`INSERT INTO price_records (item_id, price, avg_price, volume, sell_count) VALUES (?, ?, ?, 0, ?)`)
      .run(item.id, minPrice, avgPrice, data.total_count || 0);

    console.log(`[Crawler] ${item.name}: ¥${minPrice}`);
  } catch (err) {
    if (err.message === 'BUFF_AUTH_EXPIRED') {
      console.error('Cookie expired');
      new Notification({ title: 'BUFF Monitor', body: 'Cookie已过期，请重新配置' }).show();
      pauseCrawler();
    } else {
      console.error(`Crawl failed for ${goodsId}:`, err.message);
    }
  }
}

async function crawlMarketPage(game = 'csgo', page = 1) {
  if (crawlerPaused) return;

  try {
    const data = await buffAPI.getMarketGoods(game, page);
    const db = getDb();

    const upsert = db.prepare(`
      INSERT INTO items (goods_id, name, game, image_url, steam_price, buff_min_price, sell_count)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (goods_id) DO UPDATE SET
        buff_min_price = excluded.buff_min_price,
        sell_count = excluded.sell_count,
        steam_price = excluded.steam_price,
        updated_at = datetime('now')
    `);

    const insertMany = db.transaction((items) => {
      for (const item of items) {
        upsert.run(
          item.id,
          item.name,
          game,
          item.goods_info?.icon_url || '',
          parseFloat(item.goods_info?.steam_price_cny) || null,
          parseFloat(item.sell_min_price),
          item.sell_num
        );
      }
    });

    insertMany(data.items || []);
    console.log(`[Crawler] Market page ${page}: ${data.items?.length || 0} items`);
    return data.total_page;
  } catch (err) {
    console.error(`Market crawl failed:`, err.message);
    return 0;
  }
}

async function crawlPortfolioItems() {
  if (crawlerPaused) return;
  const db = getDb();
  const items = db.prepare(`
    SELECT DISTINCT i.goods_id FROM items i
    JOIN portfolio p ON p.item_id = i.id
    WHERE p.status = 'holding'
  `).all();

  for (const item of items) {
    await crawlItemPrice(item.goods_id);
  }
}

async function crawlWatchlistItems() {
  if (crawlerPaused) return;
  const db = getDb();
  const items = db.prepare(`SELECT goods_id FROM items WHERE watch_priority IN ('high', 'normal') ORDER BY updated_at ASC LIMIT 50`).all();

  for (const item of items) {
    await crawlItemPrice(item.goods_id);
  }
}

async function checkCookieValidity() {
  try {
    const result = await buffAPI.checkSession();
    if (!result.valid) {
      console.warn('[Crawler] Cookie expired!');
      new Notification({ title: 'BUFF Monitor', body: 'Cookie已失效，请及时更新！' }).show();
      pauseCrawler();
      return false;
    }
    return true;
  } catch {
    return true;
  }
}

function startCrawler(cookie) {
  buffAPI.setCookie(cookie);
  crawlerPaused = false;

  crawlerInterval = setInterval(crawlPortfolioItems, 30 * 60 * 1000);
  watchlistInterval = setInterval(crawlWatchlistItems, 2 * 60 * 60 * 1000);
  fullScanInterval = setInterval(() => crawlMarketPage('csgo', 1), 24 * 60 * 60 * 1000);
  cookieCheckInterval = setInterval(checkCookieValidity, 30 * 60 * 1000);

  setTimeout(crawlPortfolioItems, 5000);
  setTimeout(checkCookieValidity, 10000);
  console.log('[Crawler] Started');
}

function stopCrawler() {
  if (crawlerInterval) clearInterval(crawlerInterval);
  if (watchlistInterval) clearInterval(watchlistInterval);
  if (fullScanInterval) clearInterval(fullScanInterval);
  if (cookieCheckInterval) clearInterval(cookieCheckInterval);
  crawlerPaused = true;
  console.log('[Crawler] Stopped');
}

function pauseCrawler() {
  crawlerPaused = true;
}

function resumeCrawler() {
  crawlerPaused = false;
}

function updateCookie(cookie) {
  buffAPI.setCookie(cookie);
}

module.exports = {
  startCrawler,
  stopCrawler,
  pauseCrawler,
  resumeCrawler,
  updateCookie,
  crawlItemPrice,
  crawlMarketPage,
  crawlPortfolioItems,
  crawlWatchlistItems,
  BUFF_FEE_RATE,
};
