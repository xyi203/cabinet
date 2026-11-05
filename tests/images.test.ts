import assert from "node:assert/strict";
import { test } from "node:test";
const { PATHS } = await import("../server/config.ts");
const { localImageUrls } = await import("../server/agent/driver.ts");
const { imagesNote } = await import("../server/lark/bot.ts");

test("文字里提到的本地截图换成看板地址，其他路径不认", () => {
	const text = `消息里的图片已存到本地：\n- [图片 img_v3_a]：${PATHS.images}/img_v3_a.png\n- 再提一次 ${PATHS.images}/img_v3_a.png\n/etc/passwd.png ${PATHS.images}/../x.png ${PATHS.images}/b.jpeg`;
	assert.deepEqual(localImageUrls(text), ["/api/images/img_v3_a.png", "/api/images/b.jpeg"]);
});

test("图片清单：没存下来的不列", () => {
	assert.equal(imagesNote([["k1", undefined]]), "");
	assert.match(
		imagesNote([
			["k1", "/d/k1.png"],
			["k2", undefined],
		]),
		/- \[图片 k1\]：\/d\/k1\.png$/,
	);
});
