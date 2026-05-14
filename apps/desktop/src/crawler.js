const { getDb } = require('./database');
const { Notification } = require('electron');

const BUFF_BASE_URL = 'https://buff.163.com';
const BUFF_FEE_RATE = 0.025;

let crawlerPaused = false;
let crawlerInterval = null;
let watchlistInterval = null;
let fullScanInterval = null;

class BuffClient {
  constructor() {
    this.cookie = '';
    this.lastRequestTime = 0;
    this.minInterval = 3000;
  }

  setCookie(cookie) {
    this.cookie = cookie;
  }

  async request(url, retries = 3) {
    const now = Date.now();
    const elapsed = now - this.lastRequestTime;
    if (elapsed < this.minInterval) {
      await new Promise((r) => setTimeout(r, this.minInterval - elapsed));
    }
    this.lastRequestTime = Date.now();

    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const response = await fetch(url, {
          headers: {
            Cookie: this.cookie,
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
            Referer: BUFF_BASE_URL,
            Accept: 'application/json',
          },
        });

        if (response.status === 429) {
          const backoff = Math.pow(2, attempt) * 5000;
          console.warn(`Rate limited, backing off ${backoff}ms`);
          await new Promise((r) => setTimeout(r, backoff));
          continue;
        }

        if (response.status === 403) {
          throw new Error('BUFF_AUTH_EXPIRED');
        }

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }

        const json = await response.json();
        if (json.code !== 'OK') {
          throw new Error(`BUFF API: ${json.code} - ${json.msg}`);
        }

        return json.data;
      } catch (err) {
        if (attempt === retries || err.message === 'BUFF_AUTH_EXPIRED') throw err;
        await new Promise((r) => setTimeout(r, Math.pow(2, attempt) * 1000));
      }
    }
  }

  async getMarketGoods(game = 'csgo', page = 1) {
    return this.request(`${BUFF_BASE_URL}/api/market/goods?game=${game}&page_num=${page}&page_size=80`);
  }

  async getSellOrders(goodsId) {
    return this.request(`${BUFF_BASE_URL}/api/market/goods/sell_order?goods_id=${goodsId}&page_num=1`);
  }

  async getPriceHistory(goodsId, days = 30) {
    return this.request(`${BUFF_BASE_URL}/api/market/goods/price_history?goods_id=${goodsId}&days=${days}`);
  }
}

const buffClient = new BuffClient();

async function crawlItemPrice(goodsId) {
  if (crawlerPaused) return;

  const db = getDb();
  const item = db.prepare('SELECT id, name FROM items WHERE goods_id = ?').get(goodsId);
  if (!item) return;

  try {
    const data = await buffClient.getSellOrders(goodsId);
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
    const data = await buffClient.getMarketGoods(game, page);
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

function startCrawler(cookie) {
  buffClient.setCookie(cookie);
  crawlerPaused = false;

  crawlerInterval = setInterval(crawlPortfolioItems, 30 * 60 * 1000);
  watchlistInterval = setInterval(crawlWatchlistItems, 2 * 60 * 60 * 1000);
  fullScanInterval = setInterval(() => crawlMarketPage('csgo', 1), 24 * 60 * 60 * 1000);

  setTimeout(crawlPortfolioItems, 5000);
  console.log('[Crawler] Started');
}

function stopCrawler() {
  if (crawlerInterval) clearInterval(crawlerInterval);
  if (watchlistInterval) clearInterval(watchlistInterval);
  if (fullScanInterval) clearInterval(fullScanInterval);
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
  buffClient.setCookie(cookie);
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
