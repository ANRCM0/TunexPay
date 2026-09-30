# 性能改动验收核对表

本文件把本轮性能改动逐项映射到**可在真实 MySQL/Redis 环境执行的验证步骤**。本仓库的开发环境
没有 Docker/MySQL/Redis，所以下面的步骤需要在部署机（或测试环境）上执行。

配套脚本：

| 脚本 | 作用 | 是否写库 |
| --- | --- | --- |
| `apps/api/src/scripts/verify-indexes.ts` | 校验 6 个新索引存在、关键查询走索引 | **只读**，可在生产库跑 |
| `apps/api/src/scripts/verify-concurrency.ts` | 4 个并发正确性场景 | 会写测试数据（`perf-verify-` 前缀，自动清理） |

配套脚本**只在手动执行时运行**：没有任何自动触发路径——CI（`.github/workflows/docker.yml`）只跑
typecheck/测试/compose 校验，容器入口（`docker/entrypoint.sh`）只跑迁移与进程编排，两者都不调用它们。
写库脚本因此在 CI 与容器启动时都不会碰到数据库。

```bash
# 方式一：在仓库目录执行（先加载 .env）
cd /path/to/tuoxin-pay
set -a; . ./.env; set +a

cd apps/api
npx tsx src/scripts/verify-indexes.ts            # 只读
npx tsx src/scripts/verify-concurrency.ts --yes  # 写测试数据，自动清理
```

```bash
# 方式二（推荐）：容器内执行，直接复用生产环境变量，省去加载 .env
# 镜像里包含源码与 tsx（devDependencies 会被打进镜像），注意容器 WORKDIR 是 /app。
docker compose exec app npx tsx apps/api/src/scripts/verify-indexes.ts
# 写库脚本在 NODE_ENV=production 下必须额外加 --force：
docker compose exec app npx tsx apps/api/src/scripts/verify-concurrency.ts --yes --force
```

> CI 里唯一的自动覆盖是 `tsc` 类型检查（脚本在 `apps/api/tsconfig.json` 的 include 范围内），
> 它不会连数据库，也不会写任何数据。

## 安全前提

- `verify-concurrency.ts` 必须显式加 `--yes`；`NODE_ENV=production` 时还要加 `--force`。
- 建议**先备份**（`mysqldump`）再跑写库脚本；脚本只创建 `perf-verify-*` 数据并自删，但如果中途
  被强杀，可能残留，清理方式见脚本结尾的提示。
- 第 4 步会让 Redis 短暂停机（验证兜底轮询），会顺带让 Webhook 投递暂停、Worker 心跳变 STALE，
  Redis 恢复后由 MySQL Outbox 自动补发——请在测试环境做。

## 步骤 0：部署与迁移

```bash
docker compose up -d
docker compose logs app | grep -i -E 'migrat|appliance' | tail -20
```

确认迁移 `202609180001_query_indexes` 已应用：

```bash
docker compose exec mysql mysql -utuoxin -p"$MYSQL_PASSWORD" tuoxin_pay -e "
SELECT migration_name, finished_at FROM _prisma_migrations ORDER BY finished_at DESC LIMIT 3;"
```

期望：`202609180001_query_indexes` 在最上面且 `finished_at` 非空。

## 步骤 1：索引与执行计划（只读）

```bash
cd apps/api && npx tsx src/scripts/verify-indexes.ts --min-rows 500
```

期望输出：12 个 `[PASS]`（6 个索引 + 6 条查询计划；含 `orders` 的两条）。

判读规则：

- `[SKIP]` 表示该表行数少于 `--min-rows`，MySQL 在小表上会直接全表扫描，EXPLAIN 结论不可信。
  在有真实数据（或先灌压测数据）后重跑；把阈值调到实际行数以下即可。
- `[FAIL] type=ALL` = 退化为全表扫描；`[FAIL] 没有使用期望索引` = 优化器选了别的索引；
  `[FAIL] 仍需要 filesort` = 排序没有走索引。三者都请把输出的 `EXPLAIN` 摘要回传，再决定是否调整索引。

