import { buffClient } from './buff-client';
import { query } from '../../database/db';
import { logger } from '../../utils/logger';

export class CrawlerService {
  async crawlItemPrice(goodsId: number): Promise<void> {
    try {
      const itemResult = await query<{ id: number; name: string }>(
        'SELECT id, name FROM items WHERE goods_id = $1',
        [goodsId]
      );

      if (itemResult.rows.length === 0) {
        logger.warn({ goodsId }, 'Item not found in database');
        return;
      }

      const item = itemResult.rows[0];
      const sellOrders = await buffClient.getSellOrders(goodsId);

      if (sellOrders.items.length === 0) {
        logger.warn({ goodsId, name: item.name }, 'No sell orders found');
        return;
      }

      const prices = sellOrders.items.map((o) => parseFloat(o.price));
      const minPrice = Math.min(...prices);
      const avgPrice = prices.reduce((a, b) => a + b, 0) / prices.length;

      await query(
        `UPDATE items SET buff_min_price = $1, sell_count = $2, updated_at = NOW() WHERE id = $3`,
        [minPrice, sellOrders.totalCount, item.id]
      );

      await query(
        `INSERT INTO price_records (item_id, price, avg_price, volume, sell_count, recorded_at)
         VALUES ($1, $2, $3, 0, $4, NOW())`,
        [item.id, minPrice, avgPrice, sellOrders.totalCount]
      );

      logger.info({ goodsId, name: item.name, minPrice, avgPrice }, 'Price updated');
    } catch (err) {
      if ((err as Error).message === 'BUFF_AUTH_EXPIRED') {
        logger.error('Cookie expired, pausing crawler');
        throw err;
      }
      logger.error({ err, goodsId }, 'Failed to crawl item price');
    }
  }

  async crawlPriceHistory(goodsId: number, days: number = 30): Promise<void> {
    try {
      const itemResult = await query<{ id: number }>(
        'SELECT id FROM items WHERE goods_id = $1',
        [goodsId]
      );

      if (itemResult.rows.length === 0) return;

      const item = itemResult.rows[0];
      const history = await buffClient.getPriceHistory(goodsId, days);

      for (const record of history) {
        await query(
          `INSERT INTO price_records (item_id, price, avg_price, volume, sell_count, recorded_at)
           VALUES ($1, $2, $2, 0, 0, to_timestamp($3))
           ON CONFLICT DO NOTHING`,
          [item.id, record.price, record.time]
        );
      }

      logger.info({ goodsId, records: history.length }, 'Price history imported');
    } catch (err) {
      logger.error({ err, goodsId }, 'Failed to crawl price history');
    }
  }

  async crawlMarketPage(game: string = 'csgo', page: number = 1): Promise<number> {
    try {
      const data = await buffClient.getMarketGoods(game, page);

      for (const item of data.items) {
        await query(
          `INSERT INTO items (goods_id, name, game, image_url, steam_price, buff_min_price, sell_count)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (goods_id) DO UPDATE SET
             buff_min_price = EXCLUDED.buff_min_price,
             sell_count = EXCLUDED.sell_count,
             steam_price = EXCLUDED.steam_price,
             updated_at = NOW()`,
          [
            item.id,
            item.name,
            game,
            item.goods_info.icon_url,
            parseFloat(item.goods_info.steam_price_cny) || null,
            parseFloat(item.sell_min_price),
            item.sell_num,
          ]
        );
      }

      logger.info({ game, page, count: data.items.length, total: data.total_count }, 'Market page crawled');
      return data.total_page;
    } catch (err) {
      logger.error({ err, game, page }, 'Failed to crawl market page');
      throw err;
    }
  }

  async getPortfolioItems(): Promise<Array<{ goods_id: number }>> {
    const result = await query<{ goods_id: number }>(
      `SELECT DISTINCT i.goods_id FROM items i
       JOIN portfolio p ON p.item_id = i.id
       WHERE p.status = 'holding'`
    );
    return result.rows;
  }

  async getWatchlistItems(): Promise<Array<{ goods_id: number }>> {
    const result = await query<{ goods_id: number }>(
      `SELECT goods_id FROM items WHERE watch_priority IN ('high', 'normal')
       ORDER BY watch_priority ASC, updated_at ASC`
    );
    return result.rows;
  }
}

export const crawlerService = new CrawlerService();
