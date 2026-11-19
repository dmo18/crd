ALTER TABLE `scans` ADD `client_key` text;--> statement-breakpoint
CREATE UNIQUE INDEX `scans_client_key_uq` ON `scans` (`client_key`);