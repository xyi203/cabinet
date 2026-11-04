// 飞书消息、会话、事件的形状：bot.ts、card.ts 和业务模块共用

export interface Mention {
	key: string;
	id: string;
	name: string;
}

export interface Message {
	message_id: string;
	content: string;
	/** 毫秒 */
	create_time: number;
	message_position: number;
	parent_id?: string;
	root_id?: string;
	thread_id?: string;
	deleted?: boolean;
	mentions: Mention[];
	sender: { id: string; name: string; sender_type: string };
	meego?: unknown;
	/** 卡片消息里 @ 到的人：名字 -> 飞书 user_id */
	userIds?: Record<string, string>;
}

export interface Chat {
	chat_id: string;
	chat_mode: string; // p2p / group / topic；飞书项目通知归为 meego
	name: string;
	p2p_target_type?: string;
}

export type UserTarget = { chatId: string } | { replyTo: string; inThread: boolean };

export interface BotEvent {
	messageId: string;
	chatId: string;
	chatType: string; // p2p / group
	senderType: string;
	senderId: string;
	rootId?: string;
	parentId?: string;
	threadId?: string;
	content: string;
	mentions: Mention[];
}
