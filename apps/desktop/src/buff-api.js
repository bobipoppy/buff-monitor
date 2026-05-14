const { getDb } = require('./database');
const { Notification } = require('electron');

const BUFF_BASE_URL = 'https://buff.163.com';
const BUFF_FEE_RATE = 0.025;

function getRandomUA() {
  const v1 = 100 + Math.floor(Math.random() * 20);
  const v2 = Math.floor(Math.random() * 4000);
  const v3 = Math.floor(Math.random() * 200);
  const os = [
    '(Macintosh; Intel Mac OS X 10_15_7)',
    '(Windows NT 10.0; Win64; x64)',
    '(X11; Linux x86_64)',
  ][Math.floor(Math.random() * 3)];
  return `Mozilla/5.0 ${os} AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${v1}.0.${v2}.${v3} Safari/537.36`;
}

class BuffAPI {
  constructor() {
    this.cookie = '';
    this.csrfToken = '';
    this.lastRequestTime = 0;
    this.minInterval = 3000;
    this.userInfo = null;
  }

  setCookie(cookie) {
    this.cookie = cookie;
    this.csrfToken = '';
  }

  async _delay() {
    const now = Date.now();
    const elapsed = now - this.lastRequestTime;
    if (elapsed < this.minInterval) {
      await new Promise((r) => setTimeout(r, this.minInterval - elapsed));
    }
    this.lastRequestTime = Date.now();
  }

