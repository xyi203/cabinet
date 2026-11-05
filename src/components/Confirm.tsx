import { useEffect, useRef, useSyncExternalStore } from "react";

/** 一次确认：标题一句话，正文可选（比如要发出去的文字），危险操作的按钮标红 */
export interface ConfirmOptions {
	title: string;
	body?: string;
	confirmText?: string;
	danger?: boolean;
}

type Pending = ConfirmOptions & { resolve: (ok: boolean) => void };

// 页面上同一时刻只有一个确认框：模块级的一份状态，<ConfirmHost /> 订阅它
let current: Pending | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

/** 代替浏览器的 confirm()：弹应用自己的对话框，点确认返回 true，取消、Esc、点遮罩返回 false */
export function confirmDialog(opts: ConfirmOptions): Promise<boolean> {
	// 上一个还开着就当取消
	current?.resolve(false);
	return new Promise((resolve) => {
		current = { ...opts, resolve };
		emit();
	});
}

function close(ok: boolean) {
	const p = current;
	current = null;
	emit();
	p?.resolve(ok);
}

const subscribe = (l: () => void) => {
	listeners.add(l);
	return () => listeners.delete(l);
};

/** 挂在根组件里一次 */
export function ConfirmHost() {
	const p = useSyncExternalStore(
		subscribe,
		() => current,
		() => null,
	);
	const ref = useRef<HTMLDialogElement>(null);
	const ok = useRef<HTMLButtonElement>(null);
	useEffect(() => {
		const d = ref.current;
		if (!d) return;
		if (p && !d.open) {
			d.showModal();
			ok.current?.focus();
		} else if (!p && d.open) d.close();
	}, [p]);
	return (
		<dialog
			ref={ref}
			className="confirm"
			// Esc 关掉也算取消
			onCancel={(e) => {
				e.preventDefault();
				close(false);
			}}
			// 点到对话框外（遮罩）算取消
			onClick={(e) => {
				if (e.target === ref.current) close(false);
			}}
		>
			{p && (
				<div className="confirm-box">
					<div className="confirm-title">{p.title}</div>
					{p.body && <pre className="confirm-body">{p.body}</pre>}
					<div className="confirm-actions">
						<button className="btn" onClick={() => close(false)}>
							取消
						</button>
						<button ref={ok} className={`btn ${p.danger ? "danger" : "primary"}`} onClick={() => close(true)}>
							{p.confirmText ?? "确定"}
						</button>
					</div>
				</div>
			)}
		</dialog>
	);
}
