const { getDb } = require('./database');

const DEFAULTS = {
  MA_SHORT: 5,
  MA_MID: 10,
  MA_LONG: 30,
  RSI_PERIOD: 14,
  BUY_DEVIATION: -0.15,
  SELL_TARGET: 0.20,
  STOP_LOSS: -0.10,
  VOLUME_SPIKE: 2.0,
  BUFF_FEE_RATE: 0.025,
};

function calculateSMA(prices, period) {
  if (prices.length < period) return [];
  const result = [];
  for (let i = period - 1; i < prices.length; i++) {
    const slice = prices.slice(i - period + 1, i + 1);
    result.push(parseFloat((slice.reduce((s, p) => s + p, 0) / period).toFixed(2)));
  }
  return result;
}

function calculateRSI(prices, period = 14) {
  if (prices.length < period + 1) return [];

  const changes = [];
  for (let i = 1; i < prices.length; i++) {
    changes.push(prices[i] - prices[i - 1]);
  }

  const result = [];
  let avgGain = 0, avgLoss = 0;

  for (let i = 0; i < period; i++) {
    if (changes[i] > 0) avgGain += changes[i];
    else avgLoss += Math.abs(changes[i]);
  }
  avgGain /= period;
  avgLoss /= period;

  result.push(avgLoss === 0 ? 100 : parseFloat((100 - 100 / (1 + avgGain / avgLoss)).toFixed(2)));

  for (let i = period; i < changes.length; i++) {
    const gain = changes[i] > 0 ? changes[i] : 0;
    const loss = changes[i] < 0 ? Math.abs(changes[i]) : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    result.push(avgLoss === 0 ? 100 : parseFloat((100 - 100 / (1 + avgGain / avgLoss)).toFixed(2)));
  }

  return result;
}

function calculateVolatility(prices, period = 14) {
  if (prices.length < period) return 0;
  const recent = prices.slice(-period);
  const mean = recent.reduce((s, p) => s + p, 0) / period;
  const variance = recent.reduce((s, p) => s + Math.pow(p - mean, 2), 0) / period;
  return parseFloat((Math.sqrt(variance) / mean * 100).toFixed(2));
}

function detectMACross(shortMA, longMA) {
  if (shortMA.length < 2 || longMA.length < 2) return null;
  const ps = shortMA[shortMA.length - 2], cs = shortMA[shortMA.length - 1];
  const pl = longMA[longMA.length - 2], cl = longMA[longMA.length - 1];
  if (ps <= pl && cs > cl) return 'golden_cross';
  if (ps >= pl && cs < cl) return 'death_cross';
  return null;
}

function analyzeItem(itemId) {
  const db = getDb();
  const records = db.prepare(`
    SELECT price, volume FROM price_records
    WHERE item_id = ? AND recorded_at > datetime('now', '-60 days')
    ORDER BY recorded_at ASC
  `).all(itemId);

  if (records.length < DEFAULTS.MA_LONG) return null;

  const prices = records.map((r) => r.price);
  const volumes = records.map((r) => r.volume);
  const currentPrice = prices[prices.length - 1];

  const ma5 = calculateSMA(prices, DEFAULTS.MA_SHORT);
  const ma10 = calculateSMA(prices, DEFAULTS.MA_MID);
  const ma30 = calculateSMA(prices, DEFAULTS.MA_LONG);
  const rsi = calculateRSI(prices, DEFAULTS.RSI_PERIOD);
  const volatility = calculateVolatility(prices);

  const currentMa5 = ma5[ma5.length - 1] || currentPrice;
  const currentMa10 = ma10[ma10.length - 1] || currentPrice;
  const currentMa30 = ma30[ma30.length - 1] || currentPrice;
  const currentRsi = rsi[rsi.length - 1] || 50;
  const deviation = (currentPrice - currentMa30) / currentMa30;

  const recentVolume = volumes[volumes.length - 1] || 0;
  const avgVolume = volumes.slice(-8, -1).reduce((s, v) => s + v, 0) / 7 || 1;
  const volumeChange = (recentVolume - avgVolume) / avgVolume;

  const trend = currentMa5 > currentMa10 && currentMa10 > currentMa30 ? 'bullish'
    : currentMa5 < currentMa10 && currentMa10 < currentMa30 ? 'bearish' : 'neutral';

  const signals = [];

  if (deviation <= DEFAULTS.BUY_DEVIATION) {
    signals.push({
      type: 'buy_low',
      strength: deviation <= -0.25 ? 'strong' : deviation <= -0.20 ? 'moderate' : 'weak',
      message: `价格低于MA30 ${(deviation * 100).toFixed(1)}%，当前 ¥${currentPrice}`,
    });
  }

  const portfolio = db.prepare(`SELECT buy_price, target_price, stop_loss_price FROM portfolio WHERE item_id = ? AND status = 'holding' LIMIT 1`).get(itemId);
  if (portfolio) {
    const breakEven = portfolio.buy_price / (1 - DEFAULTS.BUFF_FEE_RATE);
    const profitRate = (currentPrice - breakEven) / breakEven;

    if (profitRate >= (portfolio.target_price ? (portfolio.target_price - portfolio.buy_price) / portfolio.buy_price : DEFAULTS.SELL_TARGET)) {
      signals.push({ type: 'sell_high', strength: profitRate >= 0.30 ? 'strong' : 'moderate', message: `持仓盈利 ${(profitRate * 100).toFixed(1)}%，当前 ¥${currentPrice}` });
    }

    const lossRate = (currentPrice - portfolio.buy_price) / portfolio.buy_price;
    const stopThreshold = portfolio.stop_loss_price ? (portfolio.stop_loss_price - portfolio.buy_price) / portfolio.buy_price : DEFAULTS.STOP_LOSS;
    if (lossRate <= stopThreshold) {
      signals.push({ type: 'stop_loss', strength: lossRate <= -0.20 ? 'strong' : 'moderate', message: `持仓亏损 ${(lossRate * 100).toFixed(1)}%，建议止损` });
    }
  }

  const cross = detectMACross(ma5, ma10);
  if (cross) {
    signals.push({
      type: 'trend_reversal',
      strength: 'moderate',
      message: cross === 'golden_cross' ? 'MA5上穿MA10(金叉)' : 'MA5下穿MA10(死叉)',
    });
  }

  if (Math.abs(volumeChange) >= DEFAULTS.VOLUME_SPIKE) {
    signals.push({ type: 'volume_spike', strength: 'moderate', message: `成交量${volumeChange > 0 ? '放大' : '缩小'} ${(Math.abs(volumeChange) * 100).toFixed(0)}%` });
  }

  if (currentRsi < 25) signals.push({ type: 'buy_low', strength: 'weak', message: `RSI=${currentRsi.toFixed(1)} 超卖` });
  if (currentRsi > 75) signals.push({ type: 'sell_high', strength: 'weak', message: `RSI=${currentRsi.toFixed(1)} 超买` });

  return {
    itemId, currentPrice, ma5: currentMa5, ma10: currentMa10, ma30: currentMa30,
    rsi14: currentRsi, volatility, priceDeviationFromMa30: parseFloat((deviation * 100).toFixed(2)),
    volumeChange: parseFloat((volumeChange * 100).toFixed(2)), trend, signals,
  };
}

module.exports = { analyzeItem, calculateSMA, calculateRSI, DEFAULTS };
