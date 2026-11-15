CREATE TABLE `owner_settings` (
	`id` integer PRIMARY KEY NOT NULL,
	`password_hash` text NOT NULL,
	`session_version` integer DEFAULT 1 NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	CONSTRAINT "owner_settings_single_row" CHECK(id = 1)
);
--> statement-breakpoint
ALTER TABLE `login_attempts` ADD `kind` text DEFAULT 'login' NOT NULL;