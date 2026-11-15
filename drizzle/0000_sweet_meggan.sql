CREATE TABLE `collection_snapshots` (
	`day` text PRIMARY KEY NOT NULL,
	`total_value_cents` integer NOT NULL,
	`item_count` integer NOT NULL,
	`unit_count` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `images` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`item_id` integer,
	`scan_id` integer,
	`role` text NOT NULL,
	`file` text NOT NULL,
	`thumb_file` text NOT NULL,
	`width` integer NOT NULL,
	`height` integer NOT NULL,
	`bytes` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`scan_id`) REFERENCES `scans`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `images_file_unique` ON `images` (`file`);--> statement-breakpoint
CREATE INDEX `images_item_idx` ON `images` (`item_id`);--> statement-breakpoint
CREATE INDEX `images_scan_idx` ON `images` (`scan_id`);--> statement-breakpoint
CREATE TABLE `items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`status` text DEFAULT 'needs_review' NOT NULL,
	`scan_id` integer,
	`title` text NOT NULL,
	`sport` text,
	`year` integer,
	`year_end` integer,
	`brand` text,
	`set_name` text,
	`card_number` text,
	`player` text,
	`team` text,
	`variation` text,
	`is_rookie` integer DEFAULT false NOT NULL,
	`is_error` integer DEFAULT false NOT NULL,
	`is_parallel` integer DEFAULT false NOT NULL,
	`is_insert` integer DEFAULT false NOT NULL,
	`is_autograph` integer DEFAULT false NOT NULL,
	`is_memorabilia` integer DEFAULT false NOT NULL,
	`serial_number` text,
	`rarity_tier` text,
	`rarity_notes` text,
	`condition` text,
	`condition_notes` text,
	`grader` text,
	`grade` text,
	`cert_number` text,
	`worth_grading` integer,
	`grading_notes` text,
	`product_type` text,
	`pack_count` integer,
	`seal_state` text,
	`est_count` integer,
	`container_type` text,
	`description` text,
	`pull_list` text,
	`quantity` integer DEFAULT 1 NOT NULL,
	`location_id` integer,
	`notes` text,
	`confidence` real,
	`ai_notes` text,
	`est_low_cents` integer,
	`est_high_cents` integer,
	`est_value_cents` integer,
	`value_source` text,
	`value_basis` text,
	`valued_at` integer,
	`manual_value_cents` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`scan_id`) REFERENCES `scans`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`location_id`) REFERENCES `locations`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `items_kind_idx` ON `items` (`kind`);--> statement-breakpoint
CREATE INDEX `items_status_idx` ON `items` (`status`);--> statement-breakpoint
CREATE INDEX `items_player_idx` ON `items` (`player`);--> statement-breakpoint
CREATE INDEX `items_year_idx` ON `items` (`year`);--> statement-breakpoint
CREATE INDEX `items_scan_idx` ON `items` (`scan_id`);--> statement-breakpoint
CREATE INDEX `items_location_idx` ON `items` (`location_id`);--> statement-breakpoint
CREATE TABLE `locations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`kind` text,
	`notes` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `locations_name_unique` ON `locations` (`name`);--> statement-breakpoint
CREATE TABLE `login_attempts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ip` text NOT NULL,
	`success` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `login_attempts_ip_idx` ON `login_attempts` (`ip`,`created_at`);--> statement-breakpoint
CREATE TABLE `scans` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`mode` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`hint` text,
	`location_id` integer,
	`error` text,
	`item_count` integer DEFAULT 0 NOT NULL,
	`recognizer` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`finished_at` integer,
	FOREIGN KEY (`location_id`) REFERENCES `locations`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `scans_status_idx` ON `scans` (`status`);--> statement-breakpoint
CREATE TABLE `valuations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`item_id` integer NOT NULL,
	`source` text NOT NULL,
	`low_cents` integer,
	`high_cents` integer,
	`value_cents` integer NOT NULL,
	`basis` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `valuations_item_idx` ON `valuations` (`item_id`);