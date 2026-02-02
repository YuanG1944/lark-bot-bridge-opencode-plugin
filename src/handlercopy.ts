import type { TextPartInput } from '@opencode-ai/sdk';
import type { OpenCodeApi } from './opencode';
import type { FeishuClient } from './feishu';
import { LOADING_EMOJI } from './constants';

const sessionMap = new Map<string, string>();
export const sessionOwnerMap = new Map<string, string>();
const chatQueues = new Map<string, Promise<void>>();

const MAX_CONTENT_LENGTH = 500;
const POLLING_INTERVAL = 2000; // 2秒轮询一次
const MAX_POLLING_ATTEMPTS = 60 * 2; // 最大等待 2分钟 (60 * 2s)

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export const createMessageHandler = (api: OpenCodeApi, feishu: FeishuClient) => {
  return async (chatId: string, text: string, messageId: string, senderId: string) => {
    console.log(`[Bridge] 📥 Incoming: "${text}"`);

    if (text.trim().toLowerCase() === 'ping') {
      await feishu.sendMessage(chatId, 'Pong! ⚡️');
      return;
    }

    const previousTask = chatQueues.get(chatId) || Promise.resolve();

    const currentTask = (async () => {
      await previousTask.catch(() => {});

      let reactionId: string | null = null;
      try {
        if (messageId) {
          reactionId = await feishu.addReaction(messageId, LOADING_EMOJI);
        }

        let sessionId = sessionMap.get(chatId);
        if (!sessionId) {
          const res = await api.createSession({ body: { title: `Chat ${chatId.slice(-4)}` } });
          sessionId = res.data?.id;
          if (sessionId) {
            sessionMap.set(chatId, sessionId);
            sessionOwnerMap.set(sessionId, senderId);
          }
        }

        if (!sessionId) throw new Error('Session Init Failed');

        console.log(`[Bridge] 🚀 Task Started: ${sessionId}`);

        const processedMsgIds = new Set<string>();

        await api.promptSession({
          path: { id: sessionId },
          body: { parts: [{ type: 'text', text: text }] },
        });

        // 3. 进入轮询循环，直到 AI 明确结束或超时
        let attempts = 0;
        let isTaskCompleted = false;

        while (!isTaskCompleted && attempts < MAX_POLLING_ATTEMPTS) {
          attempts++;

          // 等待 AI 处理
          await sleep(POLLING_INTERVAL);

          // 拉取最新的 N 条消息 (假设 10 条足够覆盖一轮对话的增量)
          const histRes = await api.getMessages({
            path: { id: sessionId },
            query: { limit: 10 },
          });

          const messages = histRes.data || [];

          // 过滤出：角色的 assistant 的消息 AND 还没处理过的消息
          // 注意：我们要按时间顺序处理
          const newMessages = messages.filter(
            (m: any) => m.info?.role === 'assistant' && !processedMsgIds.has(m.info.id)
          );

          if (newMessages.length === 0) {
            // 没有新消息，继续等待
            continue;
          }

          // 逐条处理新消息
          for (const msg of newMessages) {
            processedMsgIds.add(msg.info.id); // 标记为已处理
            const parts = msg.parts || [];

            // 构造飞书消息内容
            let finalResponse = await formatPartsToFeishu(parts);

            if (finalResponse.trim()) {
              console.log(`[Bridge] 📤 Sending msg ${msg.info.id} (${finalResponse.length} chars)`);
              await feishu.sendMessage(chatId, finalResponse.trim());
            }
          }

          // 4. 判断是否结束循环
          // 获取刚才处理的最后一条消息
          const lastMsg = newMessages[newMessages.length - 1];
          const lastParts = lastMsg.parts || [];

          // 核心判断逻辑：
          // 如果包含 'tool' (工具调用) 或 'reasoning' (纯思考) -> 任务可能没结束，继续 Loop
          // 如果包含 'text' 且不包含 'tool' -> 通常意味着最终回答
          // 如果包含 'step-finish' -> 明确的步骤结束信号

          const hasToolCall = lastParts.some((p: any) => p.type === 'tool');
          const hasReasoningOnly = lastParts.every((p: any) => p.type === 'reasoning');
          const hasText = lastParts.some((p: any) => p.type === 'text');
          const hasStepFinish = lastParts.some((p: any) => p.type === 'step-finish');

          if (hasStepFinish) {
            console.log(`[Bridge] ✅ Detected step-finish. Cycle complete.`);
            isTaskCompleted = true;
          } else if (hasText && !hasToolCall) {
            // 有文本且没有新的工具调用，大概率是最终回复
            console.log(`[Bridge] ✅ Detected final text response. Cycle complete.`);
            isTaskCompleted = true;
          } else {
            console.log(`[Bridge] 🔄 Task continues (Tool/Reasoning detected)...`);
          }
        }

        if (attempts >= MAX_POLLING_ATTEMPTS) {
          console.warn(`[Bridge] ⚠️ Polling timed out after ${MAX_POLLING_ATTEMPTS * 2}s`);
          await feishu.sendMessage(chatId, '⚠️ 等待响应超时，AI 可能仍在后台运行。');
        }
      } catch (err: any) {
        console.error(`[Bridge] ❌ Error:`, err);
        if (err.status === 404) sessionMap.delete(chatId);
        await feishu.sendMessage(chatId, `❌ Error: ${err.message || 'Unknown error'}`);
      } finally {
        if (messageId && reactionId) {
          await feishu.removeReaction(messageId, reactionId).catch(() => {});
        }
      }
    })();

    chatQueues.set(chatId, currentTask);
    return currentTask;
  };
};

// --- 辅助函数：格式化 Parts ---
async function formatPartsToFeishu(parts: any[]): Promise<string> {
  let finalResponse = '';

  parts.forEach((part: any, index: number) => {
    const partType = part.type;
    const stagePrefix = '⚙️ [Intermediate]\n'; // 简化一点前缀

    switch (partType) {
      case 'reasoning':
        console.log(`[Bridge] 🧠 Stage: Reasoning`);
        const thought =
          part.text.length > MAX_CONTENT_LENGTH
            ? `${part.text.substring(0, MAX_CONTENT_LENGTH)}... (Hidden)`
            : part.text;
        finalResponse += `${stagePrefix}> 💭 Thinking: ${thought}\n\n`;
        break;

      case 'text':
        // 文本直接显示，不加前缀
        finalResponse += `${part.text}\n`;
        break;

      case 'tool':
        console.log(`[Bridge] 🔧 Stage: Tooling (${part.tool})`);
        finalResponse += `${stagePrefix}🔧 Tool Call: \`${part.tool}\`\n\n`;
        break;

      case 'step-start':
        finalResponse += `${stagePrefix}🚀 Step Start\n\n`;
        break;

      case 'step-finish':
        finalResponse += `${stagePrefix}✅ Step Finished\n\n`;
        break;

      case 'patch':
        finalResponse += `${stagePrefix}📝 Patching files: \`${part.files?.join(', ')}\`\n\n`;
        break;

      case 'file':
        finalResponse += `📄 File: [${part.filename || 'Download'}](${part.url})\n\n`;
        break;

      case 'subtask':
        finalResponse += `${stagePrefix}📋 Subtask: ${part.description}\n\n`;
        break;

      default:
        // 忽略未知类型或快照，保持界面整洁
        break;
    }
  });

  return finalResponse;
}
