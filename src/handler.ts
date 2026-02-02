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
  reasoning: string;
  text: string;
  lastUpdateTime: number;
  lastDisplayHash: string; // 防止重复 edit
}

// --- 全局状态 ---
const sessionToFeishuMap = new Map<string, SessionContext>(); // sessionId -> chat context
const sessionActiveMsgMap = new Map<string, string>(); // sessionId -> active assistant messageID
const msgBufferMap = new Map<string, MessageBuffer>(); // messageID -> buffer
const messageRoleMap = new Map<string, string>(); // messageID -> role (user/assistant/...)
const sessionCache = new Map<string, string>(); // chatId -> sessionId

// 调大一点更稳（飞书限频/网络抖动时丢 edit 会少很多）
const UPDATE_INTERVAL = 900;

// 超长裁剪，避免飞书卡片内容被截断/拒绝
const MAX_REASONING_CHARS = 3000;
const MAX_TEXT_CHARS = 12000;

let isListenerStarted = false;
let shouldStopListener = false;

// 兼容不同 SDK/服务端的 step finish 命名
const STEP_FINISH_TYPES = new Set<string>([
  'step-finish',
  'step_finish',
  'step.finish',
  'step-finished',
  'step_end',
  'step-end',
  'step.completed',
]);

// --- 工具函数 ---
function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function simpleHash(s: string): string {
  // 简单 hash（避免引入依赖），用于去重 edit
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return String(h);
}

function buildDisplayContent(buffer: MessageBuffer): string {
  // 裁剪 reasoning（保留尾部更接近最新）
  let reasoning = buffer.reasoning;
  if (reasoning.length > MAX_REASONING_CHARS) {
    reasoning = reasoning.slice(-MAX_REASONING_CHARS);
  }

  // 裁剪 text（同理保留尾部）
  let text = buffer.text;
  if (text.length > MAX_TEXT_CHARS) {
    text = text.slice(-MAX_TEXT_CHARS);
  }

  let displayContent = '';

  if (reasoning.trim()) {
    const cleanReasoning = reasoning.trimEnd();
    const quoted = cleanReasoning
      .split('\n')
      .map(line => `> ${line}`)
      .join('\n');
    displayContent += `> 🤔 **Thinking...**\n${quoted}\n\n`;
  }

  if (text.trim()) {
    displayContent += text;
  }

  return displayContent;
}

async function safeEditWithRetry(
  feishu: FeishuClient,
  chatId: string,
  feishuMsgId: string,
  content: string,
): Promise<boolean> {
  const ok = await feishu.editMessage(chatId, feishuMsgId, content);
  if (ok) return true;

  // 网络抖动/限频常见：等一下再试一次
  await sleep(500);
  return feishu.editMessage(chatId, feishuMsgId, content);
}

async function flushMessageBuffer(feishu: FeishuClient, chatId: string, messageId: string) {
  const buffer = msgBufferMap.get(messageId);
  if (!buffer) return;
  if (!buffer.feishuMsgId) return;

  const content = buildDisplayContent(buffer);
  if (!content.trim()) return;

  const hash = simpleHash(content);
  if (hash === buffer.lastDisplayHash) return;

  buffer.lastDisplayHash = hash;
  await safeEditWithRetry(feishu, chatId, buffer.feishuMsgId, content).catch(() => {});
}

async function flushAllBuffers(feishu: FeishuClient) {
  // 尽最大努力把缓冲区里最后一截发出去（断线/停止时特别关键）
  for (const [msgId, buffer] of msgBufferMap.entries()) {
    if (!buffer.feishuMsgId) continue;

    // 找到它对应的 chatId：通过 sessionActiveMsgMap 反查 sessionId，再查 context
    let foundChatId: string | null = null;
    for (const [sid, activeMsgId] of sessionActiveMsgMap.entries()) {
      if (activeMsgId === msgId) {
        const ctx = sessionToFeishuMap.get(sid);
        if (ctx) foundChatId = ctx.chatId;
        break;
      }
    }
    if (!foundChatId) continue;

    await flushMessageBuffer(feishu, foundChatId, msgId);
  }
}

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
        if (shouldStopListener) break;

        // 1) 记录消息角色（避免把 user 的 part 当 assistant 转发）
        if (event.type === 'message.updated') {
          const info = (event.properties as any)?.info;
          if (info?.id && info?.role) {
            messageRoleMap.set(info.id, info.role);
          }
          continue;
        }

        // 2) 增量流
        if (event.type === 'message.part.updated') {
          const part: Part | undefined = (event.properties as any)?.part;
          const delta: string | undefined = (event.properties as any)?.delta;

          const sessionId = (part as any)?.sessionID;
          const messageId = (part as any)?.messageID;

          if (!sessionId || !messageId || !part) continue;

          // 过滤 user 消息
          const role = messageRoleMap.get(messageId);
          if (role === 'user') continue;

          const context = sessionToFeishuMap.get(sessionId);
          if (!context) continue;

          // session 切换到新的 assistant message：可选先 flush 旧的
          const prevMsgId = sessionActiveMsgMap.get(sessionId);
          if (prevMsgId && prevMsgId !== messageId) {
            await flushMessageBuffer(feishu, context.chatId, prevMsgId);
          }
          sessionActiveMsgMap.set(sessionId, messageId);

          // 处理不同 part 类型
          const isTextLike = part.type === 'text' || part.type === 'reasoning';
          const isStepFinish = STEP_FINISH_TYPES.has(part.type);

          if (isTextLike) {
            await handleStreamUpdate(feishu, context.chatId, messageId, part, delta, false);
          } else if (isStepFinish) {
            await handleStreamUpdate(feishu, context.chatId, messageId, part, undefined, true);
          }
          continue;
        }

        // 3) session 结束/报错：清理映射（并尽力 flush）
        if (event.type === 'session.deleted' || event.type === 'session.error') {
          const sid = (event.properties as any)?.sessionID;
          if (sid) {
            const ctx = sessionToFeishuMap.get(sid);
            const activeMsgId = sessionActiveMsgMap.get(sid);
            if (ctx && activeMsgId) {
              await flushMessageBuffer(feishu, ctx.chatId, activeMsgId);
            }

            sessionToFeishuMap.delete(sid);
            sessionActiveMsgMap.delete(sid);
            // msgBufferMap 不强制删：允许同 message 后续还有零星包，等自然结束也行
          }
          continue;
        }
      }

      // stream 正常结束：也 flush 一把
      await flushAllBuffers(feishu);
    } catch (error) {
      if (shouldStopListener) return;

      console.error('[Listener] ❌ Stream Disconnected:', error);

      // 断线前强刷，避免截断（非常关键）
      await flushAllBuffers(feishu);

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
  sessionActiveMsgMap.clear();
  msgBufferMap.clear();
  messageRoleMap.clear();
  // sessionCache 不清也行（保持同 chatId 复用 session），按你原逻辑保留
}

