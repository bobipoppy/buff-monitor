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

const BUFF_CATEGORY_GROUPS = [
  { group: 'rifle',     label: '步枪' },
  { group: 'pistol',    label: '手枪' },
  { group: 'smg',       label: '微型冲锋枪' },
  { group: 'shotgun',   label: '霰弹枪' },
  { group: 'machinegun', label: '机枪' },
  { group: 'knife',     label: '刀' },
  { group: 'hands',     label: '手套' },
  { group: 'sticker',   label: '贴纸' },
  { group: 'other',     label: '其他' },
  { group: 'type_customplayer', label: '特工' },
];

function extractTags(item) {
  const tags = item.goods_info?.info?.tags || {};
  return {
    category: tags.type?.localized_name || tags.category?.localized_name || '其他',
    exterior: tags.exterior?.localized_name || '',
    quality: tags.quality?.localized_name || '',
    rarity: tags.rarity?.localized_name || '',
    weapon: tags.weapon?.localized_name || '',
  };
}

function upsertItems(items, game) {
  const db = getDb();
  const upsert = db.prepare(`
    INSERT INTO items (goods_id, name, game, category, exterior, quality, rarity, weapon, image_url, steam_price, buff_min_price, sell_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (goods_id) DO UPDATE SET
      name = excluded.name,
      buff_min_price = excluded.buff_min_price,
      sell_count = excluded.sell_count,
      steam_price = excluded.steam_price,
      category = excluded.category,
      exterior = excluded.exterior,
      quality = excluded.quality,
      rarity = excluded.rarity,
      weapon = excluded.weapon,
      image_url = COALESCE(excluded.image_url, items.image_url),
      updated_at = datetime('now')
  `);

  db.transaction(() => {
    for (const item of items) {
      const t = extractTags(item);
      upsert.run(
        item.id,
        item.short_name || item.name,
        game,
        t.category,
        t.exterior,
        t.quality,
        t.rarity,
        t.weapon,
        item.goods_info?.icon_url || '',
        parseFloat(item.goods_info?.steam_price_cny) || null,
        parseFloat(item.sell_min_price),
        item.sell_num
      );
    }
  })();
}

async function crawlMarketPage(game = 'csgo', page = 1) {
  if (crawlerPaused) return;

  try {
    const data = await buffAPI.getMarketGoods(game, page);
    upsertItems(data.items || [], game);
    console.log(`[Crawler] Market page ${page}: ${data.items?.length || 0} items`);
    return data.total_page;
  } catch (err) {
    console.error(`Market crawl failed:`, err.message);
    return 0;
  }
}

let fullScanRunning = false;
let scanProgress = { running: false, phase: '', currentGroup: '', groupsDone: 0, groupsTotal: 0, pagesDone: 0, pagesTotal: 0, totalItems: 0 };

async function scanCategoryGroup(group, label, game, concurrencyDelay) {
  let page = 1;
  let totalPages = 1;
  let groupItems = 0;

  while (page <= totalPages && !crawlerPaused && fullScanRunning) {
    try {
      const data = await buffAPI.getMarketGoods(game, page, 80, group);
      if (!data?.items?.length) break;

      totalPages = data.total_page || 1;
      upsertItems(data.items, game);
      groupItems += data.items.length;

      scanProgress.pagesDone++;
      scanProgress.totalItems += data.items.length;
      scanProgress.currentGroup = label;

      console.log(`[Scan] ${label}: ${page}/${totalPages} (+${data.items.length})`);
      page++;

      await new Promise(r => setTimeout(r, concurrencyDelay + Math.random() * 1000));
    } catch (err) {
      if (err.message?.includes('429') || err.message?.includes('频繁')) {
        console.warn(`[Scan] ${label}: rate limited, waiting 10s...`);
        await new Promise(r => setTimeout(r, 10000));
      } else {
        console.error(`[Scan] ${label} page ${page} error:`, err.message);
        page++;
        await new Promise(r => setTimeout(r, 3000));
      }
    }
  }

  return groupItems;
}

async function fullMarketScan(game = 'csgo') {
  if (fullScanRunning || crawlerPaused) return { status: 'busy' };
  fullScanRunning = true;

  const groups = BUFF_CATEGORY_GROUPS;
  scanProgress = {
    running: true, phase: '扫描中', currentGroup: '',
    groupsDone: 0, groupsTotal: groups.length,
    pagesDone: 0, pagesTotal: 0, totalItems: 0,
  };

  console.log(`[Scan] Full market scan started: ${groups.length} category groups`);
  let totalItems = 0;

  try {
    const CONCURRENCY = 2;
    for (let i = 0; i < groups.length; i += CONCURRENCY) {
      if (crawlerPaused || !fullScanRunning) break;

      const batch = groups.slice(i, i + CONCURRENCY);
      const promises = batch.map((g, idx) =>
        scanCategoryGroup(g.group, g.label, game, 2000 + idx * 500)
      );

      const results = await Promise.all(promises);
      totalItems += results.reduce((a, b) => a + b, 0);
      scanProgress.groupsDone += batch.length;
      scanProgress.phase = `已完成 ${scanProgress.groupsDone}/${groups.length} 分类`;
    }
  } catch (err) {
    console.error('[Scan] Fatal error:', err.message);
  } finally {
    fullScanRunning = false;
    scanProgress.running = false;
    scanProgress.phase = `完成，共 ${totalItems} 件商品`;
  }

  console.log(`[Scan] Complete: ${totalItems} items`);
  return { status: 'complete', totalItems };
}

function stopFullScan() {
  fullScanRunning = false;
  scanProgress.running = false;
  scanProgress.phase = '已停止';
}

function getScanStatus() {
  return { ...scanProgress };
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
  stopFullScan,
  getScanStatus,
  extractTags,
  BUFF_FEE_RATE,
};
