import { logger } from '../../utils/logger';

interface PushPlusMessage {
  title: string;
  content: string;
  template?: 'html' | 'markdown' | 'txt';
}

export class NotificationService {
  private token: string;
  private apiUrl = 'https://www.pushplus.plus/send';

  constructor(token?: string) {
    this.token = token || process.env.PUSHPLUS_TOKEN || '';
  }

  async sendWeChatNotification(message: PushPlusMessage): Promise<boolean> {
    if (!this.token) {
      logger.warn('PushPlus token not configured, skipping notification');
      return false;
    }

    try {
      const response = await fetch(this.apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token: this.token,
          title: message.title,
          content: message.content,
          template: message.template || 'markdown',
        }),
      });

      const result = await response.json() as { code: number; msg: string };

      if (result.code !== 200) {
        logger.error({ result }, 'PushPlus notification failed');
        return false;
      }

      logger.info({ title: message.title }, 'WeChat notification sent');
      return true;
    } catch (err) {
      logger.error({ err }, 'Failed to send WeChat notification');
      return false;
    }
  }

  formatPriceAlert(itemName: string, signals: Array<{ type: string; message: string; strength: string }>, currentPrice: number): PushPlusMessage {
    const strongSignals = signals.filter((s) => s.strength === 'strong');
    const emoji = strongSignals.length > 0 ? '🚨' : '📊';

    const content = [
      `## ${emoji} ${itemName}`,
      '',
      `**当前价格**: ¥${currentPrice}`,
      '',
      '### 信号详情',
      '',
      ...signals.map((s) => {
        const icon = s.type === 'buy_low' ? '🟢' : s.type === 'stop_loss' ? '🔴' : s.type === 'sell_high' ? '🟡' : '📈';
        return `- ${icon} **[${s.strength.toUpperCase()}]** ${s.message}`;
      }),
      '',
      `---`,
      `*BUFF Monitor | ${new Date().toLocaleString('zh-CN')}*`,
    ].join('\n');

    return {
      title: `[BUFF] ${itemName} - ${signals.length}个信号`,
      content,
      template: 'markdown',
    };
  }

  formatDailySummary(
    analyses: Array<{ itemName: string; currentPrice: number; trend: string; signalCount: number; profitRate?: number }>
  ): PushPlusMessage {
    const content = [
      '## 📋 每日监控报告',
      '',
      `**报告时间**: ${new Date().toLocaleString('zh-CN')}`,
      '',
      '### 持仓概况',
      '',
      '| 饰品 | 当前价 | 趋势 | 信号数 |',
      '|------|--------|------|--------|',
      ...analyses.map((a) => {
        const trendIcon = a.trend === 'bullish' ? '📈' : a.trend === 'bearish' ? '📉' : '➡️';
        return `| ${a.itemName} | ¥${a.currentPrice} | ${trendIcon} | ${a.signalCount} |`;
      }),
      '',
      `---`,
      `*BUFF Monitor*`,
    ].join('\n');

    return {
      title: `[BUFF] 每日报告 - ${analyses.length}件饰品`,
      content,
      template: 'markdown',
    };
  }
}

export const notificationService = new NotificationService();
