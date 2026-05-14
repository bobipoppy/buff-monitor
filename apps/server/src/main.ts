import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { logger } from './utils/logger';
import { getPool, closePool } from './database/db';
import { getRedis, closeRedis } from './utils/redis';
import { startCrawlerWorker, stopCrawlerWorker } from './modules/crawler/crawler.queue';
import { startScheduler, stopScheduler } from './modules/crawler/scheduler';
import itemRoutes from './modules/item/item.routes';
import portfolioRoutes from './modules/portfolio/portfolio.routes';
import alertRoutes from './modules/alert/alert.routes';
import { alertService } from './modules/alert/alert.service';
import cron from 'node-cron';

const app = express();
const port = parseInt(process.env.SERVER_PORT || '3001');

app.use(cors());
app.use(express.json());

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.use('/api/items', itemRoutes);
app.use('/api/portfolio', portfolioRoutes);
app.use('/api/alerts', alertRoutes);

app.get('/api/dashboard', async (_req, res) => {
  try {
    const pool = getPool();

    const [portfolioStats, recentAlerts, itemCount] = await Promise.all([
      pool.query(`
        SELECT COUNT(*) as total_holdings,
               COALESCE(SUM(buy_price * quantity), 0)::float as total_invested
        FROM portfolio WHERE status = 'holding'
      `),
      pool.query(`
        SELECT al.id, i.name as item_name, al.message, al.current_price::float, al.triggered_at
        FROM alert_logs al JOIN items i ON i.id = al.item_id
        ORDER BY al.triggered_at DESC LIMIT 10
      `),
      pool.query(`SELECT COUNT(*) as count FROM items WHERE watch_priority != 'none'`),
    ]);

    res.json({
      portfolio: portfolioStats.rows[0],
      recentAlerts: recentAlerts.rows,
      watchedItems: parseInt(itemCount.rows[0].count),
    });
  } catch (err) {
    logger.error({ err }, 'Dashboard query failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

async function start() {
  try {
    const pool = getPool();
    await pool.query('SELECT 1');
    logger.info('PostgreSQL connected');

    getRedis();
    logger.info('Redis connected');

    startCrawlerWorker();
    startScheduler();

    cron.schedule('*/30 * * * *', () => alertService.checkAndNotify());
    cron.schedule('0 20 * * *', () => alertService.sendDailySummary());

    app.listen(port, () => {
      logger.info({ port }, `BUFF Monitor server running on port ${port}`);
    });
  } catch (err) {
    logger.error({ err }, 'Failed to start server');
    process.exit(1);
  }
}

async function shutdown() {
  logger.info('Shutting down...');
  stopScheduler();
  await stopCrawlerWorker();
  await closeRedis();
  await closePool();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

start();
