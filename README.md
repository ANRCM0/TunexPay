# TUOXIN Pay v0.1

TUOXIN Pay 是面向自有业务的轻量支付中台。它不是 MPAY 的改皮版本，而是一套重新建模的 TypeScript 项目：保留支付系统真正需要的事务、幂等、状态机、异常恢复和可靠通知，移除多商户运营、余额、清算、费率和复杂路由。

## v0.1 已实现

- 插件与多通道：同一插件可配置多个独立账号，按业务应用分配；真实接口检测、版本化检测结果和小额实付验收。历史支付绑定原通道，账单流水与采集进度按通道隔离。[使用与升级说明](docs/plugin-channels.md)。

- 本人通知：面板配置邮箱 SMTP 和飞书机器人、测试发送、独立持久化任务、失败重试、投递记录和采集失败提醒限频；[配置说明](docs/owner-notifications.md)。

- Application：独立 API Key、Webhook Secret、ePay PID/Key；敏感密钥使用 AES-256-GCM 加密保存。
- Order / Payment 分离：一张业务订单支持多次支付尝试。
- 金额全程以整数“分”保存，不使用浮点数结算。
- 支付状态机：`CREATED → PROCESSING → SUCCESS / FAILED / UNKNOWN / CLOSED`，支持终态后的可信晚到成功。
- 支付宝官方 API：当面付预创建、主动查单、关闭、退款、RSA2 回调验签。
- 支付宝账单收款：个人收款码承接、备注/金额预约、Watcher 标准流水入口、数据库租约去重和有效期匹配。
- 支付宝独立账单采集器：账务明细接口、RSA2 响应验签、分页断点、重叠补拉、失败退避和后台状态；[升级与验收说明](docs/alipay-bill-collector.md)。真实账号验收仍需执行。
- 账单面板配置：收款/采集独立开关、账号和匹配参数、加密密钥、动态生效与版本冲突保护；环境变量仅作为首次导入值。
- Mock 通道：不接真实资金即可跑通本地闭环。
- ePay V1：`submit.php`、`mapi.php`、`api.php` 查询与退款，可供 NewAPI 等现有系统接入。
- 退款：独立退款单、外部退款单号幂等、累计金额上限校验、部分/全额退款状态。
- 异常恢复：支付与退款自动查单，MySQL 持久化调度、指数退避、并发认领和人工接管。
- 订单过期：先查单、再关闭活跃支付、最后锁定订单；失败持久化退避重试，晚到成功仍可恢复。
- 支付宝日账单对账：后台上传 CSV，统一标准 Receipt、指纹去重、支付/退款自动匹配、金额差错阻断和人工重跑。
- 可靠 Webhook：支付事务内写 Outbox；Worker 通过 Redis 调度，但以 MySQL 为事实来源，支持租约恢复、指数退避、手动重试。
- Event Timeline：订单、支付、退款、通知都写入可检索业务事件。
- Payment Exception：晚到重复支付、流水多候选与状态冲突形成独立处置单；重复 Payment 退款不会误改业务订单。
- Next.js 管理后台与收银台：管理员登录、订单详情、事件时间线、渠道状态检查和应用默认渠道切换。
- 管理审计：后台变更操作记录动作、资源、结果、来源 IP、User-Agent 与 Request ID，不保存请求正文和密钥。
- Prisma/MySQL 迁移、Docker Compose、OpenResty 反向代理示例。

## 架构

```text
TUOXIN Matrix / Studio / Chat / NewAPI
                  │
       REST v1 或 ePay V1 Adapter
                  │
             Hono API
        ┌─────────┴─────────┐
        │ Payment Core      │
        │ Order / Payment   │
        │ Refund / Events   │
        │ State / Idempotency│
        └─────────┬─────────┘
                  │
   Alipay / Alipay Bill / Mock Adapter
                  │
      MySQL Outbox ── Redis ── Worker
                  │
             业务 Webhook
```

详细设计见 [docs/architecture.md](docs/architecture.md)，从 MPAY 提取/删除的内容见 [docs/mpay-reference-notes.md](docs/mpay-reference-notes.md)，接口定义见 [docs/openapi.yaml](docs/openapi.yaml)。

## 使用 Docker 启动

要求 Docker Compose v2。

当前版本采用 **TunexPay Appliance 单应用镜像**：Next.js 管理端/收银台、Hono API 与后台 Worker 打包在同一个应用镜像中，由容器内统一 Gateway 分流。宿主机只需要一个应用端口，不再分别暴露 Web 3000 和 API 3001。

```text
Internet
   │
OpenResty / Nginx
   │
127.0.0.1:3000
   │
┌─────────────────────────────┐
│ TunexPay Appliance          │
│                             │
│ Gateway :8080               │
│   ├─ Next.js Web :3000      │
│   ├─ Hono API :3001         │
│   └─ Worker                 │
└──────────────┬──────────────┘
               │
        MySQL / Redis
```

