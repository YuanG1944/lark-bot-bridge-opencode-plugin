import * as lark from '@larksuiteoapi/node-sdk';
import * as http from 'http';
import * as crypto from 'crypto';
import type { FeishuConfig } from './types';

const globalState = globalThis as any;
const processedMessageIds = globalState.__feishu_processed_ids || new Set<string>();
globalState.__feishu_processed_ids = processedMessageIds;

type MessageHandler = (
  chatId: string,
  text: string,
  messageId: string,
  senderId: string,
) => Promise<void>;

function decryptEvent(encrypted: string, encryptKey: string): string {
  const key = crypto.createHash('sha256').update(encryptKey).digest();
  const encryptedBuffer = Buffer.from(encrypted, 'base64');
  const iv = encryptedBuffer.subarray(0, 16);
  const ciphertext = encryptedBuffer.subarray(16);
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  let decrypted = decipher.update(ciphertext, undefined, 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

export class FeishuClient {
  private apiClient: lark.Client;
  private config: FeishuConfig;
  private wsClient: lark.WSClient | null = null;
  private httpServer: http.Server | null = null;

  constructor(config: FeishuConfig) {
    this.config = config;
    this.apiClient = new lark.Client({
      appId: config.appId,
      appSecret: config.appSecret,
    });
  }

  // --- Helpers ---
  private isMessageProcessed(messageId: string): boolean {
    if (processedMessageIds.has(messageId)) {
      console.log(`[Feishu] 🚫 Ignoring duplicate message ID: ${messageId}`);
      return true;
    }
    processedMessageIds.add(messageId);
    if (processedMessageIds.size > 2000) {
      const first = processedMessageIds.values().next().value;
      processedMessageIds.delete(first);
    }
    return false;
  }

  private parseAndCleanContent(contentJson: string, mentions?: any[]): string {
    try {
      const content = JSON.parse(contentJson);
      let text: string = content.text || '';
      if (mentions && mentions.length > 0) {
        mentions.forEach((m: any) => {
          if (m.key) {
            const regex = new RegExp(m.key, 'g');
            text = text.replace(regex, '');
          }
        });
      }
      return text.trim();
    } catch (e: any) {
      console.error(`[Feishu] ❌ Content Parse Error!`, e);
      return '';
    }
  }

  /**
   * 构造 Markdown 卡片 JSON
   */
  private makeCard(text: string): string {
    return JSON.stringify({
      config: {
        wide_screen_mode: true,
      },
      elements: [
        {
          tag: 'div',
          text: {
            tag: 'lark_md',
            content: text,
          },
        },
      ],
    });
  }

  // --- Public Methods ---

  /**
   * 发送消息 (卡片模式)
   */
  public async sendMessage(chatId: string, text: string): Promise<string | null> {
    try {
      const res = await this.apiClient.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'interactive',
          content: this.makeCard(text),
        },
      });

      if (res.code === 0 && res.data?.message_id) {
        return res.data.message_id;
      } else {
        console.error('[Feishu] ❌ Send failed with API error:', res);
        return null;
      }
    } catch (error) {
      console.error('[Feishu] ❌ Failed to send message:', error);
      return null;
    }
  }

  /**
   * 编辑消息 (卡片模式)
   */
  public async editMessage(chatId: string, messageId: string, text: string): Promise<boolean> {
    try {
      const res = await this.apiClient.im.message.patch({
        path: { message_id: messageId },
        data: {
          content: this.makeCard(text),
        },
      });

      if (res.code === 0) {
        return true;
      } else {
        console.error(`[Feishu] ❌ Edit failed (${res.code}): ${res.msg}`);
        return false;
      }
    } catch (error) {
      return false;
    }
  }

  public async addReaction(messageId: string, emojiType: string): Promise<string | null> {
    try {
      const res = await this.apiClient.im.messageReaction.create({
        path: { message_id: messageId },
        data: { reaction_type: { emoji_type: emojiType } },
      });
      return res.data?.reaction_id || null;
    } catch (error) {
      return null;
    }
  }

  public async removeReaction(messageId: string, reactionId: string) {
    if (!reactionId) return;
    try {
      await this.apiClient.im.messageReaction.delete({
        path: { message_id: messageId, reaction_id: reactionId },
      });
    } catch (error) {
      // ignore
    }
  }

  public async startWebSocket(onMessage: MessageHandler) {
    if (globalState.__feishu_ws_client_instance) return;

    this.wsClient = new lark.WSClient({
      appId: this.config.appId,
      appSecret: this.config.appSecret,
      loggerLevel: lark.LoggerLevel.info,
    });

    const dispatcher = new lark.EventDispatcher({}).register({
      'im.message.receive_v1': async data => {
        const { message } = data;
        const messageId = message.message_id;
        const chatId = message.chat_id;
        const senderId = (message as any).sender?.sender_id?.open_id || '';

        if (this.isMessageProcessed(messageId)) return;

        const text = this.parseAndCleanContent(message.content, message.mentions);
        if (!text) return;

        console.log(`[Feishu WS] 📩 Message from ${senderId}: "${text}"`);
        await onMessage(chatId, text, messageId, senderId);
      },
    });

    await this.wsClient.start({ eventDispatcher: dispatcher });
    globalState.__feishu_ws_client_instance = this.wsClient;
    console.log('✅ Feishu WebSocket Connected!');
  }

  public async startWebhook(onMessage: MessageHandler) {
    if (this.httpServer) return;

    const port = this.config.port || 8080;
    this.httpServer = http.createServer((req, res) => {
      if (req.method !== 'POST') {
        res.writeHead(405);
        res.end();
        return;
      }

      const chunks: Buffer[] = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', async () => {
        try {
          const rawBody = Buffer.concat(chunks).toString('utf8');
          if (!rawBody) return res.end();

          let body: any = JSON.parse(rawBody);

          if (body.encrypt && this.config.encryptKey) {
            try {
              const decrypted = decryptEvent(body.encrypt, this.config.encryptKey);
              body = JSON.parse(decrypted);
            } catch (e) {
              console.error('[Feishu Webhook] ❌ Decryption Failed');
              res.writeHead(500);
              return res.end();
            }
          }

          if (body.type === 'url_verification') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ challenge: body.challenge }));
          }

          if (body.header?.event_type === 'im.message.receive_v1') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ code: 0 }));

            const event = body.event;
            const messageId = event.message?.message_id;
            const chatId = event.message?.chat_id;
            const senderId = event.sender?.sender_id?.open_id || '';

            if (messageId && chatId && !this.isMessageProcessed(messageId)) {
              const text = this.parseAndCleanContent(event.message.content, event.message.mentions);
              if (text) {
                console.log(`[Feishu Webhook] 📩 Message from ${senderId}: "${text}"`);
                onMessage(chatId, text, messageId, senderId).catch(err => {
                  console.error('[Feishu Webhook] ❌ Handler Error:', err);
                });
              }
            }
            return;
          }

          res.writeHead(200);
          res.end('OK');
        } catch (error) {
          console.error('[Feishu Webhook] ❌ Server Error:', error);
          if (!res.headersSent) {
            res.writeHead(500);
            res.end();
          }
        }
      });
    });

    this.httpServer.listen(port, () => {
      console.log(`✅ Feishu Webhook Server listening on port ${port}`);
    });
  }

  public async stop() {
    if (this.wsClient) {
      try {
        console.log('[Feishu] Stopping WebSocket client...');
        this.wsClient = null;
        globalState.__feishu_ws_client_instance = null;
      } catch (e) {}
    }

    if (this.httpServer) {
      console.log('[Feishu] Stopping Webhook server...');
      this.httpServer.close();
      this.httpServer = null;
    }
  }
}
