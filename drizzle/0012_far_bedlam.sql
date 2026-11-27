CREATE TABLE `card_sets` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`key` text NOT NULL,
	`sport` text,
	`year` integer NOT NULL,
	`brand` text,
	`set_name` text,
	`source_set_id` text,
	`checklist_at` integer,
	`checklist_complete` integer,
	`checklist_total` integer,
	`not_in_catalog_at` integer,
	`last_stop` text,
	`last_try_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `card_sets_key_unique` ON `card_sets` (`key`);--> statement-breakpoint
CREATE TABLE `checklist_entries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`set_id` integer NOT NULL,
	`position` integer NOT NULL,
	`card_number` text,
	`number_key` text,
	`player` text,
	`team` text,
	`source_id` text,
	`url` text,
	FOREIGN KEY (`set_id`) REFERENCES `card_sets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `checklist_entries_set_idx` ON `checklist_entries` (`set_id`,`number_key`);--> statement-breakpoint
CREATE TABLE `wanted_cards` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`set_id` integer NOT NULL,
	`number_key` text NOT NULL,
	`card_number` text,
	`player` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`set_id`) REFERENCES `card_sets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `wanted_cards_set_number_uq` ON `wanted_cards` (`set_id`,`number_key`);