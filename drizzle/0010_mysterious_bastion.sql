CREATE TABLE `approvals` (
	`id` text PRIMARY KEY NOT NULL,
	`created` real NOT NULL,
	`status` text NOT NULL,
	`tool` text NOT NULL,
	`args` text NOT NULL,
	`reason` text DEFAULT '' NOT NULL,
	`origin` text DEFAULT '' NOT NULL,
	`conv_id` integer,
	`cwd` text DEFAULT '' NOT NULL,
	`dev_task_id` text,
	`draft_reply_to` text,
	`dm` text,
	`result` text,
	`decided` real
);
--> statement-breakpoint
CREATE INDEX `approvals_status` ON `approvals` (`status`);