const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...options?.headers },
    ...options,
  });

  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(error.error || `HTTP ${res.status}`);
  }

  return res.json();
}

export const api = {
  getDashboard: () => request<DashboardData>('/api/dashboard'),

  getItems: (params?: { game?: string; search?: string; page?: number }) => {
    const query = new URLSearchParams();
    if (params?.game) query.set('game', params.game);
    if (params?.search) query.set('search', params.search);
    if (params?.page) query.set('page', String(params.page));
    return request<{ items: ItemData[]; total: number }>(`/api/items?${query}`);
  },

  getItem: (id: number) => request<ItemData>(`/api/items/${id}`),

  getItemPrices: (id: number, days?: number) =>
    request<PriceData[]>(`/api/items/${id}/prices?days=${days || 30}`),

  getItemAnalysis: (id: number) => request<AnalysisData>(`/api/items/${id}/analysis`),

  addItem: (data: { goods_id: number; name: string; game?: string; watch_priority?: string }) =>
    request('/api/items', { method: 'POST', body: JSON.stringify(data) }),

  scanMarket: (game?: string, pages?: number) =>
    request('/api/items/scan', { method: 'POST', body: JSON.stringify({ game, pages }) }),

  getPortfolio: (status?: string) =>
    request<PortfolioResponse>(`/api/portfolio?status=${status || 'holding'}`),

  addPortfolio: (data: { item_id: number; buy_price: number; quantity?: number; buy_date: string; target_price?: number; stop_loss_price?: number }) =>
    request('/api/portfolio', { method: 'POST', body: JSON.stringify(data) }),

  sellPortfolio: (id: number, sold_price: number) =>
    request(`/api/portfolio/${id}/sell`, { method: 'POST', body: JSON.stringify({ sold_price }) }),

  getAlertRules: () => request<AlertRuleData[]>('/api/alerts/rules'),

  getAlertLogs: (limit?: number) => request<AlertLogData[]>(`/api/alerts/logs?limit=${limit || 50}`),

  triggerAlertCheck: () => request('/api/alerts/check', { method: 'POST' }),
};

export interface DashboardData {
  portfolio: { total_holdings: string; total_invested: number };
  recentAlerts: Array<{ id: number; item_name: string; message: string; current_price: number; triggered_at: string }>;
  watchedItems: number;
}

export interface ItemData {
  id: number;
  goods_id: number;
  name: string;
  game: string;
  category: string;
  image_url: string;
  steam_price: number | null;
  buff_min_price: number;
  sell_count: number;
  watch_priority: string;
  updated_at: string;
}

export interface PriceData {
  price: number;
  avg_price: number;
  volume: number;
  sell_count: number;
  recorded_at: string;
}

export interface AnalysisData {
  itemId: number;
  currentPrice: number;
  ma5: number;
  ma10: number;
  ma30: number;
  rsi14: number;
  volatility: number;
  priceDeviationFromMa30: number;
  volumeChange: number;
  trend: string;
  signals: Array<{ type: string; strength: string; message: string }>;
}

export interface PortfolioResponse {
  items: PortfolioItem[];
  summary: { totalItems: number; totalInvested: number; totalUnrealizedPnl: number; overallReturn: number };
}

export interface PortfolioItem {
  id: number;
  item_id: number;
  item_name: string;
  image_url: string;
  buy_price: number;
  quantity: number;
  buy_date: string;
  target_price: number | null;
  stop_loss_price: number | null;
  status: string;
  current_price: number;
  breakEvenPrice: number;
  unrealizedPnl: number | null;
  profitRate: number | null;
}

export interface AlertRuleData {
  id: number;
  item_id: number;
  item_name: string;
  type: string;
  condition: string;
  threshold: number;
  enabled: boolean;
  cooldown_minutes: number;
}

export interface AlertLogData {
  id: number;
  item_name: string;
  message: string;
  current_price: number;
  triggered_at: string;
  notified: boolean;
}
