// 报告协议里前后端都要用的常量。不依赖 zod 和 @a2ui/*：看板前端只引这个文件，不把 web_core 打进页面。
export const CATALOG_ID = "https://cabinet.local/a2ui/report/v1";
export const PROTOCOL_VERSION = "1.0";
/** 回到原会话继续对话的按钮动作：event.name 固定是这个，要说的话放 context.text */
export const REPLY_EVENT = "reply";
