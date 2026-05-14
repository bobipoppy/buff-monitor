'use client';

import { useEffect, useState } from 'react';
import { api, DashboardData } from '@/lib/api';

export default function DashboardPage() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.getDashboard().then(setData).catch(console.error).finally(() => setLoading(false));
  }, []);

  if (loading) return <LoadingSkeleton />;

  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-bold text-white">仪表盘</h2>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <StatCard
          title="监控饰品数"
          value={data?.watchedItems || 0}
          unit="件"
          icon="🎯"
        />
        <StatCard
          title="持仓数量"
          value={parseInt(data?.portfolio.total_holdings || '0')}
          unit="件"
          icon="💼"
        />
        <StatCard
          title="总投入"
          value={data?.portfolio.total_invested || 0}
          unit="¥"
          icon="💰"
          isPrice
        />
      </div>

      <div className="card">
        <h3 className="mb-4 text-lg font-semibold text-white">最近告警</h3>
        {data?.recentAlerts && data.recentAlerts.length > 0 ? (
          <div className="space-y-3">
            {data.recentAlerts.map((alert) => (
              <div
                key={alert.id}
                className="flex items-center justify-between rounded-lg bg-[var(--background)] p-3"
              >
                <div className="flex-1">
                  <p className="text-sm font-medium text-white">{alert.item_name}</p>
                  <p className="text-xs text-zinc-400">{alert.message}</p>
                </div>
                <div className="text-right">
                  <p className="text-sm font-medium text-[var(--gold)]">
                    ¥{alert.current_price}
                  </p>
                  <p className="text-xs text-zinc-500">
                    {new Date(alert.triggered_at).toLocaleString('zh-CN')}
                  </p>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-zinc-500">暂无告警记录</p>
        )}
      </div>
    </div>
  );
}

function StatCard({ title, value, unit, icon, isPrice }: {
  title: string;
  value: number;
  unit: string;
  icon: string;
  isPrice?: boolean;
}) {
  return (
    <div className="card flex items-center gap-4">
      <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-[var(--background)] text-2xl">
        {icon}
      </div>
      <div>
        <p className="text-sm text-zinc-400">{title}</p>
        <p className="text-xl font-bold text-white">
          {isPrice ? `${unit}${value.toLocaleString()}` : `${value.toLocaleString()} ${unit}`}
        </p>
      </div>
    </div>
  );
}

function LoadingSkeleton() {
  return (
    <div className="space-y-6">
      <div className="h-8 w-32 animate-pulse rounded bg-[var(--card)]" />
      <div className="grid grid-cols-3 gap-4">
        {[1, 2, 3].map((i) => (
          <div key={i} className="h-24 animate-pulse rounded-xl bg-[var(--card)]" />
        ))}
      </div>
      <div className="h-64 animate-pulse rounded-xl bg-[var(--card)]" />
    </div>
  );
}
