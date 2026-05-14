import { query } from '../../database/db';
import {
  calculateSMA,
  calculateRSI,
  calculateVolatility,
  calculateVolumeChange,
  detectMACross,
} from './indicators';
import { ANALYSIS_DEFAULTS, calculateBreakEvenPrice } from '@buff-monitor/shared';
import type { PriceAnalysis, Signal, TrendDirection, AlertType } from '@buff-monitor/shared';
import { logger } from '../../utils/logger';

export class AnalysisService {
  async analyzeItem(itemId: number): Promise<PriceAnalysis | null> {
    const priceData = await this.getPriceHistory(itemId, 60);
    if (priceData.length < ANALYSIS_DEFAULTS.MA_LONG) {
      logger.warn({ itemId, records: priceData.length }, 'Insufficient data for analysis');
      return null;
    }

    const prices = priceData.map((r) => r.price);
    const volumes = priceData.map((r) => r.volume);
    const currentPrice = prices[prices.length - 1];

    const ma5 = calculateSMA(prices, ANALYSIS_DEFAULTS.MA_SHORT);
    const ma10 = calculateSMA(prices, ANALYSIS_DEFAULTS.MA_MID);
    const ma30 = calculateSMA(prices, ANALYSIS_DEFAULTS.MA_LONG);
    const rsi = calculateRSI(prices, ANALYSIS_DEFAULTS.RSI_PERIOD);
    const volatility = calculateVolatility(prices, ANALYSIS_DEFAULTS.ATR_PERIOD);
    const volumeChange = calculateVolumeChange(volumes);

    const currentMa5 = ma5[ma5.length - 1] || currentPrice;
    const currentMa10 = ma10[ma10.length - 1] || currentPrice;
    const currentMa30 = ma30[ma30.length - 1] || currentPrice;
    const currentRsi = rsi[rsi.length - 1] || 50;

    const priceDeviationFromMa30 = (currentPrice - currentMa30) / currentMa30;
    const trend = this.determineTrend(currentMa5, currentMa10, currentMa30);
    const signals = await this.generateSignals(itemId, currentPrice, {
      ma5: currentMa5,
      ma10: currentMa10,
      ma30: currentMa30,
      rsi: currentRsi,
      deviation: priceDeviationFromMa30,
      volumeChange,
      ma5Array: ma5,
      ma10Array: ma10,
    });

    return {
      itemId,
      currentPrice,
      ma5: currentMa5,
      ma10: currentMa10,
      ma30: currentMa30,
      rsi14: currentRsi,
      atr14: volatility,
      volatility,
      priceDeviationFromMa30: parseFloat((priceDeviationFromMa30 * 100).toFixed(2)),
      volumeChange: parseFloat((volumeChange * 100).toFixed(2)),
      trend,
      signals,
    };
  }

  private determineTrend(ma5: number, ma10: number, ma30: number): TrendDirection {
    if (ma5 > ma10 && ma10 > ma30) return 'bullish';
    if (ma5 < ma10 && ma10 < ma30) return 'bearish';
    return 'neutral';
  }

