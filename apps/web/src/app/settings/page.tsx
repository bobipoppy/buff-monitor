'use client';

import { useState } from 'react';

export default function SettingsPage() {
  const [cookie, setCookie] = useState('');
  const [pushToken, setPushToken] = useState('');
  const [saved, setSaved] = useState(false);

  const handleSave = () => {
    localStorage.setItem('buff_cookie', cookie);
    localStorage.setItem('pushplus_token', pushToken);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-bold text-white">系统设置</h2>

      <div className="card space-y-6">
        <div>
          <h3 className="mb-4 text-lg font-semibold text-white">BUFF 认证配置</h3>
          <div className="space-y-4">
            <div>
              <label className="mb-1 block text-sm text-zinc-400">BUFF Cookie</label>
              <textarea
                className="input h-24 w-full resize-none"
                placeholder="登录 buff.163.com 后，从浏览器开发者工具获取 Cookie..."
                value={cookie}
                onChange={(e) => setCookie(e.target.value)}
              />
              <p className="mt-1 text-xs text-zinc-500">
                打开浏览器 F12 → Network → 找到任意 buff.163.com 请求 → 复制 Cookie 头
              </p>
            </div>
          </div>
        </div>

        <div>
          <h3 className="mb-4 text-lg font-semibold text-white">微信推送配置</h3>
          <div className="space-y-4">
            <div>
              <label className="mb-1 block text-sm text-zinc-400">PushPlus Token</label>
              <input
                type="text"
                className="input w-full"
                placeholder="在 pushplus.plus 注册后获取的 token"
                value={pushToken}
                onChange={(e) => setPushToken(e.target.value)}
              />
              <p className="mt-1 text-xs text-zinc-500">
                访问 <a href="https://www.pushplus.plus" target="_blank" className="text-[var(--accent)] hover:underline">pushplus.plus</a> 注册并获取推送 token
              </p>
            </div>
          </div>
        </div>

        <div>
          <h3 className="mb-4 text-lg font-semibold text-white">抓取策略</h3>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            <div className="rounded-lg bg-[var(--background)] p-4">
              <p className="text-sm font-medium text-white">持仓饰品</p>
              <p className="text-2xl font-bold text-[var(--accent)]">30分钟</p>
              <p className="text-xs text-zinc-500">高优先级实时监控</p>
            </div>
            <div className="rounded-lg bg-[var(--background)] p-4">
              <p className="text-sm font-medium text-white">关注列表</p>
              <p className="text-2xl font-bold text-[var(--accent)]">2小时</p>
              <p className="text-xs text-zinc-500">中等优先级</p>
            </div>
            <div className="rounded-lg bg-[var(--background)] p-4">
              <p className="text-sm font-medium text-white">全品类扫描</p>
              <p className="text-2xl font-bold text-[var(--accent)]">每天1次</p>
              <p className="text-xs text-zinc-500">凌晨3点执行</p>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-4">
          <button className="btn-primary" onClick={handleSave}>
            保存配置
          </button>
          {saved && <span className="text-sm text-[var(--green)]">已保存</span>}
        </div>
      </div>

      <div className="card">
        <h3 className="mb-4 text-lg font-semibold text-white">使用说明</h3>
        <div className="space-y-3 text-sm text-zinc-400">
          <p>1. 配置 BUFF Cookie：登录 buff.163.com → F12 打开开发者工具 → 复制 Cookie</p>
          <p>2. 配置 PushPlus Token：注册 pushplus.plus → 复制 Token → 关注公众号</p>
          <p>3. 添加饰品：进入"饰品管理" → 搜索或扫描市场 → 设置监控等级</p>
          <p>4. 添加持仓：进入"持仓管理" → 记录买入价格和数量 → 设置止盈止损</p>
          <p>5. 系统会自动分析价格趋势，触发告警时通过微信推送通知</p>
        </div>
      </div>
    </div>
  );
}
