'use client';

import ReactECharts from 'echarts-for-react';
import type { PriceData } from '@/lib/api';

interface PriceChartProps {
  prices: PriceData[];
  ma5?: number;
  ma10?: number;
  ma30?: number;
}

export default function PriceChart({ prices }: PriceChartProps) {
  if (prices.length === 0) {
    return (
      <div className="flex h-80 items-center justify-center text-zinc-500">
        暂无价格数据
      </div>
    );
  }

  const dates = prices.map((p) => new Date(p.recorded_at).toLocaleDateString('zh-CN'));
  const priceValues = prices.map((p) => p.price);
  const volumes = prices.map((p) => p.volume);

  const ma5Values = calculateMA(priceValues, 5);
  const ma10Values = calculateMA(priceValues, 10);
  const ma30Values = calculateMA(priceValues, 30);

  const option = {
    backgroundColor: 'transparent',
    tooltip: {
      trigger: 'axis',
      backgroundColor: '#1a1a2e',
      borderColor: '#2a2a4a',
      textStyle: { color: '#e4e4e7' },
    },
    legend: {
      data: ['价格', 'MA5', 'MA10', 'MA30', '成交量'],
      textStyle: { color: '#a1a1aa' },
      top: 0,
    },
    grid: [
      { left: '8%', right: '4%', top: '12%', height: '55%' },
      { left: '8%', right: '4%', top: '75%', height: '18%' },
    ],
    xAxis: [
      { type: 'category', data: dates, gridIndex: 0, axisLabel: { color: '#71717a' }, axisLine: { lineStyle: { color: '#2a2a4a' } } },
      { type: 'category', data: dates, gridIndex: 1, axisLabel: { show: false }, axisLine: { lineStyle: { color: '#2a2a4a' } } },
    ],
    yAxis: [
      { type: 'value', gridIndex: 0, axisLabel: { color: '#71717a', formatter: '¥{value}' }, splitLine: { lineStyle: { color: '#2a2a4a' } } },
      { type: 'value', gridIndex: 1, axisLabel: { color: '#71717a' }, splitLine: { lineStyle: { color: '#2a2a4a' } } },
    ],
    series: [
      {
        name: '价格',
        type: 'line',
        data: priceValues,
        xAxisIndex: 0,
        yAxisIndex: 0,
        smooth: true,
        lineStyle: { color: '#6366f1', width: 2 },
        itemStyle: { color: '#6366f1' },
        areaStyle: { color: { type: 'linear', x: 0, y: 0, x2: 0, y2: 1, colorStops: [{ offset: 0, color: 'rgba(99, 102, 241, 0.3)' }, { offset: 1, color: 'rgba(99, 102, 241, 0)' }] } },
      },
      {
        name: 'MA5',
        type: 'line',
        data: ma5Values,
        xAxisIndex: 0,
        yAxisIndex: 0,
        smooth: true,
        lineStyle: { color: '#fbbf24', width: 1 },
        itemStyle: { color: '#fbbf24' },
        symbol: 'none',
      },
      {
        name: 'MA10',
        type: 'line',
        data: ma10Values,
        xAxisIndex: 0,
        yAxisIndex: 0,
        smooth: true,
        lineStyle: { color: '#34d399', width: 1 },
        itemStyle: { color: '#34d399' },
        symbol: 'none',
      },
      {
        name: 'MA30',
        type: 'line',
        data: ma30Values,
        xAxisIndex: 0,
        yAxisIndex: 0,
        smooth: true,
        lineStyle: { color: '#f87171', width: 1 },
        itemStyle: { color: '#f87171' },
        symbol: 'none',
      },
      {
        name: '成交量',
        type: 'bar',
        data: volumes,
        xAxisIndex: 1,
        yAxisIndex: 1,
        itemStyle: { color: '#4f46e5', opacity: 0.6 },
      },
    ],
  };

  return <ReactECharts option={option} style={{ height: '400px' }} />;
}

function calculateMA(prices: number[], period: number): (number | null)[] {
  return prices.map((_, i) => {
    if (i < period - 1) return null;
    const slice = prices.slice(i - period + 1, i + 1);
    return parseFloat((slice.reduce((a, b) => a + b, 0) / period).toFixed(2));
  });
}