外部请求统一访问同一个域名：

- 管理后台、收银台和静态页面 → Next.js
- `/submit.php`、`/mapi.php`、`/api.php` → Hono API
- `/api/v1/*`、`/admin/v1/*`、`/health` → Hono API
- `/api/backend/*` → Next.js，再由 Next.js 访问容器内部 API

因此 OpenResty/Nginx 只需要反代：

```text
127.0.0.1:3000
```

不再需要单独维护 `127.0.0.1:3001` 的公网反代规则。

### 1. 准备环境变量

```bash
cp .env.example .env

openssl rand -hex 32       # 写入 SECRETS_ENCRYPTION_KEY
openssl rand -base64 36    # 写入 ADMIN_TOKEN
openssl rand -base64 24    # 写入 ADMIN_PASSWORD
openssl rand -base64 36    # 写入 ADMIN_SESSION_SECRET
openssl rand -base64 24    # 写入 MOCK_CHANNEL_TOKEN
openssl rand -base64 36    # 写入 ALIPAY_BILL_WATCHER_TOKEN
```

生产环境必须显式设置 `DATABASE_URL`，不要依赖隐式数据库地址。

### 2. 使用 Compose 自带 MySQL

`.env` 示例：

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
docker compose up -d
```

MySQL 与 Redis 默认不发布到公网。

### 3. 使用宿主机 MySQL

如果 MySQL 已安装在宿主机，例如宝塔、1Panel 或手工安装：

```dotenv
DATABASE_URL=mysql://tuoxin:your-password@host.docker.internal:3306/tuoxin_pay
REDIS_URL=redis://redis:6379

API_PUBLIC_URL=https://pay.example.com
WEB_PUBLIC_URL=https://pay.example.com
```

Compose 已加入：

```yaml
extra_hosts:
  - "host.docker.internal:host-gateway"
