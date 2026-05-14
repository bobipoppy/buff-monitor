import 'dotenv/config';
import { query, closePool } from './db';
import { logger } from '../utils/logger';

const SAMPLE_ITEMS = [
  { goods_id: 34474, name: 'AK-47 | 火蛇 (久经沙场)', game: 'csgo', category: '步枪' },
  { goods_id: 42525, name: 'M4A4 | 二西莫夫 (久经沙场)', game: 'csgo', category: '步枪' },
  { goods_id: 33891, name: 'AWP | 二西莫夫 (久经沙场)', game: 'csgo', category: '狙击步枪' },
  { goods_id: 44813, name: '蝴蝶刀（★） | 渐变之色 (崭新出厂)', game: 'csgo', category: '刀' },
  { goods_id: 45053, name: '运动手套（★） | 超导体 (略有磨损)', game: 'csgo', category: '手套' },
];

async function seed() {
  try {
    for (const item of SAMPLE_ITEMS) {
      await query(
        `INSERT INTO items (goods_id, name, game, category, buff_min_price, watch_priority)
         VALUES ($1, $2, $3, $4, 0, 'high')
         ON CONFLICT (goods_id) DO NOTHING`,
        [item.goods_id, item.name, item.game, item.category]
      );
    }
    logger.info(`Seeded ${SAMPLE_ITEMS.length} sample items`);
  } catch (err) {
    logger.error({ err }, 'Seed failed');
    process.exit(1);
  } finally {
    await closePool();
  }
}

seed();
