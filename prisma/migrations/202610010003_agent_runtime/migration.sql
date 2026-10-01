CREATE TABLE `agent_settings` (
  `id` VARCHAR(40) NOT NULL,
  `revision` INTEGER NOT NULL DEFAULT 1,
  `enabled` BOOLEAN NOT NULL DEFAULT false,
  `payloadEncrypted` LONGTEXT NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `agent_inbox` (
  `id` VARCHAR(191) NOT NULL,
  `provider` VARCHAR(16) NOT NULL,
  `eventId` VARCHAR(160) NOT NULL,
  `instanceId` VARCHAR(80) NOT NULL,
  `conversationKey` VARCHAR(255) NOT NULL,
  `chatId` VARCHAR(200) NOT NULL,
  `senderId` VARCHAR(200) NOT NULL,
  `text` TEXT NOT NULL,
  `status` VARCHAR(16) NOT NULL DEFAULT 'PENDING',
  `attempts` INTEGER NOT NULL DEFAULT 0,
  `nextAttemptAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `lockedUntil` DATETIME(3) NULL,
  `lastError` VARCHAR(500) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  UNIQUE INDEX `agent_inbox_provider_instanceId_eventId_key`(`provider`,`instanceId`,`eventId`),
  INDEX `agent_inbox_status_nextAttemptAt_idx`(`status`,`nextAttemptAt`),
  INDEX `agent_inbox_conversationKey_createdAt_idx`(`conversationKey`,`createdAt`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `agent_messages` (
  `id` VARCHAR(191) NOT NULL,
  `conversationKey` VARCHAR(255) NOT NULL,
  `role` VARCHAR(16) NOT NULL,
  `content` TEXT NOT NULL,
  `actor` VARCHAR(200) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX `agent_messages_conversationKey_createdAt_idx`(`conversationKey`,`createdAt`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
