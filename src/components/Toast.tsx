import { useEffect, useState } from "react";

/** 全局提示条：操作结果统一从右下角弹出，几秒后自动消失；出错的停留更久 */
export interface Toast {
	id: number;
	text: string;
	bad?: boolean;
}

let seq = 0;
const listeners = new Set<(t: Toast) => void>();

export function toast(text: string, bad = false) {
	if (!text) return;
	const t = { id: ++seq, text, bad };
	for (const l of listeners) l(t);
}

export function ToastHost() {
	const [items, setItems] = useState<Toast[]>([]);
	useEffect(() => {
		const add = (t: Toast) => {
			setItems((xs) => [...xs.slice(-3), t]);
			setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== t.id)), t.bad ? 7000 : 3500);
		};
		listeners.add(add);
		return () => void listeners.delete(add);
	}, []);
	return (
		<div className="pointer-events-none fixed right-4 bottom-4 z-[1000] flex max-w-sm flex-col gap-2">
			{items.map((t) => (
				<div
					key={t.id}
					role={t.bad ? "alert" : "status"}
					className={`pointer-events-auto rounded-lg border px-3.5 py-2.5 text-[13px] shadow-lg ${
						t.bad ? "border-bad/30 bg-bad-soft text-bad" : "border-line bg-panel text-text"
					}`}
					onClick={() => setItems((xs) => xs.filter((x) => x.id !== t.id))}
				>
					{t.text}
				</div>
			))}
		</div>
	);
}
