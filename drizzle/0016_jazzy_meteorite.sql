CREATE TABLE `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`source` text NOT NULL,
	`thread` text NOT NULL,
	`refs` text DEFAULT '[]' NOT NULL,
	`status` text NOT NULL,
	`need` text,
	`created` real NOT NULL,
	`updated` real NOT NULL,
	`closed` real
);
--> statement-breakpoint
CREATE INDEX `tasks_thread` ON `tasks` (`thread`);--> statement-breakpoint
CREATE INDEX `tasks_updated` ON `tasks` (`updated`);--> statement-breakpoint
ALTER TABLE `routes` ADD `task_id` text;--> statement-breakpoint
CREATE INDEX `routes_task` ON `routes` (`task_id`);