```

此时只需要启动应用和 Redis，避免额外创建一套无用 MySQL：

```bash
docker compose up -d app redis
```

宿主机 MySQL 必须满足：

1. MySQL 进程真实运行，而不只是 systemd 启动脚本显示 `active (exited)`。
2. TCP 端口可从 Docker 网桥访问。
3. 数据库用户允许来自 Docker 网段的连接。
4. 防火墙继续阻止公网直接访问 3306。

可从应用容器侧测试：

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

### 4. 数据库暂时不可用时的行为

Appliance 启动时会先执行：

```text
Prisma migrate deploy
```

如果数据库暂时不可达，不再立即退出并形成 crash loop，而是按配置等待重试：

```dotenv
DB_MIGRATION_RETRY_SECONDS=5
DB_MIGRATION_MAX_ATTEMPTS=0
```

其中 `0` 表示持续等待。

数据库恢复后：

```text
数据库可用
→ Prisma migration
→ API 启动
→ Worker 启动
→ Web 启动
→ Gateway 开放
→ /health 变为 200
```

如果 API、Web、Worker 或 Gateway 任一子进程异常退出，整个 Appliance 会退出，由 Docker `restart: unless-stopped` 统一重建，避免出现“容器显示 Up，但只有部分服务活着”的半可用状态。

### 5. 启动后检查

```bash
docker compose ps
curl -v http://127.0.0.1:3000/health
```

正常应返回：

```json
{"status":"ok","service":"tuoxin-pay-api","version":"0.1.0"}
```

公网反代配置完成后：

```bash
curl -v https://pay.example.com/health
```

同样应返回 HTTP 200。

### 6. OpenResty / Nginx

单镜像版本只需要一个 upstream：

```nginx
upstream tunexpay {
    server 127.0.0.1:3000;
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
        proxy_read_timeout 120s;
    }
}
```

无需再为 `/submit.php`、`/api/v1/*` 单独反代到宿主机 3001。

### 7. 从旧三容器部署升级

旧版本可能存在：

```text
tunexpay-web
tunexpay-api
tunexpay-worker
```

升级前先保存现有 `.env` 和数据库备份，然后：

```bash
cd /path/to/tuoxin-pay

git pull
docker compose down
docker compose pull
docker compose up -d app redis
```

如果使用 Compose 自带 MySQL，则使用：

```bash
docker compose up -d
```

升级后正常状态应以一个应用容器为主：

```text
tuoxin-pay-app
redis
mysql      # 仅使用 Compose MySQL 时
```

外部只需要确认：

```bash
curl http://127.0.0.1:3000/health
```

无需再检查宿主机 3001。

### 8. 应用与管理员凭证

首次可以在“应用”页面创建 `TUOXIN Matrix`。API Key、Webhook Secret、ePay Key 只显示一次，请立即保存。

应用创建后可以在同一页面重置凭证、停用或删除。重置会同时换掉 API Key、Webhook Secret 与 ePay Key（`epayPid` 作为商户标识不变），旧凭证立即失效。删除按业务数据量自动分两条路径：从未产生订单、退款、通知投递的应用直接删行；已经承载过资金数据的应用走**归档删除** —— 凭证立即失效、不能再创建新订单、订单/通知/异常各页都不再显示它的数据，但记录保留在库中（已成功的支付与已发起的退款一定保留，通道侧的钱已经动了），DBA 随时可按 `orders.deletedWithApplicationId` 还原。归档应用默认不在列表中显示，可用「显示已归档」开关查看。

管理端使用 12 小时有效的签名 HttpOnly 会话 Cookie。`ADMIN_TOKEN` 只用于 Web 服务访问内部管理 API，不会下发到浏览器；请勿将 `ADMIN_PASSWORD`、`ADMIN_SESSION_SECRET` 和 `ADMIN_TOKEN` 设置为相同内容。

## 自动异常恢复

支付宝支付或退款遇到网络超时、响应无法确认时会进入 `UNKNOWN`，Worker 随后依据 MySQL 中的 `nextQueryAt` 自动向支付宝查单。查询从 15 秒开始指数退避，最长间隔 15 分钟，最多自动尝试 20 次。

达到上限后系统不会擅自标记失败，而是保留原状态、停止自动查询并在后台显示“需要人工处理”。管理员仍可在订单详情或退款页面手动查单。Mock 通道不会进入自动轮询。

订单到达 `expiresAt` 后，Worker 会先查询支付宝确认是否已经支付，再关闭仍活跃的支付尝试，最后把订单置为 `CLOSED`。关闭请求失败时不会强行关单，而是从 30 秒开始指数退避，最长间隔 1 小时。后台订单详情会显示失败原因和下次重试时间。

## 管理操作审计

管理端所有 POST 变更都会写入 `admin_audit_logs`，可在“操作审计”页面查看。审计包含操作类型、资源、成功/失败、HTTP 状态、错误码、Request ID、来源地址和 User-Agent，不记录 API Key、账单内容或其他请求正文。

## 支付宝账单对账

在管理后台“对账”页面选择账单日期并上传支付宝交易明细 CSV。浏览器支持读取 UTF-8、GBK/GB18030 与 UTF-16LE 文件，服务端会：

1. 将支付宝字段标准化为收入或退款 `Receipt`。
2. 通过稳定指纹抵御重复上传。
3. 同时核对商户单号、支付宝流水号和整数分金额。
4. 仅通过 `markPaymentSucceeded()` 或退款服务推进状态，并在同一流程生成事件与业务 Webhook。
5. 把找不到本地单据的流水标为“未匹配”，把金额或标识冲突标为“存在差错”，绝不自动入账。

当前版本由管理员手动下载并上传账单；自动调用支付宝账单下载 API 属于下一步部署增强。重复上传同一日账单是安全的。

## 支付宝账单收款 Watcher

这条链路与上面的“官方日账单对账”不同：`ALIPAY_BILL` 用个人收款码承接付款，由内置采集器或外部 Watcher 查询到账流水。推荐在“支付渠道 → 支付宝账单收款配置”中开启、填写账号密钥并保存；[面板配置与升级说明](docs/alipay-bill-collector.md)。

以下环境变量只作为配置表首次初始化的兼容值，后续以面板保存的数据库配置为准：

```dotenv
ALIPAY_BILL_ENABLED=true
ALIPAY_BILL_QR_CONTENT=支付宝收款二维码解析出的内容
ALIPAY_BILL_MATCH_MODE=AMOUNT
ALIPAY_BILL_VALID_SECONDS=300
ALIPAY_BILL_WATCHER_TOKEN=至少24字符的独立随机令牌
```

Watcher 调用：

```bash
curl -X POST https://pay.example.com/api/v1/channels/alipay-bill/flows \
  -H 'Content-Type: application/json' \
  -H 'X-Watcher-Token: your-watcher-token' \
  -d '{"record":{"order_no":"支付宝流水号","price":"19.99","paid_at":"2026-09-16 12:00:00","remark":"TXA1B2C3D4E5"}}'
```

原生格式也可使用 `providerTradeNo`、整数分 `amount`、`paidAt`、`remark`，并通过 `{records:[...]}` 一次提交最多 100 条。Watcher 必须重试网络失败，并对响应中仍为 `PROCESSING` 的流水再次投递；终态为 `MATCHED`、`MISMATCH` 或 `IGNORED`。同一支付宝流水号重复提交是幂等的；即使 API 在处理中崩溃，Worker 也会在数据库租约到期后自动恢复。

匹配严格按交易号、备注码、有效期内金额进行。备注或金额只负责定位候选，系统仍会校验精确实收金额和支付时间窗。出现多候选时不会猜单，而会进入“支付异常”后台。注意：官方账务明细接口不下发付款备注，内置采集器只能用 `AMOUNT` 金额匹配；`REMARK` 仅对能抓到备注的外部 Watcher 有效。

## 本地 Mock 全链路

`.env` 中保持：

```dotenv
MOCK_CHANNEL_ENABLED=true
ALLOW_PRIVATE_WEBHOOKS=true
```

创建订单：

```bash
curl -X POST http://localhost:3000/api/v1/orders \
  -H 'Content-Type: application/json' \
  -H 'X-App-Id: app_xxx' \
  -H 'X-Api-Key: txp_app_xxx_xxx' \
  -H 'Idempotency-Key: recharge-10001' \
  -d '{"externalOrderNo":"recharge-10001","amount":1999,"currency":"CNY","subject":"余额充值"}'
```

使用返回的 `orderNo` 发起支付：

```bash
curl -X POST http://localhost:3000/api/v1/orders/ord_xxx/pay \
  -H 'Content-Type: application/json' \
  -H 'X-App-Id: app_xxx' \
  -H 'X-Api-Key: txp_app_xxx_xxx' \
  -H 'Idempotency-Key: payment-10001' \
  -d '{"channel":"MOCK","method":"alipay"}'
```

浏览器打开返回的 `cashierUrl`，点击“模拟支付成功”。后台应出现 `ORDER_SUCCEEDED`，配置了 Webhook 时还会生成投递任务。

## 支付宝配置

在 `.env` 填写：

```dotenv
ALIPAY_APP_ID=支付宝开放平台应用ID
ALIPAY_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----"
ALIPAY_PUBLIC_KEY="-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----"
ALIPAY_GATEWAY=https://openapi.alipay.com/gateway.do
API_PUBLIC_URL=https://pay.example.com
WEB_PUBLIC_URL=https://pay.example.com
```

应用默认通道改为 `ALIPAY`。支付宝异步通知入口为：

```text
https://pay.example.com/api/v1/channels/alipay/webhook
```

先在支付宝沙箱完成预创建、扫码、异步回调、重复回调、主动查单和退款测试，再切生产网关及生产密钥。

## ePay / NewAPI 接入

在 NewAPI 的易支付配置中填写：

- 网关地址：`https://pay.example.com`
- 商户 ID：应用创建时返回的 `epayPid`
- 商户密钥：应用创建时返回的 `epayKey`
- 支付类型：`alipay`

TUOXIN Pay 将 ePay 的 `out_trade_no` 映射为 `externalOrderNo`，支付成功后按照 ePay MD5 规则向原 `notify_url` 发起通知，并要求接收端返回纯文本 `success`。

## 原生 Webhook 验签

原生 Webhook 使用以下请求头：

```text
X-Tuoxin-Event: payment.succeeded
X-Tuoxin-Delivery: <delivery-id>
X-Tuoxin-Timestamp: <unix-seconds>
X-Tuoxin-Signature: v1=<hex-hmac-sha256>
```

签名原文为：

```text
timestamp + "." + 原始请求体
```

接收端应使用应用的 `webhookSecret` 计算 HMAC-SHA256，进行常量时间比较，并拒绝时间戳相差超过 5 分钟的请求。

## 开发命令

```bash
npm install
npm run db:generate
npm run db:migrate
npm run dev:api
npm run dev:worker
npm run dev:web

npm test
npm run typecheck
npm run build
```

也可以使用命令行创建应用：

```bash
npm run app:create -- --name "TUOXIN Matrix" --webhook "https://example.com/pay/webhook" --channel ALIPAY
```

## 上线前必须完成

v0.1 已具备真实联调所需的主链，但尚不应直接承接无人值守的大额生产资金。正式上线前至少要完成：

1. 支付宝沙箱与小额生产回归，覆盖超时、重复回调、关闭后晚到成功和部分退款。
2. 接入支付宝日终账单自动下载，并用真实沙箱/生产导出文件回归逐笔匹配；账单收款需配置并验收新增的内置采集器，或接入可用的外部 Watcher。
3. 为管理员登录增加反向代理限流与审计告警；如果需要多人协作，再接入正式身份系统和 RBAC。
4. 设置真实 HTTPS 域名，并保持 `ALLOW_PRIVATE_WEBHOOKS=false`、`MOCK_CHANNEL_ENABLED=false`。
5. 对 `SECRETS_ENCRYPTION_KEY` 做离线备份；丢失后已加密的 ePay/Webhook 密钥无法恢复。

这份边界是刻意保留的：v0.1 先把正确的支付核心跑通，不伪装成已经完成全部生产验证的成熟支付平台。
