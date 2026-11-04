// 关键词切分（同 komo 的 lexical_terms）：中文连续字符切 bigram，ASCII 按词小写化。
// 落单的虚字不成词：小库里 IDF 接近满分，单个「的」就能把无关条目凑过门槛（komo docs/memory.md §9.4）。
const LONE_STOPWORDS = new Set("的了是和在也就都而及与或被把给向对从让着过吗呢吧啊么个这那有我你他她它们".split(""));

const HAN = /\p{Script=Han}+/gu;
const WORD = /[a-z0-9_]+/g;

export function lexicalTerms(text: string): string[] {
	const out = new Set<string>();
	const lower = text.toLowerCase();
	for (const [run] of lower.matchAll(HAN)) {
		if (run.length === 1) {
			if (!LONE_STOPWORDS.has(run)) out.add(run);
			continue;
		}
		for (let i = 0; i + 1 < run.length; i++) out.add(run.slice(i, i + 2));
	}
	for (const [w] of lower.matchAll(WORD)) if (w.length > 1 || /\d/.test(w)) out.add(w);
	return [...out];
}

/** 写进 memory_terms 的形式：首尾带空格，查询时用 ' tok ' 整词匹配 */
export const termsField = (text: string) => ` ${lexicalTerms(text).join(" ")} `;

/** 粗估 token：中文一字一个，其余四个字符一个 */
export function estimateTokens(text: string): number {
	const han = text.match(HAN)?.join("").length ?? 0;
	return han + Math.ceil((text.length - han) / 4);
}
