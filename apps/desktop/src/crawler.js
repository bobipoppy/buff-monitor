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

const WEAPON_CATEGORIES = {
  'AK-47': 'rifle', 'M4A4': 'rifle', 'M4A1-S': 'rifle', 'AWP': 'sniper',
  'Galil AR': 'rifle', 'FAMAS': 'rifle', 'SG 553': 'rifle', 'AUG': 'rifle',
  'SSG 08': 'sniper', 'SCAR-20': 'sniper', 'G3SG1': 'sniper',
  'MAC-10': 'smg', 'MP9': 'smg', 'MP7': 'smg', 'MP5-SD': 'smg',
  'UMP-45': 'smg', 'P90': 'smg', 'PP-Bizon': 'smg',
  'Nova': 'shotgun', 'XM1014': 'shotgun', 'MAG-7': 'shotgun', 'Sawed-Off': 'shotgun',
  'M249': 'machinegun', 'Negev': 'machinegun',
  'Desert Eagle': 'pistol', 'R8 Revolver': 'pistol', 'USP-S': 'pistol',
  'P2000': 'pistol', 'Glock-18': 'pistol', 'P250': 'pistol',
  'Five-SeveN': 'pistol', 'Tec-9': 'pistol', 'CZ75-Auto': 'pistol',
  'Dual Berettas': 'pistol',
  'Bayonet': 'knife', 'Karambit': 'knife', 'M9 Bayonet': 'knife',
  'Butterfly Knife': 'knife', 'Flip Knife': 'knife', 'Gut Knife': 'knife',
  'Falchion Knife': 'knife', 'Shadow Daggers': 'knife', 'Bowie Knife': 'knife',
  'Huntsman Knife': 'knife', 'Navaja Knife': 'knife', 'Stiletto Knife': 'knife',
  'Talon Knife': 'knife', 'Ursus Knife': 'knife', 'Classic Knife': 'knife',
  'Paracord Knife': 'knife', 'Survival Knife': 'knife', 'Nomad Knife': 'knife',
  'Skeleton Knife': 'knife', 'Kukri Knife': 'knife',
};

function categorizeItem(name) {
  if (!name) return 'other';
  const lower = name.toLowerCase();

  if (lower.includes('gloves') || lower.includes('wraps') || lower.includes('hand wraps')) return 'gloves';
  if (lower.includes('sticker')) return 'sticker';
  if (lower.includes('patch')) return 'patch';
  if (lower.includes('music kit')) return 'music_kit';
  if (lower.includes('graffiti')) return 'graffiti';
  if (lower.includes('key') && !lower.includes('monkey')) return 'key';
  if (lower.includes('case') || lower.includes('capsule')) return 'case';
  if (lower.includes('agent') || lower.includes('operator')) return 'agent';
  if (lower.includes('pin') || lower.includes('collectible')) return 'collectible';

  for (const [weapon, cat] of Object.entries(WEAPON_CATEGORIES)) {
    if (name.includes(weapon)) return cat;
  }

  if (lower.includes('knife') || lower.includes('dagger') || lower.includes('sword')) return 'knife';
  return 'other';
}

async function crawlMarketPage(game = 'csgo', page = 1) {
  if (crawlerPaused) return;

  try {
    const data = await buffAPI.getMarketGoods(game, page);
    const db = getDb();

    const upsert = db.prepare(`
      INSERT INTO items (goods_id, name, game, category, image_url, steam_price, buff_min_price, sell_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (goods_id) DO UPDATE SET
        buff_min_price = excluded.buff_min_price,
        sell_count = excluded.sell_count,
        steam_price = excluded.steam_price,
        category = COALESCE(excluded.category, items.category),
        updated_at = datetime('now')
    `);

    const insertMany = db.transaction((items) => {
      for (const item of items) {
        const category = categorizeItem(item.name);
        upsert.run(
          item.id,
          item.name,
          game,
          category,
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

let fullScanRunning = false;

async function fullMarketScan(game = 'csgo') {
  if (fullScanRunning || crawlerPaused) return { status: 'busy' };
  fullScanRunning = true;
  console.log('[Crawler] Full market scan started...');

  let page = 1;
  let totalPages = 1;
  let totalItems = 0;

  try {
    while (page <= totalPages && !crawlerPaused) {
      const data = await buffAPI.getMarketGoods(game, page, 80);
      if (!data?.items?.length) break;

      totalPages = data.total_page || 1;
      const db = getDb();

      const upsert = db.prepare(`
        INSERT INTO items (goods_id, name, game, category, image_url, steam_price, buff_min_price, sell_count)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (goods_id) DO UPDATE SET
          buff_min_price = excluded.buff_min_price,
          sell_count = excluded.sell_count,
          steam_price = excluded.steam_price,
          category = COALESCE(excluded.category, items.category),
          updated_at = datetime('now')
      `);

      db.transaction(() => {
        for (const item of data.items) {
          const category = categorizeItem(item.name);
          upsert.run(
            item.id, item.name, game, category,
            item.goods_info?.icon_url || '',
            parseFloat(item.goods_info?.steam_price_cny) || null,
            parseFloat(item.sell_min_price),
            item.sell_num
          );
        }
      })();

      totalItems += data.items.length;
      console.log(`[Crawler] Full scan: page ${page}/${totalPages}, total ${totalItems} items`);
      page++;

      await new Promise((r) => setTimeout(r, 3000 + Math.random() * 2000));
    }
  } catch (err) {
    console.error('[Crawler] Full scan error:', err.message);
  } finally {
    fullScanRunning = false;
  }

  console.log(`[Crawler] Full scan complete: ${totalItems} items across ${page - 1} pages`);
  return { status: 'complete', totalItems, totalPages: page - 1 };
}

function getScanStatus() {
  return { running: fullScanRunning };
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
  fullMarketScan,
  getScanStatus,
  categorizeItem,
  BUFF_FEE_RATE,
};
