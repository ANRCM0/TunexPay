-- 按后台总览与列表页真实的查询形态补索引。这些查询每一跳/每次刷新都会跑，
-- 缺少索引时会退化成全表扫描或整表 filesort。
CREATE INDEX `orders_deletedAt_createdAt_idx` ON `orders`(`deletedAt`, `createdAt`);
CREATE INDEX `orders_deletedAt_paidAt_idx` ON `orders`(`deletedAt`, `paidAt`);
CREATE INDEX `payments_status_paidAt_idx` ON `payments`(`status`, `paidAt`);
CREATE INDEX `receipts_occurredAt_id_idx` ON `receipts`(`occurredAt`, `id`);
CREATE INDEX `refunds_createdAt_id_idx` ON `refunds`(`createdAt`, `id`);
CREATE INDEX `webhook_deliveries_createdAt_id_idx` ON `webhook_deliveries`(`createdAt`, `id`);
