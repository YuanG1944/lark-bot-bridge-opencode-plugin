import type { OpenCodeApi } from './opencode';
import type { FeishuClient } from './feishu';
import { LOADING_EMOJI } from './constants';
import type { Part } from '@opencode-ai/sdk';

// --- 类型定义 ---
interface SessionContext {
  chatId: string;
  senderId: string;
}

interface MessageBuffer {
  feishuMsgId: string | null;
  // 🔥 改动 1: 分离思考过程和正文，分别存储
  reasoningContent: string;
  textContent: string;
  lastUpdateTime: number;
}

// --- 全局状态 ---
const sessionToFeishuMap = new Map<string, SessionContext>();
const messageBuffers = new Map<string, MessageBuffer>();
const messageRoleMap = new Map<string, string>(); // 角色缓存

const UPDATE_INTERVAL = 800; // 节流间隔
let isListenerStarted = false;
let shouldStopListener = false;

// --- 核心功能 1: 全局事件监听器 ---
export async function startGlobalEventListener(api: OpenCodeApi, feishu: FeishuClient) {
  if (isListenerStarted) return;
  isListenerStarted = true;
  shouldStopListener = false;

  console.log('[Listener] 🎧 Starting Global Event Subscription...');

  let retryCount = 0;

  const connect = async () => {
    try {
      const events = await api.event.subscribe();
      console.log('[Listener] ✅ Connected to OpenCode Event Stream');
      retryCount = 0;

      for await (const event of events.stream) {
        if (shouldStopListener) {
          console.log('[Listener] 🛑 Loop terminated.');
          break;
        }

        // 1. 监听消息元数据，记录角色
        if (event.type === 'message.updated') {
          const info = event.properties.info;
          if (info && info.id && info.role) {
            messageRoleMap.set(info.id, info.role);
          }
          continue;
        }

        // 2. 监听内容流
        if (event.type === 'message.part.updated') {
          const sessionId = event.properties.part.sessionID;
          const part = event.properties.part;
          const delta = (event.properties as any).delta;

          if (!sessionId || !part) continue;

          // 过滤掉用户自己的消息
          const msgId = part.messageID;
          const role = messageRoleMap.get(msgId);
          if (role === 'user') continue;

          // 路由检查
          const context = sessionToFeishuMap.get(sessionId);
          if (!context) continue;

          // 🔥 改动 2: 日志中打出 SessionID，方便追踪
          // (为了不刷屏，这里只在有工具调用时打 Log，或者你可以选择性开启)

          if (part.type === 'text' || part.type === 'reasoning') {
            await handleStreamUpdate(feishu, context.chatId, msgId, part, delta, sessionId);
          } else if (part.type === 'tool') {
            if (part.state?.status === 'running') {
              console.log(`[Listener] [Session: ${sessionId}] 🔧 Tool Running: ${part.tool}`);
            }
          }
        } else if (event.type === 'session.deleted' || event.type === 'session.error') {
          const sid = (event.properties as any).sessionID;
          if (sid) {
            console.log(`[Listener] [Session: ${sid}] Session ended/error.`);
            sessionToFeishuMap.delete(sid);
          }
        }
      }
    } catch (error) {
      if (shouldStopListener) return;
      console.error('[Listener] ❌ Stream Disconnected:', error);
      const delay = Math.min(5000 * (retryCount + 1), 60000);
      retryCount++;
      setTimeout(connect, delay);
    }
  };

  connect();
}

export function stopGlobalEventListener() {
  shouldStopListener = true;
  isListenerStarted = false;
  sessionToFeishuMap.clear();
  messageBuffers.clear();
  messageRoleMap.clear();
}

