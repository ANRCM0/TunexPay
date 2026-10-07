# TunexPay 部署与升级指南

本文档对应当前 **TunexPay Appliance 单镜像架构**。应用层只运行一个 `app` 容器，容器内部同时托管 Next.js Web、Hono API、后台 Worker 和统一 Gateway；MySQL 与 Redis 保持独立，便于持久化、备份和升级。

## 1. 运行拓扑

```text
Internet
   │
OpenResty / Nginx / CDN
   │
127.0.0.1:3000
   │
┌──────────────────────────────┐
│ TunexPay Appliance           │
│                              │
│ Gateway :8080                │
│   ├─ Next.js Web :3000       │
│   ├─ Hono API :3001          │
│   └─ Worker                  │
└──────────────┬───────────────┘
               │
        MySQL / Redis
```

宿主机只发布一个应用端口：

```text
127.0.0.1:3000 -> app:8080
```

容器内部端口 3000/3001 不应直接暴露到宿主机或公网。

Gateway 的路由规则：

- `/submit.php`、`/mapi.php`、`/api.php` → Hono API
- `/api/v1/*`、`/admin/v1/*`、`/health` → Hono API
- 其他请求 → Next.js
- `/api/backend/*` 由 Next.js 接收，再访问容器内部 Hono API

## 2. 前置要求

- Docker Engine
- Docker Compose v2
- 一个可用的 MySQL 8.x 数据库
- Redis 7.x（可直接使用 Compose 内置 Redis）
- 生产环境 HTTPS 反向代理
- 正确设置的 `.env`

建议先确认：

```bash
docker --version
docker compose version
```

## 3. 准备配置

从示例生成：

```bash
cp .env.example .env
```

生成必要密钥：

```bash
openssl rand -hex 32
openssl rand -base64 36
openssl rand -base64 24
```

至少设置：

```dotenv
DATABASE_URL=
REDIS_URL=redis://redis:6379

API_PUBLIC_URL=https://pay.example.com
WEB_PUBLIC_URL=https://pay.example.com

SECRETS_ENCRYPTION_KEY=
ADMIN_TOKEN=
ADMIN_PASSWORD=
ADMIN_SESSION_SECRET=
```

生产环境不要保留示例密码或默认随机值。

### 生产安全边界

- 保持 `MOCK_CHANNEL_ENABLED=false`、`ALLOW_PRIVATE_WEBHOOKS=false`。示例配置现在默认关闭这两个开关；已有 `.env` 不会自动更新，需要人工核对。Mock 收银台允许付款人点击模拟成功，不能用于真实收款或真实业务入账。
- 管理员口令使用高熵随机值。应用登录接口本身不维护失败计数，公网入口必须配置限流；仓库的 `docker/openresty.conf` 示例对 `/api/auth/login` 按客户端 IP 限制为每分钟 5 次、允许 5 次突发，超限返回 429。配置需要放在 Nginx/OpenResty 的 `http` 上下文；不要直接放进已有 `server` 块。应用端口保持仅绑定 loopback，避免绕过公网限流。
- 经 CDN/负载均衡部署时，只信任明确配置的代理地址并正确恢复真实客户端 IP；不要无条件信任用户自带的 `X-Forwarded-For`。多 IP 攻击仍需 WAF 等外围控制。
- 管理员会话为最长 12 小时的无状态签名 Cookie。退出仅清除当前浏览器 Cookie，修改 `ADMIN_PASSWORD` 不会撤销已签发会话。若怀疑 Cookie 泄露，轮换 `ADMIN_SESSION_SECRET` 并重启所有 Web 实例，使旧会话全部失效。

## 4. 部署方式 A：使用 Compose MySQL

适合新部署或希望 TunexPay 自己管理独立 MySQL 的环境。

`.env`：

```dotenv
DATABASE_URL=mysql://tuoxin:your-mysql-password@mysql:3306/tuoxin_pay
MYSQL_PASSWORD=your-mysql-password
MYSQL_ROOT_PASSWORD=your-root-password
REDIS_URL=redis://redis:6379

API_PUBLIC_URL=https://pay.example.com
WEB_PUBLIC_URL=https://pay.example.com
```

