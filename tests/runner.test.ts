import assert from "node:assert/strict";
import { test } from "node:test";
import { QUOTA_RE } from "../server/util.ts";

test("额度/限流错误会触发换模型，其他错误不会", () => {
	assert.ok(QUOTA_RE.test("Claude Code: API Error: 400 You're out of extra usage. Ask your workspace admin to add more"));
	assert.ok(QUOTA_RE.test("429 Too Many Requests"));
	assert.ok(QUOTA_RE.test("overloaded_error"));
	assert.ok(!QUOTA_RE.test("prompt is too long"));
	assert.ok(!QUOTA_RE.test("invalid tool arguments"));
});
