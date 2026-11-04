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
export const MsgLine = ({ msg }: { msg: Msg }) => (
	<div className="msg" style={{ color: msg?.bad ? "var(--bad)" : "var(--ok)" }}>
		{msg?.text}
	</div>
);
