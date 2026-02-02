// src/bridge/buffer.ts
import type { Part, ToolPart, ToolState } from '@opencode-ai/sdk';
import { UPDATE_INTERVAL } from '../constants';

export type BufferStatus = 'streaming' | 'done' | 'aborted' | 'error';

export type ToolView = {
  callID: string;
  tool: string;
  status: 'pending' | 'running' | 'completed' | 'error';

  // raw-ish fields, renderer decides presentation
  title?: string;
  input?: unknown;
  output?: string;
  error?: string;
  start?: number;
  end?: number;
};

export interface MessageBuffer {
  platformMsgId: string | null; // 平台消息ID（飞书 message_id / 其他平台 id）
  reasoning: string; // 原始 reasoning
  text: string; // 原始 answer text
  tools: Map<string, ToolView>; // callID -> tool
  lastUpdateTime: number;
  lastDisplayHash: string;
  status: BufferStatus;
  statusNote?: string;
}

// --- helpers (非 UI，仅安全/通用) ---
export function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function simpleHash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return String(h);
}

/**
 * 安全截断（避免极端情况下平台 edit/patch 失败或内存爆）
 * 真实的“折叠/展示裁剪”请交给 renderer
 */
export function clipTail(s: string, max: number): string {
  if (!s) return '';
  if (s.length <= max) return s;
  return s.slice(-max);
}

function safeJsonStringify(x: unknown, maxChars: number): string {
  try {
    const s = JSON.stringify(x, null, 2);
    return clipTail(s, maxChars);
  } catch {
    return clipTail(String(x), maxChars);
  }
}

// 这些只是安全上限（不是 UI）
// 你也可以后续把这些上限挪到 renderer；这里先保留保底
const SAFE_MAX_REASONING = 8000;
const SAFE_MAX_TEXT = 24000;
const SAFE_MAX_TOOL_INPUT = 4000;
const SAFE_MAX_TOOL_OUTPUT = 8000;

export function getOrInitBuffer(
  store: Map<string, MessageBuffer>,
  messageId: string,
): MessageBuffer {
  let buf = store.get(messageId);
  if (!buf) {
    buf = {
      platformMsgId: null,
      reasoning: '',
      text: '',
      tools: new Map<string, ToolView>(),
      lastUpdateTime: 0,
      lastDisplayHash: '',
      status: 'streaming',
      statusNote: '',
    };
    store.set(messageId, buf);
  }
  return buf;
}

export function markStatus(
  store: Map<string, MessageBuffer>,
  messageId: string,
  status: BufferStatus,
  note?: string,
) {
  const buf = getOrInitBuffer(store, messageId);
  buf.status = status;
  if (note) buf.statusNote = clipTail(String(note), 500);
}

/**
 * ⚠️ 这里不再做任何“UI排版”
 * 只输出稳定的“结构化分段”，方便 renderer 做折叠/卡片化/富文本
 *
 * 约定：
 * - ## Answer
 * - ## Thinking
 * - ## Tools
 * - ## Status
 */
