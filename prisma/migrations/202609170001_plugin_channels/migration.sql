ALTER TABLE `applications` ADD COLUMN `defaultChannelId` VARCHAR(80) NULL;
ALTER TABLE `payments` ADD COLUMN `channelId` VARCHAR(80) NULL;
CREATE INDEX `payments_channelId_status_idx` ON `payments` (`channelId`, `status`);
CREATE TABLE `channel_instances` (
  `id` VARCHAR(80) NOT NULL,
  `plugin` ENUM('ALIPAY', 'ALIPAY_BILL', 'MOCK') NOT NULL,
  `name` VARCHAR(120) NOT NULL,
  `enabled` BOOLEAN NOT NULL DEFAULT false,
  `revision` INTEGER NOT NULL DEFAULT 1,
  `payloadEncrypted` LONGTEXT NOT NULL,
  `checkStatus` VARCHAR(32) NOT NULL DEFAULT 'UNCHECKED',
  `checkMessage` VARCHAR(500) NULL,
  `checkedAt` DATETIME(3) NULL,
  `checkRevision` INTEGER NULL,
  `checkLease` VARCHAR(40) NULL,
  `checkLockedUntil` DATETIME(3) NULL,
  `testPaymentNo` VARCHAR(40) NULL,
  `testRevision` INTEGER NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  INDEX `channel_instances_plugin_createdAt_idx` (`plugin`, `createdAt`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
