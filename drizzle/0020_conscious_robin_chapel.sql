CREATE TABLE `marks` (
	`key` text NOT NULL,
	`event` text NOT NULL,
	`thread` text NOT NULL,
	`actor_name` text DEFAULT '' NOT NULL,
	`owner` integer DEFAULT false NOT NULL,
	`text` text DEFAULT '' NOT NULL,
	`url` text,
	`at` real NOT NULL,
	PRIMARY KEY(`key`, `event`)
);
--> statement-breakpoint
CREATE INDEX `marks_key_at` ON `marks` (`key`,`at`);