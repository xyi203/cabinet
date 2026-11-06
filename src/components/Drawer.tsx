import { useEffect } from "react";
import { toast } from "./Toast";

export function Drawer({
	title,
	onClose,
	children,
	actions,
}: {
	title: string;
	onClose: () => void;
	children: React.ReactNode;
	actions?: React.ReactNode;
}) {
	return (
		<>
			<div className="mask show" onClick={onClose} />
			<div className="drawer show">
				<header>
					<b>{title}</b>
					<button className="x" onClick={onClose} aria-label="关闭">
						×
					</button>
				</header>
				<div className="content">{children}</div>
				{actions && <div className="actions">{actions}</div>}
			</div>
		</>
	);
}

export type Msg = { text: string; bad?: boolean } | null;
/** 操作结果：统一走右下角的全局提示条（ToastHost），不再在按钮旁边显示一行小字 */
export function MsgLine({ msg }: { msg: Msg }) {
	useEffect(() => {
		if (msg?.text) toast(msg.text, msg.bad);
	}, [msg]);
	return null;
}
