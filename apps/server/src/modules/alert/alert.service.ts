import { query } from '../../database/db';
import { analysisService } from '../analysis/analysis.service';
import { notificationService } from './notification';
import type { Signal, PriceAnalysis } from '@buff-monitor/shared';
import { ANALYSIS_DEFAULTS } from '@buff-monitor/shared';
import { logger } from '../../utils/logger';

export class AlertService {
  async checkAndNotify(): Promise<void> {
    try {
      const items = await query<{ id: number; name: string; goods_id: number }>(
        `SELECT id, name, goods_id FROM items WHERE watch_priority IN ('high', 'normal')`
      );

      for (const item of items.rows) {
        const analysis = await analysisService.analyzeItem(item.id);
        if (!analysis || analysis.signals.length === 0) continue;

        const actionableSignals = analysis.signals.filter(
          (s: Signal) => s.strength === 'strong' || s.strength === 'moderate'
        );

        if (actionableSignals.length === 0) continue;

        const shouldNotify = await this.shouldSendAlert(item.id, actionableSignals);
        if (!shouldNotify) continue;

        const message = notificationService.formatPriceAlert(
          item.name,
          actionableSignals,
          analysis.currentPrice
        );

        const sent = await notificationService.sendWeChatNotification(message);

        await this.logAlert(item.id, actionableSignals, analysis.currentPrice, sent);
      }
    } catch (err) {
      logger.error({ err }, 'Alert check failed');
    }
  }

  private async shouldSendAlert(itemId: number, signals: Signal[]): Promise<boolean> {
    const cooldownMinutes = ANALYSIS_DEFAULTS.ALERT_COOLDOWN_MINUTES;

    for (const signal of signals) {
      const existing = await query<{ id: number }>(
        `SELECT id FROM alert_logs
         WHERE item_id = $1
           AND message LIKE $2
           AND triggered_at > NOW() - INTERVAL '${cooldownMinutes} minutes'
         LIMIT 1`,
        [itemId, `%${signal.type}%`]
      );

      if (existing.rows.length === 0) return true;
    }

    return false;
  }

  private async logAlert(itemId: number, signals: Signal[], currentPrice: number, notified: boolean): Promise<void> {
    const message = signals.map((s) => `[${s.type}] ${s.message}`).join(' | ');

    await query(
      `INSERT INTO alert_logs (item_id, message, current_price, triggered_at, notified)
       VALUES ($1, $2, $3, NOW(), $4)`,
      [itemId, message, currentPrice, notified]
    );

    logger.info({ itemId, signalCount: signals.length, notified }, 'Alert logged');
  }

  async sendDailySummary(): Promise<void> {
    try {
      const analyses = await analysisService.analyzeAllWatched();

      const items = await query<{ id: number; name: string }>(
        `SELECT id, name FROM items WHERE id = ANY($1)`,
        [analyses.map((a) => a.itemId)]
      );

      const itemMap = new Map(items.rows.map((i) => [i.id, i.name]));

      const summaryData = analyses.map((a) => ({
        itemName: itemMap.get(a.itemId) || `Item#${a.itemId}`,
        currentPrice: a.currentPrice,
        trend: a.trend,
        signalCount: a.signals.length,
      }));

      const message = notificationService.formatDailySummary(summaryData);
      await notificationService.sendWeChatNotification(message);

      logger.info({ itemCount: summaryData.length }, 'Daily summary sent');
    } catch (err) {
      logger.error({ err }, 'Failed to send daily summary');
    }
  }

  async getAlertHistory(limit: number = 50): Promise<Array<{
    id: number;
    item_name: string;
    message: string;
    current_price: number;
    triggered_at: Date;
    notified: boolean;
  }>> {
    const result = await query<{
      id: number;
      item_name: string;
      message: string;
      current_price: number;
      triggered_at: Date;
      notified: boolean;
    }>(
      `SELECT al.id, i.name as item_name, al.message, al.current_price::float,
              al.triggered_at, al.notified
       FROM alert_logs al
       JOIN items i ON i.id = al.item_id
       ORDER BY al.triggered_at DESC
       LIMIT $1`,
      [limit]
    );
    return result.rows;
  }
}

export const alertService = new AlertService();
