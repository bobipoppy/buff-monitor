export const BUFF_BASE_URL = 'https://buff.163.com';

export const BUFF_API = {
  MARKET_GOODS: '/api/market/goods',
  PRICE_HISTORY: '/api/market/goods/price_history',
  SELL_ORDER: '/api/market/goods/sell_order',
  BILL_ORDER: '/api/market/goods/bill_order',
} as const;

export const BUFF_FEE_RATE = 0.025;

export const DEFAULT_CRAWL_INTERVALS = {
  PORTFOLIO: 30 * 60 * 1000,
  WATCHLIST: 2 * 60 * 60 * 1000,
  FULL_SCAN: 24 * 60 * 60 * 1000,
} as const;

export const ANALYSIS_DEFAULTS = {
  MA_SHORT: 5,
  MA_MID: 10,
  MA_LONG: 30,
  RSI_PERIOD: 14,
  ATR_PERIOD: 14,
  BUY_DEVIATION_THRESHOLD: -0.15,
  SELL_TARGET_DEFAULT: 0.20,
  STOP_LOSS_DEFAULT: -0.10,
  VOLUME_SPIKE_THRESHOLD: 2.0,
  ALERT_COOLDOWN_MINUTES: 240,
} as const;

export function calculateNetProfit(buyPrice: number, sellPrice: number, quantity: number): number {
  const grossRevenue = sellPrice * quantity;
  const fee = grossRevenue * BUFF_FEE_RATE;
  const cost = buyPrice * quantity;
  return grossRevenue - fee - cost;
}

export function calculateBreakEvenPrice(buyPrice: number): number {
  return buyPrice / (1 - BUFF_FEE_RATE);
}