// 辅助函数：处理流式更新
async function handleStreamUpdate(
  feishu: FeishuClient,
  chatId: string,
  msgId: string,
  part: Part,
  delta?: string,
  sessionId?: string // 用于日志
) {
  if (!msgId) return;
  // 类型守卫
  if (part.type !== 'text' && part.type !== 'reasoning') return;

  // 初始化 Buffer
  let buffer = messageBuffers.get(msgId);
  if (!buffer) {
    buffer = {
      feishuMsgId: null,
      reasoningContent: '', // 独立存储思考
      textContent: '', // 独立存储正文
      lastUpdateTime: 0,
    };
    messageBuffers.set(msgId, buffer);
  }

  // 🔥 改动 3: 分别追加内容 🔥
  // 无论是增量(delta)还是全量(text)，都归类存入对应的字段
  const contentToAdd = typeof delta === 'string' && delta.length > 0 ? delta : part.text || '';

  // 注意：如果 delta 存在，我们追加；如果不存在且 part.text 存在，这通常是 snapshot
  // 这里简化逻辑：如果是 delta 模式，追加；如果是 snapshot 模式(delta为空)，则覆盖(或追加，视SDK行为而定)
  // 为了稳妥，我们假设 delta 优先。

  if (typeof delta === 'string') {
    if (part.type === 'reasoning') {
      buffer.reasoningContent += delta;
    } else {
      buffer.textContent += delta;
    }
  } else if (typeof part.text === 'string') {
    // 兜底：如果没有 delta，尝试用全量覆盖（防重复需小心，这里假设主要是 delta 流）
    if (part.type === 'reasoning') {
      if (part.text.length > buffer.reasoningContent.length) buffer.reasoningContent = part.text;
    } else {
      if (part.text.length > buffer.textContent.length) buffer.textContent = part.text;
    }
  }

  // 节流
  const now = Date.now();
  const shouldUpdate = !buffer.feishuMsgId || now - buffer.lastUpdateTime > UPDATE_INTERVAL;

  if (shouldUpdate) {
    buffer.lastUpdateTime = now;

    // 🔥 改动 4: 拼接显示内容 (Markdown 格式) 🔥
    let displayContent = '';

    // 如果有思考过程，用引用块包裹
    if (buffer.reasoningContent.trim()) {
      displayContent += `> 🧠 **思考过程**\n> ${buffer.reasoningContent.replace(
        /\n/g,
        '\n> '
      )}\n\n`;
    }

    // 拼接正文
    displayContent += buffer.textContent;

    // 如果两个都为空，不发送
    if (!displayContent.trim()) return;

    try {
      if (!buffer.feishuMsgId) {
        console.log(`[Listener] [Session: ${sessionId}] Sending new msg...`);
        const sentId = await feishu.sendMessage(chatId, displayContent);
        if (sentId) buffer.feishuMsgId = sentId;
      } else {
        // console.log(`[Listener] [Session: ${sessionId}] Updating msg...`);
        await feishu.editMessage(chatId, buffer.feishuMsgId, displayContent);
      }
    } catch (e) {
      console.error(`[Listener] Failed to update Feishu msg:`, e);
    }
  }
}

// --- 核心功能 2: 极简消息处理器 ---
const sessionCache = new Map<string, string>();

export const createMessageHandler = (api: OpenCodeApi, feishu: FeishuClient) => {
  return async (chatId: string, text: string, messageId: string, senderId: string) => {
    console.log(`[Bridge] 📥 Incoming: "${text}" from Chat: ${chatId}`);

    if (text.trim().toLowerCase() === 'ping') {
      await feishu.sendMessage(chatId, 'Pong! ⚡️');
      return;
    }

    let reactionId: string | null = null;

    try {
      if (messageId) {
        reactionId = await feishu.addReaction(messageId, LOADING_EMOJI);
      }

      let sessionId = sessionCache.get(chatId);
      if (!sessionId) {
        const uniqueTitle = `Chat ${chatId.slice(-4)} [${new Date().toLocaleTimeString()}]`;
        const res = await api.createSession({ body: { title: uniqueTitle } });
        sessionId = res.data?.id;
        if (sessionId) {
          sessionCache.set(chatId, sessionId);
          // 🔥 改动 5: 创建 Session 时打印日志
          console.log(`[Bridge] ✨ Created New Session: ${sessionId}`);
        }
      }

      if (!sessionId) throw new Error('Failed to init Session');

      // 注册路由
      sessionToFeishuMap.set(sessionId, { chatId, senderId });

      await api.promptSession({
        path: { id: sessionId },
        body: { parts: [{ type: 'text', text: text }] },
      });

      // 🔥 改动 6: 发送 Prompt 后打印 SessionID
      console.log(`[Bridge] [Session: ${sessionId}] 🚀 Prompt Sent.`);
    } catch (error: any) {
      console.error('[Bridge] ❌ Error:', error);
      if (error.status === 404) sessionCache.delete(chatId);
      await feishu.sendMessage(chatId, `❌ Error: ${error.message}`);
    } finally {
      if (messageId && reactionId) {
        await feishu.removeReaction(messageId, reactionId).catch(() => {});
      }
    }
  };
};
