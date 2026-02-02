// src/bridge/opencode.bridge.ts
import type {
  SessionCreateData,
  SessionPromptData,
  SessionMessagesData,
  SessionListData,
  OpencodeClient,
} from '@opencode-ai/sdk';

export interface OpenCodeApi {
  createSession: (data: Omit<SessionCreateData, 'url'>) => Promise<any>;
  promptSession: (data: Omit<SessionPromptData, 'url'>) => Promise<any>;
  getMessages: (data: Omit<SessionMessagesData, 'url'>) => Promise<any>;
  getSessionList: (data: Omit<SessionListData, 'url'>) => Promise<any>;
  event: OpencodeClient['event'];
}

function mustFindMethod(client: any, candidates: Array<() => any>, name: string) {
  for (const fn of candidates) {
    const got = fn();
    if (typeof got === 'function') return got;
  }
  throw new Error(`[OpenCodeBridge] Cannot find client method for ${name}`);
}

export const buildOpenCodeApi = (client: any): OpenCodeApi => {
  const createSession = mustFindMethod(
    client,
    [() => client.session?.create?.bind(client.session), () => client.sessionCreate?.bind(client)],
    'createSession',
  );

  const promptSession = mustFindMethod(
    client,
    [() => client.session?.prompt?.bind(client.session), () => client.sessionPrompt?.bind(client)],
    'promptSession',
  );

  const getMessages = mustFindMethod(
    client,
    [
      () => client.session?.messages?.bind(client.session),
      () => client.sessionMessages?.bind(client),
    ],
    'getMessages',
  );

  const getSessionList = mustFindMethod(
    client,
    [() => client.session?.list?.bind(client.session), () => client.sessionList?.bind(client)],
    'getSessionList',
  );

  if (!client.event?.subscribe) {
    throw new Error('[OpenCodeBridge] client.event.subscribe not found');
  }

  return {
    createSession,
    promptSession,
    getMessages,
    getSessionList,
    event: client.event,
  };
};
