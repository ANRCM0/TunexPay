CREATE TABLE `bill_collector_states` (
  `id` VARCHAR(80) NOT NULL,
  `binding` CHAR(64) NOT NULL,
  `cursorAt` DATETIME(3) NOT NULL,
  `windowStart` DATETIME(3) NULL,
  `windowEnd` DATETIME(3) NULL,
  `nextPage` INTEGER NOT NULL DEFAULT 1,
  `leaseOwner` VARCHAR(64) NULL,
  `lockedUntil` DATETIME(3) NULL,
  `nextRunAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `heartbeatAt` DATETIME(3) NULL,
  `lastSuccessAt` DATETIME(3) NULL,
  `lastError` VARCHAR(500) NULL,
  `consecutiveErrors` INTEGER NOT NULL DEFAULT 0,
  `processedRecords` INTEGER NOT NULL DEFAULT 0,
  `updatedAt` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
