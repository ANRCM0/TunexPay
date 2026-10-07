# TuneXPay

面向自有业务的轻量支付中台（TypeScript / MySQL / Redis）。保留支付系统真正需要的事务、幂等、状态机、异常恢复与可靠通知；不做多商户运营、余额、清算、费率与复杂渠道路由。

- **运行时**：单镜像 Appliance —— Hono API、Next.js 管理台/收银台、Worker 打包在同一个镜像里，容器内 Gateway 分流，宿主机只暴露一个端口。
- **资金边界**：金额全程整数「分」；退款不自动执行、也不自动查单，只能由管理员人工发起与人工推进。
- **接入**：原生 REST V1 与 ePay V1，见[接入与联调](docs/integration.md)。

## 核心能力

- 支付状态机 `CREATED → PROCESSING → SUCCESS / FAILED / UNKNOWN / CLOSED`，支持终态后的可信晚到成功；Order / Payment 分离，一张订单可多次尝试。
- 通道：支付宝当面付、支付宝账单收款（个人收款码）、Mock；同一插件可配多个独立账号，并按业务应用分配，支持轮询组选路。
- 异常恢复：仅支付单自动查单（指数退避、并发认领、人工接管）；订单过期先查单、再关单、最后锁单。
- 可靠通知：支付事务内写 Outbox，Worker 以 MySQL 为事实来源投递，至少一次、可重试；通知插件支持 SMTP、飞书、Telegram 与通知 Webhook。
- 对账：支付宝日账单 CSV 上传、指纹去重、差额阻断；退款流水只做匹配，不自动推进退款状态。
- 治理：管理操作审计、业务事件时间线、系统监控、MCP 只读查询与受控资金审批。