启动：

```bash
docker compose pull
docker compose up -d
```

检查：

```bash
docker compose ps
curl -fsS http://127.0.0.1:3000/health
```

MySQL 与 Redis 默认不发布到公网。

## 5. 部署方式 B：使用宿主机 MySQL

适合宝塔、1Panel 或已经维护独立宿主机 MySQL 的环境。

`.env`：

```dotenv
DATABASE_URL=mysql://tuoxin:your-password@host.docker.internal:3306/tuoxin_pay
REDIS_URL=redis://redis:6379

API_PUBLIC_URL=https://pay.example.com
WEB_PUBLIC_URL=https://pay.example.com
```

Compose 已配置：

```yaml
extra_hosts:
  - "host.docker.internal:host-gateway"
```

只启动应用与 Redis：

```bash
docker compose pull app redis
docker compose up -d app redis
```

### 宿主机 MySQL 必须满足

1. mysqld 进程确实在运行。
2. MySQL TCP 端口真实监听。
3. Docker 网桥能够访问该监听地址。
4. TunexPay 数据库账号允许 Docker 网段连接。
5. 防火墙继续禁止公网直接访问 MySQL。

宿主机检查：

```bash
ps aux | grep -E '[m]ysqld|[m]ariadbd'
ss -lntp | grep ':3306'
```

容器侧检查：

```bash
docker compose exec app node -e "
const net=require('net');
const s=net.connect(3306,'host.docker.internal',()=>{
  console.log('MYSQL TCP OK');
  s.end();
});
s.on('error',console.error);
"
```

如果返回 `ECONNREFUSED`，优先检查宿主机 MySQL 的监听地址、端口和进程状态，而不是支付代码。

## 6. 数据库启动等待与迁移

Appliance 启动时先执行：

```text
prisma migrate deploy
```

数据库暂时不可达时，容器不会立即 crash-loop，而是等待重试：

```dotenv
DB_MIGRATION_RETRY_SECONDS=5
DB_MIGRATION_MAX_ATTEMPTS=0
```

`DB_MIGRATION_MAX_ATTEMPTS=0` 表示持续等待。

正常启动顺序：

```text
数据库可达
→ Prisma migration
→ Hono API
→ Worker
→ Next.js Web
→ Gateway
→ /health = 200
```

如果 API、Worker、Web 或 Gateway 任一子进程退出，Appliance 会整体退出，由 Docker restart policy 重新拉起，避免出现部分服务存活的半故障状态。

## 7. OpenResty / Nginx

单镜像部署只保留一个 upstream：

```nginx
upstream tunexpay {
    server 127.0.0.1:3000;
    keepalive 32;
}

server {
    listen 443 ssl;
    server_name pay.example.com;

    location / {
        proxy_pass http://tunexpay;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_connect_timeout 10s;
        proxy_read_timeout 120s;
        proxy_buffering off;
    }
}
```

不要再把 `/submit.php` 或 `/api/v1/*` 单独转发到宿主机 3001。

验证：

```bash
curl -fsS http://127.0.0.1:3000/health
curl -fsS https://pay.example.com/health
```

两者都应返回 HTTP 200。

## 8. 从旧版三容器迁移

旧版运行结构：

```text
tunexpay-web
tunexpay-api
tunexpay-worker
```

新版应用层：

```text
app
├─ Web
├─ API
├─ Worker
└─ Gateway
```

升级前：

```bash
cd /path/to/tuoxin-pay
cp .env .env.backup
```

并先完成 MySQL 备份。

拉取代码和镜像：

```bash
git pull
docker compose pull
```

停止旧服务：

```bash
docker compose down
```

使用宿主机 MySQL：

```bash
docker compose up -d app redis
```

使用 Compose MySQL：

```bash
docker compose up -d
```

升级后检查：

```bash
docker compose ps
docker compose logs --tail 100 app
curl -fsS http://127.0.0.1:3000/health
```

不再需要检查宿主机 `127.0.0.1:3001`。

## 9. 镜像

默认 Compose 使用：

```text
ghcr.io/anrcm0/tunexpay:latest
```

也可通过：

```dotenv
TUNEXPAY_IMAGE_TAG=<tag>
```

