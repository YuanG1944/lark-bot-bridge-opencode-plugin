import type { OpenCodeApi } from './opencode';
import type { FeishuClient } from './feishu';
import { LOADING_EMOJI } from './constants';
import type { Part } from '@opencode-ai/sdk';

// --- 类型定义 ---
interface SessionContext {
  chatId: string;
  senderId: string;
}

type BufferStatus = 'streaming' | 'done' | 'aborted' | 'error';

type ToolView = {
  callID: string;
  tool: string;
  status: 'pending' | 'running' | 'completed' | 'error';
  title?: string;
  input?: unknown;
  output?: string;
  error?: string;
  start?: number;
  end?: number;
};

interface MessageBuffer {
  feishuMsgId: string | null;
  reasoning: string;
  text: string;
  tools: Map<string, ToolView>; // callID -> tool view
  lastUpdateTime: number;
  lastDisplayHash: string;
  status: BufferStatus;
  statusNote?: string;
}

// --- 全局状态 ---
const sessionToFeishuMap = new Map<string, SessionContext>(); // sessionId -> chat context
const sessionActiveMsgMap = new Map<string, string>(); // sessionId -> active assistant messageID
const msgBufferMap = new Map<string, MessageBuffer>(); // messageID -> buffer
const messageRoleMap = new Map<string, string>(); // messageID -> role
const sessionCache = new Map<string, string>(); // chatId -> sessionId

// --- 配置 ---
const UPDATE_INTERVAL = 900;
const MAX_REASONING_CHARS = 4000;
const MAX_TEXT_CHARS = 16000;
const MAX_TOOL_OUTPUT_CHARS = 4000; // 工具输出裁剪
const MAX_TOOL_INPUT_CHARS = 2000;

let isListenerStarted = false;
let shouldStopListener = false;

// --- 工具函数 ---
function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function simpleHash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return String(h);
}

function clipTail(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(-max);
}

function statusLabel(status: BufferStatus) {
  if (status === 'streaming') return '⏳ streaming';
  if (status === 'done') return '✅ done';
  if (status === 'aborted') return '⚠️ aborted';
  return '❌ error';
}

function safeJsonStringify(x: unknown, maxChars: number): string {
  try {
    const s = JSON.stringify(x, null, 2);
    return clipTail(s, maxChars);
  } catch {
    return clipTail(String(x), maxChars);
  }
}

function getOrInitBuffer(messageId: string): MessageBuffer {
  let buffer = msgBufferMap.get(messageId);
  if (!buffer) {
    buffer = {
      feishuMsgId: null,
      reasoning: '',
      text: '',
      tools: new Map<string, ToolView>(),
      lastUpdateTime: 0,
      lastDisplayHash: '',
      status: 'streaming',
      statusNote: '',
    };
    msgBufferMap.set(messageId, buffer);
  }
  return buffer;
}

function markStatus(messageId: string, status: BufferStatus, note?: string) {
  const buf = getOrInitBuffer(messageId);
  buf.status = status;
  if (note) buf.statusNote = clipTail(String(note), 200);
}

function buildToolsSection(buffer: MessageBuffer): string {
  if (!buffer.tools.size) return '';

  const tools = Array.from(buffer.tools.values());

  // 让 running/pending 排前面，其次 error，再 completed
  const rank = (s: ToolView['status']) =>
    s === 'running' ? 0 : s === 'pending' ? 1 : s === 'error' ? 2 : 3;

  tools.sort((a, b) => rank(a.status) - rank(b.status));

  let out = `**🧰 Tools / Steps**\n`;

  for (const t of tools) {
    const title = t.title || t.tool || 'tool';
    const statusIcon =
      t.status === 'running'
        ? '⏳'
        : t.status === 'pending'
          ? '⌛'
          : t.status === 'completed'
            ? '✅'
            : '❌';

    // 使用 <details> 形式做“过程折叠”。飞书不支持的话我再给你换成纯列表。
    out += `\n<details>\n<summary>${statusIcon} ${title} (${t.status})</summary>\n\n`;

    if (t.input !== undefined) {
      out += `**input:**\n\`\`\`\n${safeJsonStringify(t.input, MAX_TOOL_INPUT_CHARS)}\n\`\`\`\n\n`;
    }
    if (t.output) {
      out += `**output:**\n\`\`\`\n${clipTail(t.output, MAX_TOOL_OUTPUT_CHARS)}\n\`\`\`\n\n`;
    }
    if (t.error) {
      out += `**error:**\n\`\`\`\n${clipTail(t.error, MAX_TOOL_OUTPUT_CHARS)}\n\`\`\`\n\n`;
    }

    out += `</details>\n`;
  }

  out += `\n`;
  return out;
}

