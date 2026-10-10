-- 应用生命周期：归档删除所需的软删除标记。
-- applications 行在「删除应用」后保留（订单、事件、退款推进与异常记录仍挂在它上面），因此需要
-- archivedAt 把「新增」与「历史」分开；orders 需要 deletedAt 让业务接口看不见已随应用归档的订单。
ALTER TABLE `applications` ADD COLUMN `archivedAt` DATETIME(3) NULL;
ALTER TABLE `applications` ADD COLUMN `pausedAt` DATETIME(3) NULL;
ALTER TABLE `orders` ADD COLUMN `deletedAt` DATETIME(3) NULL;
ALTER TABLE `orders` ADD COLUMN `deletedWithApplicationId` VARCHAR(40) NULL;
CREATE INDEX `applications_archivedAt_createdAt_idx` ON `applications` (`archivedAt`, `createdAt`);
CREATE INDEX `orders_applicationId_deletedAt_idx` ON `orders` (`applicationId`, `deletedAt`);
