import { z } from "zod";
import QRCode from "qrcode";
export function registerTools(server, client) {
    server.registerTool("wa_get_qr", {
        title: "Get WhatsApp QR Code",
        description: `Get a QR code for pairing WhatsApp Web. Returns a data URI string that can be displayed as an image. Scan it with WhatsApp mobile (Settings > Linked Devices > Link a Device). Only needed when not yet authenticated.`,
        inputSchema: z.object({}).strict(),
        annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: false,
            openWorldHint: true,
        },
    }, async () => {
        try {
            const status = await client.getConnectionStatus();
            if (status.connected) {
                return {
                    content: [
                        {
                            type: "text",
                            text: "Already connected to WhatsApp. No QR needed.",
                        },
                    ],
                };
            }
            const qrString = await client.getQR();
            const qrDataUri = await QRCode.toDataURL(qrString, {
                width: 400,
                margin: 2,
            });
            return {
                content: [
                    {
                        type: "text",
                        text: `Scan this QR code with your WhatsApp mobile app:\n\n![QR Code](${qrDataUri})`,
                    },
                ],
            };
        }
        catch (error) {
            return {
                isError: true,
                content: [
                    {
                        type: "text",
                        text: `Error getting QR code: ${error instanceof Error ? error.message : String(error)}`,
                    },
                ],
            };
        }
    });
    server.registerTool("wa_connection_status", {
        title: "WhatsApp Connection Status",
        description: `Check the current WhatsApp connection state. Returns whether the client is connected, the JID, phone number, platform, and uptime.`,
        inputSchema: z.object({}).strict(),
        annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
        },
    }, async () => {
        try {
            const status = await client.getConnectionStatus();
            return {
                content: [
                    {
                        type: "text",
                        text: status.connected
                            ? `Connected ✓\nJID: ${status.jid}\nPhone: ${status.phone}\nPlatform: ${status.platform}\nUptime: ${status.uptimeMs ? Math.round(status.uptimeMs / 1000) + "s" : "N/A"}`
                            : "Not connected. Run wa_get_qr to pair.",
                    },
                ],
            };
        }
        catch (error) {
            return {
                isError: true,
                content: [
                    {
                        type: "text",
                        text: `Error: ${error instanceof Error ? error.message : String(error)}`,
                    },
                ],
            };
        }
    });
    server.registerTool("wa_send_message", {
        title: "Send WhatsApp Message",
        description: `Send a text message to a WhatsApp user or group. Requires the recipient's JID (e.g., "123456789@s.whatsapp.net" for users, "groupid@g.us" for groups).`,
        inputSchema: z
            .object({
            jid: z
                .string()
                .min(1)
                .describe("Recipient JID. For users: phone@s.whatsapp.net (e.g., 8801700000000@s.whatsapp.net). For groups: groupid@g.us"),
            message: z
                .string()
                .min(1)
                .max(65536)
                .describe("Message text to send"),
        })
            .strict(),
        annotations: {
            readOnlyHint: false,
            destructiveHint: false,
            idempotentHint: false,
            openWorldHint: true,
        },
    }, async (params) => {
        try {
            if (!client.isConnected()) {
                return {
                    isError: true,
                    content: [
                        {
                            type: "text",
                            text: "Not connected to WhatsApp. Run wa_get_qr to pair first.",
                        },
                    ],
                };
            }
            const msgId = await client.sendMessage(params.jid, params.message);
            return {
                content: [
                    {
                        type: "text",
                        text: `Message sent to ${params.jid} (ID: ${msgId})`,
                    },
                ],
            };
        }
        catch (error) {
            return {
                isError: true,
                content: [
                    {
                        type: "text",
                        text: `Error sending message: ${error instanceof Error ? error.message : String(error)}`,
                    },
                ],
            };
        }
    });
    server.registerTool("wa_send_image", {
        title: "Send WhatsApp Image",
        description: `Send an image to a WhatsApp user or group. Provide a publicly accessible image URL. Optionally include a caption.`,
        inputSchema: z
            .object({
            jid: z.string().min(1).describe("Recipient JID"),
            url: z
                .string()
                .url()
                .describe("Public URL of the image to send"),
            caption: z
                .string()
                .max(4096)
                .optional()
                .describe("Optional caption for the image"),
        })
            .strict(),
        annotations: {
            readOnlyHint: false,
            destructiveHint: false,
            idempotentHint: false,
            openWorldHint: true,
        },
    }, async (params) => {
        try {
            if (!client.isConnected()) {
                return {
                    isError: true,
                    content: [
                        {
                            type: "text",
                            text: "Not connected to WhatsApp.",
                        },
                    ],
                };
            }
            const msgId = await client.sendImage(params.jid, params.url, params.caption);
            return {
                content: [
                    {
                        type: "text",
                        text: `Image sent to ${params.jid} (ID: ${msgId})${params.caption ? ` with caption: "${params.caption}"` : ""}`,
                    },
                ],
            };
        }
        catch (error) {
            return {
                isError: true,
                content: [
                    {
                        type: "text",
                        text: `Error sending image: ${error instanceof Error ? error.message : String(error)}`,
                    },
                ],
            };
        }
    });
    server.registerTool("wa_list_chats", {
        title: "List WhatsApp Chats",
        description: `List recent WhatsApp chats with their names, unread counts, and last message. Use pagination to control results.`,
        inputSchema: z
            .object({
            limit: z
                .number()
                .int()
                .min(1)
                .max(100)
                .default(30)
                .describe("Maximum number of chats to return (default: 30)"),
            offset: z
                .number()
                .int()
                .min(0)
                .default(0)
                .describe("Number of chats to skip for pagination (default: 0)"),
        })
            .strict(),
        annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
        },
    }, async (params) => {
        try {
            if (!client.isConnected()) {
                return {
                    isError: true,
                    content: [{ type: "text", text: "Not connected to WhatsApp." }],
                };
            }
            const all = client.listChats();
            const total = all.length;
            const chats = all.slice(params.offset, params.offset + params.limit);
            const hasMore = total > params.offset + chats.length;
            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify({
                            total,
                            count: chats.length,
                            offset: params.offset,
                            chats: chats.map((c) => ({
                                jid: c.jid,
                                name: c.name,
                                unread: c.unreadCount,
                            })),
                            has_more: hasMore,
                            next_offset: hasMore ? params.offset + chats.length : undefined,
                        }, null, 2),
                    },
                ],
            };
        }
        catch (error) {
            return {
                isError: true,
                content: [
                    {
                        type: "text",
                        text: `Error listing chats: ${error instanceof Error ? error.message : String(error)}`,
                    },
                ],
            };
        }
    });
    server.registerTool("wa_list_messages", {
        title: "List WhatsApp Messages",
        description: `Retrieve recent messages from a specific chat. Provide the chat JID to get message history.`,
        inputSchema: z
            .object({
            jid: z.string().min(1).describe("Chat JID to load messages from"),
            limit: z
                .number()
                .int()
                .min(1)
                .max(200)
                .default(50)
                .describe("Number of messages to load (default: 50, max: 200)"),
        })
            .strict(),
        annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
        },
    }, async (params) => {
        try {
            if (!client.isConnected()) {
                return {
                    isError: true,
                    content: [{ type: "text", text: "Not connected to WhatsApp." }],
                };
            }
            const messages = client.listMessages(params.jid, params.limit);
            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify({
                            jid: params.jid,
                            count: messages.length,
                            messages: messages.map((m) => ({
                                id: m.id,
                                text: m.text,
                                fromMe: m.fromMe,
                                sender: m.sender,
                                timestamp: m.timestamp,
                                type: m.type,
                            })),
                        }, null, 2),
                    },
                ],
            };
        }
        catch (error) {
            return {
                isError: true,
                content: [
                    {
                        type: "text",
                        text: `Error listing messages: ${error instanceof Error ? error.message : String(error)}`,
                    },
                ],
            };
        }
    });
    server.registerTool("wa_search_contacts", {
        title: "Search WhatsApp Contacts",
        description: `Search WhatsApp contacts and chats by name or JID. Returns matching contacts with their JID and type (user vs group).`,
        inputSchema: z
            .object({
            query: z
                .string()
                .min(1)
                .max(200)
                .describe("Search query to match against contact names or JIDs"),
        })
            .strict(),
        annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
        },
    }, async (params) => {
        try {
            if (!client.isConnected()) {
                return {
                    isError: true,
                    content: [{ type: "text", text: "Not connected to WhatsApp." }],
                };
            }
            const contacts = client.searchContacts(params.query);
            return {
                content: [
                    {
                        type: "text",
                        text: contacts.length === 0
                            ? `No contacts found matching "${params.query}"`
                            : JSON.stringify({
                                query: params.query,
                                count: contacts.length,
                                contacts,
                            }, null, 2),
                    },
                ],
            };
        }
        catch (error) {
            return {
                isError: true,
                content: [
                    {
                        type: "text",
                        text: `Error searching contacts: ${error instanceof Error ? error.message : String(error)}`,
                    },
                ],
            };
        }
    });
    server.registerTool("wa_list_groups", {
        title: "List WhatsApp Groups",
        description: `List all WhatsApp groups the account is a member of. Returns group JID, name, and member count.`,
        inputSchema: z.object({}).strict(),
        annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
        },
    }, async () => {
        try {
            if (!client.isConnected()) {
                return {
                    isError: true,
                    content: [{ type: "text", text: "Not connected to WhatsApp." }],
                };
            }
            const groups = client.listGroups();
            return {
                content: [
                    {
                        type: "text",
                        text: groups.length === 0
                            ? "No groups found."
                            : JSON.stringify({
                                count: groups.length,
                                groups,
                            }, null, 2),
                    },
                ],
            };
        }
        catch (error) {
            return {
                isError: true,
                content: [
                    {
                        type: "text",
                        text: `Error listing groups: ${error instanceof Error ? error.message : String(error)}`,
                    },
                ],
            };
        }
    });
}
//# sourceMappingURL=tools.js.map