import cron from 'node-cron';
import { crawlerService } from './crawler.service';
import { scheduleBatchPriceCrawl, scheduleMarketScan } from './crawler.queue';
import { logger } from '../../utils/logger';

let portfolioTask: cron.ScheduledTask | null = null;
let watchlistTask: cron.ScheduledTask | null = null;
let fullScanTask: cron.ScheduledTask | null = null;

export function startScheduler(): void {
  portfolioTask = cron.schedule('*/30 * * * *', async () => {
    try {
      const items = await crawlerService.getPortfolioItems();
      if (items.length > 0) {
        await scheduleBatchPriceCrawl(items.map((i) => i.goods_id), 1);
        logger.info({ count: items.length }, 'Scheduled portfolio price crawl');
      }
    } catch (err) {
      logger.error({ err }, 'Portfolio crawl scheduling failed');
    }
  });

  watchlistTask = cron.schedule('0 */2 * * *', async () => {
    try {
      const items = await crawlerService.getWatchlistItems();
      if (items.length > 0) {
        await scheduleBatchPriceCrawl(items.map((i) => i.goods_id), 5);
        logger.info({ count: items.length }, 'Scheduled watchlist price crawl');
      }
    } catch (err) {
      logger.error({ err }, 'Watchlist crawl scheduling failed');
    }
  });

  fullScanTask = cron.schedule('0 3 * * *', async () => {
    try {
      await scheduleMarketScan('csgo', 10);
      logger.info('Scheduled daily full market scan');
    } catch (err) {
      logger.error({ err }, 'Full scan scheduling failed');
    }
  });

  logger.info('Crawler scheduler started: portfolio(30min), watchlist(2h), fullscan(daily 3am)');
}

export function stopScheduler(): void {
  portfolioTask?.stop();
  watchlistTask?.stop();
  fullScanTask?.stop();
  logger.info('Crawler scheduler stopped');
}
