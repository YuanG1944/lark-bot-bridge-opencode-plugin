// src/types.ts

export type BridgeMode = 'ws' | 'webhook';

export type IncomingMessageHandler = (
  chatId: string,
  text: string,
  messageId: string,
  senderId: string,
) => Promise<void>;

export interface BridgeAdapter {
  /**
   * 启动平台监听（ws/webhook/bot polling 等）
   */
  start(onMessage: IncomingMessageHandler): Promise<void>;

  /**
   * 停止（可选）
   */
  stop?(): Promise<void>;

  /**
   * 发送消息，返回平台消息ID（用于后续 edit）
   */
  sendMessage(chatId: string, text: string): Promise<string | null>;

  /**
   * 编辑消息（用于流式更新）
   */
  editMessage(chatId: string, messageId: string, text: string): Promise<boolean>;

  /**
   * 反应（可选）
   */
  addReaction?(messageId: string, emojiType: string): Promise<string | null>;
  removeReaction?(messageId: string, reactionId: string): Promise<void>;
}

/**
 * Feishu 配置（严格按你的 agent.options 字段，不做兼容）
 */
export interface FeishuConfig {
  app_id: string;
  app_secret: string;
  mode: BridgeMode;
  port?: number;
  path?: string;
  encrypt_key?: string;
}