固定版本。

如果 GHCR package 仍是私有可见性，需要先登录：

```bash
docker login ghcr.io
```

生产环境建议固定到经过验证的版本 tag，而不是长期无条件跟随 `latest`。

镜像只在**推 tag** 时产出：分支推送与 PR 只跑检查（`.github/workflows/docker.yml`）。

### 版本号

每次发布带一个唯一版本号：

```text
v<提交日期 YYYYMMDD>-<7 位提交号>      例：v20260830-4f48e61
```

- 日期取**提交时间**（UTC）而不是构建时间：同一个提交在任何机器上重建都得到同一个版本号，不同提交必然不同。版本号因此等价于「这批代码的指纹」，可以用来回答「线上跑的到底是哪一版」。
- 版本号由**提交**算出，不取决于 tag 名：tag 只是发布触发器。tag 名与版本号一致只是便于人工对应，不是要求。

发布流程：

```bash
git tag v20260830-4f48e61        # 任意 v* tag 都能触发，建议 tag 名直接用版本号
git push origin v20260830-4f48e61
```

CI 先跑检查（typecheck、单测、脚本与 Compose 校验），通过后构建镜像并推送到 GHCR。同一个镜像打三个 tag：

| 镜像 tag | 说明 |
| --- | --- |
| `v<版本号>` | 例如 `v20260830-4f48e61`，与管理台左下角显示的值逐字一致，**部署与回滚建议按它来** |
| 你推的 tag 名 | tag 名与版本号不一致时，它是同一镜像的别名；一致时是同一个 tag |
| `latest` | 最新一次发布 |

所以界面上看到的版本号可以直接拿去拉镜像：

```bash
docker pull ghcr.io/anrcm0/tunexpay:v20260830-4f48e61
```

本地构建想带上版本号时显式传 build-arg；不传（或留空）时镜像内是 `0.1.0-dev`，管理台会如实显示这不是一次发布：

```bash
APP_VERSION=v20260830-4f48e61 docker compose build
```

在开发机上直接跑 `npm run dev:web` 会从本地 Git 读出 `v<提交日期>-<提交号>-dirty`，`-dirty` 表示构建时工作区有未提交改动。

同一个版本号可以在三处独立核对，任何一处不一致都说明有多个版本在混跑（例如 Web 回滚了但 API 没回滚）：

| 位置 | 取法 |
| --- | --- |
| 管理台左下角（悬浮看提交日期/提交号/来源） | 首屏用构建值，加载后向 `/api/version` 核对当前进程的真实值 |
| API 健康检查 | `curl -s http://127.0.0.1:3000/health` |
| 系统监控页「API 进程」、MCP `initialize` 的 `serverInfo.version` | 与 `/health` 同源 |

版本号只有一个来源（构建注入 → 本地 Git → 兜底），改格式要同时改 [apps/api/src/lib/version.ts](../apps/api/src/lib/version.ts) 与 [apps/web/lib/app-version.ts](../apps/web/lib/app-version.ts)。

## 10. 更新

### 通知 URL 长度修复的迁移检查

新增迁移 `202610010004_webhook_url_length` 将投递 URL 从 300 扩为 500 字符，与应用及订单接口对齐。它保留完整的 `(orderId, eventType, url)` 唯一键，不使用前缀索引或截断 URL。

由于 MySQL 8 常规 InnoDB 索引限制为 3072 字节，三个列都使用 utf8mb4 时最大预算为 3084 字节。迁移将内部 `eventType` 保持 80 字符但改为 `ascii_general_ci`，预算降为 2844 字节；当前写入者只生成 `payment.succeeded` 和 `refund.succeeded:<refundNo>`。Prisma Schema 无法表达列字符集，这一约束由 SQL 迁移维护，不要用 `db push` 代替正式迁移。

升级前备份数据库，并用只读查询确认历史事件类型均为 ASCII（应返回零行）：

```sql
SELECT id, eventType
FROM webhook_deliveries
WHERE HEX(eventType) <> HEX(CONVERT(eventType USING ascii));
```

