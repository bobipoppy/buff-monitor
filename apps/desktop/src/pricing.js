const { buffAPI, BUFF_FEE_RATE } = require('./buff-api');
const { getDb } = require('./database');

/**
 * 智能定价引擎
 * 参考 Steamauto 的定价策略，结合自有技术分析
 */
class PricingEngine {
  constructor(config = {}) {
    this.config = {
      referenceCount: 10,
      outlierThreshold: 0.05,
      undercutAmount: 0.01,
      takeProfitRatio: 0.15,
      stopLossRatio: -0.10,
      minPriceThreshold: 1.0,
      maxAutoTradeAmount: 500,
      ...config,
    };
  }

  updateConfig(newConfig) {
    Object.assign(this.config, newConfig);
  }

  /**
   * 获取市场合理价格（去异常值）
   * 策略：取前N个最低价，剔除离群值，返回合理参考价
   */
  async getMarketFairPrice(goodsId) {
    const data = await buffAPI.getSellOrders(goodsId);
    if (!data?.items?.length) return null;

    const prices = data.items
      .map((o) => parseFloat(o.price))
      .filter((p) => p > 0)
      .sort((a, b) => a - b);

    if (prices.length === 0) return null;
    if (prices.length === 1) return { fairPrice: prices[0], minPrice: prices[0], listings: data.total_count };

    const count = Math.min(this.config.referenceCount, prices.length);
    const referencePrices = prices.slice(0, count);

    let fairPrice;
    if (referencePrices.length >= 2) {
      const lowest = referencePrices[0];
      const second = referencePrices[1];
      if ((second - lowest) / lowest < this.config.outlierThreshold) {
        fairPrice = lowest;
      } else {
        fairPrice = second;
      }
    } else {
      fairPrice = referencePrices[0];
    }

    const median = referencePrices[Math.floor(referencePrices.length / 2)];
    const avg = referencePrices.reduce((a, b) => a + b, 0) / referencePrices.length;

    return {
      fairPrice: round2(fairPrice),
      minPrice: round2(prices[0]),
      medianPrice: round2(median),
      avgPrice: round2(avg),
      listings: data.total_count,
      priceSpread: round2((prices[count - 1] - prices[0]) / prices[0] * 100),
      lowestSellOrderId: data.items[0]?.id,
    };
  }

  /**
   * 计算卖出定价
   * 考虑：市场价、买入成本、止盈率、自动压价
   */
  calculateSellPrice(marketFairPrice, buyPrice, quantity = 1) {
    let targetPrice = marketFairPrice;

    if (buyPrice > 0 && this.config.takeProfitRatio > 0) {
      const takeProfitPrice = buyPrice * (1 + this.config.takeProfitRatio) / (1 - BUFF_FEE_RATE);
      targetPrice = Math.max(targetPrice, takeProfitPrice);
    }

    if (this.config.undercutAmount > 0 && targetPrice > this.config.minPriceThreshold) {
      targetPrice = Math.max(this.config.minPriceThreshold, targetPrice - this.config.undercutAmount);
    }

    const revenue = targetPrice * quantity * (1 - BUFF_FEE_RATE);
    const cost = buyPrice * quantity;
    const profit = revenue - cost;
    const profitRate = cost > 0 ? profit / cost : 0;

    return {
      sellPrice: round2(targetPrice),
      revenue: round2(revenue),
      profit: round2(profit),
      profitRate: round2(profitRate * 100),
      breakEven: round2(buyPrice / (1 - BUFF_FEE_RATE)),
    };
  }

  /**
   * 计算买入建议价
   * 基于市场价和期望收益率反推合理买入价
   */
  calculateBuyPrice(marketFairPrice, expectedProfitRate = null) {
    const targetProfit = expectedProfitRate || this.config.takeProfitRatio;
    const maxBuyPrice = marketFairPrice * (1 - BUFF_FEE_RATE) / (1 + targetProfit);

    return {
      maxBuyPrice: round2(maxBuyPrice),
      currentMinPrice: round2(marketFairPrice),
      afterFee: round2(marketFairPrice * (1 - BUFF_FEE_RATE)),
    };
  }

  /**
   * 评估持仓是否需要止损
   */
  evaluateStopLoss(currentPrice, buyPrice) {
    const currentValue = currentPrice * (1 - BUFF_FEE_RATE);
    const loss = (currentValue - buyPrice) / buyPrice;

    return {
      currentLoss: round2(loss * 100),
      shouldStopLoss: loss <= this.config.stopLossRatio,
      stopLossPrice: round2(buyPrice * (1 + this.config.stopLossRatio) / (1 - BUFF_FEE_RATE)),
    };
  }

  /**
   * 批量检查持仓定价建议
   */
  async analyzePortfolioPricing() {
    const db = getDb();
    const holdings = db.prepare(`
      SELECT p.*, i.goods_id, i.name as item_name, i.buff_min_price as current_price
      FROM portfolio p JOIN items i ON i.id = p.item_id
      WHERE p.status = 'holding'
    `).all();

    const results = [];
    for (const holding of holdings) {
      const market = await this.getMarketFairPrice(holding.goods_id);
      if (!market) continue;

      const sellAdvice = this.calculateSellPrice(market.fairPrice, holding.buy_price, holding.quantity);
      const stopLoss = this.evaluateStopLoss(market.fairPrice, holding.buy_price);

      results.push({
        ...holding,
        market,
        sellAdvice,
        stopLoss,
        action: stopLoss.shouldStopLoss ? 'stop_loss' : (sellAdvice.profitRate >= this.config.takeProfitRatio * 100 ? 'take_profit' : 'hold'),
      });

      await new Promise((r) => setTimeout(r, 1000));
    }

    return results;
  }

  /**
   * 多平台比价（BUFF vs Steam）
   */
  async crossPlatformCompare(goodsId) {
    const db = getDb();
    const item = db.prepare('SELECT * FROM items WHERE goods_id = ?').get(goodsId);
    if (!item) return null;

    const market = await this.getMarketFairPrice(goodsId);
    if (!market) return null;

    const steamPrice = item.steam_price;
    if (!steamPrice) return { buffPrice: market.fairPrice, steamPrice: null, arbitrage: null };

    const buffNet = market.fairPrice * (1 - BUFF_FEE_RATE);
    const steamNet = steamPrice * (1 - 0.15);
    const buffToSteamRatio = market.fairPrice / steamPrice;

    return {
      buffPrice: market.fairPrice,
      steamPrice,
      buffNet: round2(buffNet),
      steamNet: round2(steamNet),
      ratio: round2(buffToSteamRatio * 100),
      arbitrage: round2((buffNet - steamNet) / steamNet * 100),
    };
  }
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

const pricingEngine = new PricingEngine();

module.exports = { pricingEngine, PricingEngine };
