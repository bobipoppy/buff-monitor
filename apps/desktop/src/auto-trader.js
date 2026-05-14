const { getDb } = require('./database');
const { buffAPI, BUFF_FEE_RATE } = require('./buff-api');
const { pricingEngine } = require('./pricing');
const { analyzeItem } = require('./analysis');
const { sendWeChatNotification, sendNativeNotification } = require('./notification');

/**
 * 自动交易引擎
 * 基于分析信号自动执行买入/卖出/上架/改价操作
 */
class AutoTrader {
  constructor() {
    this.enabled = false;
    this.running = false;
    this.config = {
      autoBuy: false,
      autoSell: false,
      autoReprice: false,
      maxBuyAmount: 200,
      maxDailyTrades: 10,
      requireStrongSignal: true,
      cooldownMinutes: 60,
      dryRun: true,
    };
    this.tradeLog = [];
    this.checkInterval = null;
  }

  updateConfig(newConfig) {
    Object.assign(this.config, newConfig);
  }

  start() {
    if (this.enabled) return;
    this.enabled = true;
    this.checkInterval = setInterval(() => this.runCycle(), 30 * 60 * 1000);
    console.log('[AutoTrader] Started');
    setTimeout(() => this.runCycle(), 5000);
  }

  stop() {
    this.enabled = false;
    if (this.checkInterval) clearInterval(this.checkInterval);
    this.checkInterval = null;
    console.log('[AutoTrader] Stopped');
  }

  async runCycle() {
    if (this.running || !this.enabled) return;
    this.running = true;

    try {
      console.log('[AutoTrader] Running cycle...');

      if (this.config.autoSell) {
        await this.checkStopLoss();
        await this.checkTakeProfit();
      }

      if (this.config.autoBuy) {
        await this.checkBuySignals();
      }

      if (this.config.autoReprice) {
        await this.checkReprice();
      }

      console.log('[AutoTrader] Cycle complete');
    } catch (err) {
      console.error('[AutoTrader] Cycle error:', err.message);
    } finally {
      this.running = false;
    }
  }

  /**
   * 检查止损信号
   */
  async checkStopLoss() {
    const db = getDb();
    const holdings = db.prepare(`
      SELECT p.*, i.goods_id, i.name as item_name, i.buff_min_price as current_price
      FROM portfolio p JOIN items i ON i.id = p.item_id
      WHERE p.status = 'holding' AND p.stop_loss_price IS NOT NULL
    `).all();

    for (const h of holdings) {
      if (!h.current_price || h.current_price <= 0) continue;

      const stopLoss = pricingEngine.evaluateStopLoss(h.current_price, h.buy_price);
      if (!stopLoss.shouldStopLoss && h.current_price > h.stop_loss_price) continue;

      const msg = `止损触发: ${h.item_name} 当前¥${h.current_price}, 买入¥${h.buy_price}, 亏损${stopLoss.currentLoss}%`;
      console.log(`[AutoTrader] ${msg}`);

      if (this.config.dryRun) {
        this._logTrade('stop_loss_signal', h, msg);
        sendNativeNotification('止损信号', msg);
        continue;
      }

      try {
        await this._executeSell(h, h.current_price, 'stop_loss');
        sendNativeNotification('止损卖出', `${h.item_name} 已挂单 ¥${h.current_price}`);
        sendWeChatNotification('止损卖出', msg);
      } catch (err) {
        console.error(`[AutoTrader] Stop loss execution failed: ${err.message}`);
      }

      await this._sleep(5000);
    }
  }

  /**
   * 检查止盈信号
   */
  async checkTakeProfit() {
    const db = getDb();
    const holdings = db.prepare(`
      SELECT p.*, i.goods_id, i.name as item_name, i.buff_min_price as current_price
      FROM portfolio p JOIN items i ON i.id = p.item_id
      WHERE p.status = 'holding' AND p.target_price IS NOT NULL
    `).all();

    for (const h of holdings) {
      if (!h.current_price || h.current_price < h.target_price) continue;

      const sellAdvice = pricingEngine.calculateSellPrice(h.current_price, h.buy_price, h.quantity);
      const msg = `止盈触发: ${h.item_name} 当前¥${h.current_price} >= 目标¥${h.target_price}, 收益${sellAdvice.profitRate}%`;
      console.log(`[AutoTrader] ${msg}`);

      if (this.config.dryRun) {
        this._logTrade('take_profit_signal', h, msg);
        sendNativeNotification('止盈信号', msg);
        continue;
      }

      try {
        await this._executeSell(h, sellAdvice.sellPrice, 'take_profit');
        sendNativeNotification('止盈卖出', `${h.item_name} 已挂单 ¥${sellAdvice.sellPrice}`);
        sendWeChatNotification('止盈卖出', msg);
      } catch (err) {
        console.error(`[AutoTrader] Take profit execution failed: ${err.message}`);
      }

      await this._sleep(5000);
    }
  }

