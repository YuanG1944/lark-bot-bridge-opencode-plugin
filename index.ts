// index.ts
import type { Plugin } from '@opencode-ai/plugin';
import type { Config } from '@opencode-ai/sdk';

import { globalState } from './src/utils';
import { AGENT_LARK, AGENT_IMESSAGE, AGENT_TELEGRAM } from './src/constants';

import { buildOpenCodeApi } from './src/bridge/opencode.bridge';
import { AdapterMux } from './src/handler/mux';
import { startGlobalEventListener, createIncomingHandler } from './src/handler';

import { FeishuAdapter } from './src/feishu/feishu.adapter';
import type { FeishuConfig, BridgeAdapter } from './src/types';

function isEnabled(cfg: Config, key: string): boolean {
  const node = (cfg as any)?.agent?.[key];
  if (!node) return false;
  if (node.disable === true) return false;
  return true;
}

function parseFeishuConfig(cfg: Config): FeishuConfig {
  const node = (cfg as any)?.agent?.[AGENT_LARK];
  const options = (node?.options || {}) as Record<string, any>;

  const app_id = options.app_id;
  const app_secret = options.app_secret;
  const mode = (options.mode || 'ws') as 'ws' | 'webhook';

  if (!app_id || !app_secret) {
    throw new Error(`[Plugin] Missing options for ${AGENT_LARK}: app_id/app_secret`);
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

export const BridgePlugin: Plugin = async ctx => {
  const { client } = ctx;
  console.log('[Plugin] BridgePlugin entry initializing...');

  const bootstrap = async () => {
    try {
      const raw = await client.config.get();
      const cfg = ((raw as any)?.data || raw || {}) as Config;

      // mux 单例
      const mux: AdapterMux = globalState.__bridge_mux || new AdapterMux();
      globalState.__bridge_mux = mux;

      const api = buildOpenCodeApi(client);

      // 允许多个 adapter 同时启用
      const adaptersToStart: Array<{ key: string; adapter: BridgeAdapter }> = [];

      if (isEnabled(cfg, AGENT_LARK)) {
        const feishuCfg = parseFeishuConfig(cfg);
        adaptersToStart.push({ key: AGENT_LARK, adapter: new FeishuAdapter(feishuCfg) });
      }

      if (isEnabled(cfg, AGENT_IMESSAGE)) {
        console.log('[Plugin] imessage-bridge enabled (not implemented yet).');
        // TODO: mux.register(AGENT_IMESSAGE, new IMessageAdapter(...))
      }

      if (isEnabled(cfg, AGENT_TELEGRAM)) {
        console.log('[Plugin] telegram-bridge enabled (not implemented yet).');
        // TODO: mux.register(AGENT_TELEGRAM, new TelegramAdapter(...))
      }

      if (adaptersToStart.length === 0) {
        console.log('[Plugin] No bridge enabled.');
        return;
      }

      // 注册 + start（incoming）
      for (const { key, adapter } of adaptersToStart) {
        mux.register(key, adapter);
        const incoming = createIncomingHandler(api, mux, key);
        await adapter.start(incoming);
        console.log(`[Plugin] ✅ Started adapter: ${key}`);
      }

      // 全局 listener 只启动一次（mux）
      if (!globalState.__bridge_listener_started) {
        globalState.__bridge_listener_started = true;
        startGlobalEventListener(api, mux).catch(err => {
          console.error('[Plugin] ❌ startGlobalEventListener failed:', err);
          globalState.__bridge_listener_started = false;
        });
      } else {
        console.log('[Plugin] Global listener already started.');
      }

      console.log('[Plugin] ✅ BridgePlugin ready.');
    } catch (e) {
      console.error('[Plugin] Bootstrap error:', e);
    }
  };

  bootstrap();
  return {};
};
