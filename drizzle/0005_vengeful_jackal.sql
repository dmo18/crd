ALTER TABLE `images` ADD `work_file` text;--> statement-breakpoint
ALTER TABLE `images` ADD `thumb_bytes` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX `images_work_idx` ON `images` (`work_file`);