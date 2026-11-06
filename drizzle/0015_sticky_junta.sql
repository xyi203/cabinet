CREATE TABLE `runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ts` real NOT NULL,
	`agent` text,
	`tier` text,
	`model` text,
	`request` text,
	`label` text,
	`seconds` real,
	`ok` integer DEFAULT true NOT NULL,
	`input` integer DEFAULT 0 NOT NULL,
	`output` integer DEFAULT 0 NOT NULL,
	`cache_read` integer DEFAULT 0 NOT NULL,
	`cost` real DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `runs_ts` ON `runs` (`ts`);--> statement-breakpoint
-- 补录：建表前的起草 / 问答（records）和 agent 任务（dev_tasks 只有累计用量，记在创建时间上），模型不知道留空
INSERT INTO `runs` (`ts`, `agent`, `label`, `seconds`, `request`, `input`, `output`, `cache_read`, `cost`)
SELECT `ts`, `agent`, `label`, `seconds`, `kind` || ':' || coalesce(`source`, ''),
	coalesce(json_extract(`usage`, '$.input'), 0), coalesce(json_extract(`usage`, '$.output'), 0),
	coalesce(json_extract(`usage`, '$.cacheRead'), 0), coalesce(json_extract(`usage`, '$.cost'), 0)
FROM `records` WHERE `usage` IS NOT NULL;
--> statement-breakpoint
INSERT INTO `runs` (`ts`, `agent`, `tier`, `label`, `request`, `input`, `output`, `cache_read`, `cost`)
SELECT `created`, `agent`, 'task', `title`, 'dev:' || `id`,
	coalesce(json_extract(`usage`, '$.input'), 0), coalesce(json_extract(`usage`, '$.output'), 0),
	coalesce(json_extract(`usage`, '$.cacheRead'), 0), coalesce(json_extract(`usage`, '$.cost'), 0)
FROM `dev_tasks` WHERE `usage` IS NOT NULL;
