-- CreateTable
CREATE TABLE `applications` (
    `id` VARCHAR(191) NOT NULL,
    `appId` VARCHAR(40) NOT NULL,
    `name` VARCHAR(120) NOT NULL,
    `status` ENUM('ACTIVE', 'DISABLED') NOT NULL DEFAULT 'ACTIVE',
    `apiKeyHash` CHAR(64) NOT NULL,
    `webhookUrl` VARCHAR(500) NULL,
    `webhookSecretEncrypted` TEXT NOT NULL,
    `epayPid` VARCHAR(32) NOT NULL,
    `epayKeyEncrypted` TEXT NOT NULL,
    `defaultChannel` ENUM('ALIPAY', 'MOCK') NOT NULL DEFAULT 'MOCK',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `applications_appId_key`(`appId`),
    UNIQUE INDEX `applications_epayPid_key`(`epayPid`),
    INDEX `applications_status_createdAt_idx`(`status`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `orders` (
    `id` VARCHAR(191) NOT NULL,
    `orderNo` VARCHAR(40) NOT NULL,
    `externalOrderNo` VARCHAR(80) NOT NULL,
    `applicationId` VARCHAR(191) NOT NULL,
    `amount` INTEGER UNSIGNED NOT NULL,
    `currency` CHAR(3) NOT NULL DEFAULT 'CNY',
    `subject` VARCHAR(160) NOT NULL,
    `description` VARCHAR(500) NULL,
    `metadata` JSON NULL,
    `protocol` ENUM('NATIVE_V1', 'EPAY_V1') NOT NULL DEFAULT 'NATIVE_V1',
    `notifyUrl` VARCHAR(500) NULL,
    `returnUrl` VARCHAR(500) NULL,
    `status` ENUM('CREATED', 'PENDING', 'SUCCESS', 'CLOSED', 'PARTIALLY_REFUNDED', 'REFUNDED') NOT NULL DEFAULT 'CREATED',
    `idempotencyKey` VARCHAR(120) NULL,
    `requestHash` CHAR(64) NOT NULL,
    `winningPaymentId` VARCHAR(32) NULL,
    `expiresAt` DATETIME(3) NULL,
    `paidAt` DATETIME(3) NULL,
    `closedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `orders_orderNo_key`(`orderNo`),
    INDEX `orders_applicationId_status_createdAt_idx`(`applicationId`, `status`, `createdAt`),
    INDEX `orders_createdAt_id_idx`(`createdAt`, `id`),
    UNIQUE INDEX `orders_applicationId_externalOrderNo_key`(`applicationId`, `externalOrderNo`),
    UNIQUE INDEX `orders_applicationId_idempotencyKey_key`(`applicationId`, `idempotencyKey`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `payments` (
    `id` VARCHAR(191) NOT NULL,
    `paymentNo` VARCHAR(40) NOT NULL,
    `orderId` VARCHAR(191) NOT NULL,
    `attemptNo` SMALLINT UNSIGNED NOT NULL,
    `idempotencyKey` VARCHAR(120) NULL,
    `channel` ENUM('ALIPAY', 'MOCK') NOT NULL,
    `method` VARCHAR(32) NOT NULL,
    `status` ENUM('CREATED', 'PROCESSING', 'SUCCESS', 'FAILED', 'UNKNOWN', 'CLOSED') NOT NULL DEFAULT 'CREATED',
    `amount` INTEGER UNSIGNED NOT NULL,
    `channelTradeNo` VARCHAR(100) NULL,
    `channelOrderNo` VARCHAR(100) NULL,
    `clientPayload` JSON NULL,
    `rawResponse` JSON NULL,
    `errorCode` VARCHAR(80) NULL,
    `errorMessage` VARCHAR(500) NULL,
    `paidAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `payments_paymentNo_key`(`paymentNo`),
    UNIQUE INDEX `payments_channelTradeNo_key`(`channelTradeNo`),
    INDEX `payments_orderId_status_createdAt_idx`(`orderId`, `status`, `createdAt`),
    INDEX `payments_status_updatedAt_idx`(`status`, `updatedAt`),
    UNIQUE INDEX `payments_orderId_attemptNo_key`(`orderId`, `attemptNo`),
    UNIQUE INDEX `payments_orderId_idempotencyKey_key`(`orderId`, `idempotencyKey`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `refunds` (
    `id` VARCHAR(191) NOT NULL,
    `refundNo` VARCHAR(40) NOT NULL,
    `externalRefundNo` VARCHAR(80) NOT NULL,
    `applicationId` VARCHAR(191) NOT NULL,
    `paymentId` VARCHAR(191) NOT NULL,
    `amount` INTEGER UNSIGNED NOT NULL,
    `reason` VARCHAR(300) NULL,
    `status` ENUM('CREATED', 'PROCESSING', 'SUCCESS', 'FAILED', 'UNKNOWN') NOT NULL DEFAULT 'CREATED',
    `channelRefundNo` VARCHAR(100) NULL,
    `rawResponse` JSON NULL,
    `errorCode` VARCHAR(80) NULL,
    `errorMessage` VARCHAR(500) NULL,
    `succeededAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `refunds_refundNo_key`(`refundNo`),
    INDEX `refunds_paymentId_status_createdAt_idx`(`paymentId`, `status`, `createdAt`),
    INDEX `refunds_applicationId_createdAt_idx`(`applicationId`, `createdAt`),
    UNIQUE INDEX `refunds_applicationId_externalRefundNo_key`(`applicationId`, `externalRefundNo`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `payment_events` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `aggregateType` VARCHAR(24) NOT NULL,
    `aggregateId` VARCHAR(40) NOT NULL,
    `orderId` VARCHAR(191) NULL,
    `paymentId` VARCHAR(191) NULL,
    `type` VARCHAR(64) NOT NULL,
    `source` VARCHAR(32) NOT NULL,
    `requestId` VARCHAR(64) NULL,
    `payload` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `payment_events_aggregateType_aggregateId_id_idx`(`aggregateType`, `aggregateId`, `id`),
    INDEX `payment_events_orderId_id_idx`(`orderId`, `id`),
    INDEX `payment_events_paymentId_id_idx`(`paymentId`, `id`),
    INDEX `payment_events_createdAt_id_idx`(`createdAt`, `id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `channel_callbacks` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `channel` ENUM('ALIPAY', 'MOCK') NOT NULL,
    `eventKey` VARCHAR(160) NOT NULL,
    `paymentNo` VARCHAR(40) NULL,
    `verified` BOOLEAN NOT NULL DEFAULT false,
    `processed` BOOLEAN NOT NULL DEFAULT false,
    `rawPayload` JSON NOT NULL,
    `errorMessage` VARCHAR(500) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `processedAt` DATETIME(3) NULL,

    INDEX `channel_callbacks_paymentNo_createdAt_idx`(`paymentNo`, `createdAt`),
    UNIQUE INDEX `channel_callbacks_channel_eventKey_key`(`channel`, `eventKey`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `webhook_deliveries` (
    `id` VARCHAR(191) NOT NULL,
    `applicationId` VARCHAR(191) NOT NULL,
    `orderId` VARCHAR(191) NOT NULL,
    `eventType` VARCHAR(80) NOT NULL,
    `protocol` ENUM('NATIVE_V1', 'EPAY_V1') NOT NULL,
    `url` VARCHAR(300) NOT NULL,
    `payload` JSON NOT NULL,
    `status` ENUM('PENDING', 'PROCESSING', 'SUCCESS', 'DEAD') NOT NULL DEFAULT 'PENDING',
    `attempts` SMALLINT UNSIGNED NOT NULL DEFAULT 0,
    `maxAttempts` SMALLINT UNSIGNED NOT NULL DEFAULT 8,
    `nextAttemptAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `lockedUntil` DATETIME(3) NULL,
    `lastError` VARCHAR(500) NULL,
    `responseStatus` INTEGER NULL,
    `responseBody` TEXT NULL,
    `deliveredAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `webhook_deliveries_status_nextAttemptAt_id_idx`(`status`, `nextAttemptAt`, `id`),
    INDEX `webhook_deliveries_lockedUntil_status_idx`(`lockedUntil`, `status`),
    INDEX `webhook_deliveries_applicationId_createdAt_idx`(`applicationId`, `createdAt`),
    UNIQUE INDEX `webhook_deliveries_orderId_eventType_url_key`(`orderId`, `eventType`, `url`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `orders` ADD CONSTRAINT `orders_applicationId_fkey` FOREIGN KEY (`applicationId`) REFERENCES `applications`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payments` ADD CONSTRAINT `payments_orderId_fkey` FOREIGN KEY (`orderId`) REFERENCES `orders`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `refunds` ADD CONSTRAINT `refunds_applicationId_fkey` FOREIGN KEY (`applicationId`) REFERENCES `applications`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `refunds` ADD CONSTRAINT `refunds_paymentId_fkey` FOREIGN KEY (`paymentId`) REFERENCES `payments`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payment_events` ADD CONSTRAINT `payment_events_orderId_fkey` FOREIGN KEY (`orderId`) REFERENCES `orders`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payment_events` ADD CONSTRAINT `payment_events_paymentId_fkey` FOREIGN KEY (`paymentId`) REFERENCES `payments`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `webhook_deliveries` ADD CONSTRAINT `webhook_deliveries_applicationId_fkey` FOREIGN KEY (`applicationId`) REFERENCES `applications`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `webhook_deliveries` ADD CONSTRAINT `webhook_deliveries_orderId_fkey` FOREIGN KEY (`orderId`) REFERENCES `orders`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
