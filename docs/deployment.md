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
ghcr.io/paimoncai/tunexpay:latest
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

生产环境建议固定到经过验证的版本或 SHA tag，而不是长期无条件跟随 `latest`。

## 10. 更新

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
