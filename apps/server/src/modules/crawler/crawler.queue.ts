import { Queue, Worker, Job } from 'bullmq';
import { getRedis } from '../../utils/redis';
import { crawlerService } from './crawler.service';
import { logger } from '../../utils/logger';

const QUEUE_NAME = 'buff-crawler';

interface CrawlJobData {
  type: 'price' | 'history' | 'market_scan';
  goodsId?: number;
  game?: string;
  page?: number;
  days?: number;
}

let crawlerQueue: Queue<CrawlJobData> | null = null;
let crawlerWorker: Worker<CrawlJobData> | null = null;

export function getCrawlerQueue(): Queue<CrawlJobData> {
  if (!crawlerQueue) {
    crawlerQueue = new Queue<CrawlJobData>(QUEUE_NAME, {
      connection: getRedis(),
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: { count: 1000 },
        removeOnFail: { count: 500 },
      },
    });
  }
  return crawlerQueue;
}

export function startCrawlerWorker(): void {
  crawlerWorker = new Worker<CrawlJobData>(
    QUEUE_NAME,
    async (job: Job<CrawlJobData>) => {
      const { type, goodsId, game, page, days } = job.data;

      switch (type) {
        case 'price':
          if (!goodsId) throw new Error('goodsId required for price crawl');
          await crawlerService.crawlItemPrice(goodsId);
          break;

        case 'history':
          if (!goodsId) throw new Error('goodsId required for history crawl');
          await crawlerService.crawlPriceHistory(goodsId, days || 30);
          break;

        case 'market_scan':
          await crawlerService.crawlMarketPage(game || 'csgo', page || 1);
          break;

        default:
          throw new Error(`Unknown job type: ${type}`);
      }
    },
    {
      connection: getRedis(),
      concurrency: 1,
      limiter: { max: 20, duration: 60000 },
    }
  );

  crawlerWorker.on('completed', (job) => {
    logger.debug({ jobId: job.id, type: job.data.type }, 'Crawl job completed');
  });

  crawlerWorker.on('failed', (job, err) => {
    logger.error({ jobId: job?.id, type: job?.data.type, err }, 'Crawl job failed');
  });

  logger.info('Crawler worker started');
}

export async function schedulePriceCrawl(goodsId: number, priority: number = 5): Promise<void> {
  const queue = getCrawlerQueue();
  await queue.add(`price-${goodsId}`, { type: 'price', goodsId }, { priority });
}

export async function scheduleBatchPriceCrawl(goodsIds: number[], priority: number = 5): Promise<void> {
  const queue = getCrawlerQueue();
  const jobs = goodsIds.map((goodsId) => ({
    name: `price-${goodsId}`,
    data: { type: 'price' as const, goodsId },
    opts: { priority },
  }));
  await queue.addBulk(jobs);
}

export async function scheduleMarketScan(game: string = 'csgo', pages: number = 5): Promise<void> {
  const queue = getCrawlerQueue();
  const jobs = Array.from({ length: pages }, (_, i) => ({
    name: `market-${game}-${i + 1}`,
    data: { type: 'market_scan' as const, game, page: i + 1 },
    opts: { priority: 10 },
  }));
  await queue.addBulk(jobs);
}

export async function stopCrawlerWorker(): Promise<void> {
  if (crawlerWorker) {
    await crawlerWorker.close();
    crawlerWorker = null;
  }
  if (crawlerQueue) {
    await crawlerQueue.close();
    crawlerQueue = null;
  }
}
