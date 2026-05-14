import { logger } from './logger';

export class RateLimiter {
  private queue: Array<() => void> = [];
  private running = 0;
  private lastRequestTime = 0;

  constructor(
    private readonly maxPerMinute: number,
    private readonly minIntervalMs: number = 3000
  ) {}

  async acquire(): Promise<void> {
    const now = Date.now();
    const elapsed = now - this.lastRequestTime;

    if (elapsed < this.minIntervalMs) {
      const waitTime = this.minIntervalMs - elapsed;
      await this.sleep(waitTime);
    }

    if (this.running >= this.maxPerMinute) {
      await new Promise<void>((resolve) => {
        this.queue.push(resolve);
      });
    }

    this.running++;
    this.lastRequestTime = Date.now();

    setTimeout(() => {
      this.running--;
      const next = this.queue.shift();
      if (next) next();
    }, 60000);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  getStatus() {
    return {
      running: this.running,
      queued: this.queue.length,
      maxPerMinute: this.maxPerMinute,
    };
  }
}

export const buffRateLimiter = new RateLimiter(
  parseInt(process.env.CRAWL_RATE_LIMIT_PER_MINUTE || '20'),
  3000
);
