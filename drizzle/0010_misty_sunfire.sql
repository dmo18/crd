ALTER TABLE `scans` ADD `batch_key` text;--> statement-breakpoint
CREATE INDEX `scans_batch_key_idx` ON `scans` (`batch_key`);