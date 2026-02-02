// src/handler/index.ts
import type { Part } from '@opencode-ai/sdk';
import type { OpenCodeApi } from '../bridge/opencode.bridge';
import type { BridgeAdapter } from '../types';
import { LOADING_EMOJI } from '../constants';
import { AdapterMux } from './mux';

import {
  sleep,
  simpleHash,
  buildDisplayContent,
  getOrInitBuffer,
  markStatus,
  applyPartToBuffer,
  shouldFlushNow,
} from '../bridge/buffer';

// --- session/message 状态 ---
type SessionContext = { chatId: string; senderId: string };

const sessionToCtx = new Map<string, SessionContext>(); // sessionId -> chat context
const sessionActiveMsg = new Map<string, string>(); // sessionId -> active assistant messageID
const msgRole = new Map<string, string>(); // messageId -> role
const msgBuffers = new Map<string, any>(); // messageId -> buffer (MessageBuffer)
const sessionCache = new Map<string, string>(); // adapterKey:chatId -> sessionId
const sessionToAdapterKey = new Map<string, string>(); // sessionId -> adapterKey

let isListenerStarted = false;
let shouldStopListener = false;

function isAbortedError(err: any): boolean {
  return err?.name === 'MessageAbortedError';
}
function isOutputLengthError(err: any): boolean {
  return err?.name === 'MessageOutputLengthError';
}
function isApiError(err: any): boolean {
  return err?.name === 'APIError';
}

async function safeEditWithRetry(
  adapter: BridgeAdapter,
  chatId: string,
  platformMsgId: string,
  content: string,
): Promise<boolean> {
  const ok = await adapter.editMessage(chatId, platformMsgId, content);
  if (ok) return true;
  await sleep(500);
  return adapter.editMessage(chatId, platformMsgId, content);
}

async function flushMessage(
  adapter: BridgeAdapter,
  chatId: string,
  messageId: string,
  force = false,
) {
  const buffer = msgBuffers.get(messageId);
  if (!buffer?.platformMsgId) return;

  const content = buildDisplayContent(buffer);
  if (!content.trim()) return;

  const hash = simpleHash(content);
  if (!force && hash === buffer.lastDisplayHash) return;

  buffer.lastDisplayHash = hash;
  await safeEditWithRetry(adapter, chatId, buffer.platformMsgId, content).catch(() => {});
}

async function flushAll(mux: AdapterMux) {
  for (const [sid, mid] of sessionActiveMsg.entries()) {
    const ctx = sessionToCtx.get(sid);
    const adapterKey = sessionToAdapterKey.get(sid);
    if (!ctx || !mid || !adapterKey) continue;

    const adapter = mux.get(adapterKey);
    if (!adapter) continue;

    await flushMessage(adapter, ctx.chatId, mid, true);
  }
}