若存在手工写入的非 ASCII 事件类型，先调查，不要直接替换或删除。迁移显式启用严格 SQL 模式，非 ASCII 数据转换会失败而不是静默替换；默认的启动迁移重试可能因此持续等待，需要查看日志解决前置问题。迁移不删除业务数据或缩短已有字段。

升级后核对：

```sql
SHOW FULL COLUMNS FROM webhook_deliveries;
SHOW INDEX FROM webhook_deliveries;
```

确认 `url` 为 `varchar(500)`、`eventType` 为 ASCII 字符集，唯一键仍覆盖完整三列。请在隔离的真实 MySQL 8 测试库执行迁移并验证长 URL 后再上线；单元测试和静态索引预算检查不能替代真实 DDL 验收。

常规更新：

```bash
cd /path/to/tuoxin-pay
git pull
docker compose pull
docker compose up -d
```

使用宿主机 MySQL 时：

```bash
docker compose up -d app redis
```

随后：

```bash
docker compose ps
docker compose logs --tail 100 app
curl -fsS http://127.0.0.1:3000/health
```

## 11. 回滚

在更新前记录当前镜像 tag 或 SHA。

回滚时设置：

```dotenv
TUNEXPAY_IMAGE_TAG=<previous-tag>
```

然后：

```bash
docker compose pull app
docker compose up -d app
```

数据库 migration 应按照向前兼容原则设计。涉及不可逆 schema 变更时，不要只回滚镜像，必须按对应版本的迁移说明处理数据库。

## 12. 故障排查

### /health 返回 502

先看应用：

```bash
docker compose ps
docker compose logs --tail 200 app
```

### 日志出现 Prisma P1001

表示数据库 TCP 不可达。检查：

```bash
ss -lntp | grep ':3306'
```

宿主机数据库模式再检查：

```bash
docker compose exec app node -e "
const net=require('net');
const s=net.connect(3306,'host.docker.internal',()=>{
  console.log('MYSQL TCP OK');
  s.end();
});
s.on('error',console.error);
"
```

### 外部 502，但本地 /health 正常

如果：

```bash
curl http://127.0.0.1:3000/health
```

正常，而公网域名失败，则重点检查 OpenResty/Nginx/CDN，不再检查 TunexPay 内部 3001。

### 容器显示 Up 但健康检查失败

```bash
docker inspect "$(docker compose ps -q app)" --format '{{json .State.Health}}'
docker compose logs --tail 200 app
```

## 13. 上线检查清单

部署完成后至少确认：

- `docker compose ps` 中 app 健康。
- `http://127.0.0.1:3000/health` 返回 200。
- 公网 `https://pay.example.com/health` 返回 200。
- `/submit.php` 不再经过独立宿主机 3001 upstream。
- MySQL 不对公网开放。
- `API_PUBLIC_URL` 与 `WEB_PUBLIC_URL` 使用生产 HTTPS 域名。
- `MOCK_CHANNEL_ENABLED=false`。
- `ALLOW_PRIVATE_WEBHOOKS=false`。
- 生产密钥均已替换示例值。
- 数据库和 `SECRETS_ENCRYPTION_KEY` 已备份。

### 上线前必须完成

v0.1 已具备真实联调所需的主链，但尚不应直接承接无人值守的大额生产资金。正式上线前至少要完成：

1. 支付宝沙箱与小额生产回归，覆盖超时、重复回调、关闭后晚到成功、部分退款，以及「MCP 审批发起退款 → 退款页人工查单确认」这条人工链路。
2. 接入支付宝日终账单自动下载，并用真实沙箱/生产导出文件回归逐笔匹配；账单收款需配置并验收内置采集器，或接入可用的外部 Watcher。
3. 为管理员登录增加反向代理限流与审计告警；如果需要多人协作，再接入正式身份系统和 RBAC。
4. 设置真实 HTTPS 域名，并保持 `ALLOW_PRIVATE_WEBHOOKS=false`、`MOCK_CHANNEL_ENABLED=false`。
5. 对 `SECRETS_ENCRYPTION_KEY` 做离线备份；丢失后已加密的 ePay/Webhook 密钥无法恢复。

这份边界是刻意保留的：v0.1 先把正确的支付核心跑通，不伪装成已经完成全部生产验证的成熟支付平台。
