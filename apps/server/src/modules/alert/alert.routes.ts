import { Router, Request, Response } from 'express';
import { query } from '../../database/db';
import { alertService } from './alert.service';
import { logger } from '../../utils/logger';

const router = Router();

router.get('/rules', async (req: Request, res: Response) => {
  try {
    const result = await query(
      `SELECT ar.*, i.name as item_name
       FROM alert_rules ar
       LEFT JOIN items i ON i.id = ar.item_id
       ORDER BY ar.created_at DESC`
    );
    res.json(result.rows);
  } catch (err) {
    logger.error({ err }, 'Failed to fetch alert rules');
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/rules', async (req: Request, res: Response) => {
  try {
    const { item_id, portfolio_id, type, condition, threshold, cooldown_minutes = 240 } = req.body;

    if (!type || !condition || threshold === undefined) {
      return res.status(400).json({ error: 'type, condition, and threshold are required' });
    }

    const result = await query(
      `INSERT INTO alert_rules (item_id, portfolio_id, type, condition, threshold, cooldown_minutes)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [item_id || null, portfolio_id || null, type, condition, threshold, cooldown_minutes]
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    logger.error({ err }, 'Failed to create alert rule');
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.patch('/rules/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { enabled, threshold, cooldown_minutes } = req.body;

    const updates: string[] = [];
    const params: unknown[] = [];
    let paramIdx = 1;

    if (enabled !== undefined) { updates.push(`enabled = $${paramIdx++}`); params.push(enabled); }
    if (threshold !== undefined) { updates.push(`threshold = $${paramIdx++}`); params.push(threshold); }
    if (cooldown_minutes !== undefined) { updates.push(`cooldown_minutes = $${paramIdx++}`); params.push(cooldown_minutes); }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    updates.push('updated_at = NOW()');
    params.push(id);

    const result = await query(
      `UPDATE alert_rules SET ${updates.join(', ')} WHERE id = $${paramIdx} RETURNING *`,
      params
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Rule not found' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    logger.error({ err }, 'Failed to update alert rule');
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.delete('/rules/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const result = await query('DELETE FROM alert_rules WHERE id = $1 RETURNING id', [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Rule not found' });
    }

    res.json({ deleted: true });
  } catch (err) {
    logger.error({ err }, 'Failed to delete alert rule');
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/logs', async (req: Request, res: Response) => {
  try {
    const { limit = '50' } = req.query;
    const logs = await alertService.getAlertHistory(parseInt(limit as string));
    res.json(logs);
  } catch (err) {
    logger.error({ err }, 'Failed to fetch alert logs');
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/check', async (_req: Request, res: Response) => {
  try {
    await alertService.checkAndNotify();
    res.json({ message: 'Alert check completed' });
  } catch (err) {
    logger.error({ err }, 'Failed to run alert check');
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/daily-summary', async (_req: Request, res: Response) => {
  try {
    await alertService.sendDailySummary();
    res.json({ message: 'Daily summary sent' });
  } catch (err) {
    logger.error({ err }, 'Failed to send daily summary');
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
