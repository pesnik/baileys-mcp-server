import {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  type WAMessage,
  type WASocket,
  type Chat,
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import * as fs from "node:fs";
import * as path from "node:path";
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

export class BaileysClient extends EventEmitter {
  private sock: WASocket | null = null;
  private authDir: string;
  private startTime: number = 0;
  private connected: boolean = false;
  private qrResolve: ((qr: string) => void) | null = null;
  private qrPromise: Promise<string> | null = null;
  private chats: Map<string, StoredChat> = new Map();
  private messages: Map<string, StoredMessage[]> = new Map();

  constructor(authDir: string) {
    super();
    this.authDir = path.resolve(authDir);
    if (!fs.existsSync(this.authDir)) {
      fs.mkdirSync(this.authDir, { recursive: true });
    }
  }

  private createQRPromise(): Promise<string> {
    this.qrPromise = new Promise((resolve) => {
      this.qrResolve = resolve;
    });
    return this.qrPromise;
  }

  private extractText(msg: WAMessage): string {
    const m = msg.message;
    if (!m) return "[empty message]";
    return (
      m.conversation ||
      m.extendedTextMessage?.text ||
      m.imageMessage?.caption ||
      m.videoMessage?.caption ||
      m.documentMessage?.caption ||
      "[non-text message]"
    );
  }

  private upsertChat(id: string | null | undefined, name?: string | null, unreadCount?: number | null): void {
    if (!id) return;
    const existing = this.chats.get(id);
    this.chats.set(id, {
      jid: id,
      name: name || existing?.name || id.split("@")[0],
      unreadCount: unreadCount ?? existing?.unreadCount ?? 0,
    });
  }

  private upsertMessage(msg: WAMessage): void {
    const jid = msg.key?.remoteJid;
    if (!jid) return;
    if (!this.messages.has(jid)) {
      this.messages.set(jid, []);
    }
    const msgs = this.messages.get(jid)!;
    const idx = msgs.findIndex((m) => m.id === msg.key?.id);
    const entry: StoredMessage = {
      id: msg.key?.id || "",
      text: this.extractText(msg),
      fromMe: msg.key?.fromMe ?? false,
      sender: msg.key?.participant || msg.key?.remoteJid || undefined,
      timestamp:
        typeof msg.messageTimestamp === "number"
          ? msg.messageTimestamp
          : Date.now(),
      type: Object.keys(msg.message || {})[0] || "unknown",
      chatJid: jid,
    };
    if (idx >= 0) {
      msgs[idx] = entry;
    } else {
      msgs.push(entry);
    }
    msgs.sort((a, b) => b.timestamp - a.timestamp);
  }

  async connect(): Promise<void> {
    const { state, saveCreds } = await useMultiFileAuthState(this.authDir);
    this.startTime = Date.now();

    this.sock = makeWASocket({
      auth: state,
      syncFullHistory: false,
      emitOwnEvents: false,
      generateHighQualityLinkPreview: true,
      qrTimeout: 120_000,
    });

    this.sock.ev.on("creds.update", saveCreds);
    this.createQRPromise();

    this.sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr && this.qrResolve) {
        this.qrResolve(qr);
        this.qrResolve = null;
      }

      if (connection === "close") {
        const shouldReconnect =
          (lastDisconnect?.error as Boom)?.output?.statusCode !==
          DisconnectReason.loggedOut;

        this.connected = false;
        this.emit("disconnected");

        if (shouldReconnect) {
          console.error("Connection closed, reconnecting...");
          await this.connect();
        } else {
          console.error("Logged out, delete auth dir to re-pair");
        }
      } else if (connection === "open") {
        this.connected = true;
        const user = this.sock?.user;
        this.emit("connected", {
          jid: user?.id,
          phone: user?.id ? user.id.split("@")[0] : undefined,
        });
      }
    });

    this.sock.ev.on("messaging-history.set", ({ chats, messages }) => {
      for (const chat of chats) {
        this.upsertChat(chat.id, chat.name, chat.unreadCount);
      }
      for (const msg of messages) {
        this.upsertMessage(msg);
      }
    });

    this.sock.ev.on("chats.upsert", (chats) => {
      for (const chat of chats) {
        this.upsertChat(chat.id, chat.name, chat.unreadCount);
      }
    });

    this.sock.ev.on("chats.update", (updates) => {
      for (const update of updates) {
        if (update.id) {
          this.upsertChat(update.id, "name" in update ? update.name : undefined, "unreadCount" in update ? update.unreadCount : undefined);
        }
      }
    });

    this.sock.ev.on("messages.upsert", ({ messages }) => {
      for (const msg of messages) {
        this.upsertMessage(msg);
      }
    });
  }

  async getQR(): Promise<string> {
    if (this.connected) {
      throw new Error("Already connected. No QR needed.");
    }
    if (!this.qrPromise) {
      return this.createQRPromise();
    }
    return this.qrPromise;
  }

  async getConnectionStatus(): Promise<ConnectionData> {
    if (!this.sock || !this.connected) {
      return { connected: false };
    }
    return {
      connected: true,
      jid: this.sock.user?.id,
      phone: this.sock.user?.id?.split("@")[0],
      uptimeMs: Date.now() - this.startTime,
    };
  }

  async sendMessage(jid: string, text: string): Promise<string> {
    if (!this.sock || !this.connected) {
      throw new Error("Not connected to WhatsApp");
    }
    const result = await this.sock.sendMessage(jid, { text });
    return result?.key?.id || "unknown";
  }

  async sendImage(jid: string, url: string, caption?: string): Promise<string> {
    if (!this.sock || !this.connected) {
      throw new Error("Not connected to WhatsApp");
    }
    const result = await this.sock.sendMessage(jid, {
      image: { url },
      caption,
    });
    return result?.key?.id || "unknown";
  }

  listChats(): StoredChat[] {
    return Array.from(this.chats.values());
  }

  listMessages(jid: string, limit: number = 50): StoredMessage[] {
    const msgs = this.messages.get(jid) || [];
    return msgs.slice(0, limit);
  }

  searchContacts(query: string): StoredChat[] {
    const q = query.toLowerCase();
    return Array.from(this.chats.values())
      .filter((c) => c.name.toLowerCase().includes(q) || c.jid.toLowerCase().includes(q))
      .slice(0, 20);
  }

  listGroups(): StoredChat[] {
    return Array.from(this.chats.values()).filter((c) =>
      c.jid.endsWith("@g.us"),
    );
  }

  async disconnect(): Promise<void> {
    if (this.sock) {
      await this.sock.end(undefined);
      this.sock = null;
    }
    this.connected = false;
    this.chats.clear();
    this.messages.clear();
  }

  isConnected(): boolean {
    return this.connected;
  }
}
