import type { BridgeAdapter, FeishuConfig, IncomingMessageHandler } from '../types';
import { FeishuClient } from './feishuClient';
import { FeishuRenderer } from './feishu.renderer';

function clip(s: string, n = 8000) {
  if (!s) return '';
  return s.length > n ? s.slice(0, n) + `\n... (clipped, len=${s.length})` : s;
}

export class FeishuAdapter implements BridgeAdapter {
  private client: FeishuClient;
  private renderer: FeishuRenderer;
  private config: FeishuConfig;

  constructor(config: FeishuConfig) {
    this.config = config;
    this.client = new FeishuClient(config);
    this.renderer = new FeishuRenderer();
  }

  async start(onMessage: IncomingMessageHandler): Promise<void> {
    if (this.config.mode === 'webhook') {
      await this.client.startWebhook(onMessage);
    } else {
      await this.client.startWebSocket(onMessage);
    }
  }

  async stop(): Promise<void> {
    await this.client.stop();
  }

  async sendMessage(chatId: string, text: string): Promise<string | null> {
    return this.client.sendMessage(chatId, this.renderer.render(text));
  }

  async editMessage(chatId: string, messageId: string, text: string): Promise<boolean> {
    return this.client.editMessage(chatId, messageId, this.renderer.render(text));
  }

  async addReaction(messageId: string, emojiType: string): Promise<string | null> {
    return this.client.addReaction(messageId, emojiType);
  }

  async removeReaction(messageId: string, reactionId: string): Promise<void> {
    await this.client.removeReaction(messageId, reactionId);
  }
}
