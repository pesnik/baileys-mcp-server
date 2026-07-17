import { DatabaseSync } from "node:sqlite";
import * as path from "node:path";
import * as fs from "node:fs";

export interface Chat {
  jid: string;
  name: string | null;
  last_message_time: string | null;
  last_message: string | null;
  last_sender: string | null;
  last_is_from_me: boolean | null;
}

export interface Message {
  id: string;
  chat_jid: string;
  sender: string | null;
  content: string;
  timestamp: string;
  is_from_me: boolean;
  chat_name: string | null;
}

export interface Contact {
  jid: string;
  name: string | null;
  notify: string | null;
  phone_number: string | null;
}

let db: DatabaseSync | null = null;

function getDb(dataDir: string): DatabaseSync {
  if (!db) {
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    db = new DatabaseSync(path.join(dataDir, "whatsapp.db"));
    db.exec("PRAGMA journal_mode = WAL");
    db.exec(`CREATE TABLE IF NOT EXISTS chats (
      jid TEXT PRIMARY KEY,
      name TEXT,
      last_message_time TEXT
    )`);
    db.exec(`CREATE TABLE IF NOT EXISTS messages (
      id TEXT,
      chat_jid TEXT,
      sender TEXT,
      content TEXT,
      timestamp TEXT,
      is_from_me INTEGER,
      PRIMARY KEY (id, chat_jid),
      FOREIGN KEY (chat_jid) REFERENCES chats(jid) ON DELETE CASCADE
    )`);
    db.exec(`CREATE TABLE IF NOT EXISTS contacts (
      jid TEXT PRIMARY KEY,
      name TEXT,
      notify TEXT,
      phone_number TEXT
    )`);
    db.exec("CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_messages_chat_jid ON messages(chat_jid)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_chats_last_message_time ON chats(last_message_time)");
  }
  return db;
}

export function initDatabase(dataDir: string): void {
  getDb(dataDir);
}

export function storeChat(dataDir: string, chat: { jid: string; name?: string | null; last_message_time?: string | null }): void {
  const d = getDb(dataDir);
  try {
    const stmt = d.prepare(`INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)
      ON CONFLICT(jid) DO UPDATE SET name = COALESCE(excluded.name, name), last_message_time = COALESCE(excluded.last_message_time, last_message_time)`);
    stmt.run(chat.jid, chat.name ?? null, chat.last_message_time ?? null);
  } catch {}
}

export function storeMessage(dataDir: string, msg: Omit<Message, "chat_name">): void {
  const d = getDb(dataDir);
  try {
    storeChat(dataDir, { jid: msg.chat_jid, last_message_time: msg.timestamp });
    const stmt = d.prepare(`INSERT OR REPLACE INTO messages (id, chat_jid, sender, content, timestamp, is_from_me) VALUES (?, ?, ?, ?, ?, ?)`);
    stmt.run(msg.id, msg.chat_jid, msg.sender, msg.content, msg.timestamp, msg.is_from_me ? 1 : 0);
    const upd = d.prepare(`UPDATE chats SET last_message_time = MAX(COALESCE(last_message_time, '1970-01-01T00:00:00.000Z'), ?) WHERE jid = ?`);
    upd.run(msg.timestamp, msg.chat_jid);
  } catch {}
}

export function storeContact(dataDir: string, contact: Contact): void {
  const d = getDb(dataDir);
  try {
    const stmt = d.prepare(`INSERT INTO contacts (jid, name, notify, phone_number) VALUES (?, ?, ?, ?)
      ON CONFLICT(jid) DO UPDATE SET name = COALESCE(excluded.name, name), notify = COALESCE(excluded.notify, notify), phone_number = COALESCE(excluded.phone_number, phone_number)`);
    stmt.run(contact.jid, contact.name, contact.notify, contact.phone_number);
  } catch {}
}

export function getMessages(dataDir: string, chatJid: string, limit: number = 50, offset: number = 0): Message[] {
  const d = getDb(dataDir);
  try {
    const stmt = d.prepare(`SELECT m.*, c.name as chat_name FROM messages m JOIN chats c ON m.chat_jid = c.jid WHERE m.chat_jid = ? ORDER BY m.timestamp DESC LIMIT ? OFFSET ?`);
    return (stmt.all(chatJid, limit, offset) as any[]).map(rowToMessage);
  } catch { return []; }
}

