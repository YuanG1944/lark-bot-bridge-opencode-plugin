// src/feishu/feishuClient.ts
import * as lark from '@larksuiteoapi/node-sdk';
import * as http from 'http';
import * as crypto from 'crypto';
import * as path from 'path';
import * as https from 'https';

import type { FeishuConfig, IncomingMessageHandler } from '../types';
import type { FilePartInput } from '@opencode-ai/sdk';
import {
  DEFAULT_MAX_FILE_MB,
  DEFAULT_MAX_FILE_RETRY,
  ERROR_HEADER,
  globalState,
  sleep,
} from '../utils';
import { FeishuRenderer } from './feishu.renderer';

function clip(s: string, n = 2000) {
  if (!s) return '';
  return s.length > n ? s.slice(0, n) + ` ... (clipped, len=${s.length})` : s;
}
function looksLikeJsonCard(s: string) {
  const trimmed = s.trim();
  // 必须以 { 开头，} 结尾，且包含 elements 或 header 关键字，才是飞书卡片
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return false;

  try {
    const obj = JSON.parse(trimmed);
    // 飞书卡片特征：必须是对象，通常有 elements 数组
    return (
      !!obj && typeof obj === 'object' && (Array.isArray(obj.elements) || (obj as any).card_link)
    );
  } catch {
    return false;
  }
}