细化说明见下方[文档索引](#文档)。

## 管理台

管理台与收银台是 Next.js 应用，与 API 同镜像发布，随管理台一起提供多页签、暗色模式与键盘快捷入口。前端版式对齐 MPAY V2 管理台（SnowAdmin 骨架 + Arco Design 组件体系）：

- **骨架**：侧栏 220px（可折叠到 48px 并记住状态）、品牌区与顶栏各 60px、页签栏 40px；窄屏时侧栏收成抽屉。
- **列表页**：统一为「查询表单 + 表格 + 分页同处一张卡」，筛选在点「查询」后才生效，列表在本地分页。
- **交互**：多页签栏（可关闭、刷新、右键菜单，状态持久化）、`Ctrl/Cmd + K` 命令面板、暗色模式（跟随系统并可手动切换）、全屏、路由骨架屏与真实导航进度条。
- **收银台**：移动端优先，长轮询确认支付结果，自动重试并退避。

实现约定、与上游的差异以及两个容易踩的样式覆盖陷阱，见[前端重构说明](docs/frontend-redesign.md)。

## 安装

要求 Docker Compose v2。

```bash
git clone https://github.com/ANRCM0/TunexPay.git
cd TunexPay
cp .env.example .env
```

生成密钥并写入 `.env`：

```bash
openssl rand -hex 32      # SECRETS_ENCRYPTION_KEY
openssl rand -base64 36   # ADMIN_TOKEN
openssl rand -base64 24   # ADMIN_PASSWORD
openssl rand -base64 36   # ADMIN_SESSION_SECRET
openssl rand -base64 24   # MOCK_CHANNEL_TOKEN
openssl rand -base64 36   # ALIPAY_BILL_WATCHER_TOKEN
```

至少设置数据库与公网地址：

```dotenv
DATABASE_URL=mysql://tuoxin:your-password@mysql:3306/tuoxin_pay
REDIS_URL=redis://redis:6379
API_PUBLIC_URL=https://pay.example.com
WEB_PUBLIC_URL=https://pay.example.com
```

使用宿主机已有的 MySQL 时，把地址改成 `host.docker.internal:3306`，并只启动应用与 Redis：`docker compose up -d app redis`。

镜像地址由 `.env` 的 `TUNEXPAY_IMAGE` 决定，默认 `ghcr.io/anrcm0/tunexpay`（当前已发布的镜像就在这个路径下）。CI 按仓库归属生成镜像名，仓库若更换归属，发布后的镜像会出现在新归属下，届时同步改 `TUNEXPAY_IMAGE`。

启动并检查：

```bash
docker compose pull     # 拉取发布镜像；GHCR 包为私有可见性时先 docker login ghcr.io
docker compose up -d
docker compose ps
curl http://127.0.0.1:3000/health
```

`/health` 返回 200 即就绪，`version` 是当前发布的版本号。数据库迁移由容器入口自动执行；数据库暂时不可达时按 `DB_MIGRATION_RETRY_SECONDS` 重试，而不是陷入 crash loop。

生产部署（宿主机 MySQL、OpenResty 反代、安全边界、故障排查）见[部署与升级指南](docs/deployment.md)。

## 升级

升级前备份 `.env` 与数据库，并记录当前镜像 tag 以便回滚。

```bash
docker compose pull app
docker compose up -d app
```

- 数据库迁移在容器启动时自动执行，按向前兼容设计。
- 固定版本：在 `.env` 设置 `TUNEXPAY_IMAGE_TAG=<tag>`；回滚就是改回上一个 tag 再执行上面的两条命令。
- 只有推 tag 才会产出新镜像，普通分支提交不会。

## 开发

```bash
npm install
npm run db:generate
npm run db:migrate

npm run dev:api      # Hono API
npm run dev:worker   # 后台 Worker
npm run dev:web      # Next.js 管理台

npm test
npm run typecheck
npm run build
```

不接真实资金的本地联调（下单 → 支付 → Webhook 全链路）见[本地 Mock 全链路](docs/integration.md#3-本地-mock-全链路)。

## 卸载

```bash
docker compose down                # 停止并删除容器与网络，数据卷保留
docker compose down -v             # 确定不再需要数据时：连同 MySQL / Redis 数据卷一起删除
docker images --format '{{.Repository}}:{{.Tag}}' ghcr.io/anrcm0/tunexpay | xargs -r docker rmi
rm -f .env
```

删除数据卷前务必先导出数据库：卷一旦删除，订单、支付、退款与审计记录都无法恢复；`SECRETS_ENCRYPTION_KEY` 丢失后，已加密的 ePay / Webhook 密钥也无法解密。

## 版本号

每次发布带一个唯一版本号 `v<提交日期 YYYYMMDD>-<7 位提交号>`（如 `v20260830-4f48e61`）：管理台左下角常驻显示，`/health`、系统监控页、MCP `serverInfo` 同源，发布镜像也用同一个版本号打 tag。

```bash
docker pull ghcr.io/anrcm0/tunexpay:v20260830-4f48e61
```

发布即推 tag：CI 检查通过后构建镜像并推送到 GHCR，同时打「版本号」「你推的 tag 名」「latest」三个 tag。完整约定见[版本号与发布](docs/deployment.md#版本号)。

## 文档

| 文档 | 内容 |
| --- | --- |
| [前端重构说明](docs/frontend-redesign.md) | 管理台版式基准、结构约定、样式覆盖陷阱与验收方式 |
| [架构说明](docs/architecture.md) | 设计边界、核心不变量、状态模型、支付成功事务、异常恢复 |
| [部署与升级指南](docs/deployment.md) | 运行拓扑、部署、发布、升级、回滚、故障排查、上线检查清单 |
| [接入与联调](docs/integration.md) | 应用凭证、下单与支付、支付宝、ePay/NewAPI、Webhook 验签、Mock 全链路 |
| [MCP / Agent Access](docs/mcp.md) | 外部 Agent 接入、Scope、审批与审计 |
| [通知插件](docs/notification-plugins.md) | SMTP、飞书、Telegram、通知 Webhook |
| [插件与通道](docs/plugin-channels.md) | 多账号、通道检测、凭证生命周期 |
| [轮询组](docs/routing-groups.md) | 收款选路、权重与成员暂停 |
| [账单采集器](docs/alipay-bill-collector.md) | 个人收款码承接、采集器配置与验收 |
| [OpenAPI](docs/openapi.yaml) | 接口定义 |
