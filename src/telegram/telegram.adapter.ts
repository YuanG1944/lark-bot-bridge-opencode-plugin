// src/telegram/telegram.adapter.ts
import type { BridgeAdapter, IncomingMessageHandler } from '../types';

export class TelegramAdapter implements BridgeAdapter {
  provider: 'telegram' = 'telegram';

  async start(_handler: IncomingMessageHandler) {
    throw new Error('TelegramAdapter not implemented');
  }
  async stop() {}

  //@ts-ignore
  // TODO
  async sendMessage(_chatId: string, _markdown: string) {
    throw new Error('TelegramAdapter not implemented');
  }

  //@ts-ignore
  // TODO
  async editMessage(_chatId: string, _messageId: string, _markdown: string) {
    throw new Error('TelegramAdapter not implemented');
  }
}
