/**
 * Technical indicator calculations for price analysis.
 * All functions expect prices in chronological order (oldest first).
 */

export function calculateSMA(prices: number[], period: number): number[] {
  if (prices.length < period) return [];

  const result: number[] = [];
  for (let i = period - 1; i < prices.length; i++) {
    const slice = prices.slice(i - period + 1, i + 1);
    const avg = slice.reduce((sum, p) => sum + p, 0) / period;
    result.push(parseFloat(avg.toFixed(2)));
  }
  return result;
}

export function calculateEMA(prices: number[], period: number): number[] {
  if (prices.length < period) return [];

  const multiplier = 2 / (period + 1);
  const result: number[] = [];

  let ema = prices.slice(0, period).reduce((sum, p) => sum + p, 0) / period;
  result.push(parseFloat(ema.toFixed(2)));

  for (let i = period; i < prices.length; i++) {
    ema = (prices[i] - ema) * multiplier + ema;
    result.push(parseFloat(ema.toFixed(2)));
  }
  return result;
}

export function calculateRSI(prices: number[], period: number = 14): number[] {
  if (prices.length < period + 1) return [];

  const changes: number[] = [];
  for (let i = 1; i < prices.length; i++) {
    changes.push(prices[i] - prices[i - 1]);
  }

  const result: number[] = [];
  let avgGain = 0;
  let avgLoss = 0;

  for (let i = 0; i < period; i++) {
    if (changes[i] > 0) avgGain += changes[i];
    else avgLoss += Math.abs(changes[i]);
  }
  avgGain /= period;
  avgLoss /= period;

  if (avgLoss === 0) {
    result.push(100);
  } else {
    const rs = avgGain / avgLoss;
    result.push(parseFloat((100 - 100 / (1 + rs)).toFixed(2)));
  }

  for (let i = period; i < changes.length; i++) {
    const gain = changes[i] > 0 ? changes[i] : 0;
    const loss = changes[i] < 0 ? Math.abs(changes[i]) : 0;

    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;

    if (avgLoss === 0) {
      result.push(100);
    } else {
      const rs = avgGain / avgLoss;
      result.push(parseFloat((100 - 100 / (1 + rs)).toFixed(2)));
    }
  }

  return result;
}

export function calculateATR(
  highs: number[],
  lows: number[],
  closes: number[],
  period: number = 14
): number[] {
  if (closes.length < period + 1) return [];

  const trueRanges: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    const tr = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    );
    trueRanges.push(tr);
  }

  const result: number[] = [];
  let atr = trueRanges.slice(0, period).reduce((sum, tr) => sum + tr, 0) / period;
  result.push(parseFloat(atr.toFixed(2)));

  for (let i = period; i < trueRanges.length; i++) {
    atr = (atr * (period - 1) + trueRanges[i]) / period;
    result.push(parseFloat(atr.toFixed(2)));
  }

  return result;
}

export function calculateVolatility(prices: number[], period: number = 14): number {
  if (prices.length < period) return 0;

  const recent = prices.slice(-period);
  const mean = recent.reduce((sum, p) => sum + p, 0) / period;
  const variance = recent.reduce((sum, p) => sum + Math.pow(p - mean, 2), 0) / period;
  return parseFloat((Math.sqrt(variance) / mean * 100).toFixed(2));
}

export function detectMACross(
  shortMA: number[],
  longMA: number[]
): 'golden_cross' | 'death_cross' | null {
  if (shortMA.length < 2 || longMA.length < 2) return null;

  const prevShort = shortMA[shortMA.length - 2];
  const currShort = shortMA[shortMA.length - 1];
  const prevLong = longMA[longMA.length - 2];
  const currLong = longMA[longMA.length - 1];

  if (prevShort <= prevLong && currShort > currLong) return 'golden_cross';
  if (prevShort >= prevLong && currShort < currLong) return 'death_cross';
  return null;
}

export function calculateVolumeChange(volumes: number[], period: number = 7): number {
  if (volumes.length < period + 1) return 0;

  const recent = volumes[volumes.length - 1];
  const avgPast = volumes.slice(-period - 1, -1).reduce((sum, v) => sum + v, 0) / period;

  if (avgPast === 0) return 0;
  return parseFloat(((recent - avgPast) / avgPast).toFixed(4));
}