索引清单（迁移里 6 个）：

| 索引 | 服务的查询 |
| --- | --- |
| `orders(deletedAt, createdAt)` | 今日订单数、订单列表倒序 |
| `orders(deletedAt, paidAt)` | 今日实收（原先是**全表扫描**） |
| `payments(status, paidAt)` | 今日成功支付金额 |
| `refunds(createdAt, id)` | 退款列表倒序（原先整表 filesort） |
| `webhook_deliveries(createdAt, id)` | 通知列表倒序（原先整表 filesort） |
| `receipts(occurredAt, id)` | 对账流水倒序 |

## 步骤 2：总览接口的语句数（15 → 2）

```bash
A=$(docker compose exec -T mysql mysql -utuoxin -p"$MYSQL_PASSWORD" -N -e "SHOW GLOBAL STATUS LIKE 'Com_select'" | awk '{print $2}')
for i in 1 2 3 4 5; do
  curl -s -o /dev/null -H "Authorization: Bearer $ADMIN_TOKEN" "$API_PUBLIC_URL/admin/v1/dashboard"
done
B=$(docker compose exec -T mysql mysql -utuoxin -p"$MYSQL_PASSWORD" -N -e "SHOW GLOBAL STATUS LIKE 'Com_select'" | awk '{print $2}')
echo "5 次总览刷新的 SELECT 增量：$((B-A))（改动前约 75，改动后期望 ≤ 30）"
```

注意：该实例上的其它活动也会计入，请在安静环境测量，或用 `performance_schema` 按 digest 精确统计。

## 步骤 3：并发正确性（写库，自动清理）

```bash
cd apps/api && npx tsx src/scripts/verify-concurrency.ts --yes --rounds 20
```

四个场景与它们各自守护的资金不变量：

| 场景 | 断言 | 守护的是 |
| --- | --- | --- |
| S1 8 路并发创建同一订单 | 全部返回同一订单号，库里恰好 1 行 | `createOrder` 去掉 Serializable 后的幂等收敛 |
| S2 20 轮「同订单两笔支付并发成功」 | 每轮恰好 1 个胜出者、1 条 `PAYMENT_LATE_DUPLICATE`、1 条异常单 | `markPaymentSucceeded` 保留 Serializable（重复入账防线） |
| S3 同 revision 并发保存通道配置 | 恰好 1 次成功、1 次 `CHANNEL_CONFIG_CONFLICT` | `saveChannel` 保留 Serializable（revision 校验） |
| S4 两笔各 60% 并发退款 | 恰好 1 笔成功、累计 ≤ 支付金额 | `createRefund` 保留 Serializable（退款上限） |

- S4 需要 `MOCK_CHANNEL_ENABLED=true`，否则显示 `[SKIP]`。
- 脚本结尾会打印**死锁（1213）/锁等待超时（1205）**的出现次数。S2 是重点观察对象：
  如果出现 1213，说明并发下的锁顺序需要复核，请把完整报错回传。
- 任一 `[FAIL]` 都请连同该轮的具体数字回传。

## 步骤 4：收银台长轮询（事件唤醒 + 兜底）

**(a) Redis 正常：状态变更应立即唤醒**

```bash
# 终端 1：对一笔未支付订单发起 12 秒长轮询并计时
curl -s -o /dev/null -w "长轮询耗时 %{time_total}s\n" \
  "$API_PUBLIC_URL/api/v1/channels/public/payments/<paymentNo>?wait=12"

# 终端 2：1 秒后把该笔支付改成成功（MOCK 通道；真实场景就是用户付款）
sleep 1
curl -s -X POST -H "x-mock-token: $MOCK_CHANNEL_TOKEN" \
  "$API_PUBLIC_URL/api/v1/channels/mock/<paymentNo>/succeed"
```

