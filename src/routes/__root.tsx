import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { HeadContent, Outlet, Scripts, createRootRoute } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import { ConfirmHost } from "../components/Confirm";
import appCss from "../styles.css?url";

export const Route = createRootRoute({
	head: () => ({
		meta: [{ charSet: "utf-8" }, { name: "viewport", content: "width=device-width, initial-scale=1" }, { title: "Cabinet" }],
		links: [
			{ rel: "stylesheet", href: appCss },
			// 等宽数字和印章字；断网时退回系统字体
			{ rel: "stylesheet", href: "https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500&display=swap" },
			{ rel: "stylesheet", href: "https://fonts.googleapis.com/css2?family=Noto+Serif+SC:wght@700&text=%E9%98%81&display=swap" },
		],
	}),
	shellComponent: RootDocument,
	component: RootComponent,
});

function RootComponent() {
	const [client] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: true } } }));
	return (
		<QueryClientProvider client={client}>
			<Outlet />
			<ConfirmHost />
		</QueryClientProvider>
	);
}

function RootDocument({ children }: { children: ReactNode }) {
	return (
		<html lang="zh-CN">
			<head>
				<HeadContent />
			</head>
			<body>
				{children}
				<Scripts />
			</body>
		</html>
	);
}