/**
 * 展示格式：Thinking / Answer / Tools / Status
 */
function buildDisplayContent(buffer: MessageBuffer): string {
  const reasoning = clipTail(buffer.reasoning, MAX_REASONING_CHARS);
  const text = clipTail(buffer.text, MAX_TEXT_CHARS);

  let out = '';

  // --- Thinking ---
  if (reasoning.trim()) {
    const clean = reasoning.trimEnd();
    const quoted = clean
      .split('\n')
      .map(line => `> ${line}`)
      .join('\n');
    out += `> 🤔 **Thinking**\n${quoted}\n\n`;
  }

  // --- Answer ---
  if (text.trim()) {
    out += `**📝 Answer**\n\n${text}\n\n`;
  }

  // --- Tools / Steps ---
  out += buildToolsSection(buffer);

  // --- Status ---
  const note = buffer.statusNote ? ` — ${buffer.statusNote}` : '';
  out += `---\n**📌 Status:** ${statusLabel(buffer.status)}${note}`;

  return out;
}

async function safeEditWithRetry(
  feishu: FeishuClient,
  chatId: string,
  feishuMsgId: string,
  content: string,
): Promise<boolean> {
  const ok = await feishu.editMessage(chatId, feishuMsgId, content);
  if (ok) return true;
  await sleep(500);
  return feishu.editMessage(chatId, feishuMsgId, content);
}

async function flushMessageBuffer(
  feishu: FeishuClient,
  chatId: string,
  messageId: string,
  force = false,
) {
  const buffer = msgBufferMap.get(messageId);
  if (!buffer) return;
  if (!buffer.feishuMsgId) return;

  const content = buildDisplayContent(buffer);
  if (!content.trim()) return;

  const hash = simpleHash(content);
  if (!force && hash === buffer.lastDisplayHash) return;

  buffer.lastDisplayHash = hash;
  await safeEditWithRetry(feishu, chatId, buffer.feishuMsgId, content).catch(() => {});
}

async function flushAllBuffers(feishu: FeishuClient) {
  for (const [sid, activeMsgId] of sessionActiveMsgMap.entries()) {
    const ctx = sessionToFeishuMap.get(sid);
    if (!ctx || !activeMsgId) continue;
    await flushMessageBuffer(feishu, ctx.chatId, activeMsgId, true);
  }
}

function isAbortedError(err: any): boolean {
  return err?.name === 'MessageAbortedError';
}

function isOutputLengthError(err: any): boolean {
  return err?.name === 'MessageOutputLengthError';
}

