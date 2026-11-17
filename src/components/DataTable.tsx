// 通用数据表（TanStack Table v9，headless）：表格本体 + 分页条。
// 调用方用 useTable 建表（features 用这里导出的 pageFeatures），服务端分页时传 manualPagination + rowCount，
// 分页状态受控在调用方（state.pagination / onPaginationChange），放进 useQuery 的 key 里
import { type PaginationState, type ReactTable, type RowData, rowPaginationFeature, tableFeatures } from "@tanstack/react-table";
import { type ReactNode, useState } from "react";

export const pageFeatures = tableFeatures({ rowPaginationFeature });
export type PageTable<T extends RowData> = ReactTable<typeof pageFeatures, T>;
export type { PaginationState };

export const PAGE_SIZES = [20, 50, 100];

/**
 * 表格本体。colClass 按列 id 给 th/td 加类（宽度、窄屏隐藏）；
 * loading 时保留上一页内容、整体变淡，不闪空
 */
export function DataTable<T extends RowData>({
	table,
	colClass = {},
	empty = "没有数据。",
	loading,
}: {
	table: PageTable<T>;
	colClass?: Record<string, string>;
	empty?: ReactNode;
	loading?: boolean;
}) {
	const rows = table.getRowModel().rows;
	return (
		<div className={`overflow-x-auto transition-opacity ${loading ? "opacity-60" : ""}`}>
			<table className="w-full table-fixed border-collapse text-[14px]">
				<thead>
					{table.getHeaderGroups().map((group) => (
						<tr key={group.id} className="border-b border-line">
							{group.headers.map((header) => (
								<th
									key={header.id}
									className={`px-2 py-2 text-left text-[12px] font-normal whitespace-nowrap text-muted first:pl-1 ${colClass[header.column.id] ?? ""}`}
								>
									{header.isPlaceholder ? null : <table.FlexRender header={header} />}
								</th>
							))}
						</tr>
					))}
				</thead>
				<tbody>
					{rows.length ? (
						rows.map((row) => (
							<tr key={row.id} className="border-b border-line align-top last:border-b-0 hover:bg-bg">
								{row.getAllCells().map((cell) => (
									<td key={cell.id} className={`px-2 py-2.5 text-text first:pl-1 ${colClass[cell.column.id] ?? ""}`}>
										<table.FlexRender cell={cell} />
									</td>
								))}
							</tr>
						))
					) : (
						<tr>
							<td colSpan={table.getAllLeafColumns().length} className="px-1 py-6 text-center text-muted">
								{loading ? "加载中…" : empty}
							</td>
						</tr>
					)}
				</tbody>
			</table>
		</div>
	);
}

/** 页码按钮：首尾页常驻，当前页前后各一页，中间用省略号 */
export function pageItems(current: number, count: number): Array<number | "…"> {
	if (count <= 7) return Array.from({ length: count }, (_, i) => i);
	const out: Array<number | "…"> = [0];
	const from = Math.max(1, Math.min(current - 1, count - 4));
	const to = Math.min(count - 2, Math.max(current + 1, 3));
	if (from > 1) out.push("…");
	for (let i = from; i <= to; i++) out.push(i);
	if (to < count - 2) out.push("…");
	out.push(count - 1);
	return out;
}

const pageBtn =
	"min-w-[30px] cursor-pointer rounded-[8px] border-0 px-2 py-1 text-[13px] tabular-nums disabled:cursor-default disabled:opacity-40";

/** 分页条：共几条、当前范围、每页条数、首页 / 上一页 / 页码 / 下一页 / 末页、跳页 */
export function Pagination<T extends RowData>({ table, sizes = PAGE_SIZES }: { table: PageTable<T>; sizes?: number[] }) {
	const { pageIndex, pageSize } = table.state.pagination;
	const total = table.getRowCount();
	const count = Math.max(1, table.getPageCount());
	const [jump, setJump] = useState("");
	if (!total) return null;
	const from = pageIndex * pageSize + 1;
	const to = Math.min(total, from + pageSize - 1);
	const go = () => {
		const n = Number(jump);
		if (Number.isInteger(n) && n >= 1 && n <= count) table.setPageIndex(n - 1);
		setJump("");
	};
	return (
		<nav aria-label="分页" className="flex flex-wrap items-center gap-x-3 gap-y-2 text-[12px] text-muted">
			<span className="tabular-nums">
				第 {from}–{to} 条，共 {total} 条
			</span>
			<label className="flex items-center gap-1">
				每页
				<select
					className="rounded-[6px] border-0 bg-soft px-1.5 py-0.5 text-[12px] text-text [font:inherit]"
					value={pageSize}
					onChange={(e) => {
						table.setPageSize(Number(e.target.value));
						table.setPageIndex(0);
					}}
				>
					{sizes.map((s) => (
						<option key={s} value={s}>
							{s}
						</option>
					))}
				</select>
				条
			</label>
			<div className="ml-auto flex items-center gap-0.5">
				<button
					type="button"
					className={`${pageBtn} bg-transparent text-text-2 hover:bg-soft`}
					aria-label="第一页"
					disabled={!table.getCanPreviousPage()}
					onClick={() => table.firstPage()}
				>
					«
				</button>
				<button
					type="button"
					className={`${pageBtn} bg-transparent text-text-2 hover:bg-soft`}
					aria-label="上一页"
					disabled={!table.getCanPreviousPage()}
					onClick={() => table.previousPage()}
				>
					‹
				</button>
				{pageItems(pageIndex, count).map((p, i) =>
					p === "…" ? (
						<span key={`gap${i}`} className="px-1">
							…
						</span>
					) : (
						<button
							key={p}
							type="button"
							aria-current={p === pageIndex ? "page" : undefined}
							className={`${pageBtn} ${p === pageIndex ? "bg-accent-soft font-semibold text-accent" : "bg-transparent text-text-2 hover:bg-soft"}`}
							onClick={() => table.setPageIndex(p)}
						>
							{p + 1}
						</button>
					),
				)}
				<button
					type="button"
					className={`${pageBtn} bg-transparent text-text-2 hover:bg-soft`}
					aria-label="下一页"
					disabled={!table.getCanNextPage()}
					onClick={() => table.nextPage()}
				>
					›
				</button>
				<button
					type="button"
					className={`${pageBtn} bg-transparent text-text-2 hover:bg-soft`}
					aria-label="最后一页"
					disabled={!table.getCanNextPage()}
					onClick={() => table.lastPage()}
				>
					»
				</button>
				{count > 7 && (
					<input
						className="ml-1 w-[52px] rounded-[6px] border-0 bg-soft px-1.5 py-0.5 text-[12px] text-text tabular-nums [font:inherit]"
						aria-label="跳到第几页"
						inputMode="numeric"
						placeholder="跳页"
						value={jump}
						onChange={(e) => setJump(e.target.value.replace(/\D/g, ""))}
						onKeyDown={(e) => e.key === "Enter" && go()}
					/>
				)}
			</div>
		</nav>
	);
}
