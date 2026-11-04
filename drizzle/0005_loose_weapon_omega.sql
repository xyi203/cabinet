CREATE TABLE `memories` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`content` text NOT NULL,
	`kind` text NOT NULL,
	`application` text DEFAULT 'reference' NOT NULL,
	`applies_when` text DEFAULT '' NOT NULL,
	`scope` text DEFAULT 'personal' NOT NULL,
	`scope_name` text DEFAULT '' NOT NULL,
	`provenance` text NOT NULL,
	`confirmed` integer DEFAULT false NOT NULL,
	`state` text NOT NULL,
	`evidence` text DEFAULT '[]' NOT NULL,
	`conflicts` text DEFAULT '[]' NOT NULL,
	`superseded_by` integer,
	`source` text DEFAULT '' NOT NULL,
	`injected` integer DEFAULT 0 NOT NULL,
	`last_injected` real,
	`created` real NOT NULL,
	`updated` real NOT NULL
);
--> statement-breakpoint
CREATE INDEX `memories_state` ON `memories` (`state`,`application`);--> statement-breakpoint
CREATE TABLE `memory_terms` (
	`memory_id` integer PRIMARY KEY NOT NULL,
	`revision` integer NOT NULL,
	`terms` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `memory_vectors` (
	`memory_id` integer PRIMARY KEY NOT NULL,
	`revision` integer NOT NULL,
	`model` text NOT NULL,
	`vec` blob NOT NULL
);
