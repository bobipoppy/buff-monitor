'use client';

import { useEffect, useState } from 'react';
import { api, ItemData } from '@/lib/api';

export default function ItemsPage() {
  const [items, setItems] = useState<ItemData[]>([]);
  const [total, setTotal] = useState(0);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);

  useEffect(() => {
    setLoading(true);
    api.getItems({ search: search || undefined, page })
      .then((res) => { setItems(res.items); setTotal(res.total); })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [search, page]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold text-white">饰品管理</h2>
        <button
          className="btn-primary"
          onClick={() => api.scanMarket('csgo', 5).then(() => alert('扫描任务已提交'))}
        >
          扫描市场
        </button>
      </div>

      <div className="flex gap-4">
        <input
          type="text"
          className="input flex-1"
          placeholder="搜索饰品名称..."
          value={search}
          onChange={(e) => { setSearch(e.target.value); setPage(1); }}
        />
      </div>

      <div className="overflow-hidden rounded-xl border border-[var(--border)]">
        <table className="w-full text-sm">
          <thead className="bg-[var(--card)]">
            <tr>
              <th className="px-4 py-3 text-left text-zinc-400">饰品</th>
              <th className="px-4 py-3 text-right text-zinc-400">BUFF最低价</th>
              <th className="px-4 py-3 text-right text-zinc-400">Steam参考价</th>
              <th className="px-4 py-3 text-right text-zinc-400">在售数量</th>
              <th className="px-4 py-3 text-right text-zinc-400">监控等级</th>
              <th className="px-4 py-3 text-right text-zinc-400">更新时间</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--border)]">
            {loading ? (
              Array.from({ length: 5 }).map((_, i) => (
                <tr key={i}>
                  <td colSpan={6} className="px-4 py-4">
                    <div className="h-4 w-full animate-pulse rounded bg-[var(--card)]" />
                  </td>
                </tr>
              ))
            ) : items.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-zinc-500">
                  暂无数据，请先扫描市场
                </td>
              </tr>
            ) : (
              items.map((item) => (
                <tr key={item.id} className="hover:bg-[var(--card-hover)]">
                  <td className="px-4 py-3">
                    <a href={`/items/${item.id}`} className="text-white hover:text-[var(--accent)]">
                      {item.name}
                    </a>
                    <p className="text-xs text-zinc-500">{item.category}</p>
                  </td>
                  <td className="px-4 py-3 text-right font-medium text-[var(--gold)]">
                    ¥{item.buff_min_price?.toFixed(2)}
                  </td>
                  <td className="px-4 py-3 text-right text-zinc-400">
                    {item.steam_price ? `¥${item.steam_price.toFixed(2)}` : '-'}
                  </td>
                  <td className="px-4 py-3 text-right text-zinc-400">
                    {item.sell_count}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <PriorityBadge priority={item.watch_priority} />
                  </td>
                  <td className="px-4 py-3 text-right text-xs text-zinc-500">
                    {new Date(item.updated_at).toLocaleString('zh-CN')}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {total > 50 && (
        <div className="flex justify-center gap-2">
          <button className="btn-secondary" disabled={page === 1} onClick={() => setPage(page - 1)}>
            上一页
          </button>
          <span className="px-4 py-2 text-sm text-zinc-400">
            第 {page} 页 / 共 {Math.ceil(total / 50)} 页
          </span>
          <button className="btn-secondary" disabled={page >= Math.ceil(total / 50)} onClick={() => setPage(page + 1)}>
            下一页
          </button>
        </div>
      )}
    </div>
  );
}

function PriorityBadge({ priority }: { priority: string }) {
  switch (priority) {
    case 'high':
      return <span className="badge-red">高</span>;
    case 'normal':
      return <span className="badge-yellow">中</span>;
    default:
      return <span className="text-xs text-zinc-500">低</span>;
  }
}
