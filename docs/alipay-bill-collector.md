# 支付宝账单独立采集器

运行在现有 `worker` 服务中，仅调用 `alipay.data.bill.accountlog.query`，不依赖 MPAY 授权、浏览器、Cookie 或手机通知。请求 RSA2 加签；响应使用支付宝公钥校验原始响应对象的签名后才处理。

接口参考：https://opendocs.alipay.com/open/02awe0?ref=api

## 配置与升级

先备份数据库和当前配置，再将新代码部署到项目目录。不要删除数据库卷或变更已有 `SECRETS_ENCRYPTION_KEY`。

```dotenv
ALIPAY_BILL_ENABLED=true
ALIPAY_BILL_COLLECTOR_ENABLED=true
ALIPAY_BILL_USER_ID=2088xxxxxxxxxxxx
ALIPAY_BILL_QR_CONTENT=收款码解析后的内容
ALIPAY_BILL_MATCH_MODE=REMARK
ALIPAY_BILL_POLL_SECONDS=10
ALIPAY_BILL_LOOKBACK_SECONDS=3600
ALIPAY_BILL_OVERLAP_SECONDS=300
ALIPAY_BILL_LAG_SECONDS=15
MOCK_CHANNEL_ENABLED=false
```

同时配置已验证具有账务查询权限的 `ALIPAY_APP_ID`、`ALIPAY_PRIVATE_KEY`、`ALIPAY_PUBLIC_KEY` 和 `ALIPAY_GATEWAY`，以及正确的 HTTPS `API_PUBLIC_URL`、`WEB_PUBLIC_URL`。密钥不得提交仓库；PEM 可写成带 `\n` 的单行值。

```bash
docker compose up -d --build api worker web
docker compose logs --tail 100 api worker
```

API 启动自动应用 `202609160006_bill_collector` 迁移。代码更新需要重新构建。后台“支付渠道”可查看采集状态，再将应用默认渠道切为 `ALIPAY_BILL`，使用新订单测试。

内置采集直接调用本地支付服务，不需要 Watcher 令牌。没有配置外部令牌时，外部流水 HTTP 入口仍拒绝请求。兼容外部 Watcher 时继续设置至少 24 字符的专用令牌。

## 查询与安全边界

- 单账号 `alipay-bill-default`，二维码必须属于配置的查询账号。
- 首次启动回看一小时；之后从数据库断点继续。每个窗口最多前进 30 分钟，回叠五分钟，最新数据延后 15 秒查询。
- 每轮最多五页，每页 100 条。固定窗口和页码持久化，下轮继续未完成窗口。
- 接口字段契约：`total_size`、`account_log_list`，条目使用 `income`、`outcome`、`alipay_order_no`、`trans_dt`、`trans_memo`。未知结构报错并保留断点，不能当作“没有收入”。必须用实际账号的已验签响应验证这些字段及备注完整性。
- 收入为正、支出为零且有支付宝订单号的条目才送入匹配；明确退款/冲正说明的条目排除。账务明细并非全部是顾客付款，仍需业务金额、时间和唯一识别码校验。条目入账时间不必然等于原始交易付款时间，也需联调检查延迟。
- 流水先持久化，再推进页码；失败重放，交易号去重和支付核心幂等防止重复充值。
- 查询失败指数退避，最多五分钟；多 Worker 使用数据库租约。Compose 给 Worker 120 秒优雅退出时间。
- 后台显示心跳、成功查询时间、断点、页码和错误码。`RUNNING` 不代表所有真实支付场景已验收。
- App ID、用户 ID、网关或二维码变更时暂停采集，显示 `ACCOUNT_BINDING_CHANGED`。需人工核对未完成订单并迁移账号，不要直接清空状态表复用历史订单。
- 回叠补拉不能覆盖超过配置时间的延迟入账。需观察实际延迟、调整回叠时间，并保留日终账单或人工对账兜底。
- 静态码不能由系统真正关停；退款仍需人工处理。金额模式中普通同额转账可能误配，应隔离日常转账和业务收款，优先使用备注模式。

## 真实上线验收（尚需账号执行）

1. 使用独立测试应用，暂不连接正式充值业务。确认查询成功，日志没有权限/验签错误。
2. 小额付款填写完整备注，核对实收金额、时间、支付宝交易号和订单状态。
3. 验证重叠查询不重复充值，重启 Worker 保留断点，暂时断网恢复后补拉。
4. 验证错付、漏备注、过期和多候选不自动充值。
5. 最后连接 NewAPI，确认通知送达且只充值一次，配置备份和定期对账。

本地模拟接口测试不是支付宝真实账号验收。未验证真实字段、备注和收入场景覆盖前，不开放无人值守生产充值。
