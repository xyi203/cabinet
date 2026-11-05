CREATE TABLE `stories` (
	`id` text PRIMARY KEY NOT NULL,
	`project_key` text NOT NULL,
	`type_key` text NOT NULL,
	`title` text NOT NULL,
	`url` text DEFAULT '' NOT NULL,
	`node` text DEFAULT '' NOT NULL,
	`stage` text DEFAULT 'dev' NOT NULL,
	`tickets` text DEFAULT '[]' NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`created` real NOT NULL,
	`updated` real NOT NULL
);
--> statement-breakpoint
ALTER TABLE `dev_tasks` ADD `story_id` text;