// 消息正文：飞书图片在文字里是「[图片 img_v3_…]」占位，按消息 id 换成缩略图，点开看原图（server/api.ts /api/msgimg）
import { useState } from "react";

const IMG_RE = /\[图片 (img_[\w-]+)\]/g;

function Thumb({ mid, imgKey }: { mid: string; imgKey: string }) {
	const [failed, setFailed] = useState(false);
	if (failed) return <span className="text-muted">[图片]</span>;
	const src = `/api/msgimg/${mid}/${imgKey}`;
	return (
		<a href={src} target="_blank" rel="noreferrer" className="my-1 inline-block" onClick={(e) => e.stopPropagation()}>
			<img
				src={src}
				alt="消息图片"
				loading="lazy"
				onError={() => setFailed(true)}
				className="max-h-[240px] max-w-full rounded border border-line object-contain"
			/>
		</a>
	);
}

/** 不是飞书消息（没有 om_ 开头的 id）就原样显示文字 */
export function MsgText({ text, mid }: { text: string; mid?: string | null }) {
	if (!mid?.startsWith("om_") || !text.includes("[图片 ")) return <>{text}</>;
	const out: React.ReactNode[] = [];
	let last = 0;
	for (const m of text.matchAll(IMG_RE)) {
		if (m.index > last) out.push(text.slice(last, m.index));
		out.push(<Thumb key={`${m[1]}-${m.index}`} mid={mid} imgKey={m[1]} />);
		last = m.index + m[0].length;
	}
	out.push(text.slice(last));
	return <>{out}</>;
}
