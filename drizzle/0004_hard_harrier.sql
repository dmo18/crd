CREATE TABLE `alert_state` (
	`key` text PRIMARY KEY NOT NULL,
	`last_sent_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `audit_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`event` text NOT NULL,
	`ip` text NOT NULL,
	`device_id` text,
	`outcome` text NOT NULL,
	`detail` text
);
--> statement-breakpoint
CREATE INDEX `audit_events_at_idx` ON `audit_events` (`at`);--> statement-breakpoint
CREATE INDEX `audit_events_event_idx` ON `audit_events` (`event`,`at`);