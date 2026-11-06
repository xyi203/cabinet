ALTER TABLE `dev_tasks` ADD `patrol` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `schedules` ADD `model` text;--> statement-breakpoint
ALTER TABLE `schedules` ADD `thinking` text;--> statement-breakpoint
ALTER TABLE `schedules` ADD `until` real;--> statement-breakpoint
ALTER TABLE `schedules` ADD `patrol` integer DEFAULT false NOT NULL;