function isApiError(err: any): boolean {
  return err?.name === 'APIError';
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

      for await (const event of (events as any).stream) {
        if (shouldStopListener) break;

        // 1) message.updated：记录 role + 捕捉 assistant 完成/错误/finish
        if (event.type === 'message.updated') {
          const info = (event.properties as any)?.info;
          if (info?.id && info?.role) {
            messageRoleMap.set(info.id, info.role);
          }

          // assistant message 的 error/finish 在这里最可靠
          if (info?.role === 'assistant' && info?.id && info?.sessionID) {
            const sid = info.sessionID as string;
            const mid = info.id as string;

            const ctx = sessionToFeishuMap.get(sid);
            if (ctx) {
              // 标记 active message（防止你没收到 part 也能 flush）
              sessionActiveMsgMap.set(sid, mid);

              if (info.error) {
                if (isAbortedError(info.error)) {
                  markStatus(mid, 'aborted', info.error?.data?.message || 'aborted');
                } else if (isOutputLengthError(info.error)) {
                  markStatus(mid, 'error', 'output too long');
                } else if (isApiError(info.error)) {
                  markStatus(mid, 'error', info.error?.data?.message || 'api error');
                } else {
                  markStatus(
                    mid,
                    'error',
                    info.error?.data?.message || info.error?.name || 'error',
                  );
                }
                await flushMessageBuffer(feishu, ctx.chatId, mid, true);
              } else if (info.finish || info.time?.completed) {
                // 完成信号：finish 或 completed 时间
                markStatus(mid, 'done', info.finish || 'completed');
                await flushMessageBuffer(feishu, ctx.chatId, mid, true);
              }
            }
          }

          continue;
        }

        // 2) message.part.updated：text / reasoning / tool / step-finish / snapshot 等
        if (event.type === 'message.part.updated') {
          const part: Part | undefined = (event.properties as any)?.part;
          const delta: string | undefined = (event.properties as any)?.delta;

          const sessionId = (part as any)?.sessionID;
          const messageId = (part as any)?.messageID;

          if (!sessionId || !messageId || !part) continue;

          // 过滤 user
          const role = messageRoleMap.get(messageId);
          if (role === 'user') continue;

          const ctx = sessionToFeishuMap.get(sessionId);
          if (!ctx) continue;

          // 如果 session 切换到了新的 message，先 flush 旧的（更“不断联”）
          const prev = sessionActiveMsgMap.get(sessionId);
          if (prev && prev !== messageId) {
            markStatus(prev, 'done');
            await flushMessageBuffer(feishu, ctx.chatId, prev, true);
          }
          sessionActiveMsgMap.set(sessionId, messageId);

          // handle
          await handleStreamUpdate(feishu, ctx.chatId, messageId, part, delta);

          continue;
        }

        // 3) session.error：abort 最常在这里出现（MessageAbortedError）
        if (event.type === 'session.error') {
          const sid = (event.properties as any)?.sessionID;
          const err = (event.properties as any)?.error;

          if (sid) {
            const ctx = sessionToFeishuMap.get(sid);
            const mid = sessionActiveMsgMap.get(sid);

            if (ctx && mid) {
              if (isAbortedError(err)) {
                markStatus(mid, 'aborted', err?.data?.message || 'aborted');
              } else {
                markStatus(mid, 'error', err?.data?.message || err?.name || 'session.error');
              }
              await flushMessageBuffer(feishu, ctx.chatId, mid, true);
            }
          }
          continue;
        }

        // 4) session.idle：作为“本轮结束”的可靠信号之一
        if (event.type === 'session.idle') {
          const sid = (event.properties as any)?.sessionID;
          if (sid) {
            const ctx = sessionToFeishuMap.get(sid);
            const mid = sessionActiveMsgMap.get(sid);
            if (ctx && mid) {
              // 如果之前已经 aborted/error 就不覆盖
              const buf = msgBufferMap.get(mid);
              if (buf && (buf.status === 'aborted' || buf.status === 'error')) {
                await flushMessageBuffer(feishu, ctx.chatId, mid, true);
              } else {
                markStatus(mid, 'done', 'idle');
                await flushMessageBuffer(feishu, ctx.chatId, mid, true);
              }
            }
          }
          continue;
        }

        // 5) session.deleted：清理（也先 flush 一次）
        if (event.type === 'session.deleted') {
          const info = (event.properties as any)?.info;
          const sid = info?.id;
          if (sid) {
            const ctx = sessionToFeishuMap.get(sid);
            const mid = sessionActiveMsgMap.get(sid);
            if (ctx && mid) {
              const buf = msgBufferMap.get(mid);
              if (buf && buf.status === 'streaming') markStatus(mid, 'done', 'deleted');
              await flushMessageBuffer(feishu, ctx.chatId, mid, true);
            }
            sessionToFeishuMap.delete(sid);
            sessionActiveMsgMap.delete(sid);
          }
          continue;
        }
      }

      // stream 正常结束：flush
      await flushAllBuffers(feishu);
    } catch (error) {
      if (shouldStopListener) return;

      console.error('[Listener] ❌ Stream Disconnected:', error);

      // 断线前强刷：把已生成的过程/结果都尽量展示出来
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
}

// ✅ 推荐：停止时也 flush
export async function stopGlobalEventListenerAsync(feishu: FeishuClient) {
  shouldStopListener = true;
  isListenerStarted = false;

  await flushAllBuffers(feishu);

  sessionToFeishuMap.clear();
  sessionActiveMsgMap.clear();
  msgBufferMap.clear();
  messageRoleMap.clear();
}

