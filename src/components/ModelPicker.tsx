import { useQuery } from "@tanstack/react-query";
import { fetchModels } from "../lib/api";

const EFFORT: Record<string, string> = {
	off: "off（不思考）",
	minimal: "minimal",
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: "xhigh",
	max: "max",
};

/** effort 不在新模型支持的级别里时，退到最接近的较低一级 */
export function fitEffort(levels: string[], want: string) {
	if (levels.includes(want)) return want;
	const order = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
	for (let i = order.indexOf(want); i >= 0; i--) if (levels.includes(order[i])) return order[i];
	return levels[0] ?? "";
}

/** 模型 + effort：effort 只列出所选模型支持的级别 */
export function ModelPicker({
	model,
	thinking,
	onChange,
}: {
	model: string;
	thinking: string;
	onChange: (model: string, thinking: string) => void;
}) {
	const { data: models } = useQuery({ queryKey: ["models"], queryFn: fetchModels, staleTime: 600_000 });
	const levels = models?.find((m) => m.id === model)?.levels ?? [];
	return (
		<>
			<select
				value={model}
				title="模型"
				onChange={(e) => {
					const next = models?.find((m) => m.id === e.target.value);
					onChange(e.target.value, fitEffort(next?.levels ?? [], thinking));
				}}
			>
				{models?.map((m) => (
					<option key={m.id} value={m.id}>
						{m.name}
					</option>
				))}
			</select>
			<select value={thinking} title="effort（思考强度）" onChange={(e) => onChange(model, e.target.value)}>
				{levels.map((l) => (
					<option key={l} value={l}>
						effort: {EFFORT[l] ?? l}
					</option>
				))}
			</select>
		</>
	);
}
