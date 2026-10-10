-- CreateTable
CREATE TABLE `receipts` (
    `id` VARCHAR(191) NOT NULL,
    `provider` ENUM('ALIPAY', 'MOCK') NOT NULL,
    `statementDate` DATE NOT NULL,
    `direction` ENUM('INCOME', 'REFUND') NOT NULL,
    `providerTradeNo` VARCHAR(100) NULL,
    `merchantOrderNo` VARCHAR(80) NULL,
    `providerRefundNo` VARCHAR(100) NULL,
    `merchantRefundNo` VARCHAR(80) NULL,
    `amount` INTEGER UNSIGNED NOT NULL,
    `currency` CHAR(3) NOT NULL DEFAULT 'CNY',
    `occurredAt` DATETIME(3) NOT NULL,
    `fingerprint` CHAR(64) NOT NULL,
    `matchStatus` ENUM('UNMATCHED', 'MATCHED', 'MISMATCH', 'IGNORED') NOT NULL DEFAULT 'UNMATCHED',
    `mismatchReason` VARCHAR(500) NULL,
    `rawPayload` JSON NOT NULL,
    `paymentId` VARCHAR(191) NULL,
    `refundId` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `receipts_fingerprint_key`(`fingerprint`),
    INDEX `receipts_provider_statementDate_id_idx`(`provider`, `statementDate`, `id`),
    INDEX `receipts_matchStatus_occurredAt_id_idx`(`matchStatus`, `occurredAt`, `id`),
    INDEX `receipts_paymentId_id_idx`(`paymentId`, `id`),
    INDEX `receipts_refundId_id_idx`(`refundId`, `id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `reconciliation_runs` (
    `id` VARCHAR(191) NOT NULL,
    `provider` ENUM('ALIPAY', 'MOCK') NOT NULL,
    `statementDate` DATE NOT NULL,
    `status` ENUM('PROCESSING', 'SUCCESS', 'FAILED') NOT NULL DEFAULT 'PROCESSING',
    `fileName` VARCHAR(255) NULL,
    `importedCount` INTEGER UNSIGNED NOT NULL DEFAULT 0,
    `duplicateCount` INTEGER UNSIGNED NOT NULL DEFAULT 0,
    `matchedCount` INTEGER UNSIGNED NOT NULL DEFAULT 0,
    `mismatchedCount` INTEGER UNSIGNED NOT NULL DEFAULT 0,
    `unmatchedCount` INTEGER UNSIGNED NOT NULL DEFAULT 0,
    `skippedCount` INTEGER UNSIGNED NOT NULL DEFAULT 0,
    `errorMessage` VARCHAR(500) NULL,
    `startedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `completedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `reconciliation_runs_provider_statementDate_key`(`provider`, `statementDate`),
    INDEX `reconciliation_runs_status_statementDate_idx`(`status`, `statementDate`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `receipts` ADD CONSTRAINT `receipts_paymentId_fkey` FOREIGN KEY (`paymentId`) REFERENCES `payments`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `receipts` ADD CONSTRAINT `receipts_refundId_fkey` FOREIGN KEY (`refundId`) REFERENCES `refunds`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
