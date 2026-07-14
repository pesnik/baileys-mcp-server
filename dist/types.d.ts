export interface BaileysStore {
    chats: Map<string, any>;
    messages: Map<string, any[]>;
}
export interface ConnectionData {
    connected: boolean;
    jid?: string;
    phone?: string;
    platform?: string;
    uptimeMs?: number;
}
export interface ChatInfo {
    jid: string;
    name: string;
    unreadCount: number;
    lastMessage?: {
        text: string;
        timestamp: number;
        fromMe: boolean;
    };
}
export interface ContactInfo {
    jid: string;
    name?: string;
    phone?: string;
    isGroup: boolean;
}
export interface MessageInfo {
    id: string;
    text: string;
    fromMe: boolean;
    sender?: string;
    timestamp: number;
    type: string;
}
//# sourceMappingURL=types.d.ts.map