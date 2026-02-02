// src/imessage/imessage.adapter.ts
import type { BridgeAdapter, IncomingMessageHandler } from '../types';

export class IMessageAdapter implements BridgeAdapter {
  provider: 'imessage' = 'imessage';

  async start(_handler: IncomingMessageHandler) {
    throw new Error('IMessageAdapter not implemented');
  }
  async stop() {}

  //@ts-ignore
  // TODO
  async sendMessage(_chatId: string, _markdown: string) {
    throw new Error('IMessageAdapter not implemented');
  }
  //@ts-ignore
  // TODO
  async editMessage(_chatId: string, _messageId: string, _markdown: string) {
    throw new Error('IMessageAdapter not implemented');
  }
}