const processedMessageIds: Set<string> = globalState.__feishu_processed_ids || new Set<string>();
globalState.__feishu_processed_ids = processedMessageIds;

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
  private callbackUrl?: string;
  private callbackPort?: number;
  private renderer: FeishuRenderer;

  constructor(config: FeishuConfig) {
    this.config = config;
    this.apiClient = new lark.Client({
      appId: config.app_id,
      appSecret: config.app_secret,
    });
    this.renderer = new FeishuRenderer();
    if (config.callback_url) {
      this.callbackUrl = config.callback_url;
      try {
        const u = new URL(this.callbackUrl);
        this.callbackPort = u.port ? Number(u.port) : undefined;
      } catch {
        // ignore
      }
    }
  }

  private isMessageProcessed(messageId: string): boolean {
    if (processedMessageIds.has(messageId)) {
      console.log(`[Feishu] 🚫 Ignoring duplicate message ID: ${messageId}`);
      return true;
    }
    processedMessageIds.add(messageId);
    if (processedMessageIds.size > 2000) {
      const first = processedMessageIds.values().next().value || '';
      processedMessageIds.delete(first);
    }
    return false;
  }

  private decodeDataUrl(dataUrl: string): { mime: string; buffer: Buffer } | null {
    const match = dataUrl.match(/^data:([^;]+);base64,(.*)$/s);
    if (!match) return null;
    const mime = match[1];
    const base64 = match[2];
    try {
      const buffer = Buffer.from(base64, 'base64');
      return { mime, buffer };
    } catch {
      return null;
    }
  }

  private inferMimeFromFilename(filename?: string): string | undefined {
    const ext = filename ? path.extname(filename).toLowerCase() : '';
    if (!ext) return undefined;
    switch (ext) {
      case '.png':
        return 'image/png';
      case '.jpg':
      case '.jpeg':
        return 'image/jpeg';
      case '.webp':
        return 'image/webp';
      case '.gif':
        return 'image/gif';
      case '.bmp':
        return 'image/bmp';
      case '.tiff':
      case '.tif':
        return 'image/tiff';
      case '.ico':
        return 'image/x-icon';
      case '.pdf':
        return 'application/pdf';
      case '.doc':
        return 'application/msword';
      case '.docx':
        return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
      case '.xls':
        return 'application/vnd.ms-excel';
      case '.xlsx':
        return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
      case '.ppt':
        return 'application/vnd.ms-powerpoint';
      case '.pptx':
        return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
      case '.mp4':
        return 'video/mp4';
      case '.opus':
        return 'audio/opus';
      default:
        return undefined;
    }
  }

  private filenameFromContentDisposition(disposition?: string): string | undefined {
    if (!disposition) return undefined;
    const match = disposition.match(/filename\\*=UTF-8''([^;]+)/i);
    if (match?.[1]) return decodeURIComponent(match[1]);
    const match2 = disposition.match(/filename=\"?([^\";]+)\"?/i);
    return match2?.[1];
  }

  private async fetchUrlToBuffer(
    urlStr: string,
    maxBytes: number,
    redirectLeft = 3
  ): Promise<{ buffer: Buffer; mime?: string; filename?: string }> {
    const url = new URL(urlStr);
    const client = url.protocol === 'https:' ? https : http;

    return new Promise((resolve, reject) => {
      const req = client.get(url, res => {
        const status = res.statusCode || 0;
        if ([301, 302, 303, 307, 308].includes(status) && res.headers.location) {
          if (redirectLeft <= 0) {
            res.resume();
            return reject(new Error('Too many redirects'));
          }
          const next = new URL(res.headers.location, url).toString();
          res.resume();
          return this.fetchUrlToBuffer(next, maxBytes, redirectLeft - 1)
            .then(resolve)
            .catch(reject);
        }

        if (status < 200 || status >= 300) {
          res.resume();
          return reject(new Error(`HTTP ${status}`));
        }

        const contentLengthRaw = res.headers['content-length'];
        const contentLength = contentLengthRaw ? Number(contentLengthRaw) : 0;
        if (contentLength && contentLength > maxBytes) {
          res.resume();
          return reject(new Error('Content too large'));
        }

        const chunks: Buffer[] = [];
        let total = 0;
        res.on('data', chunk => {
          total += chunk.length;
          if (total > maxBytes) {
            res.destroy();
            return reject(new Error('Content too large'));
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          const buffer = Buffer.concat(chunks);
          const mime =
            (res.headers['content-type'] as string | undefined)?.split(';')[0]?.trim();
          const filename =
            this.filenameFromContentDisposition(
              res.headers['content-disposition'] as string | undefined
            ) || path.basename(url.pathname) || undefined;
          resolve({ buffer, mime, filename });
        });
      });
      req.on('error', reject);
    });
  }

  private inferFileType(mime: string, filename?: string):
    | 'opus'
    | 'mp4'
    | 'pdf'
    | 'doc'
    | 'xls'
    | 'ppt'
    | 'stream' {
    const m = (mime || '').toLowerCase();
    if (m.includes('audio/opus')) return 'opus';
    if (m.includes('video/mp4')) return 'mp4';
    if (m.includes('application/pdf')) return 'pdf';
    if (m.includes('application/msword') || m.includes('wordprocessingml')) return 'doc';
    if (m.includes('application/vnd.ms-excel') || m.includes('spreadsheetml')) return 'xls';
    if (m.includes('application/vnd.ms-powerpoint') || m.includes('presentationml'))
      return 'ppt';

    const ext = filename ? path.extname(filename).toLowerCase() : '';
    if (ext === '.opus') return 'opus';
    if (ext === '.mp4') return 'mp4';
    if (ext === '.pdf') return 'pdf';
    if (ext === '.doc' || ext === '.docx') return 'doc';
    if (ext === '.xls' || ext === '.xlsx') return 'xls';
    if (ext === '.ppt' || ext === '.pptx') return 'ppt';
    return 'stream';
  }

  private async sendMediaMessage(
    chatId: string,
    msgType: 'image' | 'file',
    content: Record<string, string>
  ): Promise<boolean> {
    try {
      console.log(
        `[Feishu] 📤 sendMediaMessage type=${msgType} chat=${chatId} content=${JSON.stringify(
          content
        )}`
      );
      const res = await this.apiClient.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: msgType,
          content: JSON.stringify(content),
        },
      });
      return res.code === 0;
    } catch (e) {
      console.error('[Feishu] ❌ Failed to send media:', e);
      return false;
    }
  }

  async sendFileAttachment(
    chatId: string,
    file: { filename?: string; mime?: string; url: string }
  ): Promise<boolean> {
    const { url, filename } = file;
    if (!url) return false;

    console.log(
      `[Feishu] 📎 sendFileAttachment url=${url.slice(0, 120)}${
        url.length > 120 ? '...' : ''
      } filename=${filename || ''} mime=${file.mime || ''}`
    );
    console.log(
      `[Feishu] 🌐 proxy http_proxy=${process.env.http_proxy || ''} https_proxy=${
        process.env.https_proxy || ''
      } NO_PROXY=${process.env.NO_PROXY || process.env.no_proxy || ''}`
    );

    let buffer: Buffer | null = null;
    let mime = file.mime || '';
    let finalName = filename || '';

    if (url.startsWith('data:')) {
      const decoded = this.decodeDataUrl(url);
      if (!decoded) {
        console.warn('[Feishu] ⚠️ Skip file: invalid data URL.');
        return false;
      }
      buffer = decoded.buffer;
      if (!mime) mime = decoded.mime;
      console.log(`[Feishu] ✅ data URL decoded size=${buffer.length} mime=${mime}`);
    } else if (url.startsWith('http://') || url.startsWith('https://')) {
      const maxBytes = mime.startsWith('image/') ? 10 * 1024 * 1024 : 30 * 1024 * 1024;
      try {
        console.log(`[Feishu] ⬇️ downloading url (max=${maxBytes} bytes)`);
        const res = await this.fetchUrlToBuffer(url, maxBytes);
        buffer = res.buffer;
        if (!mime) mime = res.mime || '';
        if (!finalName) finalName = res.filename || '';
        console.log(
          `[Feishu] ✅ download ok size=${buffer.length} mime=${mime} filename=${finalName}`
        );
      } catch (e) {
        console.error('[Feishu] ❌ Download file failed:', e);
        return false;
      }
    } else {
      console.warn('[Feishu] ⚠️ Skip file: unsupported URL scheme.');
      return false;
    }

    if (!buffer) return false;
    if (!mime) mime = this.inferMimeFromFilename(finalName) || 'application/octet-stream';

    if (mime.startsWith('image/')) {
      if (buffer.length > 10 * 1024 * 1024) {
        console.warn('[Feishu] ⚠️ Image too large (>10MB).');
        return false;
      }
      try {
        console.log(
          `[Feishu] ⬆️ uploading image size=${buffer.length} mime=${mime} name=${finalName}`
        );
        const resp = await this.apiClient.im.image.create({
          data: { image_type: 'message', image: buffer },
        });
        const imageKey = resp?.image_key;
        console.log(`[Feishu] ✅ upload image ok image_key=${imageKey || ''}`);
        if (!imageKey) return false;
        return this.sendMediaMessage(chatId, 'image', { image_key: imageKey });
      } catch (e) {
        console.error('[Feishu] ❌ Upload image failed:', e);
        return false;
      }
    }

    if (buffer.length > 30 * 1024 * 1024) {
      console.warn('[Feishu] ⚠️ File too large (>30MB).');
      return false;
    }

    try {
      const fileType = this.inferFileType(mime, finalName);
      console.log(
        `[Feishu] ⬆️ uploading file size=${buffer.length} mime=${mime} type=${fileType} name=${finalName}`
      );
      const resp = await this.apiClient.im.file.create({
        data: {
          file_type: fileType,
          file_name: finalName || 'file',
          file: buffer,
        },
      });
      const fileKey = resp?.file_key;
      console.log(`[Feishu] ✅ upload file ok file_key=${fileKey || ''}`);
      if (!fileKey) return false;
      return this.sendMediaMessage(chatId, 'file', { file_key: fileKey });
    } catch (e) {
      console.error('[Feishu] ❌ Upload file failed:', e);
      return false;
    }
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

  private async readStreamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
    const chunks: Buffer[] = [];
    return new Promise((resolve, reject) => {
      stream.on('data', chunk => chunks.push(Buffer.from(chunk)));
      stream.on('end', () => resolve(Buffer.concat(chunks)));
      stream.on('error', reject);
    });
  }

  private async buildFilePart(
    messageId: string,
    msgType: string,
    contentJson: string,
    chatId: string
  ): Promise<FilePartInput | null> {
    let content: any;
    try {
      content = JSON.parse(contentJson);
    } catch {
      return null;
    }

    const fileKey = content.file_key || content.image_key || content.fileKey || content.imageKey;
    if (!fileKey) return null;

    const fileName =
      content.file_name || content.name || content.fileName || `${msgType}-${fileKey}`;

    let progressMsgId: string | null = null;
    try {
      console.log(
        `[Feishu] 📦 Download resource start: msg=${messageId} type=${msgType} key=${fileKey} name=${fileName}`
      );
      const maxSizeMb =
        (globalState.__bridge_max_file_size?.get?.(chatId) as number) ??
        DEFAULT_MAX_FILE_MB;
      const maxBytes = Math.floor(maxSizeMb * 1024 * 1024);

      let res: any;
      const maxRetry =
        (globalState.__bridge_max_file_retry?.get?.(chatId) as number) ??
        DEFAULT_MAX_FILE_RETRY;
      if (maxRetry > 0) {
        progressMsgId = await this.sendMessage(
          chatId,
          this.renderer.render(`## Status\n正在处理 ${msgType} 文件：${fileName}`)
        );
        await sleep(500);
      }
      for (let attempt = 0; attempt <= maxRetry; attempt++) {
        try {
          res = await this.apiClient.im.messageResource.get(
            {
              path: { message_id: messageId, file_key: fileKey },
              params: { type: msgType },
            },
            { timeout: 20000 }
          );
          break;
        } catch (e) {
          if (attempt >= maxRetry) throw e;
          await sleep(500 * (attempt + 1));
        }
      }
      const contentLengthRaw = res.headers?.['content-length'];
      const contentLength = contentLengthRaw ? Number(contentLengthRaw) : 0;
      if (contentLength && contentLength > maxBytes) {
        await this.sendMessage(
          chatId,
          `❌ 文件过大（${(contentLength / 1024 / 1024).toFixed(
            2
          )}MB），当前限制 ${maxSizeMb}MB。可用 /maxFileSize <xmb> 调整。`
        );
        console.warn(
          `[Feishu] ⚠️ Resource too large by header: ${contentLength} bytes > ${maxBytes}`
        );
        if (progressMsgId) {
          await this.apiClient.im.message
            .delete({ path: { message_id: progressMsgId } })
            .catch(() => {});
        }
        return null;
      }
      const stream = res.getReadableStream();
      const buf = await this.readStreamToBuffer(stream);
      if (buf.length > maxBytes) {
        await this.sendMessage(
          chatId,
          `❌ 文件过大（${(buf.length / 1024 / 1024).toFixed(
            2
          )}MB），当前限制 ${maxSizeMb}MB。可用 /maxFileSize <xmb> 调整。`
        );
        console.warn(`[Feishu] ⚠️ Resource too large by body: ${buf.length} bytes > ${maxBytes}`);
        if (progressMsgId) {
          await this.apiClient.im.message
            .delete({ path: { message_id: progressMsgId } })
            .catch(() => {});
        }
        return null;
      }
      const mime = (res.headers?.['content-type'] as string) || 'application/octet-stream';
      const url = `data:${mime};base64,${buf.toString('base64')}`;
      console.log(
        `[Feishu] ✅ Download resource ok: size=${buf.length} bytes mime=${mime}`
      );
      if (progressMsgId) {
        await this.apiClient.im.message
          .delete({ path: { message_id: progressMsgId } })
          .catch(() => {});
      }
      return {
        type: 'file',
        mime,
        filename: fileName,
        url,
      };
    } catch (e) {
      console.error('[Feishu] ❌ Failed to download resource:', {
        messageId,
        msgType,
        fileKey,
        fileName,
        error: e,
      });
      if (progressMsgId) {
        await this.apiClient.im.message
          .delete({ path: { message_id: progressMsgId } })
          .catch(() => {});
      }
      const sendError = globalState.__bridge_send_error_message as
        | ((chatId: string, content: string) => Promise<void>)
        | undefined;
      if (sendError) {
        await sendError(chatId, '资源下载失败，请稍后重试。');
      } else {
        await this.sendMessage(chatId, `${ERROR_HEADER}\n资源下载失败，请稍后重试。`);
      }
      return null;
    }
  }

  private makeCard(text: string): string {
    const raw = text ?? '';

    const trimmed = raw.trim();
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
      try {
        const obj = JSON.parse(trimmed);
        if (obj && typeof obj === 'object' && Array.isArray(obj.elements)) {
          return trimmed;
        }
      } catch {
        // 不是合法 JSON，就走 fallback 包装
      }
    }

    return JSON.stringify({
      config: { wide_screen_mode: true },
      elements: [
        {
          tag: 'div',
          text: { tag: 'lark_md', content: raw },
        },
      ],
    });
  }

  async sendMessage(chatId: string, text: string): Promise<string | null> {
    try {
      const isCard = looksLikeJsonCard(text);

      const finalContent = isCard ? text : this.makeCard(text);

      const res = await this.apiClient.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'interactive', // 永远使用 interactive
          content: finalContent,
        },
      });
      if (res.code === 0 && res.data?.message_id) return res.data.message_id;
      console.error('[Feishu] ❌ Send failed:', res);
      return null;
    } catch (e) {
      console.error('[Feishu] ❌ Failed to send:', e);
      return null;
    }
  }

  async editMessage(chatId: string, messageId: string, text: string): Promise<boolean> {
    try {
      const res = await this.apiClient.im.message.patch({
        path: { message_id: messageId },
        data: {
          content: text,
        },
      });

      return res.code === 0;
    } catch {
      return false;
    }
  }

  async addReaction(messageId: string, emojiType: string): Promise<string | null> {
    try {
      const res = await this.apiClient.im.messageReaction.create({
        path: { message_id: messageId },
        data: { reaction_type: { emoji_type: emojiType } },
      });
      return res.data?.reaction_id || null;
    } catch {
      return null;
    }
  }

  async removeReaction(messageId: string, reactionId: string) {
    if (!reactionId) return;
    try {
      await this.apiClient.im.messageReaction.delete({
        path: { message_id: messageId, reaction_id: reactionId },
      });
    } catch {
      // ignore
    }
  }

  async startWebSocket(onMessage: IncomingMessageHandler) {
    if (globalState.__feishu_ws_client_instance) return;

    this.wsClient = new lark.WSClient({
      appId: this.config.app_id,
      appSecret: this.config.app_secret,
      loggerLevel: lark.LoggerLevel.info,
    });

    const dispatcher = new lark.EventDispatcher({}).register({
      'im.message.receive_v1': async data => {
        const { message, sender } = data;
        const messageId = message.message_id;
        const chatId = message.chat_id;
        const senderId = sender?.sender_id?.open_id || '';

        if (this.isMessageProcessed(messageId)) return;

        const msgType = (message as any).msg_type || (message as any).message_type || 'text';
        if (msgType === 'text') {
          const text = this.parseAndCleanContent(message.content, message.mentions);
          if (!text) return;
          await onMessage(chatId, text, messageId, senderId);
          return;
        }

        const part = await this.buildFilePart(messageId, msgType, message.content, chatId);
        if (!part) return;
        const text = `收到 ${msgType} 文件：${part.filename || ''}`;
        await onMessage(chatId, text, messageId, senderId, [part]);
      },
    });

    await this.wsClient.start({ eventDispatcher: dispatcher });
    globalState.__feishu_ws_client_instance = this.wsClient;
    console.log('✅ Feishu WebSocket Connected!');
  }

  async startWebhook(onMessage: IncomingMessageHandler) {
    if (this.httpServer) return;

    const port = this.callbackPort || 8080;
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

          if (body.encrypt && this.config.encrypt_key) {
            const decrypted = decryptEvent(body.encrypt, this.config.encrypt_key);
            body = JSON.parse(decrypted);
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
              const msgType =
                event.message?.message_type || event.message?.msg_type || 'text';
              if (msgType === 'text') {
                const text = this.parseAndCleanContent(
                  event.message.content,
                  event.message.mentions
                );
                if (text) {
                  onMessage(chatId, text, messageId, senderId).catch(err => {
                    console.error('[Feishu Webhook] ❌ Handler Error:', err);
                  });
                }
              } else {
                const part = await this.buildFilePart(
                  messageId,
                  msgType,
                  event.message.content,
                  chatId
                );
                if (!part) return;
                const text = `收到 ${msgType} 文件：${part.filename || ''}`;
                onMessage(chatId, text, messageId, senderId, [part]).catch(err => {
                  console.error('[Feishu Webhook] ❌ Handler Error:', err);
                });
              }
            }
            return;
          }

          res.writeHead(200);
          res.end('OK');
        } catch (e) {
          console.error('[Feishu Webhook] ❌ Server Error:', e);
          if (!res.headersSent) {
            res.writeHead(500);
            res.end();
          }
        }
      });
    });

    this.httpServer.listen(port, () => {
      console.log(`✅ Feishu Webhook Server listening on port ${port}`);
      if (this.callbackUrl) {
        console.log(`[Feishu] Callback URL: ${this.callbackUrl}`);
      } else {
        console.log('[Feishu] Callback URL: http://<public-host>:' + port);
      }
    });
  }

  async stop() {
    if (this.wsClient) {
      this.wsClient = null;
      globalState.__feishu_ws_client_instance = null;
    }
    if (this.httpServer) {
      this.httpServer.close();
      this.httpServer = null;
    }
  }
}
