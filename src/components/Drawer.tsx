import { createContext, useContext, useEffect } from "react";
import { toast } from "./Toast";

/** 嵌在任务详情的时间线里：草稿、agent 任务的抽屉内容原样复用，只是不再盖一层遮罩 */
export const Embedded = createContext(false);

/**
 * 工作台右边的详情：操作都交给页面底部的选项卡和输入框（Workbench 的 Dock），
 * 抽屉里的发送 / 审批 / 停止这些按钮不再重复出现；草稿框里改的字记在这里，选「发送」时发的就是它
 */
export interface DockCtx {
	edit: (draftId: string) => string | undefined;
	setEdit: (draftId: string, text: string) => void;
}
export const Docked = createContext<DockCtx | null>(null);

export function Drawer({
	title,
	onClose,
	children,
	actions,
	onBack,
	backLabel = "返回",
}: {
	title: string;
	onClose: () => void;
	children: React.ReactNode;
	actions?: React.ReactNode;
	/** 从别的抽屉点进来的（比如需求里的任务）：回到原来那个 */
	onBack?: () => void;
	backLabel?: string;
}) {
	if (useContext(Embedded))
		return (
			<section className="embed">
				<header>{title}</header>
				<div className="content">{children}</div>
				{actions && <div className="actions">{actions}</div>}
			</section>
		);
	return (
		<>
			<div className="mask show" onClick={onClose} />
			<div className="drawer show">
				<header>
					{onBack && (
						<button className="back" onClick={onBack}>
							‹ {backLabel}
						</button>
					)}
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
