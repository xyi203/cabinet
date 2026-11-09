// Markdown 预览：日报、技能说明、agent 的回答共用。不开原始 HTML（react-markdown 默认就不渲染），
// agent 回答和 SKILL.md 里的内容不可信，不能让它在页面里插标签。
import type { ComponentProps } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

// GFM 的裸链接一直延伸到空白才停，中文里常见「https://x/a，然后」「https://x/a这个问题」整段被当成链接；
// 在第一个中日韩字符或全角标点处切开，后半段按普通文字显示
const CJK = /[⺀-鿿가-힯豈-﫿︰-﹏＀-￯]/;

function Link({ href, title, children }: ComponentProps<"a">) {
	if (typeof children === "string" && href && /^(https?:\/\/|www\.)/.test(children)) {
		const i = children.search(CJK);
		if (i > 0) {
			const url = children.slice(0, i);
			return (
				<>
					<a title={title} href={url.startsWith("www.") ? `http://${url}` : url} target="_blank" rel="noreferrer">
						{url}
					</a>
					{children.slice(i)}
				</>
			);
		}
	}
	return (
		<a title={title} href={href} target="_blank" rel="noreferrer">
			{children}
		</a>
	);
}

const components: Components = {
	a: Link,
	// 宽表格只在自己的框里横向滚动，不撑破卡片
	table: ({ children }) => (
		<div className="md-table">
			<table>{children}</table>
		</div>
	),
};

/** 开头的 YAML frontmatter（SKILL.md 的 name / description）单独拿出来，按原文显示，不当正文渲染 */
export function splitFrontmatter(text: string) {
	const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
	return m ? { meta: m[1], body: text.slice(m[0].length) } : { meta: "", body: text };
}

export function Markdown({ text, className = "" }: { text: string; className?: string }) {
	return (
		<div className={`md ${className}`}>
			<ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
				{text}
			</ReactMarkdown>
		</div>
	);
}
