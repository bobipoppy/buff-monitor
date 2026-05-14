export interface Item {
  id: number;
  goodsId: number;
  name: string;
  game: GameType;
  category: string;
  imageUrl: string;
  steamPrice: number | null;
  buffMinPrice: number;
  sellCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface PriceRecord {
  id: number;
  itemId: number;
  price: number;
  avgPrice: number;
  volume: number;
  sellCount: number;
  recordedAt: Date;
}

export interface Portfolio {
  id: number;
  itemId: number;
  buyPrice: number;
  quantity: number;
  buyDate: Date;
  targetPrice: number | null;
  stopLossPrice: number | null;
  soldPrice: number | null;
  soldDate: Date | null;
  status: PortfolioStatus;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface AlertRule {
  id: number;
  itemId: number | null;
  portfolioId: number | null;
  type: AlertType;
  condition: AlertCondition;
  threshold: number;
  enabled: boolean;
  lastTriggeredAt: Date | null;
  cooldownMinutes: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface AlertLog {
  id: number;
  ruleId: number;
  itemId: number;
  message: string;
  currentPrice: number;
  triggeredAt: Date;
  notified: boolean;
}

export type GameType = 'csgo' | 'dota2';
export type PortfolioStatus = 'holding' | 'sold' | 'watching';
export type AlertType = 'buy_low' | 'sell_high' | 'stop_loss' | 'trend_reversal' | 'volume_spike';
export type AlertCondition = 'below_ma' | 'above_target' | 'below_stop_loss' | 'ma_cross' | 'volume_change';

export interface PriceAnalysis {
  itemId: number;
  currentPrice: number;
  ma5: number;
  ma10: number;
  ma30: number;
  rsi14: number;
  atr14: number;
  volatility: number;
  priceDeviationFromMa30: number;
  volumeChange: number;
  trend: TrendDirection;
  signals: Signal[];
}

export type TrendDirection = 'bullish' | 'bearish' | 'neutral';

export interface Signal {
  type: AlertType;
  strength: 'strong' | 'moderate' | 'weak';
  message: string;
  timestamp: Date;
}

export interface BuffApiResponse<T> {
  code: string;
  data: T;
  msg: string | null;
}

export interface BuffGoodsItem {
  id: number;
  name: string;
  goods_info: {
    icon_url: string;
    steam_price: string;
    steam_price_cny: string;
  };
  sell_min_price: string;
  sell_num: number;
  quick_price: string;
}

export interface BuffPriceHistoryItem {
  price: number;
  time: number;
}
