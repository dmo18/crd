CREATE TABLE `bulk_ops` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`action` text NOT NULL,
	`summary` text NOT NULL,
	`item_count` integer NOT NULL,
	`undo` text NOT NULL,
	`undone_at` integer
);
--> statement-breakpoint
CREATE INDEX `bulk_ops_at_idx` ON `bulk_ops` (`at`);--> statement-breakpoint
ALTER TABLE `items` ADD `deleted_at` integer;--> statement-breakpoint
CREATE INDEX `items_deleted_idx` ON `items` (`deleted_at`);