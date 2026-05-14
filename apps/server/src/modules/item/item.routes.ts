import { Router, Request, Response } from 'express';
import { query } from '../../database/db';
import { analysisService } from '../analysis/analysis.service';
import { schedulePriceCrawl, scheduleMarketScan } from '../crawler/crawler.queue';
import { logger } from '../../utils/logger';

const router = Router();

router.get('/', async (req: Request, res: Response) => {
  try {
    const { game, category, search, page = '1', limit = '50' } = req.query;
    const offset = (parseInt(page as string) - 1) * parseInt(limit as string);

    let sql = `SELECT id, goods_id, name, game, category, image_url,
               steam_price::float, buff_min_price::float, sell_count,
               watch_priority, updated_at FROM items WHERE 1=1`;
    const params: unknown[] = [];
    let paramIdx = 1;

    if (game) {
      sql += ` AND game = $${paramIdx++}`;
      params.push(game);
    }
    if (category) {
      sql += ` AND category = $${paramIdx++}`;
      params.push(category);
    }
    if (search) {
      sql += ` AND name ILIKE $${paramIdx++}`;
      params.push(`%${search}%`);
    }

    const countResult = await query<{ count: string }>(
      sql.replace(/SELECT .+ FROM/, 'SELECT COUNT(*) as count FROM'),
      params
    );

    sql += ` ORDER BY updated_at DESC LIMIT $${paramIdx++} OFFSET $${paramIdx++}`;
    params.push(parseInt(limit as string), offset);

    const result = await query(sql, params);

    res.json({
      items: result.rows,
      total: parseInt(countResult.rows[0].count),
      page: parseInt(page as string),
      limit: parseInt(limit as string),
    });
  } catch (err) {
    logger.error({ err }, 'Failed to fetch items');
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const result = await query(
      `SELECT id, goods_id, name, game, category, image_url,
              steam_price::float, buff_min_price::float, sell_count,
              watch_priority, created_at, updated_at
       FROM items WHERE id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Item not found' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    logger.error({ err }, 'Failed to fetch item');
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/:id/prices', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { days = '30' } = req.query;

    const result = await query(
      `SELECT price::float, avg_price::float, volume, sell_count, recorded_at
       FROM price_records
       WHERE item_id = $1 AND recorded_at > NOW() - INTERVAL '${parseInt(days as string)} days'
       ORDER BY recorded_at ASC`,
      [id]
    );

    res.json(result.rows);
  } catch (err) {
    logger.error({ err }, 'Failed to fetch prices');
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/:id/analysis', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const analysis = await analysisService.analyzeItem(parseInt(id));

    if (!analysis) {
      return res.status(404).json({ error: 'Insufficient data for analysis' });
    }

    res.json(analysis);
  } catch (err) {
    logger.error({ err }, 'Failed to analyze item');
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/', async (req: Request, res: Response) => {
  try {
    const { goods_id, name, game = 'csgo', category, watch_priority = 'normal' } = req.body;

    if (!goods_id || !name) {
      return res.status(400).json({ error: 'goods_id and name are required' });
    }

    const result = await query(
      `INSERT INTO items (goods_id, name, game, category, watch_priority, buff_min_price)
       VALUES ($1, $2, $3, $4, $5, 0)
       ON CONFLICT (goods_id) DO UPDATE SET watch_priority = $5, updated_at = NOW()
       RETURNING id, goods_id, name, game, category, watch_priority`,
      [goods_id, name, game, category, watch_priority]
    );

    await schedulePriceCrawl(goods_id, 1);

    res.status(201).json(result.rows[0]);
  } catch (err) {
    logger.error({ err }, 'Failed to create item');
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.patch('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { watch_priority, category } = req.body;

    const updates: string[] = [];
    const params: unknown[] = [];
    let paramIdx = 1;

    if (watch_priority) {
      updates.push(`watch_priority = $${paramIdx++}`);
      params.push(watch_priority);
    }
    if (category) {
      updates.push(`category = $${paramIdx++}`);
      params.push(category);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    updates.push('updated_at = NOW()');
    params.push(id);

    const result = await query(
      `UPDATE items SET ${updates.join(', ')} WHERE id = $${paramIdx} RETURNING *`,
      params
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Item not found' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    logger.error({ err }, 'Failed to update item');
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const result = await query('DELETE FROM items WHERE id = $1 RETURNING id', [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Item not found' });
    }

    res.json({ deleted: true });
  } catch (err) {
    logger.error({ err }, 'Failed to delete item');
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/scan', async (req: Request, res: Response) => {
  try {
    const { game = 'csgo', pages = 5 } = req.body;
    await scheduleMarketScan(game, pages);
    res.json({ message: `Market scan scheduled: ${game}, ${pages} pages` });
  } catch (err) {
    logger.error({ err }, 'Failed to schedule scan');
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
