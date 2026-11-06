import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// 开发时页面由 vite 提供，/api 转给后端进程（pnpm dev），后端需配置 DEV_ORIGIN=http://localhost:5173
export default defineConfig({
	server: {
		port: 5173,
		proxy: { "/api": { target: "http://127.0.0.1:10086", changeOrigin: true } },
	},
	plugins: [tailwindcss(), tanstackStart(), viteReact()],
});
