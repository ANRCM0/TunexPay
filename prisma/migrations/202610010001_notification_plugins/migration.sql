CREATE TABLE `notification_instances` (
  `id` VARCHAR(80) NOT NULL,
  `plugin` VARCHAR(32) NOT NULL,
  `name` VARCHAR(120) NOT NULL,
  `enabled` BOOLEAN NOT NULL DEFAULT false,
  `revision` INTEGER NOT NULL DEFAULT 1,
  `payloadEncrypted` LONGTEXT NOT NULL,
  `archivedAt` DATETIME(3) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  INDEX `notification_instances_plugin_createdAt_idx`(`plugin`, `createdAt`),
  INDEX `notification_instances_archivedAt_createdAt_idx`(`archivedAt`, `createdAt`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `notification_subscriptions` (
  `id` VARCHAR(191) NOT NULL,
  `instanceId` VARCHAR(80) NOT NULL,
  `eventType` VARCHAR(64) NOT NULL,
  `enabled` BOOLEAN NOT NULL DEFAULT true,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  UNIQUE INDEX `notification_subscriptions_instanceId_eventType_key`(`instanceId`, `eventType`),
  INDEX `notification_subscriptions_eventType_enabled_idx`(`eventType`, `enabled`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `owner_notification_deliveries`
  MODIFY `channel` VARCHAR(32) NOT NULL,
  ADD COLUMN `instanceId` VARCHAR(80) NULL,
  ADD COLUMN `eventType` VARCHAR(64) NULL,
  ADD COLUMN `payload` JSON NULL;

CREATE INDEX `owner_notification_deliveries_instanceId_createdAt_idx`
  ON `owner_notification_deliveries`(`instanceId`, `createdAt`);

ALTER TABLE `notification_subscriptions`
  ADD CONSTRAINT `notification_subscriptions_instanceId_fkey`
  FOREIGN KEY (`instanceId`) REFERENCES `notification_instances`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `owner_notification_deliveries`
  ADD CONSTRAINT `owner_notification_deliveries_instanceId_fkey`
  FOREIGN KEY (`instanceId`) REFERENCES `notification_instances`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
