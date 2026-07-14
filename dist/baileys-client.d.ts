import { EventEmitter } from "node:events";
import type { ConnectionData } from "./types.js";
interface StoredChat {
    jid: string;
    name: string;
    unreadCount: number;
}
interface StoredMessage {
    id: string;
    text: string;
    fromMe: boolean;
    sender?: string;
    timestamp: number;
    type: string;
    chatJid: string;
}
export declare class BaileysClient extends EventEmitter {
    private sock;
    private authDir;
    private startTime;
    private connected;
    private qrResolve;
    private qrPromise;
    private chats;
    private messages;
    constructor(authDir: string);
    private createQRPromise;
    private extractText;
    private upsertChat;
    private upsertMessage;
    connect(): Promise<void>;
    getQR(): Promise<string>;
    getConnectionStatus(): Promise<ConnectionData>;
    sendMessage(jid: string, text: string): Promise<string>;
    sendImage(jid: string, url: string, caption?: string): Promise<string>;
    listChats(): StoredChat[];
    listMessages(jid: string, limit?: number): StoredMessage[];
    searchContacts(query: string): StoredChat[];
    listGroups(): StoredChat[];
    disconnect(): Promise<void>;
    isConnected(): boolean;
}
export {};
//# sourceMappingURL=baileys-client.d.ts.map