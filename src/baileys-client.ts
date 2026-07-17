import {
  makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  DisconnectReason,
  isJidGroup,
  jidNormalizedUser,
  type WAMessage,
  type WASocket,
  type Chat,
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import * as fs from "node:fs";
import * as path from "node:path";
import { EventEmitter } from "node:events";
import pino from "pino";
import * as db from "./database.js";
import type { ConnectionData } from "./types.js";

export class BaileysClient extends EventEmitter {
  private sock: WASocket | null = null;
  private authDir: string;
  private dataDir: string;
  private startTime: number = 0;
  private qrResolve: ((qr: string) => void) | null = null;
  private qrPromise: Promise<string> | null = null;
  private logger: pino.Logger;
  private _connected: boolean = false;

  constructor(authDir: string, dataDir: string) {
    super();
    this.authDir = path.resolve(authDir);
    this.dataDir = path.resolve(dataDir);
    if (!fs.existsSync(this.authDir)) {
      fs.mkdirSync(this.authDir, { recursive: true });
    }
    db.initDatabase(this.dataDir);
    this.logger = pino(
      { level: "info", timestamp: pino.stdTimeFunctions.isoTime },
      pino.destination(path.join(this.dataDir, "wa-logs.txt")),
    );
  }

  isConnected(): boolean {
    return this._connected;
  }

  private createQRPromise(): Promise<string> {
    this.qrPromise = new Promise((resolve) => {
      this.qrResolve = resolve;
    });
    return this.qrPromise;
  }

  private parseMessage(msg: WAMessage): Omit<db.Message, "chat_name"> | null {
    if (!msg.message || !msg.key || !msg.key.remoteJid) return null;
    let content: string | null = null;
    const m = msg.message;
    if (m.conversation) content = m.conversation;
    else if (m.extendedTextMessage?.text) content = m.extendedTextMessage.text;
    else if (m.imageMessage?.caption) content = `[Image] ${m.imageMessage.caption}`;
    else if (m.videoMessage?.caption) content = `[Video] ${m.videoMessage.caption}`;
    else if (m.documentMessage?.caption) content = `[Document] ${m.documentMessage.caption || m.documentMessage.fileName || ""}`;
    else if (m.audioMessage) content = "[Audio]";
    else if (m.stickerMessage) content = "[Sticker]";
    else if (m.contactMessage?.displayName) content = `[Contact] ${m.contactMessage.displayName}`;
    else if (m.pollCreationMessage?.name) content = `[Poll] ${m.pollCreationMessage.name}`;
    if (!content) return null;
    let ts = Date.now();
    if (msg.messageTimestamp != null) ts = Number(msg.messageTimestamp) * 1000;
    let sender: string | null | undefined = msg.key.participant;
    if (!msg.key.fromMe && !sender && !isJidGroup(msg.key.remoteJid)) sender = msg.key.remoteJid;
    if (msg.key.fromMe && !isJidGroup(msg.key.remoteJid)) sender = null;
    return {
      id: msg.key.id!,
      chat_jid: msg.key.remoteJid,
      sender: sender ? jidNormalizedUser(sender) : null,
      content,
      timestamp: new Date(ts).toISOString(),
      is_from_me: msg.key.fromMe ?? false,
    };
  }

  async connect(): Promise<void> {
    if (this.sock) {
      try { await this.sock.end(undefined); } catch {}
      this.sock = null;
    }
    this._connected = false;

    const { state, saveCreds } = await useMultiFileAuthState(this.authDir);
    const { version, isLatest } = await fetchLatestBaileysVersion();
    this.logger.info({ version, isLatest }, "Baileys version");

    this.startTime = Date.now();
    this.sock = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, this.logger),
      },
      syncFullHistory: true,
      logger: this.logger,
      generateHighQualityLinkPreview: true,
      markOnlineOnConnect: false,
    });

    this.createQRPromise();

    this.sock.ev.process(async (events) => {
      if (events["connection.update"]) {
        const { connection, lastDisconnect, qr } = events["connection.update"];
        if (qr && this.qrResolve) {
          this.qrResolve(qr);
          this.qrResolve = null;
        }
        if (connection === "close") {
          const code = (lastDisconnect?.error as Boom)?.output?.statusCode;
          const shouldReconnect = code !== DisconnectReason.loggedOut;
          this._connected = false;
          this.emit("disconnected");
          this.logger.warn({ code }, "connection closed");
          if (shouldReconnect) {
            setTimeout(() => this.connect(), 3000);
          } else {
            this.logger.error("logged out");
          }
        } else if (connection === "open") {
          this._connected = true;
          this.logger.info({ jid: this.sock?.user?.id }, "connected");
          this.emit("connected", {
            jid: this.sock?.user?.id,
            phone: this.sock?.user?.id?.split("@")[0],
          });
        }
      }

      if (events["creds.update"]) {
        await saveCreds();
      }

      if (events["messaging-history.set"]) {
        const { chats, contacts, messages } = events["messaging-history.set"];
        this.logger.info({ chats: chats.length, contacts: contacts.length, messages: messages.length }, "history sync");
        for (const c of contacts) {
          db.storeContact(this.dataDir, {
            jid: c.id,
            name: c.name ?? null,
            notify: c.notify ?? null,
            phone_number: (c as any).phoneNumber ?? null,
          });
        }
        for (const chat of chats) {
          const name = chat.name || chat.id?.split("@")[0] || null;
          db.storeChat(this.dataDir, {
            jid: chat.id!,
            name,
            last_message_time: chat.conversationTimestamp
              ? new Date(Number(chat.conversationTimestamp) * 1000).toISOString()
              : null,
          });
        }
        for (const msg of messages) {
          const parsed = this.parseMessage(msg);
          if (parsed) db.storeMessage(this.dataDir, parsed);
        }
      }

      if (events["messages.upsert"]) {
        const { messages } = events["messages.upsert"];
        for (const msg of messages) {
          const parsed = this.parseMessage(msg);
          if (parsed) db.storeMessage(this.dataDir, parsed);
        }
      }

      if (events["chats.upsert"]) {
        for (const chat of events["chats.upsert"]) {
          db.storeChat(this.dataDir, {
            jid: chat.id!,
            name: chat.name,
            last_message_time: chat.conversationTimestamp
              ? new Date(Number(chat.conversationTimestamp) * 1000).toISOString()
              : null,
          });
        }
      }

      if (events["chats.update"]) {
        for (const update of events["chats.update"]) {
          db.storeChat(this.dataDir, {
            jid: update.id!,
            name: update.name,
            last_message_time: update.conversationTimestamp
              ? new Date(Number(update.conversationTimestamp) * 1000).toISOString()
              : null,
          });
        }
      }
    });
  }

  async getQR(): Promise<string> {
    if (this._connected) throw new Error("Already connected.");
    if (!this.qrPromise) this.createQRPromise();
    return this.qrPromise!;
  }

  async getConnectionStatus(): Promise<ConnectionData> {
    if (!this.sock || !this._connected) {
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
    if (!this.sock) throw new Error("Not connected to WhatsApp");
    const result = await this.sock.sendMessage(jid, { text });
    return result?.key?.id || "unknown";
  }

  async sendImage(jid: string, url: string, caption?: string): Promise<string> {
    if (!this.sock) throw new Error("Not connected to WhatsApp");
    const result = await this.sock.sendMessage(jid, { image: { url }, caption });
    return result?.key?.id || "unknown";
  }

  listChats(limit: number = 30, offset: number = 0, query?: string | null): db.Chat[] {
    return db.getChats(this.dataDir, limit, offset, query);
  }

  listMessages(jid: string, limit: number = 50, offset: number = 0): db.Message[] {
    return db.getMessages(this.dataDir, jid, limit, offset);
  }

  searchContacts(query: string): { jid: string; name: string | null }[] {
    return db.searchContacts(this.dataDir, query);
  }

  listGroups(): db.Chat[] {
    return db.getChats(this.dataDir, 100, 0).filter((c) => c.jid.endsWith("@g.us"));
  }

  getTotalChats(): number {
    return db.getTotalChats(this.dataDir);
  }

  async disconnect(): Promise<void> {
    if (this.sock) {
      await this.sock.end(undefined);
      this.sock = null;
    }
    this._connected = false;
  }
}
