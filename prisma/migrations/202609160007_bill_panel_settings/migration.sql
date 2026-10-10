CREATE TABLE `bill_channel_settings` (
  `id` VARCHAR(80) NOT NULL,
  `revision` INTEGER NOT NULL DEFAULT 1,
  `payloadEncrypted` LONGTEXT NOT NULL,
  `updatedAt` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