  /**
   * 检查买入信号
   */
  async checkBuySignals() {
    const db = getDb();
    const watchItems = db.prepare(`
      SELECT * FROM items WHERE watch_priority = 'high' ORDER BY updated_at DESC LIMIT 20
    `).all();

    const todayTrades = this._getTodayTradeCount();
    if (todayTrades >= this.config.maxDailyTrades) {
      console.log('[AutoTrader] Daily trade limit reached');
      return;
    }

    for (const item of watchItems) {
      if (this._isOnCooldown(item.id)) continue;

      const analysis = analyzeItem(item.id);
      if (!analysis || analysis.signals.length === 0) continue;

      const buySignals = analysis.signals.filter((s) =>
        s.type === 'buy' && (this.config.requireStrongSignal ? s.strength === 'strong' : true)
      );

      if (buySignals.length === 0) continue;

      const market = await pricingEngine.getMarketFairPrice(item.goods_id);
      if (!market) continue;
      if (market.fairPrice > this.config.maxBuyAmount) continue;

      const msg = `买入信号: ${item.name} ¥${market.fairPrice} [${buySignals.map((s) => s.message).join(', ')}]`;
      console.log(`[AutoTrader] ${msg}`);

      if (this.config.dryRun) {
        this._logTrade('buy_signal', { item_name: item.name, goods_id: item.goods_id, price: market.fairPrice }, msg);
        sendNativeNotification('买入信号', msg);
        continue;
      }

      try {
        await this._executeBuy(item, market);
        sendNativeNotification('自动买入', `${item.name} ¥${market.fairPrice}`);
        sendWeChatNotification('自动买入', msg);
      } catch (err) {
        console.error(`[AutoTrader] Buy execution failed: ${err.message}`);
      }

      await this._sleep(8000);
    }
  }

  /**
   * 自动改价：跟踪市场最低价
   */
  async checkReprice() {
    try {
      const onSale = await buffAPI.getMyOnSale();
      if (!onSale?.items?.length) return;

      const changes = [];
      for (const listing of onSale.items) {
        const goodsId = listing.goods_id;
        const currentPrice = parseFloat(listing.price);

        const market = await pricingEngine.getMarketFairPrice(goodsId);
        if (!market) continue;

        const newPrice = Math.max(
          pricingEngine.config.minPriceThreshold,
          market.fairPrice - pricingEngine.config.undercutAmount
        );

        if (Math.abs(newPrice - currentPrice) > 0.01 && newPrice < currentPrice) {
          changes.push({
            sell_order_id: listing.id,
            price: newPrice.toFixed(2),
            income: (newPrice * (1 - BUFF_FEE_RATE)).toFixed(2),
          });
          console.log(`[AutoTrader] Reprice: ${listing.goods_id} ¥${currentPrice} → ¥${newPrice.toFixed(2)}`);
        }

        await this._sleep(2000);
      }

      if (changes.length > 0 && !this.config.dryRun) {
        for (let i = 0; i < changes.length; i += 50) {
          await buffAPI.changeSellPrice(changes.slice(i, i + 50));
          await this._sleep(3000);
        }
        console.log(`[AutoTrader] Repriced ${changes.length} items`);
      } else if (changes.length > 0) {
        this._logTrade('reprice_signal', null, `${changes.length} items could be repriced`);
      }
    } catch (err) {
      console.error(`[AutoTrader] Reprice check failed: ${err.message}`);
    }
  }

  /**
   * 手动一键买入
   */
  async manualBuy(goodsId, maxPrice = null) {
    const market = await pricingEngine.getMarketFairPrice(goodsId);
    if (!market?.lowestSellOrderId) throw new Error('No listings found');

    const price = market.minPrice;
    if (maxPrice && price > maxPrice) throw new Error(`Price ¥${price} exceeds max ¥${maxPrice}`);

    if (this.config.dryRun) {
      return { success: true, dryRun: true, price, message: `[模拟] 买入 ¥${price}` };
    }

    const result = await buffAPI.buyGoods(market.lowestSellOrderId, goodsId, price.toFixed(2));
    const db = getDb();
    const item = db.prepare('SELECT id FROM items WHERE goods_id = ?').get(goodsId);
    if (item) {
      db.prepare(`INSERT INTO portfolio (item_id, buy_price, quantity, buy_date) VALUES (?, ?, 1, datetime('now'))`)
        .run(item.id, price);
    }

    this._logTrade('manual_buy', { goods_id: goodsId, price }, `Manual buy at ¥${price}`);
    return { success: true, price, result };
  }

