CREATE TABLE `results` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`action_kind` text NOT NULL,
	`action_id` text,
	`route_id` integer,
	`outcome` text NOT NULL,
	`effect` text NOT NULL,
	`ref` text,
	`detail` text,
	`at` real NOT NULL
);
--> statement-breakpoint
CREATE INDEX `results_action` ON `results` (`action_kind`,`action_id`);--> statement-breakpoint
CREATE INDEX `results_at` ON `results` (`at`);--> statement-breakpoint
CREATE TABLE `routes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`triggers` text NOT NULL,
	`agent` text,
	`rule` text NOT NULL,
	`session` text,
	`action_kind` text NOT NULL,
	`action_id` text,
	`at` real NOT NULL
);
--> statement-breakpoint
CREATE INDEX `routes_action` ON `routes` (`action_kind`,`action_id`);--> statement-breakpoint
CREATE TABLE `triggers` (
	`id` text PRIMARY KEY NOT NULL,
	`channel` text NOT NULL,
	`thread` text NOT NULL,
	`actor_id` text DEFAULT '' NOT NULL,
	`actor_name` text DEFAULT '' NOT NULL,
	`owner` integer DEFAULT false NOT NULL,
	`text` text DEFAULT '' NOT NULL,
	`url` text,
	`refs` text DEFAULT '[]' NOT NULL,
	`at` real NOT NULL,
	`status` text NOT NULL,
	`route_id` integer
);
--> statement-breakpoint
CREATE INDEX `triggers_at` ON `triggers` (`at`);--> statement-breakpoint
CREATE INDEX `triggers_thread` ON `triggers` (`thread`);--> statement-breakpoint
ALTER TABLE `dev_tasks` ADD `route_id` integer;--> statement-breakpoint
ALTER TABLE `drafts` ADD `route_id` integer;