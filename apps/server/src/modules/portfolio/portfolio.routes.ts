import { Router, Request, Response } from 'express';
import { query } from '../../database/db';
import { calculateBreakEvenPrice, calculateNetProfit } from '@buff-monitor/shared';
import { logger } from '../../utils/logger';

const router = Router();

router.get('/', async (req: Request, res: Response) => {
  try {
    const { status = 'holding' } = req.query;

    interface PortfolioRow {
      id: number;
      item_id: number;
      item_name: string;
      image_url: string;
      goods_id: number;
      buy_price: number;
      quantity: number;
      buy_date: string;
      target_price: number | null;
      stop_loss_price: number | null;
      sold_price: number | null;
      sold_date: string | null;
      status: string;
      notes: string | null;
      current_price: number;
    }

    const result = await query<PortfolioRow>(
      `SELECT p.id, p.item_id, i.name as item_name, i.image_url, i.goods_id,
              p.buy_price::float, p.quantity, p.buy_date,
              p.target_price::float, p.stop_loss_price::float,
              p.sold_price::float, p.sold_date,
              p.status, p.notes,
              i.buff_min_price::float as current_price
       FROM portfolio p
       JOIN items i ON i.id = p.item_id
       WHERE p.status = $1
       ORDER BY p.created_at DESC`,
      [status]
    );

    const portfolioWithPnl = result.rows.map((row) => {
      const breakEvenPrice = calculateBreakEvenPrice(row.buy_price);
      const unrealizedPnl = row.status === 'holding'
        ? calculateNetProfit(row.buy_price, row.current_price, row.quantity)
        : null;
      const realizedPnl = row.status === 'sold' && row.sold_price
        ? calculateNetProfit(row.buy_price, row.sold_price, row.quantity)
        : null;
      const profitRate = row.status === 'holding'
        ? (row.current_price - breakEvenPrice) / breakEvenPrice
        : null;

      return { ...row, breakEvenPrice, unrealizedPnl, realizedPnl, profitRate };
    });

    const totalInvested = portfolioWithPnl.reduce((sum, p) => sum + p.buy_price * p.quantity, 0);
    const totalUnrealizedPnl = portfolioWithPnl.reduce((sum, p) => sum + (p.unrealizedPnl || 0), 0);

    res.json({
      items: portfolioWithPnl,
      summary: {
        totalItems: portfolioWithPnl.length,
        totalInvested: parseFloat(totalInvested.toFixed(2)),
        totalUnrealizedPnl: parseFloat(totalUnrealizedPnl.toFixed(2)),
        overallReturn: totalInvested > 0
          ? parseFloat((totalUnrealizedPnl / totalInvested * 100).toFixed(2))
          : 0,
      },
    });
  } catch (err) {
    logger.error({ err }, 'Failed to fetch portfolio');
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/', async (req: Request, res: Response) => {
  try {
    const { item_id, buy_price, quantity = 1, buy_date, target_price, stop_loss_price, notes } = req.body;

    if (!item_id || !buy_price || !buy_date) {
      return res.status(400).json({ error: 'item_id, buy_price, and buy_date are required' });
    }

    const itemExists = await query('SELECT id FROM items WHERE id = $1', [item_id]);
    if (itemExists.rows.length === 0) {
      return res.status(404).json({ error: 'Item not found' });
    }

    const result = await query(
      `INSERT INTO portfolio (item_id, buy_price, quantity, buy_date, target_price, stop_loss_price, notes, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'holding')
       RETURNING *`,
      [item_id, buy_price, quantity, buy_date, target_price || null, stop_loss_price || null, notes || null]
    );

    await query(
      `UPDATE items SET watch_priority = 'high' WHERE id = $1`,
      [item_id]
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    logger.error({ err }, 'Failed to create portfolio entry');
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.patch('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { target_price, stop_loss_price, notes, status, sold_price, sold_date } = req.body;

    const updates: string[] = [];
    const params: unknown[] = [];
    let paramIdx = 1;

    if (target_price !== undefined) { updates.push(`target_price = $${paramIdx++}`); params.push(target_price); }
    if (stop_loss_price !== undefined) { updates.push(`stop_loss_price = $${paramIdx++}`); params.push(stop_loss_price); }
    if (notes !== undefined) { updates.push(`notes = $${paramIdx++}`); params.push(notes); }
    if (status) { updates.push(`status = $${paramIdx++}`); params.push(status); }
    if (sold_price !== undefined) { updates.push(`sold_price = $${paramIdx++}`); params.push(sold_price); }
    if (sold_date !== undefined) { updates.push(`sold_date = $${paramIdx++}`); params.push(sold_date); }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    updates.push('updated_at = NOW()');
    params.push(id);

    const result = await query(
      `UPDATE portfolio SET ${updates.join(', ')} WHERE id = $${paramIdx} RETURNING *`,
      params
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Portfolio entry not found' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    logger.error({ err }, 'Failed to update portfolio');
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/:id/sell', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { sold_price, sold_date } = req.body;

    if (!sold_price) {
      return res.status(400).json({ error: 'sold_price is required' });
    }

    const result = await query(
      `UPDATE portfolio SET status = 'sold', sold_price = $1, sold_date = $2, updated_at = NOW()
       WHERE id = $3 AND status = 'holding'
       RETURNING *`,
      [sold_price, sold_date || new Date().toISOString(), id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Active portfolio entry not found' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    logger.error({ err }, 'Failed to sell portfolio');
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const result = await query('DELETE FROM portfolio WHERE id = $1 RETURNING id', [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Portfolio entry not found' });
    }

    res.json({ deleted: true });
  } catch (err) {
    logger.error({ err }, 'Failed to delete portfolio entry');
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
