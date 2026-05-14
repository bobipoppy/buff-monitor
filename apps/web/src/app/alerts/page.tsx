'use client';

import { useEffect, useState } from 'react';
import { api, AlertLogData, AlertRuleData } from '@/lib/api';

export default function AlertsPage() {
  const [logs, setLogs] = useState<AlertLogData[]>([]);
  const [rules, setRules] = useState<AlertRuleData[]>([]);
  const [tab, setTab] = useState<'logs' | 'rules'>('logs');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    if (tab === 'logs') {
      api.getAlertLogs(100).then(setLogs).catch(console.error).finally(() => setLoading(false));
    } else {
      api.getAlertRules().then(setRules).catch(console.error).finally(() => setLoading(false));
    }
  }, [tab]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold text-white">告警中心</h2>
        <div className="flex gap-2">
          <button
            className={tab === 'logs' ? 'btn-primary' : 'btn-secondary'}
            onClick={() => setTab('logs')}
          >
            告警记录
          </button>
          <button
            className={tab === 'rules' ? 'btn-primary' : 'btn-secondary'}
            onClick={() => setTab('rules')}
          >
            规则管理
          </button>
          <button
            className="btn-secondary"
            onClick={() => api.triggerAlertCheck().then(() => alert('检查完成'))}
          >
            立即检查
          </button>
        </div>
      </div>

      {tab === 'logs' ? (
        <div className="space-y-3">
          {loading ? (
            Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="h-16 animate-pulse rounded-xl bg-[var(--card)]" />
            ))
          ) : logs.length === 0 ? (
            <div className="card text-center text-zinc-500">暂无告警记录</div>
          ) : (
            logs.map((log) => (
              <div key={log.id} className="card !p-4">
                <div className="flex items-center justify-between">
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-white">{log.item_name}</span>
                      {log.notified && <span className="badge-green">已推送</span>}
                    </div>
                    <p className="mt-1 text-sm text-zinc-400">{log.message}</p>
                  </div>
                  <div className="text-right">
                    <p className="font-medium text-[var(--gold)]">¥{log.current_price}</p>
                    <p className="text-xs text-zinc-500">
                      {new Date(log.triggered_at).toLocaleString('zh-CN')}
                    </p>
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-[var(--border)]">
          <table className="w-full text-sm">
            <thead className="bg-[var(--card)]">
              <tr>
                <th className="px-4 py-3 text-left text-zinc-400">饰品</th>
                <th className="px-4 py-3 text-left text-zinc-400">类型</th>
                <th className="px-4 py-3 text-left text-zinc-400">条件</th>
                <th className="px-4 py-3 text-right text-zinc-400">阈值</th>
                <th className="px-4 py-3 text-right text-zinc-400">冷却(分钟)</th>
                <th className="px-4 py-3 text-center text-zinc-400">状态</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border)]">
              {rules.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-zinc-500">
                    暂无告警规则
                  </td>
                </tr>
              ) : (
                rules.map((rule) => (
                  <tr key={rule.id} className="hover:bg-[var(--card-hover)]">
                    <td className="px-4 py-3 text-white">{rule.item_name || '全局'}</td>
                    <td className="px-4 py-3 text-zinc-300">{formatType(rule.type)}</td>
                    <td className="px-4 py-3 text-zinc-300">{formatCondition(rule.condition)}</td>
                    <td className="px-4 py-3 text-right text-zinc-300">{rule.threshold}</td>
                    <td className="px-4 py-3 text-right text-zinc-300">{rule.cooldown_minutes}</td>
                    <td className="px-4 py-3 text-center">
                      {rule.enabled
                        ? <span className="badge-green">启用</span>
                        : <span className="text-xs text-zinc-500">禁用</span>
                      }
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function formatType(type: string): string {
  const map: Record<string, string> = {
    buy_low: '低价买入',
    sell_high: '止盈卖出',
    stop_loss: '止损',
    trend_reversal: '趋势反转',
    volume_spike: '成交量异动',
  };
  return map[type] || type;
}

function formatCondition(condition: string): string {
  const map: Record<string, string> = {
    below_ma: '低于均线',
    above_target: '高于目标',
    below_stop_loss: '低于止损线',
    ma_cross: 'MA交叉',
    volume_change: '成交量变化',
  };
  return map[condition] || condition;
}
