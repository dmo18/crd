CREATE TABLE `auth_state` (
	`id` integer PRIMARY KEY NOT NULL,
	`env_session_version` integer DEFAULT 0 NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	CONSTRAINT "auth_state_single_row" CHECK(id = 1)
);
--> statement-breakpoint
ALTER TABLE `login_attempts` ADD `net` text;--> statement-breakpoint
ALTER TABLE `login_attempts` ADD `device_id` text;--> statement-breakpoint
CREATE INDEX `login_attempts_device_idx` ON `login_attempts` (`device_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `scans` ADD `started_at` integer;--> statement-breakpoint
-- Names that differ only in capital letters get their number added, so the new index can be created.
UPDATE `locations` SET `name` = substr(`name`, 1, 48) || ' (' || `id` || ')' WHERE `id` NOT IN (SELECT min(`id`) FROM `locations` GROUP BY lower(`name`));--> statement-breakpoint
CREATE UNIQUE INDEX `locations_name_lower_unique` ON `locations` (lower("name"));