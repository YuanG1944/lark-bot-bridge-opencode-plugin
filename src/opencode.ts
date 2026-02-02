// src/opencode.ts
import type {
  SessionCreateData,
  SessionPromptData,
  SessionMessagesData,
  SessionListData,
  OpencodeClient, // 确保引入了 OpencodeClient
} from '@opencode-ai/sdk';

export interface OpenCodeApi {
  createSession: (
    data: Omit<SessionCreateData, 'url'>
  ) => Promise<ReturnType<OpencodeClient['session']['create']>>;
  promptSession: (
    data: Omit<SessionPromptData, 'url'>
  ) => Promise<ReturnType<OpencodeClient['session']['prompt']>>;
  getMessages: (
    data: Omit<SessionMessagesData, 'url'>
  ) => Promise<ReturnType<OpencodeClient['session']['messages']>>;
  getSessionList: (
    data: Omit<SessionListData, 'url'>
  ) => Promise<ReturnType<OpencodeClient['session']['list']>>;
  event: OpencodeClient['event'];
}

const findMethod = (client: any, name: string, namespace?: string) => {
  if (client[name]) return client[name].bind(client);
  if (
    namespace &&
    client[namespace] &&
    client[namespace][name.replace(namespace, '').toLowerCase()]
  ) {
    return client[namespace][name.replace(namespace, '').toLowerCase()].bind(client[namespace]);
  }
  if (namespace && client[namespace] && client[namespace][name]) {
    return client[namespace][name].bind(client[namespace]);
  }
  return null;
};

export const buildOpenCodeApi = (client: any): OpenCodeApi => {
  return {
    createSession: findMethod(client, 'sessionCreate', 'session'),
    promptSession: findMethod(client, 'sessionPrompt', 'session'),
    getMessages: findMethod(client, 'sessionMessages', 'session'),
    getSessionList: findMethod(client, 'sessionList', 'session'),
    event: client.event,
  };
};
