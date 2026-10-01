CREATE TABLE `routing_groups` (
    `id` VARCHAR(80) NOT NULL,
    `name` VARCHAR(120) NOT NULL,
    `strategy` ENUM('RANDOM', 'WEIGHTED_RANDOM') NOT NULL DEFAULT 'RANDOM',
    `enabled` BOOLEAN NOT NULL DEFAULT true,
    `revision` INTEGER NOT NULL DEFAULT 1,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    INDEX `routing_groups_enabled_createdAt_idx` (`enabled`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `routing_group_members` (
    `groupId` VARCHAR(80) NOT NULL,
    `channelId` VARCHAR(80) NOT NULL,
    `weight` INTEGER UNSIGNED NOT NULL DEFAULT 1,
    `enabled` BOOLEAN NOT NULL DEFAULT true,
    INDEX `routing_group_members_channelId_idx` (`channelId`),
    PRIMARY KEY (`groupId`, `channelId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `applications` ADD COLUMN `routingGroupId` VARCHAR(80) NULL;
CREATE INDEX `applications_routingGroupId_idx` ON `applications` (`routingGroupId`);
ALTER TABLE `payments` ADD COLUMN `routingGroupId` VARCHAR(80) NULL;
CREATE INDEX `payments_routingGroupId_createdAt_idx` ON `payments` (`routingGroupId`, `createdAt`);

ALTER TABLE `applications` ADD CONSTRAINT `applications_routingGroupId_fkey`
    FOREIGN KEY (`routingGroupId`) REFERENCES `routing_groups` (`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `routing_group_members` ADD CONSTRAINT `routing_group_members_groupId_fkey`
    FOREIGN KEY (`groupId`) REFERENCES `routing_groups` (`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `routing_group_members` ADD CONSTRAINT `routing_group_members_channelId_fkey`
    FOREIGN KEY (`channelId`) REFERENCES `channel_instances` (`id`) ON DELETE CASCADE ON UPDATE CASCADE;
