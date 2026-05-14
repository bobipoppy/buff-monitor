'use client';

import { useEffect, useState } from 'react';
import { api, PortfolioResponse } from '@/lib/api';

export default function PortfolioPage() {
  const [data, setData] = useState<PortfolioResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<'holding' | 'sold'>('holding');

  useEffect(() => {
    setLoading(true);
    api.getPortfolio(tab).then(setData).catch(console.error).finally(() => setLoading(false));
  }, [tab]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold text-white">持仓管理</h2>
        <div className="flex gap-2">
          <button
            className={tab === 'holding' ? 'btn-primary' : 'btn-secondary'}
            onClick={() => setTab('holding')}
          >
            持仓中
          </button>
          <button
            className={tab === 'sold' ? 'btn-primary' : 'btn-secondary'}
            onClick={() => setTab('sold')}
          >
            已卖出
          </button>
        </div>
      </div>

      {data && tab === 'holding' && (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
          <SummaryCard label="持仓件数" value={`${data.summary.totalItems} 件`} />
          <SummaryCard label="总投入" value={`¥${data.summary.totalInvested.toLocaleString()}`} />
          <SummaryCard
            label="未实现盈亏"
            value={`${data.summary.totalUnrealizedPnl >= 0 ? '+' : ''}¥${data.summary.totalUnrealizedPnl.toFixed(2)}`}
            isProfit={data.summary.totalUnrealizedPnl >= 0}
          />
          <SummaryCard
            label="总收益率"
            value={`${data.summary.overallReturn >= 0 ? '+' : ''}${data.summary.overallReturn.toFixed(2)}%`}
            isProfit={data.summary.overallReturn >= 0}
          />
        </div>
      )}

      <div className="overflow-hidden rounded-xl border border-[var(--border)]">
        <table className="w-full text-sm">
          <thead className="bg-[var(--card)]">
            <tr>
              <th className="px-4 py-3 text-left text-zinc-400">饰品</th>
              <th className="px-4 py-3 text-right text-zinc-400">买入价</th>
              <th className="px-4 py-3 text-right text-zinc-400">当前价</th>
              <th className="px-4 py-3 text-right text-zinc-400">盈亏</th>
              <th className="px-4 py-3 text-right text-zinc-400">收益率</th>
              <th className="px-4 py-3 text-right text-zinc-400">数量</th>
              <th className="px-4 py-3 text-right text-zinc-400">操作</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--border)]">
            {loading ? (
              Array.from({ length: 3 }).map((_, i) => (
                <tr key={i}>
                  <td colSpan={7} className="px-4 py-4">
                    <div className="h-4 w-full animate-pulse rounded bg-[var(--card)]" />
                  </td>
                </tr>
              ))
            ) : data?.items.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-zinc-500">
                  暂无持仓记录
                </td>
              </tr>
            ) : (
              data?.items.map((item) => (
                <tr key={item.id} className="hover:bg-[var(--card-hover)]">
                  <td className="px-4 py-3">
                    <p className="text-white">{item.item_name}</p>
                    <p className="text-xs text-zinc-500">
                      买入: {new Date(item.buy_date).toLocaleDateString('zh-CN')}
                    </p>
                  </td>
                  <td className="px-4 py-3 text-right text-zinc-300">¥{item.buy_price.toFixed(2)}</td>
                  <td className="px-4 py-3 text-right font-medium text-[var(--gold)]">
                    ¥{item.current_price.toFixed(2)}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <span className={item.unrealizedPnl && item.unrealizedPnl >= 0 ? 'text-[var(--green)]' : 'text-[var(--red)]'}>
                      {item.unrealizedPnl ? `${item.unrealizedPnl >= 0 ? '+' : ''}¥${item.unrealizedPnl.toFixed(2)}` : '-'}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <span className={item.profitRate && item.profitRate >= 0 ? 'text-[var(--green)]' : 'text-[var(--red)]'}>
                      {item.profitRate ? `${item.profitRate >= 0 ? '+' : ''}${(item.profitRate * 100).toFixed(1)}%` : '-'}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right text-zinc-300">{item.quantity}</td>
                  <td className="px-4 py-3 text-right">
                    {item.status === 'holding' && (
                      <button
                        className="rounded bg-[var(--red)]/20 px-3 py-1 text-xs text-[var(--red)] hover:bg-[var(--red)]/30"
                        onClick={() => handleSell(item.id, item.current_price)}
                      >
                        卖出
                      </button>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function SummaryCard({ label, value, isProfit }: { label: string; value: string; isProfit?: boolean }) {
  return (
    <div className="card !p-4">
      <p className="text-xs text-zinc-500">{label}</p>
      <p className={`text-lg font-bold ${isProfit === true ? 'text-[var(--green)]' : isProfit === false ? 'text-[var(--red)]' : 'text-white'}`}>
        {value}
      </p>
    </div>
  );
}

async function handleSell(portfolioId: number, currentPrice: number) {
  const confirmed = confirm(`确认以 ¥${currentPrice.toFixed(2)} 卖出?`);
  if (confirmed) {
    try {
      await api.sellPortfolio(portfolioId, currentPrice);
      window.location.reload();
    } catch (err) {
      alert('卖出失败: ' + (err as Error).message);
    }
  }
}
