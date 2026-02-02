// index.feishu.ts
import type { Config } from '@opencode-ai/sdk';

import { buildOpenCodeApi } from './src/bridge/opencode.bridge';
import { createIncomingHandler, startGlobalEventListener } from './src/handler';
import { FeishuAdapter } from './src/feishu/feishu.adapter';

import type { BridgeAdapter, FeishuConfig } from './src/types';
import { globalState } from './src/utils';
import { AGENT_LARK } from './src/constants';

let feishuAdapter: BridgeAdapter | null = globalState.__bridge_feishu_adapter || null;

function getAgentOptions(agentConfig: Config): Record<string, any> {
  const node = agentConfig?.agent?.[AGENT_LARK] as any;
  return (node?.options || {}) as Record<string, any>;
}

function parseFeishuConfig(options: Record<string, any>): FeishuConfig {
  const app_id = options.app_id;
  const app_secret = options.app_secret;
  const mode = (options.mode || 'ws') as 'ws' | 'webhook';

  if (!app_id || !app_secret) {
    throw new Error(`[FeishuBridge] Missing options: app_id/app_secret in agent["${AGENT_LARK}"]`);
  }

  return {
    app_id,
    app_secret,
    mode,
    port: options.port,
    path: options.path,
    encrypt_key: options.encrypt_key,
  };
}

/**
 * 启动 Feishu Bridge（给总入口 index.ts 调用）
 */
export async function startFeishuBridge(opencodeClient: any, rawConfig: Config) {
  // 只读 lark-bridge 配置
  const options = getAgentOptions(rawConfig);
  const feishuConfig = parseFeishuConfig(options);

  if (!feishuAdapter) {
    feishuAdapter = new FeishuAdapter(feishuConfig);
    globalState.__bridge_feishu_adapter = feishuAdapter;
    console.log('[FeishuBridge] Created FeishuAdapter.');
  } else {
    console.log('[FeishuBridge] Reusing FeishuAdapter.');
  }

  // listener 只启动一次（全局）
  if (!globalState.__bridge_listener_started) {
    globalState.__bridge_listener_started = false;
  }

  const api = buildOpenCodeApi(opencodeClient);

  if (!globalState.__bridge_listener_started) {
    console.log('[FeishuBridge] Starting Global Event Listener...');
    startGlobalEventListener(api, feishuAdapter).catch(err => {
      console.error('[FeishuBridge] ❌ startGlobalEventListener failed:', err);
      globalState.__bridge_listener_started = false;
    });
    globalState.__bridge_listener_started = true;
  } else {
    console.log('[FeishuBridge] Global listener already running.');
  }

  // incoming handler（平台->opencode）
  const incoming = createIncomingHandler(api, feishuAdapter);
  await feishuAdapter.start(incoming);

  console.log('[FeishuBridge] ✅ Ready.');
}
