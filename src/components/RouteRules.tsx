// 设置 → 路由规则：按 Router 的六步排列（docs/flow.md §3），能调的阈值直接改，保存后写 config/routes.json，下一条消息就按新的走
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { type RouteRules, fetchRoutes, saveRoutes } from "../lib/api";
import { toast } from "./Toast";

function Num({
	id,
	value,
	onChange,
	unit,
	step = 1,
}: {
	id: string;
	value: number;
	onChange: (v: number) => void;
	unit: string;
	step?: number;
}) {
	return (
		<span className="numin">
			<input id={id} className="in" type="number" min={0} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
			{unit}
		</span>
	);
}

function Step({ n, name, sub, children }: { n: string; name: string; sub?: string; children: React.ReactNode }) {
	return (
		<div className="cfg">
			<div className="lab">
				{n} {name}
				{sub && <small>{sub}</small>}
			</div>
			<div className="val">{children}</div>
		</div>
	);
}

const list = (s: string) =>
	s
		.split(/[\s,，]+/)
		.map((x) => x.trim())
		.filter(Boolean);

export function RouteRulesPage() {
	const qc = useQueryClient();
	const { data } = useQuery({ queryKey: ["routes"], queryFn: fetchRoutes });
	const [r, setR] = useState<RouteRules | null>(null);
	const [busy, setBusy] = useState(false);
	if (!data) return <div className="empty">加载中…</div>;
	const cur = r ?? data.rules;
	const set = (patch: (x: RouteRules) => RouteRules) => setR(patch(structuredClone(cur)));
	const dirty = r !== null && JSON.stringify(r) !== JSON.stringify(data.rules);
	async function save(next: RouteRules, done: string) {
		setBusy(true);
		try {
			await saveRoutes(next);
			setR(null);
			await qc.invalidateQueries({ queryKey: ["routes"] });
			toast(done);
		} catch (e) {
			toast((e as Error).message, true);
		} finally {
			setBusy(false);
		}
	}
	return (
		<>
			<p className="meta note">每条进来的事件按顺序走，命中一步就停。改完点保存，下一条消息就按新的走，不用重启。</p>
			<div className="list">
				<Step n="1" name="去重" sub="渠道 + 渠道内 ID">
					<span className="meta">同一条事件只处理一次，固定</span>
				</Step>
				<Step n="2" name="过滤" sub="命中就不处理，记下原因">
					<span className="meta">自己发的、机器人自己的卡片、PagerDuty 的 [Ack] / [Res]、你已经亲自回了</span>
				</Step>
				<Step n="3" name="指令" sub="你对已有的事的操作">
					<span className="meta">引用卡片回「发 / 改 / 不发 / 完成」、看板按钮、「记住」</span>
				</Step>
				<Step n="4" name="归属" sub="追加到已有的事">
					<span>话题、工作项、MR 关闭后</span>
					<Num
						id="rule-reopen"
						value={Math.round((cur.reopen / 86400) * 10) / 10}
						step={0.5}
						unit="天"
						onChange={(v) => set((x) => ({ ...x, reopen: Math.round(v * 86400) }))}
					/>
					<span>内再来消息就重开；私聊和群的主线只接还没关闭的</span>
				</Step>
				<Step n="5" name="攒批" sub="告警按群攒一批">
					<span>静默</span>
					<Num id="rule-quiet" value={cur.alert.quiet} unit="秒收口" onChange={(v) => set((x) => ((x.alert.quiet = v), x))} />
					<span>最长</span>
					<Num id="rule-max" value={cur.alert.maxWait} unit="秒" onChange={(v) => set((x) => ((x.alert.maxWait = v), x))} />
					<span>同群</span>
					<Num id="rule-follow" value={cur.alert.follow} unit="秒内续批" onChange={(v) => set((x) => ((x.alert.follow = v), x))} />
				</Step>
				<Step n="" name="告警来源" sub="空着就不限">
					<input
						id="rule-senders"
						className="in wide"
						defaultValue={cur.alert.senders.join(" ")}
						onBlur={(e) => set((x) => ((x.alert.senders = list(e.target.value)), x))}
						placeholder="只认这些机器人（发送者 ID，空格分隔）"
						aria-label="只认这些机器人"
					/>
					<input
						id="rule-chats"
						className="in wide"
						defaultValue={cur.alert.chats.join(" ")}
						onBlur={(e) => set((x) => ((x.alert.chats = list(e.target.value)), x))}
						placeholder="只认这些群（chat_id，空格分隔）"
						aria-label="只认这些群"
					/>
				</Step>
				<Step n="" name="你正在聊" sub="多半你自己就回了">
					<span>触发前</span>
					<Num
						id="rule-window"
						value={cur.yiActive.window}
						unit="秒内你说过话"
						onChange={(v) => set((x) => ((x.yiActive.window = v), x))}
					/>
					<span>就先等最多</span>
					<Num id="rule-delay" value={cur.yiActive.delay} unit="秒" onChange={(v) => set((x) => ((x.yiActive.delay = v), x))} />
					<span>每</span>
					<Num
						id="rule-check"
						value={cur.yiActive.check}
						unit="秒看一次；0 秒不等"
						onChange={(v) => set((x) => ((x.yiActive.check = v), x))}
					/>
				</Step>
				<Step n="6" name="分诊" sub="先规则，再模型">
					<span className="meta">消息带 MR 链接 → 助手 · mr；定时、看板按各自配置；其余由 agents.json 里 _router 的模型判档位</span>
				</Step>
				<Step n="" name="定时巡检" sub="手动运行不拦">
					<span>Claude 5 小时额度用到</span>
					<Num
						id="rule-patrol"
						value={Math.round(cur.cron.patrolPauseAt * 100)}
						unit="% 就跳过这一轮"
						onChange={(v) => set((x) => ((x.cron.patrolPauseAt = v / 100), x))}
					/>
				</Step>
			</div>
			<div className="oa" style={{ marginTop: 14 }}>
				<button className="btn pri sm" disabled={!dirty || busy} onClick={() => save(cur, "已保存，下一条消息起生效")}>
					保存
				</button>
				{dirty && (
					<button className="btn ghost sm" onClick={() => setR(null)}>
						放弃修改
					</button>
				)}
				{JSON.stringify(data.rules) !== JSON.stringify(data.defaults) && (
					<button className="btn ghost sm" disabled={busy} onClick={() => save(data.defaults, "已恢复默认值")}>
						恢复默认
					</button>
				)}
			</div>
		</>
	);
}
