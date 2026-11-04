CREATE TABLE `schedules` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`cron` text NOT NULL,
	`agent` text NOT NULL,
	`prompt` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`next_run` real,
	`last_run` real,
	`last_task` text,
	`created` real NOT NULL,
	`updated` real NOT NULL
);
--> statement-breakpoint
ALTER TABLE `dev_tasks` ADD `notify` integer DEFAULT false NOT NULL;