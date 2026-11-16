CREATE TABLE `catalog_cards` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`canonical_key` text NOT NULL,
	`sport` text NOT NULL,
	`year` integer NOT NULL,
	`brand` text NOT NULL,
	`set_name` text,
	`card_number` text,
	`player` text NOT NULL,
	`team` text,
	`variation` text,
	`verified` integer DEFAULT false NOT NULL,
	`field_sources` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `catalog_cards_canonical_key_unique` ON `catalog_cards` (`canonical_key`);--> statement-breakpoint
CREATE TABLE `catalog_sources` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`catalog_card_id` integer NOT NULL,
	`source` text NOT NULL,
	`source_id` text NOT NULL,
	`url` text,
	`source_set_id` text,
	`fetched_at` integer NOT NULL,
	FOREIGN KEY (`catalog_card_id`) REFERENCES `catalog_cards`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `catalog_sources_source_id_uq` ON `catalog_sources` (`source`,`source_id`);--> statement-breakpoint
CREATE INDEX `catalog_sources_card_idx` ON `catalog_sources` (`catalog_card_id`);--> statement-breakpoint
CREATE TABLE `connection_keys` (
	`source` text PRIMARY KEY NOT NULL,
	`ciphertext` text NOT NULL,
	`iv` text NOT NULL,
	`auth_tag` text NOT NULL,
	`last4` text NOT NULL,
	`saved_at` integer NOT NULL,
	`last_test_at` integer,
	`last_test_result` text
);
--> statement-breakpoint
CREATE TABLE `outside_cache` (
	`key` text PRIMARY KEY NOT NULL,
	`source` text NOT NULL,
	`kind` text NOT NULL,
	`body` text NOT NULL,
	`fetched_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`bytes` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `outside_cache_source_idx` ON `outside_cache` (`source`);--> statement-breakpoint
CREATE INDEX `outside_cache_expires_idx` ON `outside_cache` (`expires_at`);--> statement-breakpoint
CREATE INDEX `outside_cache_fetched_idx` ON `outside_cache` (`fetched_at`);--> statement-breakpoint
CREATE TABLE `outside_state` (
	`source` text PRIMARY KEY NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`paused_until` integer,
	`last_ok_at` integer,
	`last_error` text,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `outside_usage` (
	`source` text NOT NULL,
	`day` text NOT NULL,
	`calls` integer DEFAULT 0 NOT NULL,
	`store_hits` integer DEFAULT 0 NOT NULL,
	`errors` integer DEFAULT 0 NOT NULL,
	`slow_downs` integer DEFAULT 0 NOT NULL,
	`skipped` integer DEFAULT 0 NOT NULL,
	`wait_ms` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`source`, `day`)
);
--> statement-breakpoint
ALTER TABLE `items` ADD `catalog_card_id` integer REFERENCES `catalog_cards`(`id`) ON UPDATE no action ON DELETE set null;--> statement-breakpoint
ALTER TABLE `items` ADD `first_suggestion` text;--> statement-breakpoint
ALTER TABLE `items` ADD `field_sources` text;--> statement-breakpoint
ALTER TABLE `items` ADD `catalog_candidates` text;--> statement-breakpoint
CREATE INDEX `items_catalog_card_idx` ON `items` (`catalog_card_id`);