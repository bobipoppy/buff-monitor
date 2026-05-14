import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'BUFF Monitor - 饰品价格监控',
  description: '网易BUFF饰品价格趋势监控系统',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body className="min-h-screen antialiased">
        <div className="flex min-h-screen">
          <nav className="fixed left-0 top-0 h-full w-60 border-r border-[var(--border)] bg-[var(--card)] p-4">
            <div className="mb-8">
              <h1 className="text-xl font-bold text-white">BUFF Monitor</h1>
              <p className="text-xs text-zinc-500">饰品价格监控系统</p>
            </div>
            <ul className="space-y-1">
              <NavItem href="/" label="仪表盘" icon="📊" />
              <NavItem href="/items" label="饰品管理" icon="🎯" />
              <NavItem href="/portfolio" label="持仓管理" icon="💰" />
              <NavItem href="/alerts" label="告警中心" icon="🔔" />
              <NavItem href="/settings" label="系统设置" icon="⚙️" />
            </ul>
          </nav>
          <main className="ml-60 flex-1 p-8">{children}</main>
        </div>
      </body>
    </html>
  );
}

function NavItem({ href, label, icon }: { href: string; label: string; icon: string }) {
  return (
    <li>
      <a
        href={href}
        className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm text-zinc-400 transition-colors hover:bg-[var(--background)] hover:text-white"
      >
        <span>{icon}</span>
        <span>{label}</span>
      </a>
    </li>
  );
}