// --- 处理 part 更新（过程展示关键在 tool part） ---
async function handleStreamUpdate(
  feishu: FeishuClient,
  chatId: string,
  messageId: string,
  part: Part,
  delta: string | undefined,
) {
  const buffer = getOrInitBuffer(messageId);

  // text / reasoning：增量累积
  if (part.type === 'text' || part.type === 'reasoning') {
    if (typeof delta === 'string' && delta.length > 0) {
      if (part.type === 'reasoning') buffer.reasoning += delta;
      else buffer.text += delta;
    } else if (typeof (part as any).text === 'string') {
      // 兜底：快照只在更长时采纳
      const snap = (part as any).text as string;
      if (part.type === 'reasoning' && snap.length > buffer.reasoning.length)
        buffer.reasoning = snap;
      if (part.type === 'text' && snap.length > buffer.text.length) buffer.text = snap;
    }
  }

  // tool：展示过程（pending/running/completed/error）
  if (part.type === 'tool') {
    const callID = (part as any).callID as string;
    const tool = (part as any).tool as string;
    const state = (part as any).state;

    if (callID && state?.status) {
      const view: ToolView = buffer.tools.get(callID) || {
        callID,
        tool,
        status: state.status,
      };

      view.tool = tool;
      view.status = state.status;

      if (state.title) view.title = state.title;

      // input 一般在 pending/running 里就有
      if (state.input !== undefined) view.input = state.input;

      // completed/error
      if (state.status === 'completed') {
        if (typeof state.output === 'string') view.output = state.output;
        if (state.time?.start) view.start = state.time.start;
        if (state.time?.end) view.end = state.time.end;
      } else if (state.status === 'error') {
        if (typeof state.error === 'string') view.error = state.error;
        if (state.time?.start) view.start = state.time.start;
        if (state.time?.end) view.end = state.time.end;
      } else if (state.status === 'running') {
        if (state.time?.start) view.start = state.time.start;
      }

      buffer.tools.set(callID, view);
    }
  }

  // step-finish：标记 done（但不覆盖 aborted/error）
  if (part.type === 'step-finish') {
    const reason = (part as any).reason;
    const buf = msgBufferMap.get(messageId);
    if (buf && buf.status === 'streaming') {
      markStatus(messageId, 'done', reason || 'step-finish');
    }
  }

  // snapshot：可选（这里不展开 snapshot 内容，太长）
  // retry/compaction/agent/subtask/patch/file 等也可以按需展示（你要的话我再加）

  // --- 节流更新 ---
  const now = Date.now();
  const timeSinceLastUpdate = now - buffer.lastUpdateTime;

  const shouldUpdate = !buffer.feishuMsgId || timeSinceLastUpdate > UPDATE_INTERVAL;

  if (!shouldUpdate) return;

  const hasAny = buffer.reasoning.length > 0 || buffer.text.length > 0 || buffer.tools.size > 0;

  if (!hasAny) return;

  buffer.lastUpdateTime = now;

  const displayContent = buildDisplayContent(buffer);
  if (!displayContent.trim()) return;

  const hash = simpleHash(displayContent);
  if (buffer.feishuMsgId && hash === buffer.lastDisplayHash) return;

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
    console.error('[Listener] Failed to update Feishu msg:', e);
  }
}

// --- 核心功能 2: 消息处理器 ---
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
        sessionId = (res as any)?.data?.id;
        if (sessionId) sessionCache.set(chatId, sessionId);
      }

      if (!sessionId) throw new Error('Failed to init Session');

      sessionToFeishuMap.set(sessionId, { chatId, senderId });

      await api.promptSession({
        path: { id: sessionId },
        body: { parts: [{ type: 'text', text }] },
      });

      console.log(`[Bridge] [Session: ${sessionId}] 🚀 Prompt Sent.`);
    } catch (error: any) {
      console.error('[Bridge] ❌ Error:', error);
      if (error?.status === 404) sessionCache.delete(chatId);
      await feishu.sendMessage(chatId, `❌ Error: ${error?.message || String(error)}`);
    } finally {
      if (messageId && reactionId) {
        await feishu.removeReaction(messageId, reactionId).catch(() => {});
      }
    }
  };
};
