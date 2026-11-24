// 外部文字进提示词时包成资料块（docs/bot-borrow.md §4，参照 Orca 的事件围栏和 T3 的 <webhook-data>）：
// 别人的消息、评论、MR 描述、告警正文都可能写着「忽略上面的规则」「【复查】…」这类话，
// 包进块里，系统规则（config/system.md）说明块里的只是资料；块头写来源，agent 能分清是谁说的。
// 只转义伪造的块边界：正文原样保留，agent 引用对方原话时不会带出奇怪字符。

const TAG = "资料";

/** 把一段外部文字包成资料块；label 写这段是什么、从哪来。空文本返回空串 */
export function fence(label: string, body: string): string {
	if (!body.trim()) return "";
	// 正文里出现 <资料 / </资料 换成全角尖括号，伪造不了块边界
	const safe = body.replace(/<(\/?)资料/g, "＜$1资料");
	return `<${TAG} 来源="${label.replace(/"/g, "'")}">\n${safe}\n</${TAG}>`;
}

/** 发言人的档位：Yi 本人 / 机器人 / 同事（飞书里的人都是同租户的同事） */
export function speakerTag(sender: { id: string; sender_type?: string }, ownerId: string): string {
	if (ownerId && sender.id === ownerId) return "（Yi 本人）";
	if (sender.sender_type === "app") return "（机器人）";
	return "";
}