  private async generateSignals(
    itemId: number,
    currentPrice: number,
    indicators: {
      ma5: number;
      ma10: number;
      ma30: number;
      rsi: number;
      deviation: number;
      volumeChange: number;
      ma5Array: number[];
      ma10Array: number[];
    }
  ): Promise<Signal[]> {
    const signals: Signal[] = [];
    const now = new Date();

    if (indicators.deviation <= ANALYSIS_DEFAULTS.BUY_DEVIATION_THRESHOLD) {
      const strength = indicators.deviation <= -0.25 ? 'strong' : indicators.deviation <= -0.20 ? 'moderate' : 'weak';
      signals.push({
        type: 'buy_low',
        strength,
        message: `价格低于MA30 ${(indicators.deviation * 100).toFixed(1)}%，当前 ¥${currentPrice}`,
        timestamp: now,
      });
    }

    const portfolio = await this.getHoldingPortfolio(itemId);
    if (portfolio) {
      const breakEven = calculateBreakEvenPrice(portfolio.buy_price);
      const profitRate = (currentPrice - breakEven) / breakEven;

      if (profitRate >= (portfolio.target_price ? (portfolio.target_price - portfolio.buy_price) / portfolio.buy_price : ANALYSIS_DEFAULTS.SELL_TARGET_DEFAULT)) {
        signals.push({
          type: 'sell_high',
          strength: profitRate >= 0.30 ? 'strong' : 'moderate',
          message: `持仓盈利 ${(profitRate * 100).toFixed(1)}%，当前 ¥${currentPrice}，买入价 ¥${portfolio.buy_price}`,
          timestamp: now,
        });
      }

      const stopLossThreshold = portfolio.stop_loss_price
        ? (portfolio.stop_loss_price - portfolio.buy_price) / portfolio.buy_price
        : ANALYSIS_DEFAULTS.STOP_LOSS_DEFAULT;

      const lossRate = (currentPrice - portfolio.buy_price) / portfolio.buy_price;
      if (lossRate <= stopLossThreshold) {
        signals.push({
          type: 'stop_loss',
          strength: lossRate <= -0.20 ? 'strong' : 'moderate',
          message: `持仓亏损 ${(lossRate * 100).toFixed(1)}%，当前 ¥${currentPrice}，买入价 ¥${portfolio.buy_price}，建议止损`,
          timestamp: now,
        });
      }
    }

    const cross = detectMACross(indicators.ma5Array, indicators.ma10Array);
    if (cross) {
      signals.push({
        type: 'trend_reversal',
        strength: 'moderate',
        message: cross === 'golden_cross'
          ? `MA5上穿MA10(金叉)，趋势可能反转向上`
          : `MA5下穿MA10(死叉)，趋势可能反转向下`,
        timestamp: now,
      });
    }

    if (Math.abs(indicators.volumeChange) >= ANALYSIS_DEFAULTS.VOLUME_SPIKE_THRESHOLD) {
      signals.push({
        type: 'volume_spike',
        strength: Math.abs(indicators.volumeChange) >= 3 ? 'strong' : 'moderate',
        message: `成交量异动 ${indicators.volumeChange > 0 ? '放大' : '缩小'} ${(Math.abs(indicators.volumeChange) * 100).toFixed(0)}%`,
        timestamp: now,
      });
    }

    if (indicators.rsi < 25) {
      signals.push({
        type: 'buy_low',
        strength: indicators.rsi < 15 ? 'strong' : 'weak',
        message: `RSI=${indicators.rsi.toFixed(1)} 超卖区间，可能有反弹机会`,
        timestamp: now,
      });
    } else if (indicators.rsi > 75) {
      signals.push({
        type: 'sell_high',
        strength: indicators.rsi > 85 ? 'strong' : 'weak',
        message: `RSI=${indicators.rsi.toFixed(1)} 超买区间，注意风险`,
        timestamp: now,
      });
    }

    return signals;
  }

  private async getPriceHistory(itemId: number, days: number): Promise<Array<{ price: number; volume: number; recorded_at: Date }>> {
    const result = await query<{ price: number; volume: number; recorded_at: Date }>(
      `SELECT price::float, volume, recorded_at FROM price_records
       WHERE item_id = $1 AND recorded_at > NOW() - INTERVAL '${days} days'
       ORDER BY recorded_at ASC`,
      [itemId]
    );
    return result.rows;
  }

  private async getHoldingPortfolio(itemId: number): Promise<{ buy_price: number; target_price: number | null; stop_loss_price: number | null } | null> {
    const result = await query<{ buy_price: number; target_price: number | null; stop_loss_price: number | null }>(
      `SELECT buy_price::float, target_price::float, stop_loss_price::float FROM portfolio
       WHERE item_id = $1 AND status = 'holding' LIMIT 1`,
      [itemId]
    );
    return result.rows[0] || null;
  }

  async analyzeAllWatched(): Promise<PriceAnalysis[]> {
    const items = await query<{ id: number }>(
      `SELECT id FROM items WHERE watch_priority IN ('high', 'normal') ORDER BY watch_priority ASC`
    );

    const analyses: PriceAnalysis[] = [];
    for (const item of items.rows) {
      const analysis = await this.analyzeItem(item.id);
      if (analysis) analyses.push(analysis);
    }
    return analyses;
  }
}

export const analysisService = new AnalysisService();