  /**
   * 手动一键上架
   */
  async manualSell(goodsId, price = null) {
    const db = getDb();
    const item = db.prepare('SELECT * FROM items WHERE goods_id = ?').get(goodsId);
    if (!item) throw new Error('Item not found');

    let sellPrice = price;
    if (!sellPrice) {
      const market = await pricingEngine.getMarketFairPrice(goodsId);
      if (!market) throw new Error('Cannot determine price');
      sellPrice = Math.max(pricingEngine.config.minPriceThreshold, market.fairPrice - pricingEngine.config.undercutAmount);
    }

    if (this.config.dryRun) {
      return { success: true, dryRun: true, sellPrice, message: `[模拟] 上架 ¥${sellPrice}` };
    }

    const inventory = await buffAPI.getMyInventory();
    const asset = inventory?.items?.find((a) => String(a.goods_id) === String(goodsId));
    if (!asset) throw new Error('Item not in Steam inventory');

    const result = await buffAPI.createSellOrder([{
      assetid: asset.assetid,
      game: 'csgo',
      price: sellPrice.toFixed(2),
      income: (sellPrice * (1 - BUFF_FEE_RATE)).toFixed(2),
    }]);

    this._logTrade('manual_sell', { goods_id: goodsId, price: sellPrice }, `Listed at ¥${sellPrice}`);
    return { success: true, sellPrice, result };
  }

  async _executeBuy(item, market) {
    if (!market.lowestSellOrderId) throw new Error('No sell order ID');
    await buffAPI.buyGoods(market.lowestSellOrderId, item.goods_id, market.minPrice.toFixed(2));

    const db = getDb();
    db.prepare(`INSERT INTO portfolio (item_id, buy_price, quantity, buy_date) VALUES (?, ?, 1, datetime('now'))`)
      .run(item.id, market.minPrice);
    db.prepare(`UPDATE items SET watch_priority = 'high' WHERE id = ?`).run(item.id);

    this._logTrade('auto_buy', { item_name: item.name, price: market.minPrice }, `Auto bought ${item.name} at ¥${market.minPrice}`);
  }

  async _executeSell(holding, price, reason) {
    const db = getDb();
    const item = db.prepare('SELECT goods_id FROM items WHERE id = ?').get(holding.item_id);
    if (!item) throw new Error('Item not found');

    const inventory = await buffAPI.getMyInventory();
    const asset = inventory?.items?.find((a) => String(a.goods_id) === String(item.goods_id));
    if (!asset) throw new Error('Item not in inventory, may need manual sell');

    await buffAPI.createSellOrder([{
      assetid: asset.assetid,
      game: 'csgo',
      price: price.toFixed(2),
      income: (price * (1 - BUFF_FEE_RATE)).toFixed(2),
    }]);

    db.prepare(`UPDATE portfolio SET status = 'selling', updated_at = datetime('now') WHERE id = ?`).run(holding.id);
    this._logTrade(reason, holding, `Listed ${holding.item_name} at ¥${price}`);
  }

  _logTrade(type, data, message) {
    const entry = { type, data, message, time: new Date().toISOString() };
    this.tradeLog.unshift(entry);
    if (this.tradeLog.length > 200) this.tradeLog.length = 200;

    const db = getDb();
    try {
      db.prepare(`INSERT INTO trade_logs (type, message, data, created_at) VALUES (?, ?, ?, datetime('now'))`)
        .run(type, message, JSON.stringify(data));
    } catch {}
  }

  _getTodayTradeCount() {
    const db = getDb();
    try {
      const row = db.prepare(`SELECT COUNT(*) as count FROM trade_logs WHERE type IN ('auto_buy','auto_sell','stop_loss','take_profit') AND created_at > datetime('now', '-1 day')`).get();
      return row?.count || 0;
    } catch {
      return 0;
    }
  }

  _isOnCooldown(itemId) {
    const db = getDb();
    try {
      const row = db.prepare(`SELECT id FROM trade_logs WHERE data LIKE ? AND created_at > datetime('now', '-${this.config.cooldownMinutes} minutes') LIMIT 1`)
        .get(`%"item_id":${itemId}%`);
      return !!row;
    } catch {
      return false;
    }
  }

  _sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  getStatus() {
    return {
      enabled: this.enabled,
      running: this.running,
      config: this.config,
      recentTrades: this.tradeLog.slice(0, 20),
      todayCount: this._getTodayTradeCount(),
    };
  }
}

const autoTrader = new AutoTrader();

module.exports = { autoTrader, AutoTrader };
