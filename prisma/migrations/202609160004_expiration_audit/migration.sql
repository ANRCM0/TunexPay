-- AlterTable
ALTER TABLE `orders`
    ADD COLUMN `expirationAttempts` SMALLINT UNSIGNED NOT NULL DEFAULT 0,
    ADD COLUMN `expirationNextAttemptAt` DATETIME(3) NULL,
    ADD COLUMN `expirationLockedUntil` DATETIME(3) NULL,
    ADD COLUMN `expirationError` VARCHAR(500) NULL;

UPDATE `orders`
SET `expirationNextAttemptAt` = `expiresAt`
WHERE `status` IN ('CREATED', 'PENDING') AND `expiresAt` IS NOT NULL;

CREATE INDEX `orders_status_expirationNextAttemptAt_id_idx`
ON `orders`(`status`, `expirationNextAttemptAt`, `id`);

-- CreateTable
CREATE TABLE `admin_audit_logs` (
    `id` VARCHAR(191) NOT NULL,
    `actor` VARCHAR(80) NOT NULL DEFAULT 'admin-token',
    `action` VARCHAR(80) NOT NULL,
    `resourceType` VARCHAR(40) NULL,
    `resourceId` VARCHAR(191) NULL,
    `method` VARCHAR(12) NOT NULL,
    `path` VARCHAR(255) NOT NULL,
    `requestId` VARCHAR(64) NULL,
    `ipAddress` VARCHAR(64) NULL,
    `userAgent` VARCHAR(500) NULL,
    `success` BOOLEAN NOT NULL,
    `statusCode` SMALLINT UNSIGNED NOT NULL,
    `errorCode` VARCHAR(80) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `admin_audit_logs_createdAt_id_idx`(`createdAt`, `id`),
    INDEX `admin_audit_logs_action_createdAt_idx`(`action`, `createdAt`),
    INDEX `admin_audit_logs_resourceType_resourceId_createdAt_idx`(`resourceType`, `resourceId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
