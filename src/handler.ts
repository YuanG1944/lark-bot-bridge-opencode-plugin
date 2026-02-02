import type { TextPartInput } from '@opencode-ai/sdk';
import type { OpenCodeApi } from './opencode';
import type { FeishuClient } from './feishu';
import { LOADING_EMOJI } from './constants';

const sessionMap = new Map<string, string>();
export const sessionOwnerMap = new Map<string, string>();

const chatQueues = new Map<string, Promise<void>>();

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export const createMessageHandler = (api: OpenCodeApi, feishu: FeishuClient) => {
  return async (chatId: string, text: string, messageId: string, senderId: string) => {
    console.log(`[Bridge] 📥 Received: "${text}"`);

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
          const uniqueSessionTitle = `Feishu Chat ${chatId.slice(
            -4
          )} [${new Date().toLocaleTimeString()}]`;

          try {
            const res = await api.createSession({
              body: {
                title: uniqueSessionTitle,
              },
            });
            sessionId = res.id || res.data?.id;
            console.log(`[Bridge] ✨ Created Session: ${sessionId}`);
          } catch (createErr: any) {
            console.error('[Bridge] Failed to create session:', createErr);
            throw new Error('Could not create new session.');
          }

          if (sessionId) {
            sessionMap.set(chatId, sessionId);
            sessionOwnerMap.set(sessionId, senderId);
          }
        }

        if (!sessionId) throw new Error('No Session ID');

        console.log(`[Bridge] 🚀 Prompting AI...`);
        const parts: TextPartInput[] = [{ type: 'text', text: text }];

        try {
          await api.promptSession({
            path: { id: sessionId },
            body: {
              parts: parts,
            },
          });
        } catch (err: any) {
          if (JSON.stringify(err).includes('404') || err.status === 404) {
            sessionMap.delete(chatId);
            throw new Error('Session expired. Please retry.');
          }
          throw err;
        }

        if (api.getMessages) {
          let replyText = '';
          let attempts = 0;

          while (attempts < 60) {
            attempts++;
            await sleep(60000);

            const res: any = await api.getMessages({
              path: { id: sessionId },
              query: { limit: 5 } as any,
            });

            const messages = Array.isArray(res) ? res : res.data || [];
            if (messages.length === 0) continue;

            const lastItem = messages[messages.length - 1];
            const info = lastItem.info || {};

            if (info.error) throw new Error(info.error.message || info.error);

            if (info.role === 'assistant') {
              let currentText = '';
              if (lastItem.parts?.length > 0) {
                currentText = lastItem.parts
                  .filter((p: any) => p.type === 'text')
                  .map((p: any) => p.text)
                  .join('\n')
                  .trim();
              }

              if (currentText.length > 0) {
                replyText = currentText;
                break;
              }
            }
          }

          if (replyText) {
            console.log(`[Bridge] ✅ Reply sent (${replyText.length} chars)`);
            await feishu.sendMessage(chatId, replyText);
          } else {
            await feishu.sendMessage(
              chatId,
              '❌ AI Response Timeout. If this task still pending, you can resent a message to activate it.'
            );
          }
        }
      } catch (error: any) {
        console.error('[Bridge] Error:', error);
        await feishu.sendMessage(chatId, `⚠️ Error: ${error.message || 'Unknown error'}`);
      } finally {
        if (messageId && reactionId) {
          await feishu.removeReaction(messageId, reactionId);
        }
      }
    })();

    chatQueues.set(chatId, currentTask);
    return currentTask;
  };
};
