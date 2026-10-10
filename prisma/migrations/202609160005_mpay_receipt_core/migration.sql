-- Expand payment provider enums.
ALTER TABLE `applications` MODIFY `defaultChannel` ENUM('ALIPAY', 'ALIPAY_BILL', 'MOCK') NOT NULL DEFAULT 'MOCK';
ALTER TABLE `payments` MODIFY `channel` ENUM('ALIPAY', 'ALIPAY_BILL', 'MOCK') NOT NULL;
ALTER TABLE `channel_callbacks` MODIFY `channel` ENUM('ALIPAY', 'ALIPAY_BILL', 'MOCK') NOT NULL;
ALTER TABLE `receipts` MODIFY `provider` ENUM('ALIPAY', 'ALIPAY_BILL', 'MOCK') NOT NULL;
ALTER TABLE `reconciliation_runs` MODIFY `provider` ENUM('ALIPAY', 'ALIPAY_BILL', 'MOCK') NOT NULL;
ALTER TABLE `receipts` MODIFY `matchStatus` ENUM('UNMATCHED', 'PROCESSING', 'MATCHED', 'MISMATCH', 'IGNORED') NOT NULL DEFAULT 'UNMATCHED';

-- Payment keeps business amount immutable and stores receipt-channel values separately.
ALTER TABLE `payments`
    ADD COLUMN `channelAmount` INTEGER UNSIGNED NULL AFTER `amount`,
    ADD COLUMN `receivedAmount` INTEGER UNSIGNED NULL AFTER `channelAmount`,
    ADD COLUMN `receiptMatchMode` ENUM('DIRECT', 'REMARK', 'AMOUNT') NULL AFTER `channelOrderNo`,
    ADD COLUMN `receiptMatchReference` VARCHAR(64) NULL AFTER `receiptMatchMode`,
    ADD COLUMN `receiptValidFrom` DATETIME(3) NULL AFTER `receiptMatchReference`,
    ADD COLUMN `receiptValidUntil` DATETIME(3) NULL AFTER `receiptValidFrom`;

UPDATE `payments` SET `channelAmount` = `amount` WHERE `channelAmount` IS NULL;
ALTER TABLE `payments` MODIFY `channelAmount` INTEGER UNSIGNED NOT NULL;
CREATE INDEX `payments_channel_receiptMatchReference_idx` ON `payments`(`channel`, `receiptMatchReference`);
CREATE INDEX `payments_channel_channelAmount_receiptValidUntil_idx` ON `payments`(`channel`, `channelAmount`, `receiptValidUntil`);

ALTER TABLE `receipts`
    ADD COLUMN `accountKey` VARCHAR(80) NULL AFTER `mismatchReason`,
    ADD COLUMN `remark` VARCHAR(300) NULL AFTER `accountKey`,
    ADD COLUMN `matchMode` ENUM('DIRECT', 'REMARK', 'AMOUNT') NULL AFTER `remark`,
    ADD COLUMN `lockedUntil` DATETIME(3) NULL AFTER `matchMode`;
CREATE INDEX `receipts_provider_matchStatus_lockedUntil_idx` ON `receipts`(`provider`, `matchStatus`, `lockedUntil`);

CREATE TABLE `receipt_accounts` (
    `id` VARCHAR(80) NOT NULL,
    `name` VARCHAR(120) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

INSERT INTO `receipt_accounts` (`id`, `name`, `updatedAt`)
VALUES ('alipay-bill-default', '支付宝账单收款默认账号', CURRENT_TIMESTAMP(3));

CREATE TABLE `receipt_match_reservations` (
    `id` VARCHAR(191) NOT NULL,
    `accountId` VARCHAR(80) NOT NULL,
    `mode` ENUM('DIRECT', 'REMARK', 'AMOUNT') NOT NULL,
    `value` VARCHAR(64) NOT NULL,
    `paymentId` VARCHAR(191) NOT NULL,
    `expiresAt` DATETIME(3) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    UNIQUE INDEX `receipt_match_reservations_paymentId_key`(`paymentId`),
    UNIQUE INDEX `receipt_match_reservations_accountId_mode_value_key`(`accountId`, `mode`, `value`),
    INDEX `receipt_match_reservations_accountId_expiresAt_idx`(`accountId`, `expiresAt`),
    PRIMARY KEY (`id`),
    CONSTRAINT `receipt_match_reservations_accountId_fkey` FOREIGN KEY (`accountId`) REFERENCES `receipt_accounts`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT `receipt_match_reservations_paymentId_fkey` FOREIGN KEY (`paymentId`) REFERENCES `payments`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `payment_exceptions` (
    `id` VARCHAR(191) NOT NULL,
    `exceptionNo` VARCHAR(40) NOT NULL,
    `type` ENUM('LATE_DUPLICATE', 'RECEIPT_AMBIGUOUS', 'PAYMENT_STATE_CONFLICT') NOT NULL,
    `status` ENUM('OPEN', 'PROCESSING', 'RESOLVED', 'IGNORED') NOT NULL DEFAULT 'OPEN',
    `severity` ENUM('MEDIUM', 'HIGH', 'CRITICAL') NOT NULL,
    `subjectType` VARCHAR(24) NOT NULL,
    `subjectId` VARCHAR(191) NOT NULL,
    `orderId` VARCHAR(191) NULL,
    `paymentId` VARCHAR(191) NULL,
    `source` VARCHAR(32) NOT NULL,
    `summary` VARCHAR(300) NOT NULL,
    `detail` JSON NULL,
    `resolution` VARCHAR(500) NULL,
    `resolutionRef` VARCHAR(80) NULL,
    `detectedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `resolvedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    UNIQUE INDEX `payment_exceptions_exceptionNo_key`(`exceptionNo`),
    UNIQUE INDEX `payment_exceptions_subjectType_subjectId_type_key`(`subjectType`, `subjectId`, `type`),
    INDEX `payment_exceptions_status_severity_detectedAt_idx`(`status`, `severity`, `detectedAt`),
    INDEX `payment_exceptions_orderId_createdAt_idx`(`orderId`, `createdAt`),
    INDEX `payment_exceptions_paymentId_createdAt_idx`(`paymentId`, `createdAt`),
    PRIMARY KEY (`id`),
    CONSTRAINT `payment_exceptions_orderId_fkey` FOREIGN KEY (`orderId`) REFERENCES `orders`(`id`) ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT `payment_exceptions_paymentId_fkey` FOREIGN KEY (`paymentId`) REFERENCES `payments`(`id`) ON DELETE SET NULL ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