export function getChats(dataDir: string, limit: number = 30, offset: number = 0, query?: string | null): Chat[] {
  const d = getDb(dataDir);
  try {
    let sql = `SELECT c.jid, COALESCE(c.name, ct.name, ct.notify, ct.phone_number) as name, c.last_message_time,
      (SELECT m.content FROM messages m WHERE m.chat_jid = c.jid ORDER BY m.timestamp DESC LIMIT 1) as last_message,
      (SELECT m.sender FROM messages m WHERE m.chat_jid = c.jid ORDER BY m.timestamp DESC LIMIT 1) as last_sender,
      (SELECT m.is_from_me FROM messages m WHERE m.chat_jid = c.jid ORDER BY m.timestamp DESC LIMIT 1) as last_is_from_me
      FROM chats c LEFT JOIN contacts ct ON c.jid = ct.jid`;
    const params: (string | number)[] = [];
    if (query) {
      sql += ` WHERE (LOWER(COALESCE(c.name, ct.name, ct.notify, ct.phone_number)) LIKE ? OR c.jid LIKE ?)`;
      params.push(`%${query.toLowerCase()}%`, `%${query.toLowerCase()}%`);
    }
    sql += ` ORDER BY c.last_message_time DESC NULLS LAST LIMIT ? OFFSET ?`;
    params.push(limit, offset);
    return (d.prepare(sql).all(...params) as any[]).map(rowToChat);
  } catch { return []; }
}

export function searchMessages(dataDir: string, searchQuery: string, chatJid?: string | null, limit: number = 20, offset: number = 0): Message[] {
  const d = getDb(dataDir);
  try {
    let sql = `SELECT m.*, COALESCE(c.name, ct.name, ct.notify, ct.phone_number) as chat_name FROM messages m JOIN chats c ON m.chat_jid = c.jid LEFT JOIN contacts ct ON c.jid = ct.jid WHERE LOWER(m.content) LIKE ?`;
    const params: (string | number)[] = [`%${searchQuery.toLowerCase()}%`];
    if (chatJid) { sql += ` AND m.chat_jid = ?`; params.push(chatJid); }
    sql += ` ORDER BY m.timestamp DESC LIMIT ? OFFSET ?`;
    params.push(limit, offset);
    return (d.prepare(sql).all(...params) as any[]).map(rowToMessage);
  } catch { return []; }
}

export function searchContacts(dataDir: string, query: string, limit: number = 20): { jid: string; name: string | null }[] {
  const d = getDb(dataDir);
  try {
    const stmt = d.prepare(`SELECT jid, COALESCE(name, notify, phone_number, jid) as name FROM contacts WHERE LOWER(COALESCE(name, notify, phone_number, jid)) LIKE ? LIMIT ?`);
    return (stmt.all(`%${query.toLowerCase()}%`, limit) as any[]).map((r: any) => ({ jid: r.jid, name: r.name }));
  } catch { return []; }
}

export function getChat(dataDir: string, jid: string): Chat | null {
  const d = getDb(dataDir);
  try {
    const stmt = d.prepare(`SELECT c.jid, COALESCE(c.name, ct.name, ct.notify, ct.phone_number) as name, c.last_message_time,
      (SELECT m.content FROM messages m WHERE m.chat_jid = c.jid ORDER BY m.timestamp DESC LIMIT 1) as last_message,
      (SELECT m.sender FROM messages m WHERE m.chat_jid = c.jid ORDER BY m.timestamp DESC LIMIT 1) as last_sender,
      (SELECT m.is_from_me FROM messages m WHERE m.chat_jid = c.jid ORDER BY m.timestamp DESC LIMIT 1) as last_is_from_me
      FROM chats c LEFT JOIN contacts ct ON c.jid = ct.jid WHERE c.jid = ?`);
    const row = stmt.get(jid) as any;
    return row ? rowToChat(row) : null;
  } catch { return null; }
}

export function getTotalChats(dataDir: string): number {
  const d = getDb(dataDir);
  try {
    const row = d.prepare("SELECT COUNT(*) as count FROM chats").get() as any;
    return row?.count ?? 0;
  } catch { return 0; }
}

function rowToMessage(row: any): Message {
  return { id: row.id, chat_jid: row.chat_jid, sender: row.sender, content: row.content, timestamp: row.timestamp, is_from_me: Boolean(row.is_from_me), chat_name: row.chat_name ?? null };
}

function rowToChat(row: any): Chat {
  return { jid: row.jid, name: row.name ?? null, last_message_time: row.last_message_time ?? null, last_message: row.last_message ?? null, last_sender: row.last_sender ?? null, last_is_from_me: row.last_is_from_me !== null ? Boolean(row.last_is_from_me) : null };
}