// --- 全局事件监听：只启动一次 ---
export async function startGlobalEventListener(api: OpenCodeApi, mux: AdapterMux) {
  if (isListenerStarted) return;
  isListenerStarted = true;
  shouldStopListener = false;

  console.log('[Listener] 🎧 Starting Global Event Subscription (MUX)...');

  let retryCount = 0;

  const connect = async () => {
    try {
      const events = await api.event.subscribe();
      console.log('[Listener] ✅ Connected to OpenCode Event Stream');
      retryCount = 0;

      for await (const event of (events as any).stream) {
        if (shouldStopListener) break;

        // 1) message.updated：记录 role + assistant 完成/错误/finish
        if (event.type === 'message.updated') {
          const info = (event.properties as any)?.info;
          if (info?.id && info?.role) msgRole.set(info.id, info.role);

          if (info?.role === 'assistant' && info?.id && info?.sessionID) {
            const sid = info.sessionID as string;
            const mid = info.id as string;

            const ctx = sessionToCtx.get(sid);
            const adapterKey = sessionToAdapterKey.get(sid);
            const adapter = adapterKey ? mux.get(adapterKey) : undefined;
            if (!ctx || !adapter) continue;

            sessionActiveMsg.set(sid, mid);

            if (info.error) {
              if (isAbortedError(info.error)) {
                markStatus(
                  msgBuffers as any,
                  mid,
                  'aborted',
                  info.error?.data?.message || 'aborted',
                );
              } else if (isOutputLengthError(info.error)) {
                markStatus(msgBuffers as any, mid, 'error', 'output too long');
              } else if (isApiError(info.error)) {
                markStatus(
                  msgBuffers as any,
                  mid,
                  'error',
                  info.error?.data?.message || 'api error',
                );
              } else {
                markStatus(
                  msgBuffers as any,
                  mid,
                  'error',
                  info.error?.data?.message || info.error?.name || 'error',
                );
              }
              await flushMessage(adapter, ctx.chatId, mid, true);
            } else if (info.finish || info.time?.completed) {
              markStatus(msgBuffers as any, mid, 'done', info.finish || 'completed');
              await flushMessage(adapter, ctx.chatId, mid, true);
            }
          }
          continue;
        }

        // 2) message.part.updated
        if (event.type === 'message.part.updated') {
          const part: Part | undefined = (event.properties as any)?.part;
          const delta: string | undefined = (event.properties as any)?.delta;

          const sessionId = (part as any)?.sessionID;
          const messageId = (part as any)?.messageID;
          if (!sessionId || !messageId || !part) continue;

          if (msgRole.get(messageId) === 'user') continue;

          const ctx = sessionToCtx.get(sessionId);
          const adapterKey = sessionToAdapterKey.get(sessionId);
          const adapter = adapterKey ? mux.get(adapterKey) : undefined;
          if (!ctx || !adapter) continue;

          // session 内切换到新 assistant message：先 flush 旧的
          const prev = sessionActiveMsg.get(sessionId);
          if (prev && prev !== messageId) {
            markStatus(msgBuffers as any, prev, 'done');
            await flushMessage(adapter, ctx.chatId, prev, true);
          }
          sessionActiveMsg.set(sessionId, messageId);

          const buffer = getOrInitBuffer(msgBuffers as any, messageId);
          applyPartToBuffer(buffer, part, delta);

          // step-finish：只作为状态 done 的信号之一（不覆盖 aborted/error）
          if (part.type === 'step-finish') {
            if (buffer.status === 'streaming') {
              markStatus(
                msgBuffers as any,
                messageId,
                'done',
                (part as any).reason || 'step-finish',
              );
            }
          }

          if (!shouldFlushNow(buffer)) continue;

          const hasAny =
            buffer.reasoning.length > 0 || buffer.text.length > 0 || buffer.tools.size > 0;
          if (!hasAny) continue;

          buffer.lastUpdateTime = Date.now();

          const display = buildDisplayContent(buffer);
          const hash = simpleHash(display);
          if (buffer.platformMsgId && hash === buffer.lastDisplayHash) continue;

          if (!buffer.platformMsgId) {
            const sent = await adapter.sendMessage(ctx.chatId, display);
            if (sent) {
              buffer.platformMsgId = sent;
              buffer.lastDisplayHash = hash;
            }
          } else {
            const ok = await safeEditWithRetry(adapter, ctx.chatId, buffer.platformMsgId, display);
            if (ok) buffer.lastDisplayHash = hash;
          }

          continue;
        }

        // 3) session.error：abort 最常在这里出现
        if (event.type === 'session.error') {
          const sid = (event.properties as any)?.sessionID;
          const err = (event.properties as any)?.error;
          if (!sid) continue;

          const ctx = sessionToCtx.get(sid);
          const adapterKey = sessionToAdapterKey.get(sid);
          const adapter = adapterKey ? mux.get(adapterKey) : undefined;
          const mid = sessionActiveMsg.get(sid);

          if (ctx && adapter && mid) {
            if (isAbortedError(err)) {
              markStatus(msgBuffers as any, mid, 'aborted', err?.data?.message || 'aborted');
            } else {
              markStatus(
                msgBuffers as any,
                mid,
                'error',
                err?.data?.message || err?.name || 'session.error',
              );
            }
            await flushMessage(adapter, ctx.chatId, mid, true);
          }
          continue;
        }

        // 4) session.idle：作为“本轮结束”的可靠信号
        if (event.type === 'session.idle') {
          const sid = (event.properties as any)?.sessionID;
          if (!sid) continue;

          const ctx = sessionToCtx.get(sid);
          const adapterKey = sessionToAdapterKey.get(sid);
          const adapter = adapterKey ? mux.get(adapterKey) : undefined;
          const mid = sessionActiveMsg.get(sid);

          if (ctx && adapter && mid) {
            const buf = msgBuffers.get(mid);
            if (buf && (buf.status === 'aborted' || buf.status === 'error')) {
              await flushMessage(adapter, ctx.chatId, mid, true);
            } else {
              markStatus(msgBuffers as any, mid, 'done', 'idle');
              await flushMessage(adapter, ctx.chatId, mid, true);
            }
          }
          continue;
        }
      }

      await flushAll(mux);
    } catch (e) {
      if (shouldStopListener) return;

      console.error('[Listener] ❌ Stream Disconnected:', e);
      await flushAll(mux);

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

  sessionToCtx.clear();
  sessionActiveMsg.clear();
  msgRole.clear();
  msgBuffers.clear();
  sessionCache.clear();
  sessionToAdapterKey.clear();
}

/**
 * Incoming handler：每个平台传 adapterKey，自动绑定 session->adapterKey
 */
export const createIncomingHandler = (api: OpenCodeApi, mux: AdapterMux, adapterKey: string) => {
  const adapter = mux.get(adapterKey);
  if (!adapter) throw new Error(`[Handler] Adapter not found: ${adapterKey}`);

  return async (chatId: string, text: string, messageId: string, senderId: string) => {
    console.log(`[Bridge] 📥 [${adapterKey}] Incoming: "${text}" chat=${chatId}`);

    if (text.trim().toLowerCase() === 'ping') {
      await adapter.sendMessage(chatId, 'Pong! ⚡️');
      return;
    }

    let reactionId: string | null = null;

    try {
      if (messageId && adapter.addReaction) {
        reactionId = await adapter.addReaction(messageId, LOADING_EMOJI);
      }

      const cacheKey = `${adapterKey}:${chatId}`;

      let sessionId = sessionCache.get(cacheKey);
      if (!sessionId) {
        const uniqueTitle = `[${adapterKey}] Chat ${chatId.slice(-4)} [${new Date().toLocaleTimeString()}]`;
        const res = await api.createSession({ body: { title: uniqueTitle } });
        sessionId = (res as any)?.data?.id;
        if (sessionId) sessionCache.set(cacheKey, sessionId);
      }

      if (!sessionId) throw new Error('Failed to init Session');

      // ✅ 绑定：这个 session 的输出回到哪个平台
      sessionToAdapterKey.set(sessionId, adapterKey);
      sessionToCtx.set(sessionId, { chatId, senderId });

      await api.promptSession({
        path: { id: sessionId },
        body: { parts: [{ type: 'text', text }] },
      });

      console.log(`[Bridge] [${adapterKey}] [Session: ${sessionId}] 🚀 Prompt Sent.`);
    } catch (err: any) {
      console.error(`[Bridge] ❌ [${adapterKey}] Error:`, err);
      await adapter.sendMessage(chatId, `❌ Error: ${err?.message || String(err)}`);
    } finally {
      if (messageId && reactionId && adapter.removeReaction) {
        await adapter.removeReaction(messageId, reactionId).catch(() => {});
      }
    }
  };
};