期望：长轮询约 **1 秒**返回（而不是等满 12 秒）。这验证唤醒消息生效。
改动前是每 400ms 查一次库、最多 12 秒窗口约 30 次查询；改动后同一窗口约 9 次（兜底）+ 状态变更 1 次。

**(b) Redis 停机：兜底必须仍然可用**

```bash
docker compose stop redis
# 重复 (a)：期望长轮询在约 1.5 秒内返回（兜底间隔），收银台仍能显示支付成功
docker compose start redis
```

期望：确认延迟仍是秒级，而不是长时间不返回。同时管理台会显示 Worker `STALE`（心跳停更），
Redis 恢复后 Webhook 由 MySQL Outbox 自动补发——这是设计内行为。

## 步骤 5：流水批量并发（Watcher 路径）

准备一个 `ALIPAY_BILL` 待支付单，然后用同一批 20 条流水重复投递 3 次：

```bash
for i in 1 2 3; do
  time curl -s -X POST "$API_PUBLIC_URL/api/v1/channels/alipay-bill/flows" \
    -H 'Content-Type: application/json' -H "X-Watcher-Token: $ALIPAY_BILL_WATCHER_TOKEN" \
    -d '{"records":[ /* 同一批 20 条 */ ]}' | head -c 300; echo;
done

docker compose exec mysql mysql -utuoxin -p"$MYSQL_PASSWORD" tuoxin_pay -e "
SELECT fingerprint, COUNT(*) c FROM receipts GROUP BY fingerprint HAVING c > 1;"
docker compose logs app | grep -E '1213|1205|Deadlock|Lock wait' | tail
```

期望：第二次、第三次全部返回 `duplicate: true`（或租约未过期）；`HAVING c > 1` **无输出**（每条形码只
一行回执）；日志里没有死锁/锁等待超时。

调参（`FLOW_CONCURRENCY` 现在写死为 4，位于 `apps/api/src/services/receipt-flow-service.ts`）：
把该常量临时改成 1 / 4 / 8，各跑 100 条一批并记录墙钟与 P95，作为是否调整的依据。
若 `DATABASE_URL` 里带了 `connection_limit`，并发上限不应超过它。

## 步骤 6：采集器空闲开销（`performance_schema`）

在开启 `ALIPAY_BILL` 采集、且当前**没有**待收流水的情况下，取两次快照、间隔 60 秒：

```sql
-- 第一次
SELECT DIGEST_TEXT, COUNT_STAR FROM performance_schema.events_statements_summary_by_digest
WHERE DIGEST_TEXT LIKE '%bill_collector_states%';
-- 等 60 秒后第二次，逐条求差
```

期望：`UPDATE ... bill_collector_states ... SET heartbeatAt` 的增量从约 **20 次/分钟** 降到约 **2 次/分钟**；
`SELECT ... bill_collector_states ... FOR UPDATE` 相关的 digest 不再出现在空闲窗口里。

## 步骤 7：把实测值填回来

| 指标 | 改动前 | 期望 | 实测 |
| --- | --- | --- | --- |
| 总览 5 次刷新的 SELECT 增量 | ≈75 | ≤30 | |
| 长轮询：状态变更→返回 | ≈0.4s | ≈0.1s | |
| 长轮询：12s 窗口内查询次数 | ≈30 | ≈9 | |
| 长轮询：Redis 停机时返回 | ≈0.4s | ≤2s | |
| 100 条流水投递墙钟（并发 4） | 串行基线 | 明显下降 | |
| 采集器空闲心跳写入 | ≈20 次/分 | ≈2 次/分 | |
| 并发验收 S1–S4 | — | 全 PASS | |
| 死锁/锁等待次数 | — | 0 | |

把这张表和 `verify-indexes.ts` / `verify-concurrency.ts` 的原始输出一起回传，就能决定是否需要
调整 `FLOW_CONCURRENCY`、兜底间隔（现在 1.5 秒，常量在 `apps/api/src/lib/payment-wake.ts`）
以及是否需要补/改索引。
