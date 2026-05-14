'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { api, ItemData, PriceData, AnalysisData } from '@/lib/api';
import PriceChart from '@/components/PriceChart';

export default function ItemDetailPage() {
  const params = useParams();
  const id = Number(params?.id);
  const [item, setItem] = useState<ItemData | null>(null);
  const [prices, setPrices] = useState<PriceData[]>([]);
  const [analysis, setAnalysis] = useState<AnalysisData | null>(null);
  const [days, setDays] = useState(30);

  useEffect(() => {
    if (!id) return;
    api.getItem(id).then(setItem).catch(console.error);
    api.getItemPrices(id, days).then(setPrices).catch(console.error);
    api.getItemAnalysis(id).then(setAnalysis).catch(() => setAnalysis(null));
  }, [id, days]);

  if (!item) {
    return <div className="h-96 animate-pulse rounded-xl bg-[var(--card)]" />;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-white">{item.name}</h2>
          <p className="text-sm text-zinc-500">{item.game.toUpperCase()} · {item.category}</p>
        </div>
        <div className="text-right">
          <p className="text-3xl font-bold text-[var(--gold)]">¥{item.buff_min_price?.toFixed(2)}</p>
          <p className="text-sm text-zinc-500">在售 {item.sell_count} 件</p>
        </div>
      </div>

      {analysis && (
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          <IndicatorCard label="MA5" value={`¥${analysis.ma5}`} />
          <IndicatorCard label="MA10" value={`¥${analysis.ma10}`} />
          <IndicatorCard label="MA30" value={`¥${analysis.ma30}`} />
          <IndicatorCard label="RSI(14)" value={analysis.rsi14.toFixed(1)} highlight={analysis.rsi14 < 30 || analysis.rsi14 > 70} />
          <IndicatorCard label="偏离MA30" value={`${analysis.priceDeviationFromMa30.toFixed(1)}%`} highlight={Math.abs(analysis.priceDeviationFromMa30) > 15} />
          <IndicatorCard label="波动率" value={`${analysis.volatility.toFixed(1)}%`} />
          <IndicatorCard label="成交量变化" value={`${analysis.volumeChange > 0 ? '+' : ''}${analysis.volumeChange.toFixed(1)}%`} />
          <IndicatorCard label="趋势" value={analysis.trend === 'bullish' ? '看涨' : analysis.trend === 'bearish' ? '看跌' : '震荡'} />
        </div>
      )}

      <div className="card">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-lg font-semibold text-white">价格走势</h3>
          <div className="flex gap-2">
            {[7, 30, 60, 90].map((d) => (
              <button
                key={d}
                className={`rounded px-3 py-1 text-xs ${days === d ? 'bg-[var(--accent)] text-white' : 'text-zinc-400 hover:text-white'}`}
                onClick={() => setDays(d)}
              >
                {d}天
              </button>
            ))}
          </div>
        </div>
        <PriceChart prices={prices} ma5={analysis?.ma5} ma10={analysis?.ma10} ma30={analysis?.ma30} />
      </div>

      {analysis && analysis.signals.length > 0 && (
        <div className="card">
          <h3 className="mb-4 text-lg font-semibold text-white">交易信号</h3>
          <div className="space-y-2">
            {analysis.signals.map((signal, i) => (
              <div key={i} className="flex items-center gap-3 rounded-lg bg-[var(--background)] p-3">
                <SignalIcon type={signal.type} />
                <div className="flex-1">
                  <p className="text-sm text-white">{signal.message}</p>
                </div>
                <StrengthBadge strength={signal.strength} />
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function IndicatorCard({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div className="card !p-4">
      <p className="text-xs text-zinc-500">{label}</p>
      <p className={`text-lg font-bold ${highlight ? 'text-[var(--highlight)]' : 'text-white'}`}>{value}</p>
    </div>
  );
}

function SignalIcon({ type }: { type: string }) {
  const icons: Record<string, string> = {
    buy_low: '🟢', sell_high: '🟡', stop_loss: '🔴', trend_reversal: '📈', volume_spike: '📊',
  };
  return <span className="text-xl">{icons[type] || '⚡'}</span>;
}

function StrengthBadge({ strength }: { strength: string }) {
  const classes: Record<string, string> = {
    strong: 'badge-red', moderate: 'badge-yellow', weak: 'badge-green',
  };
  const labels: Record<string, string> = { strong: '强', moderate: '中', weak: '弱' };
  return <span className={classes[strength] || 'badge-green'}>{labels[strength] || strength}</span>;
}
