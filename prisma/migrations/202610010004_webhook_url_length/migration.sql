-- Keep the complete (orderId, eventType, url) unique key and the public 500-character URL contract.
-- eventType is an internal ASCII event name: payment.succeeded or refund.succeeded:<refundNo>.
-- With utf8mb4 everywhere, 191*4 + 80*4 + 500*4 = 3084 exceeds InnoDB's 3072-byte limit.
-- ASCII eventType reduces the full-key budget to 191*4 + 80 + 500*4 = 2844 bytes.
-- Strict mode makes non-ASCII historical event names fail rather than silently replacing data.
-- Inspect historical data and take a backup before deploying; no rows or columns are deleted.
SET @tunexpay_previous_sql_mode = @@SESSION.sql_mode;
SET SESSION sql_mode = CONCAT_WS(',', NULLIF(@tunexpay_previous_sql_mode, ''), 'STRICT_ALL_TABLES');

ALTER TABLE `webhook_deliveries`
    MODIFY `eventType` VARCHAR(80) CHARACTER SET ascii COLLATE ascii_general_ci NOT NULL,
    MODIFY `url` VARCHAR(500) NOT NULL;

SET SESSION sql_mode = @tunexpay_previous_sql_mode;