export function buildDisplayContent(buffer: MessageBuffer): string {
  const out: string[] = [];

  // Answer（优先放前，方便 renderer 默认展开）
  out.push('## Answer');
  out.push(buffer.text ? clipTail(buffer.text, SAFE_MAX_TEXT) : '');
  out.push(''); // blank line

  // Thinking
  if (buffer.reasoning && buffer.reasoning.trim()) {
    out.push('## Thinking');
    out.push(clipTail(buffer.reasoning, SAFE_MAX_REASONING));
    out.push('');
  }

  // Tools（最朴素结构：renderer 自己决定如何折叠、排序、图标等）
  if (buffer.tools.size > 0) {
    out.push('## Tools');

    for (const t of buffer.tools.values()) {
      const head = ['-', t.tool || 'tool', `(${t.status})`, t.title ? ` ${t.title}` : ''].join('');
      out.push(head);

      // input/output/error 保持“字段块”，renderer 再决定是否折叠/裁剪/隐藏
      if (t.input !== undefined) {
        out.push('  input:');
        out.push('  ```json');
        out.push(
          safeJsonStringify(t.input, SAFE_MAX_TOOL_INPUT)
            .split('\n')
            .map(l => `  ${l}`)
            .join('\n'),
        );
        out.push('  ```');
      }

      if (t.output) {
        out.push('  output:');
        out.push('  ```');
        out.push(
          clipTail(t.output, SAFE_MAX_TOOL_OUTPUT)
            .split('\n')
            .map(l => `  ${l}`)
            .join('\n'),
        );
        out.push('  ```');
      }

      if (t.error) {
        out.push('  error:');
        out.push('  ```');
        out.push(
          clipTail(t.error, SAFE_MAX_TOOL_OUTPUT)
            .split('\n')
            .map(l => `  ${l}`)
            .join('\n'),
        );
        out.push('  ```');
      }

      // time（纯字段）
      if (t.start || t.end) {
        out.push(`  time: ${t.start ?? ''}${t.end ? ` -> ${t.end}` : ''}`);
      }
    }

    out.push('');
  }

  // Status（纯字段，无 label/emoji）
  out.push('## Status');
  out.push(`${buffer.status}${buffer.statusNote ? `: ${buffer.statusNote}` : ''}`);

  return out.join('\n');
}

/**
 * 把 Part（含 delta）累积到 buffer —— “抽象核心”
 * 这里只做数据累积，不做 UI 改动
 */
export function applyPartToBuffer(buffer: MessageBuffer, part: Part, delta?: string) {
  // text/reasoning：累积原始 delta（优先）
  if (part.type === 'text' || part.type === 'reasoning') {
    if (typeof delta === 'string' && delta.length > 0) {
      if (part.type === 'reasoning') buffer.reasoning += delta;
      else buffer.text += delta;
    } else if (typeof part.text === 'string') {
      // snapshot 兜底：更长才覆盖
      const snap = part.text as string;
      if (part.type === 'reasoning' && snap.length > buffer.reasoning.length)
        buffer.reasoning = snap;
      if (part.type === 'text' && snap.length > buffer.text.length) buffer.text = snap;
    }
    return;
  }

  // tool：只做字段累积（不做展示逻辑）
  if (part.type === 'tool') {
    const toolPart = part as ToolPart;

    const callID = toolPart.callID;
    const tool = toolPart.tool;
    const state: ToolState = toolPart.state;

    const view: ToolView =
      buffer.tools.get(callID) ||
      ({
        callID,
        tool,
        status: state.status,
      } as ToolView);

    view.tool = tool;
    view.status = state.status;

    // input 在所有状态都有
    view.input = state.input;

    // ✅ 这里用 switch，TS 会按你给的 ToolState 联合类型自动收窄
    switch (state.status) {
      case 'pending': {
        // pending: 没 title/time/output/error
        break;
      }

      case 'running': {
        if (state.title) view.title = state.title; // running: title?: string
        if (state.time?.start) view.start = state.time.start;
        break;
      }

      case 'completed': {
        view.title = state.title; // completed: title: string
        view.output = state.output;
        if (state.time?.start) view.start = state.time.start;
        if (state.time?.end) view.end = state.time.end;
        break;
      }

      case 'error': {
        view.error = state.error;
        if (state.time?.start) view.start = state.time.start;
        if (state.time?.end) view.end = state.time.end;
        break;
      }
    }

    buffer.tools.set(callID, view);
    return;
  }

  // 其它 part：暂不处理（renderer/后续需要再加）
}

export function shouldFlushNow(buffer: MessageBuffer): boolean {
  const now = Date.now();
  const timeSinceLastUpdate = now - buffer.lastUpdateTime;
  return !buffer.platformMsgId || timeSinceLastUpdate > UPDATE_INTERVAL;
}
