-- AlterTable
ALTER TABLE `payments`
    ADD COLUMN `queryAttempts` SMALLINT UNSIGNED NOT NULL DEFAULT 0,
    ADD COLUMN `nextQueryAt` DATETIME(3) NULL,
    ADD COLUMN `lastQueriedAt` DATETIME(3) NULL;

-- AlterTable
ALTER TABLE `refunds`
    ADD COLUMN `queryAttempts` SMALLINT UNSIGNED NOT NULL DEFAULT 0,
    ADD COLUMN `nextQueryAt` DATETIME(3) NULL,
    ADD COLUMN `lastQueriedAt` DATETIME(3) NULL;

-- Backfill recoverable records created before this migration.
UPDATE `payments`
SET `nextQueryAt` = DATE_ADD(CURRENT_TIMESTAMP(3), INTERVAL 15 SECOND)
WHERE `channel` = 'ALIPAY' AND `status` IN ('PROCESSING', 'UNKNOWN');

UPDATE `refunds` AS `r`
INNER JOIN `payments` AS `p` ON `p`.`id` = `r`.`paymentId`
SET `r`.`nextQueryAt` = DATE_ADD(CURRENT_TIMESTAMP(3), INTERVAL 15 SECOND)
WHERE `p`.`channel` = 'ALIPAY' AND `r`.`status` IN ('PROCESSING', 'UNKNOWN');

-- CreateIndex
CREATE INDEX `payments_status_nextQueryAt_id_idx` ON `payments`(`status`, `nextQueryAt`, `id`);
CREATE INDEX `refunds_status_nextQueryAt_id_idx` ON `refunds`(`status`, `nextQueryAt`, `id`);
