CREATE TABLE `mcp_clients` (
  `id` VARCHAR(64) NOT NULL,
  `name` VARCHAR(120) NOT NULL,
  `tokenHash` CHAR(64) NOT NULL,
  `tokenPrefix` VARCHAR(20) NOT NULL,
  `scope` VARCHAR(16) NOT NULL DEFAULT 'READ',
  `allowedTools` JSON NOT NULL,
  `enabled` BOOLEAN NOT NULL DEFAULT true,
  `revision` INTEGER NOT NULL DEFAULT 1,
  `expiresAt` DATETIME(3) NULL,
  `lastUsedAt` DATETIME(3) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  UNIQUE INDEX `mcp_clients_tokenHash_key`(`tokenHash`),
  INDEX `mcp_clients_enabled_expiresAt_idx`(`enabled`, `expiresAt`),
  INDEX `mcp_clients_createdAt_idx`(`createdAt`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `mcp_audit_logs` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `clientId` VARCHAR(64) NULL,
  `clientName` VARCHAR(120) NOT NULL,
  `scope` VARCHAR(16) NOT NULL,
  `tool` VARCHAR(100) NOT NULL,
  `argumentsSummary` JSON NULL,
  `success` BOOLEAN NOT NULL,
  `durationMs` INTEGER UNSIGNED NOT NULL,
  `errorCode` VARCHAR(80) NULL,
  `requestId` VARCHAR(64) NULL,
  `ipAddress` VARCHAR(64) NULL,
  `userAgent` VARCHAR(500) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX `mcp_audit_logs_clientId_createdAt_idx`(`clientId`, `createdAt`),
  INDEX `mcp_audit_logs_tool_createdAt_idx`(`tool`, `createdAt`),
  INDEX `mcp_audit_logs_success_createdAt_idx`(`success`, `createdAt`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `mcp_audit_logs`
  ADD CONSTRAINT `mcp_audit_logs_clientId_fkey`
  FOREIGN KEY (`clientId`) REFERENCES `mcp_clients`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
