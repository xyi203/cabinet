CREATE TABLE `subscriptions` (
	`key` text NOT NULL,
	`agent` text NOT NULL,
	`session` text NOT NULL,
	`info` text DEFAULT '{}' NOT NULL,
	`route_id` integer,
	`updated` real NOT NULL,
	PRIMARY KEY(`key`, `session`)
);
--> statement-breakpoint
CREATE INDEX `subscriptions_updated` ON `subscriptions` (`updated`);