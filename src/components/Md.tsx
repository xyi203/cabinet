import { Fragment, type ReactNode } from "react";

/**
 * 助手结论、评审报告、日报里的 Markdown。只做 AI 输出里常见的几样：
 * 标题、段落、有序 / 无序 / 嵌套列表、任务勾选、引用、表格、代码块、分割线，行内的粗体、代码、链接、删除线。
 * 不引入渲染库、不用 innerHTML：逐段拼 React 节点，内容里的 HTML 原样当文字显示，不会被执行。
 * 斜体按产品规范不用：*x* 只去掉星号
 */
export function Md({ text, dropTitle = false }: { text: string; dropTitle?: boolean }) {
	let lines = text.replace(/\r\n?/g, "\n").split("\n");
	// 日报这类外面已经有标题的，开头的一级标题不再重复
	if (dropTitle) {
		const i = lines.findIndex((l) => l.trim());
		if (i >= 0 && /^#\s/.test(lines[i])) lines = lines.slice(i + 1);
	}
	return <div className="md">{blocks(lines)}</div>;
}

const LIST = /^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/;
const FENCE = /^\s*(```|~~~)/;
const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

function blocks(lines: string[]): ReactNode[] {
	const out: ReactNode[] = [];
	let i = 0;
	while (i < lines.length) {
		const line = lines[i];
		const k = out.length;
		if (!line.trim()) {
			i++;
			continue;
		}
		// 代码块：原样显示，不折叠空行
		const fence = line.match(FENCE);
		if (fence) {
			const body: string[] = [];
			i++;
			while (i < lines.length && !lines[i].trim().startsWith(fence[1])) body.push(lines[i++]);
			i++;
			out.push(<pre key={k}>{body.join("\n")}</pre>);
			continue;
		}
		const h = line.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
		if (h) {
			out.push(
				<div key={k} className={h[1].length <= 2 ? "md-h1" : "md-h2"} role="heading" aria-level={h[1].length}>
					{inline(h[2])}
				</div>,
			);
			i++;
			continue;
		}
		if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
			out.push(<hr key={k} />);
			i++;
			continue;
		}
		if (/^\s*>/.test(line)) {
			const body: string[] = [];
			while (i < lines.length && /^\s*>/.test(lines[i])) body.push(lines[i++].replace(/^\s*>\s?/, ""));
			out.push(<blockquote key={k}>{blocks(body)}</blockquote>);
			continue;
		}
		if (line.includes("|") && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1])) {
			const rows: string[][] = [cells(line)];
			const align = cells(lines[i + 1]).map((c) => (/^:-+:$/.test(c) ? "center" : c.endsWith("-:") ? "right" : undefined));
			i += 2;
			while (i < lines.length && lines[i].includes("|") && lines[i].trim()) rows.push(cells(lines[i++]));
			out.push(<Table key={k} rows={rows} align={align} />);
			continue;
		}
		if (LIST.test(line)) {
			const items: string[] = [];
			// 列表一直到空行后不再是列表、或者顶格的非列表行为止；缩进的续行归上一项
			while (i < lines.length) {
				const l = lines[i];
				if (LIST.test(l) || (l.trim() && /^\s/.test(l) && items.length)) items.push(l);
				else if (!l.trim() && i + 1 < lines.length && (LIST.test(lines[i + 1]) || /^\s+\S/.test(lines[i + 1]))) items.push("");
				else break;
				i++;
			}
			out.push(<Fragment key={k}>{list(items)}</Fragment>);
			continue;
		}
		// 段落：连续的行放一段，保留换行（中文回复里换行通常是有意的）
		const para: string[] = [];
		while (
			i < lines.length &&
			lines[i].trim() &&
			!FENCE.test(lines[i]) &&
			!/^#{1,6}\s/.test(lines[i]) &&
			!/^\s*>/.test(lines[i]) &&
			!LIST.test(lines[i])
		)
			para.push(lines[i++]);
		out.push(
			<p key={k}>
				{para.map((l, j) => (
					<Fragment key={j}>
						{j > 0 && <br />}
						{inline(l.trim())}
					</Fragment>
				))}
			</p>,
		);
	}
	return out;
}

/** 列表：按缩进分层，同一层里第一项决定是有序还是无序 */
function list(lines: string[]): ReactNode {
	type Item = { text: string[]; children: string[] };
	const first = lines.find((l) => LIST.test(l))!.match(LIST)!;
	const base = first[1].length;
	const ordered = /\d/.test(first[2]);
	const start = ordered ? Number.parseInt(first[2], 10) : undefined;
	const items: Item[] = [];
	for (const l of lines) {
		const m = l.match(LIST);
		if (m && m[1].length <= base + 1) items.push({ text: [m[3]], children: [] });
		else if (items.length) {
			const cur = items.at(-1)!;
			// 更深一层的列表交给子列表；同层缩进的续行接在这一项后面
			if (cur.children.length || (m && m[1].length > base + 1)) cur.children.push(l);
			else if (l.trim()) cur.text.push(l.trim());
		}
	}
	const Tag = ordered ? "ol" : "ul";
	return (
		<Tag start={start !== 1 ? start : undefined}>
			{items.map((it, j) => {
				const task = it.text[0].match(/^\[([ xX])\]\s+(.*)$/);
				return (
					<li key={j} className={task ? "task" : undefined}>
						{task && <span className={`check${task[1] === " " ? "" : " on"}`} aria-label={task[1] === " " ? "未完成" : "已完成"} />}
						{it.text.map((t, n) => (
							<Fragment key={n}>
								{n > 0 && <br />}
								{inline(n === 0 && task ? task[2] : t)}
							</Fragment>
						))}
						{it.children.some((c) => LIST.test(c)) ? list(it.children) : null}
					</li>
				);
			})}
		</Tag>
	);
}

function cells(row: string) {
	return row
		.trim()
		.replace(/^\|/, "")
		.replace(/\|$/, "")
		.split(/(?<!\\)\|/)
		.map((c) => c.trim().replace(/\\\|/g, "|"));
}

function Table({ rows, align }: { rows: string[][]; align: Array<"center" | "right" | undefined> }) {
	const [head, ...body] = rows;
	return (
		// 列多时横向滚动，只滚表格本身，不撑宽页面
		<div className="md-table">
			<table>
				<thead>
					<tr>
						{head.map((c, j) => (
							<th key={j} style={{ textAlign: align[j] }}>
								{inline(c)}
							</th>
						))}
					</tr>
				</thead>
				<tbody>
					{body.map((r, i) => (
						<tr key={i}>
							{head.map((_, j) => (
								<td key={j} style={{ textAlign: align[j] }}>
									{inline(r[j] ?? "")}
								</td>
							))}
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}

// 自动识别的链接遇到中文、全角标点就停（AI 常把链接和后面的中文连着写）；
// __粗体__ 两侧不能紧挨字母数字，免得把 mcp__x__y 这类标识符当成粗体
const INLINE =
	/`([^`]+)`|\*\*(.+?)\*\*|(?<!\w)__(.+?)__(?!\w)|~~(.+?)~~|\[([^\]]+)\]\((https?:[^)\s]+)\)|(https?:\/\/[^\s<>()　-〿㐀-鿿＀-￯]+[^\s<>()　-〿㐀-鿿＀-￯.,;:!?'"])|(?<![\w*])\*(?!\s)([^*\n]+?)\*(?![\w*])/g;

function inline(s: string): ReactNode[] {
	const out: ReactNode[] = [];
	let last = 0;
	for (const m of s.matchAll(INLINE)) {
		if (m.index > last) out.push(s.slice(last, m.index));
		const k = m.index;
		if (m[1] != null) out.push(<code key={k}>{m[1]}</code>);
		else if (m[2] != null || m[3] != null) out.push(<b key={k}>{inline(m[2] ?? m[3])}</b>);
		else if (m[4] != null) out.push(<s key={k}>{inline(m[4])}</s>);
		else if (m[5] != null)
			out.push(
				<a key={k} href={m[6]} target="_blank" rel="noreferrer">
					{inline(m[5])}
				</a>,
			);
		else if (m[7] != null)
			out.push(
				<a key={k} href={m[7]} target="_blank" rel="noreferrer">
					{m[7]}
				</a>,
			);
		else out.push(<Fragment key={k}>{inline(m[8])}</Fragment>);
		last = k + m[0].length;
	}
	if (last < s.length) out.push(s.slice(last));
	return out;
}
