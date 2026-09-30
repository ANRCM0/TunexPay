-- 通道归档软删除：通道行里存着对接密钥，硬删会让历史支付单的查单、关闭与原路退款永久失效，
-- 因此承载过资金数据的通道改为归档（行与密钥保留、不再可用）。
ALTER TABLE `channel_instances` ADD COLUMN `archivedAt` DATETIME(3) NULL;

CREATE INDEX `channel_instances_archivedAt_createdAt_idx` ON `channel_instances`(`archivedAt`, `createdAt`);
