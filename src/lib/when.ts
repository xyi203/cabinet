// 定时任务的「时间」：一句话 → cron 或时间点、cron 说成人话、预览接下来几次。纯函数，不依赖 React，测试直接引（tests/when.test.ts）。
// 后端的 cron 解析在 server/schedules.ts，这里只覆盖看板上写得出来的几种，预览和保存前的提示用

export const WEEK = "日一二三四五六";
const pad = (n: number) => String(n).padStart(2, "0");

const monthDay = (t: number) => {
	const d = new Date(t * 1000);
	return `${d.getMonth() + 1}月${d.getDate()}日 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/** 按时间点跑的任务在列表上的说明（和 server/schedules.ts describeTimes 同一个格式） */
export function describeTimes(times: number[]): string {
	return times.length === 1 ? `一次 ${monthDay(times[0])}` : `${times.length} 次：${times.map(monthDay).join("、")}`;
}

/** 常见的几种 cron 说成人话；认不出的原样给 */
export function humanCron(cron: string): string {
	const [mi, h, dom, mon, dow] = cron.trim().split(/\s+/);
	if (mon !== "*") return cron;
	if (dom === "*" && dow === "*") {
		if (/^\*\/\d+$/.test(mi) && h === "*") return `每 ${mi.slice(2)} 分钟`;
		if (mi === "0" && /^\*\/\d+$/.test(h)) return `每 ${h.slice(2)} 小时`;
		if (/^\d+$/.test(mi) && h === "*") return +mi ? `每小时第 ${+mi} 分钟` : "每小时整点";
	}
	if (!/^\d+$/.test(mi) || !/^\d+(,\d+)*$/.test(h)) return cron;
	const at = h
		.split(",")
		.map((x) => `${pad(+x)}:${pad(+mi)}`)
		.join("、");
	if (dom !== "*") return /^\d+(,\d+)*$/.test(dom) && dow === "*" ? `每月 ${dom.split(",").join("、")} 号 ${at}` : cron;
	if (dow === "*") return `每天 ${at}`;
	if (dow === "1-5") return `每个工作日 ${at}`;
	if (dow === "0,6" || dow === "6,0") return `每个周末 ${at}`;
	if (/^\d(,\d)*$/.test(dow))
		return `每周${dow
			.split(",")
			.map((d) => WEEK[+d % 7])
			.join("、")} ${at}`;
	return cron;
}

function field(f: string, v: number): boolean {
	if (f === "*") return true;
	return f.split(",").some((p) => {
		if (p.startsWith("*/")) return v % +p.slice(2) === 0;
		if (p.includes("-")) {
			const [a, b] = p.split("-").map(Number);
			return v >= a && v <= b;
		}
		return +p === v || (p === "7" && v === 0);
	});
}

/** 预览用：from（毫秒）之后接下来 n 次触发时间。日和周都限定时任一满足就算（同后端） */
export function nextRuns(cron: string, n: number, from: number): Date[] {
	const [mi, h, dom, mon, dow] = cron.trim().split(/\s+/);
	const either = dom !== "*" && dow !== "*";
	const start = new Date(from);
	start.setSeconds(0, 0);
	start.setMinutes(start.getMinutes() + 1);
	const out: Date[] = [];
	// 按天往后找，一年多一点够覆盖每月、每周
	for (let i = 0; i < 400 && out.length < n; i++) {
		const day = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
		if (!field(mon, day.getMonth() + 1)) continue;
		const a = field(dom, day.getDate());
		const b = field(dow, day.getDay());
		if (either ? !(a || b) : !(a && b)) continue;
		for (let hh = 0; hh < 24 && out.length < n; hh++) {
			if (!field(h, hh)) continue;
			for (let m = 0; m < 60 && out.length < n; m++) {
				if (!field(mi, m)) continue;
				const t = new Date(day.getFullYear(), day.getMonth(), day.getDate(), hh, m);
				if (t >= start) out.push(t);
			}
		}
	}
	return out;
}

/** 一句话里的钟点：「9 点」「下午 3 点半」「12:30」「晚上 8 点 15」；没有返回 null */
function clockOf(text: string): { h: number; mi: number } | null {
	const m = /(\d{1,2})\s*[点:：]\s*(半|\d{1,2})?/.exec(text);
	if (!m) return null;
	let h = +m[1];
	const mi = m[2] === "半" ? 30 : m[2] ? +m[2] : 0;
	if (/下午|晚上|傍晚|今晚|明晚/.test(text) && h < 12) h += 12;
	// 中午 1 点是 13 点，中午 12 点还是 12 点
	if (/中午/.test(text) && h < 6) h += 12;
	if (h > 23 || mi > 59) return null;
	return { h, mi };
}

const DAYS = "一二三四五六日天";
const dowOf = (c: string) => (c === "日" || c === "天" ? 0 : "一二三四五六".indexOf(c) + 1);
const WEEKLY = new RegExp(`每个?(?:周|星期|礼拜)([${DAYS}](?:\\s*[、,，和及到至~-]?\\s*(?:周|星期|礼拜)?[${DAYS}])*)`);

/** 「一三五」→ 1,3,5；「一到五」→ 1-5；「六、日」→ 6,0 */
function dowList(s: string): string {
	const days = [...s].filter((c) => DAYS.includes(c)).map(dowOf);
	if (/[到至~-]/.test(s) && days.length === 2 && days[0] < days[1]) return `${days[0]}-${days[1]}`;
	return [...new Set(days)].join(",");
}

/** 只跑一次的那一天（当天 0 点）：今天 / 明天 / 后天 / 11月25日 / 周五 / 下周一；没写返回 undefined */
function dayOf(text: string, now: Date): Date | undefined {
	const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
	const plus = (n: number) => new Date(today.getFullYear(), today.getMonth(), today.getDate() + n);
	if (/今天|今晚|今早/.test(text)) return today;
	if (/明天|明早|明晚/.test(text)) return plus(1);
	if (/后天/.test(text)) return plus(2);
	const md = /(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]/.exec(text);
	if (md) {
		const d = new Date(today.getFullYear(), +md[1] - 1, +md[2]);
		// 已经过了的日子说的是明年
		return d < today ? new Date(today.getFullYear() + 1, +md[1] - 1, +md[2]) : d;
	}
	const wk = new RegExp(`(下|这|本)?(?:周|星期|礼拜)([${DAYS}])`).exec(text);
	if (wk) {
		const want = dowOf(wk[2]);
		if (wk[1] === "下") {
			// 下周按周一开始算：下周一 = 这周一 + 7
			const monday = plus(-((today.getDay() + 6) % 7));
			return new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 7 + ((want + 6) % 7));
		}
		return plus((want - today.getDay() + 7) % 7);
	}
}

export interface ParsedWhen {
	name: string;
	/** 重复跑的 cron；只跑一次的是说明文字（「一次 11月25日 09:00」） */
	cron: string;
	/** 只跑一次：时间点（unix 秒） */
	times?: number[];
	/** 只跑一次的时间已经过了 */
	past?: boolean;
}

/** 一句话里认出的时间片段，起名字时去掉 */
const TIME_WORDS = new RegExp(
	[
		String.raw`每\s*\d+\s*(分钟|小时)`,
		String.raw`\d+\s*(分钟|小时)(之|以)?后`,
		String.raw`每个?月\s*\d{1,2}\s*[号日]`,
		WEEKLY.source,
		"每天|每个?工作日|每个?周末|周末",
		"今天|今晚|今早|明天|明早|明晚|后天",
		String.raw`\d{1,2}\s*月\s*\d{1,2}\s*[日号]`,
		`(下|这|本)?(周|星期|礼拜)[${DAYS}]`,
		"上午|中午|下午|晚上|傍晚|早上",
		String.raw`\d{1,2}\s*[点:：]\s*(半|\d{1,2}\s*分?)?`,
	].join("|"),
	"g",
);

/**
 * 一句话 → 名字 + 时间。重复跑的认「每天 / 每个工作日 / 周末 / 每周一三五 / 每月 1 号」+ 钟点、「每 N 分钟 / 小时」；
 * 只跑一次的认「今天 / 明天 / 后天 / 11月25日 / 周五 / 下周一」+ 钟点、「30 分钟后」。没写「每」也没写哪天的，按每天算。认不出返回 null
 */
export function parseOneLine(text: string, now = Date.now()): ParsedWhen | null {
	const name =
		text
			.replace(TIME_WORDS, "")
			.replace(/^[，,。、\s的]+/, "")
			.trim()
			.slice(0, 30) || "定时任务";
	const once = (t: number): ParsedWhen => {
		const times = [Math.round(t / 1000)];
		return { name, cron: describeTimes(times), times, past: t <= now };
	};
	const later = /(\d+)\s*(分钟|小时)(?:之|以)?后/.exec(text);
	if (later) {
		const t = now + +later[1] * (later[2] === "分钟" ? 60_000 : 3_600_000);
		// 对齐到整分钟：定时任务按分钟检查
		return once(Math.ceil(t / 60_000) * 60_000);
	}
	const every = /每\s*(\d+)\s*(分钟|小时)/.exec(text);
	if (every) {
		const n = +every[1];
		// */0 不是合法 cron；超过一个周期的（每 90 分钟）cron 表达不了，会被当成每小时一次，不如说没认出
		if (n < 1 || n > (every[2] === "分钟" ? 59 : 23)) return null;
		return { name, cron: every[2] === "分钟" ? `*/${n} * * * *` : `0 */${n} * * *` };
	}
	const clock = clockOf(text);
	if (!clock) return null;
	// 「每天 / 每周X / 每月N号 / 每个工作日」才是重复跑；正文里别处的「每」（「明天 9 点看看每个店」）不算
	if (!/每\s*(天|日|个?工作日|个?周末|个?(周|星期|礼拜)|个?月)/.test(text)) {
		const day = dayOf(text, new Date(now));
		if (day) return once(new Date(day.getFullYear(), day.getMonth(), day.getDate(), clock.h, clock.mi).getTime());
	}
	const month = /每个?月\s*(\d{1,2})\s*[号日]/.exec(text);
	if (month && (+month[1] < 1 || +month[1] > 31)) return null;
	const weekly = WEEKLY.exec(text);
	const dow = /工作日/.test(text) ? "1-5" : /周末/.test(text) ? "0,6" : weekly ? dowList(weekly[1]) : "*";
	return { name, cron: `${clock.mi} ${clock.h} ${month ? +month[1] : "*"} * ${month ? "*" : dow}` };
}

/** 编辑时的「时间」：5 段 cron 原样用，否则当一句话解析；认不出返回 null */
export const looksLikeCron = (v: string) => /^[\d*,/-]+(\s+[\d*,/-]+){4}$/.test(v.trim());
export const whenOf = (v: string, now = Date.now()): Omit<ParsedWhen, "name"> | null =>
	looksLikeCron(v) ? { cron: v.trim() } : parseOneLine(v, now);