// --- 辅助函数：处理流式更新（以 messageID 为 buffer key） ---
async function handleStreamUpdate(
  feishu: FeishuClient,
  chatId: string,
  messageId: string,
  part: Part,
  delta: string | undefined,
  forceFlush: boolean,
) {
  let buffer = msgBufferMap.get(messageId);
  if (!buffer) {
    buffer = {
      feishuMsgId: null,
      reasoning: '',
      text: '',
      lastUpdateTime: 0,
      lastDisplayHash: '',
    };
    msgBufferMap.set(messageId, buffer);
  }

  // 1) 严格累积：优先 delta
  if (typeof delta === 'string' && delta.length > 0) {
    if (part.type === 'reasoning') buffer.reasoning += delta;
    if (part.type === 'text') buffer.text += delta;
  } else {
    // 2) 兜底：快照（只在更长时采纳）
    const snapshotText = (part as any)?.text;
    if (typeof snapshotText === 'string') {
      if (part.type === 'reasoning' && snapshotText.length > buffer.reasoning.length) {
        buffer.reasoning = snapshotText;
      }
      if (part.type === 'text' && snapshotText.length > buffer.text.length) {
        buffer.text = snapshotText;
      }
    }
  }

  const now = Date.now();
  const timeSinceLastUpdate = now - buffer.lastUpdateTime;

  const shouldUpdate = forceFlush || !buffer.feishuMsgId || timeSinceLastUpdate > UPDATE_INTERVAL;

  if (!shouldUpdate) return;

  const hasContent = buffer.reasoning.length > 0 || buffer.text.length > 0;
  if (!hasContent) return;

  buffer.lastUpdateTime = now;

  const displayContent = buildDisplayContent(buffer);
  if (!displayContent.trim()) return;

  // 去重：内容完全一致就不 edit
  const hash = simpleHash(displayContent);
  if (buffer.feishuMsgId && hash === buffer.lastDisplayHash && !forceFlush) return;

  try {
    if (!buffer.feishuMsgId) {
      const sentId = await feishu.sendMessage(chatId, displayContent);
      if (sentId) {
        buffer.feishuMsgId = sentId;
        buffer.lastDisplayHash = hash;
      }
    } else {
      const ok = await safeEditWithRetry(feishu, chatId, buffer.feishuMsgId, displayContent);
      if (ok) buffer.lastDisplayHash = hash;
    }
  } catch (e) {
    console.error(`[Listener] Failed to update Feishu msg:`, e);
  }
}

// --- 核心功能 2: 极简消息处理器 ---
export const createMessageHandler = (api: OpenCodeApi, feishu: FeishuClient) => {
  return async (chatId: string, text: string, messageId: string, senderId: string) => {
    console.log(`[Bridge] 📥 Incoming: "${text}" from Chat: ${chatId}`);

    if (text.trim().toLowerCase() === 'ping') {
      await feishu.sendMessage(chatId, 'Pong! ⚡️');
      return;
    }

    let reactionId: string | null = null;

    try {
      // 先加 loading reaction
      if (messageId) {
        reactionId = await feishu.addReaction(messageId, LOADING_EMOJI);
      }

      // 获取/创建 session
      let sessionId = sessionCache.get(chatId);
      if (!sessionId) {
        const uniqueTitle = `Chat ${chatId.slice(-4)} [${new Date().toLocaleTimeString()}]`;
        const res = await api.createSession({ body: { title: uniqueTitle } });
        sessionId = (res as any)?.data?.id;
        if (sessionId) sessionCache.set(chatId, sessionId);
      }

      if (!sessionId) throw new Error('Failed to init Session');

      // 绑定 session 上下文
      sessionToFeishuMap.set(sessionId, { chatId, senderId });

      // 发送 prompt
      await api.promptSession({
        path: { id: sessionId },
        body: { parts: [{ type: 'text', text }] },
      });

      console.log(`[Bridge] [Session: ${sessionId}] 🚀 Prompt Sent.`);
    } catch (error: any) {
      console.error('[Bridge] ❌ Error:', error);

      // session 过期（404）则清掉 cache，下次自动新建
      if (error?.status === 404) sessionCache.delete(chatId);

      await feishu.sendMessage(chatId, `❌ Error: ${error?.message || String(error)}`);
    } finally {
      // 移除 loading reaction
      if (messageId && reactionId) {
        await feishu.removeReaction(messageId, reactionId).catch(() => {});
      }
    }
  };
};
