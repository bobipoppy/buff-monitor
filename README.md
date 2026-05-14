# BUFF Monitor - 饰品价格监控系统

网易 BUFF 饰品价格趋势监控系统，支持大规模饰品抓取、技术分析、多策略告警和微信通知。

提供 **Mac 桌面版**（Electron）和 **Web 服务版**（Docker）两种部署方式。

## 功能特性

- **价格监控**: 自动抓取 BUFF 饰品价格，支持 100+ 饰品并发监控
- **技术分析**: MA5/MA10/MA30 均线、RSI、波动率、成交量分析
- **智能信号**: 低价买入、止盈卖出、止损提醒、趋势反转检测
- **微信推送**: 通过 PushPlus 实时推送价格告警到微信
- **macOS 原生通知**: 桌面版支持系统通知中心推送
- **持仓管理**: 记录买卖操作，自动计算盈亏（含 2.5% 手续费）
- **Web 面板**: 可视化 K 线图表、仪表盘、告警配置
- **系统托盘**: 桌面版常驻后台运行，右键菜单快速操作

## 快速开始 - Mac 桌面版（推荐）

无需 Docker，打开即用，数据存储在本地 SQLite。

### 1. 安装依赖

```bash
cd buff-monitor
pnpm install
```

### 2. 开发模式运行

```bash
# 终端1: 启动前端
pnpm dev:web

# 终端2: 启动桌面应用
pnpm dev:desktop
```

### 3. 打包为 macOS App

```bash
pnpm build:desktop
# 生成 DMG 文件在 apps/desktop/dist/
```

### 桌面版特性

- 系统托盘常驻，关闭窗口不退出
- 原生 macOS 通知推送
- SQLite 本地数据库，无外部依赖
- 内嵌 Express API 服务器
- 自动定时抓取（持仓30min / 关注2h / 全品类每天）

## 快速开始 - Web 服务版

适合服务器部署，使用 PostgreSQL + Redis。

### 1. 克隆并安装依赖

```bash
cd buff-monitor
pnpm install
```

### 2. 启动基础设施（PostgreSQL + Redis）

```bash
docker compose up -d postgres redis
```

### 3. 配置环境变量

```bash
cp .env.example .env
# 编辑 .env 文件，填入你的 BUFF Cookie 和 PushPlus Token
```

### 4. 初始化数据库

```bash
pnpm db:migrate
pnpm db:seed  # 可选：导入示例饰品
```

### 5. 启动服务

```bash
# 后端 (端口 3001)
pnpm dev:server

# 前端 (端口 3000)
pnpm dev:web
```

### 6. 一键 Docker 部署（生产环境）

```bash
cp .env.example .env
# 编辑 .env
docker compose up -d
```

## 获取 BUFF Cookie

1. 在浏览器中登录 [buff.163.com](https://buff.163.com)
2. 按 F12 打开开发者工具
3. 切换到 Network 标签
4. 刷新页面，点击任意请求
5. 在 Request Headers 中找到 `Cookie` 字段，复制整个值

> ⚠️ Cookie 有效期约 24 小时，过期后需重新获取

## 获取 PushPlus Token

1. 访问 [pushplus.plus](https://www.pushplus.plus)
2. 微信扫码注册/登录
3. 复制首页显示的 Token
4. 关注"pushplus推送加"公众号以接收消息

## API 接口

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/health` | GET | 健康检查 |
| `/api/dashboard` | GET | 仪表盘数据 |
| `/api/items` | GET/POST | 饰品管理 |
| `/api/items/:id/prices` | GET | 价格历史 |
| `/api/items/:id/analysis` | GET | 技术分析 |
| `/api/items/scan` | POST | 扫描市场 |
| `/api/portfolio` | GET/POST | 持仓管理 |
| `/api/portfolio/:id/sell` | POST | 卖出操作 |
| `/api/alerts/rules` | GET/POST | 告警规则 |
| `/api/alerts/logs` | GET | 告警记录 |
| `/api/alerts/check` | POST | 手动触发检查 |

## 项目结构

```
buff-monitor/
├── apps/
│   ├── server/          # NestJS 后端 API + 爬虫 + 分析引擎
│   └── web/             # Next.js 前端面板
├── packages/
│   └── shared/          # 共享类型和常量
├── docker-compose.yml   # 一键部署配置
└── .env.example         # 环境变量模板
```

## 监控策略说明

| 信号类型 | 触发条件 | 说明 |
|---------|---------|------|
| 低价买入 | 价格低于 MA30 的 15% | 可能是超卖，适合抄底 |
| 止盈卖出 | 持仓收益率达到目标 | 默认 20%，可自定义 |
| 止损提醒 | 持仓亏损超过阈值 | 默认 -10%，含手续费 |
| 趋势反转 | MA5 上穿/下穿 MA10 | 金叉/死叉信号 |
| 成交量异动 | 成交量变化超过 200% | 可能有大事件 |
| RSI 超买超卖 | RSI < 25 或 RSI > 75 | 辅助判断 |

## 注意事项

- BUFF 有反爬机制，默认请求频率限制为 20次/分钟
- 卖出手续费为 2.5%，系统已在盈亏计算中扣除
- Cookie 过期后爬虫会自动暂停并发送告警
- 建议使用代理 IP 池应对大规模抓取场景

## License

MIT