  async _get(path, params = {}, retries = 3) {
    await this._delay();
    const url = new URL(path, BUFF_BASE_URL);
    Object.entries(params).forEach(([k, v]) => {
      if (v !== undefined && v !== null) url.searchParams.set(k, v);
    });

    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const resp = await fetch(url.toString(), {
          headers: {
            Cookie: this.cookie,
            'User-Agent': getRandomUA(),
            Referer: BUFF_BASE_URL,
            Accept: 'application/json',
          },
        });

        if (resp.status === 429) {
          const backoff = Math.pow(2, attempt) * 5000 + Math.random() * 2000;
          console.warn(`[BuffAPI] Rate limited, retry in ${Math.round(backoff)}ms`);
          await new Promise((r) => setTimeout(r, backoff));
          continue;
        }

        if (resp.status === 403) throw new Error('BUFF_AUTH_EXPIRED');
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

        const json = await resp.json();
        if (json.code === 'Login Required') throw new Error('BUFF_AUTH_EXPIRED');
        if (json.code !== 'OK') {
          if (json.error?.includes('系统繁忙') || json.msg?.includes('系统繁忙')) {
            console.warn('[BuffAPI] 系统繁忙，重试...');
            await new Promise((r) => setTimeout(r, 3000));
            continue;
          }
          throw new Error(`BUFF: ${json.code} - ${json.msg || json.error || ''}`);
        }
        return json.data;
      } catch (err) {
        if (attempt === retries || err.message === 'BUFF_AUTH_EXPIRED') throw err;
        await new Promise((r) => setTimeout(r, Math.pow(2, attempt) * 1000 + Math.random() * 1000));
      }
    }
  }

  async _post(path, body = {}, retries = 3) {
    await this._delay();
    const url = `${BUFF_BASE_URL}${path}`;

    if (!this.csrfToken) {
      await this._refreshCSRF();
    }

    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const resp = await fetch(url, {
          method: 'POST',
          headers: {
            Cookie: this.cookie,
            'User-Agent': getRandomUA(),
            'Content-Type': 'application/json',
            'X-CSRFToken': this.csrfToken,
            'X-Requested-With': 'XMLHttpRequest',
            Referer: BUFF_BASE_URL + '/market/',
            Origin: BUFF_BASE_URL,
          },
          body: JSON.stringify(body),
        });

        if (resp.status === 429) {
          await new Promise((r) => setTimeout(r, Math.pow(2, attempt) * 5000));
          continue;
        }
        if (resp.status === 403) throw new Error('BUFF_AUTH_EXPIRED');
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

        const json = await resp.json();
        if (json.code === 'Login Required') throw new Error('BUFF_AUTH_EXPIRED');
        if (json.code !== 'OK') {
          if (json.msg?.includes('系统繁忙')) {
            await new Promise((r) => setTimeout(r, 3000));
            continue;
          }
          throw new Error(`BUFF: ${json.code} - ${json.msg || ''}`);
        }
        return json.data;
      } catch (err) {
        if (attempt === retries || err.message === 'BUFF_AUTH_EXPIRED') throw err;
        await new Promise((r) => setTimeout(r, Math.pow(2, attempt) * 1000));
      }
    }
  }

  async _refreshCSRF() {
    const resp = await fetch(`${BUFF_BASE_URL}/api/market/steam_trade`, {
      headers: { Cookie: this.cookie, 'User-Agent': getRandomUA() },
    });
    const setCookie = resp.headers.get('set-cookie') || '';
    const match = setCookie.match(/csrf_token=([^;]+)/);
    if (match) {
      this.csrfToken = match[1];
      if (!this.cookie.includes('csrf_token=')) {
        this.cookie += `; csrf_token=${this.csrfToken}`;
      }
    }
  }

  // ==================== 用户信息 ====================

  async getUserInfo() {
    const data = await this._get('/account/api/user/info');
    this.userInfo = data;
    return data;
  }

  async getBalance() {
    return this._get('/api/asset/get_brief_asset');
  }

  async checkSession() {
    try {
      const data = await this._get('/api/message/notification');
      return { valid: true, data };
    } catch (err) {
      if (err.message === 'BUFF_AUTH_EXPIRED') return { valid: false };
      throw err;
    }
  }

  // ==================== 市场查询 ====================

  async searchGoods(keyword, game = 'csgo') {
    return this._get('/api/market/search/suggest', { text: keyword, game });
  }

  async getMarketGoods(game = 'csgo', page = 1, pageSize = 80) {
    return this._get('/api/market/goods', { game, page_num: page, page_size: pageSize });
  }

  async getSellOrders(goodsId, page = 1, sortBy = 'default', game = 'csgo') {
    return this._get('/api/market/goods/sell_order', {
      goods_id: goodsId,
      page_num: page,
      sort_by: sortBy,
      game,
    });
  }

  async getBuyOrders(goodsId, page = 1, game = 'csgo') {
    return this._get('/api/market/goods/buy_order', {
      goods_id: goodsId,
      page_num: page,
      game,
    });
  }

  async getPriceHistory(goodsId, days = 30) {
    return this._get('/api/market/goods/price_history', { goods_id: goodsId, days });
  }

  async getGoodsInfo(goodsId, game = 'csgo') {
    return this._get('/api/market/goods/info', { goods_id: goodsId, game });
  }

  // ==================== 购买 ====================

  async buyPreview(sellOrderId, goodsId, price, game = 'csgo') {
    return this._get('/api/market/goods/buy/preview', {
      game,
      sell_order_id: sellOrderId,
      goods_id: goodsId,
      price,
    });
  }

  async buyGoods(sellOrderId, goodsId, price, payMethod = 'buff-balance', game = 'csgo') {
    const PAY_MAP = { 'buff-balance': 3, 'buff-alipay': 3, 'buff-bankcard': 1 };
    const data = await this._post('/api/market/goods/buy', {
      game,
      goods_id: goodsId,
      price,
      sell_order_id: sellOrderId,
      pay_method: PAY_MAP[payMethod] || 3,
      token: '',
      cdkey_id: '',
    });
    return data;
  }

  // ==================== 出售/上架 ====================

  async getMyOnSale(page = 1, pageSize = 100, game = 'csgo') {
    return this._get('/api/market/sell_order/on_sale', {
      page_num: page,
      page_size: pageSize,
      game,
      appid: 730,
    });
  }

  async getMyInventory(game = 'csgo', page = 1, state = 'cangku', force = 0) {
    return this._get('/api/market/steam_inventory', {
      game,
      page_num: page,
      state,
      force,
    });
  }

  async createSellOrder(assets, game = 'csgo') {
    return this._post('/api/market/sell_order/create/manual_plus', {
      appid: '730',
      game,
      assets,
    });
  }

  async changeSellPrice(sellOrders) {
    return this._post('/api/market/sell_order/change', {
      appid: '730',
      sell_orders: sellOrders,
    });
  }

  async cancelSellOrder(sellOrders, game = 'csgo') {
    return this._post('/api/market/sell_order/cancel', {
      game,
      sell_orders: sellOrders,
    });
  }

  // ==================== 交易管理 ====================

  async getSteamTrade() {
    return this._get('/api/market/steam_trade');
  }

  async getOrdersToDeliver(game = 'csgo', appid = 730) {
    return this._get('/api/market/sell_order/to_deliver', { game, appid: String(appid) });
  }

  async getSellHistory(appid = 730) {
    return this._get('/api/market/sell_order/history', { appid: String(appid), mode: '1' });
  }

  async getBuyHistory(game = 'csgo') {
    return this._get('/api/market/bill_order/history', { game });
  }
}

const buffAPI = new BuffAPI();

module.exports = { buffAPI, BuffAPI, BUFF_BASE_URL, BUFF_FEE_RATE, getRandomUA };
