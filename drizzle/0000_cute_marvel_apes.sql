CREATE TABLE `drafts` (
	`id` text PRIMARY KEY NOT NULL,
	`chat_id` text NOT NULL,
	`chat_mode` text NOT NULL,
	`chat_name` text DEFAULT '' NOT NULL,
	`reply_to` text NOT NULL,
	`thread_id` text,
	`sender_id` text DEFAULT '' NOT NULL,
	`sender_name` text DEFAULT '' NOT NULL,
	`text` text DEFAULT '' NOT NULL,
	`meego` text,
	`agent` text,
	`session` text,
	`route` text,
	`kind` text DEFAULT 'text' NOT NULL,
	`draft` text DEFAULT '' NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`report` text DEFAULT '' NOT NULL,
	`status` text NOT NULL,
	`created` real NOT NULL
);
--> statement-breakpoint
CREATE INDEX `drafts_chat` ON `drafts` (`chat_id`,`status`);--> statement-breakpoint
CREATE TABLE `handled` (
	`message_id` text PRIMARY KEY NOT NULL,
	`at` real NOT NULL
);
--> statement-breakpoint
CREATE TABLE `kv` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text
);
--> statement-breakpoint
CREATE TABLE `records` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ts` real NOT NULL,
	`kind` text NOT NULL,
	`status` text NOT NULL,
	`chat_id` text,
	`source` text,
	`dm` text,
	`session` text,
	`agent` text,
	`label` text,
	`seconds` real,
	`usage` text,
	`question` text,
	`answer` text,
	`error` text,
	`reason` text,
	`retry` text
);
--> statement-breakpoint
CREATE INDEX `records_ts` ON `records` (`ts`);--> statement-breakpoint
CREATE INDEX `records_source` ON `records` (`source`);