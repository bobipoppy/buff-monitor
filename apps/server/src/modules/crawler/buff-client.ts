import { BUFF_BASE_URL, BUFF_API } from '@buff-monitor/shared';
import type { BuffApiResponse, BuffGoodsItem, BuffPriceHistoryItem } from '@buff-monitor/shared';
import { buffRateLimiter } from '../../utils/rate-limiter';
import { logger } from '../../utils/logger';

export interface BuffMarketResponse {
  items: BuffGoodsItem[];
  page_num: number;
  page_size: number;
  total_count: number;
  total_page: number;
}

export interface BuffSellOrder {
  price: string;
  user_id: string;
  created_at: number;
}

export class BuffClient {
  private cookie: string;
  private headers: Record<string, string>;

  constructor(cookie?: string) {
    this.cookie = cookie || process.env.BUFF_COOKIE || '';
    this.headers = {
      'Cookie': this.cookie,
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Referer': BUFF_BASE_URL,
      'Accept': 'application/json',
    };
  }

  updateCookie(cookie: string) {
    this.cookie = cookie;
    this.headers['Cookie'] = cookie;
  }

  async getMarketGoods(game: string = 'csgo', page: number = 1, pageSize: number = 80): Promise<BuffMarketResponse> {
    const url = `${BUFF_BASE_URL}${BUFF_API.MARKET_GOODS}?game=${game}&page_num=${page}&page_size=${pageSize}`;
    const data = await this.request<BuffMarketResponse>(url);
    return data;
  }

  async getPriceHistory(goodsId: number, days: number = 30): Promise<BuffPriceHistoryItem[]> {
    const url = `${BUFF_BASE_URL}${BUFF_API.PRICE_HISTORY}?goods_id=${goodsId}&days=${days}`;
    const data = await this.request<{ price_history: Array<[number, number]> }>(url);
    return (data.price_history || []).map(([time, price]) => ({ time, price }));
  }

  async getSellOrders(goodsId: number, page: number = 1): Promise<{ items: BuffSellOrder[]; totalCount: number }> {
    const url = `${BUFF_BASE_URL}${BUFF_API.SELL_ORDER}?goods_id=${goodsId}&page_num=${page}`;
    const data = await this.request<{ items: BuffSellOrder[]; total_count: number }>(url);
    return { items: data.items || [], totalCount: data.total_count || 0 };
  }

  async getBillOrders(goodsId: number, page: number = 1): Promise<{ items: Array<{ price: string; updated_at: number }>; totalCount: number }> {
    const url = `${BUFF_BASE_URL}${BUFF_API.BILL_ORDER}?goods_id=${goodsId}&page_num=${page}`;
    const data = await this.request<{ items: Array<{ price: string; updated_at: number }>; total_count: number }>(url);
    return { items: data.items || [], totalCount: data.total_count || 0 };
  }

  private async request<T>(url: string, retries: number = 3): Promise<T> {
    await buffRateLimiter.acquire();

    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const response = await fetch(url, { headers: this.headers });

        if (response.status === 429) {
          const backoff = Math.pow(2, attempt) * 5000;
          logger.warn({ url, attempt, backoff }, 'Rate limited by BUFF, backing off');
          await new Promise((resolve) => setTimeout(resolve, backoff));
          continue;
        }

        if (response.status === 403) {
          logger.error('BUFF cookie expired or invalid, need to re-authenticate');
          throw new Error('BUFF_AUTH_EXPIRED');
        }

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const json = await response.json() as BuffApiResponse<T>;
        if (json.code !== 'OK') {
          throw new Error(`BUFF API error: ${json.code} - ${json.msg}`);
        }

        return json.data;
      } catch (err) {
        if (attempt === retries || (err as Error).message === 'BUFF_AUTH_EXPIRED') {
          throw err;
        }
        const backoff = Math.pow(2, attempt) * 1000;
        logger.warn({ url, attempt, err }, `Request failed, retrying in ${backoff}ms`);
        await new Promise((resolve) => setTimeout(resolve, backoff));
      }
    }

    throw new Error(`Failed to fetch ${url} after ${retries} retries`);
  }
}

export const buffClient = new BuffClient();
