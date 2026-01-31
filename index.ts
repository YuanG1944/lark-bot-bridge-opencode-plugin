import type { Plugin } from '@opencode-ai/plugin';
import type { Config } from '@opencode-ai/sdk';
import { FeishuClient } from './src/feishu';
import { buildOpenCodeApi } from './src/opencode';
import { createMessageHandler } from './src/handler';
import type { FeishuConfig } from './src/types';
import { PLUGIN_CONFIG_NAME } from './src/constants';

export const FeishuBridgePlugin: Plugin = async ctx => {
  const { client } = ctx;

  console.log('[Plugin] Plugin Loaded. Initiating bootstrap...');

  const bootstrap = async () => {
    try {
      console.log(
        '[Plugin] [Step 1/4] Retrieving configuration from OpenCode Host (opencode.json)...',
      );

      const configPromise = client.config.get();

      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Client Config API Timeout (1000ms)')), 1000),
      );

      let rawResponse: any = null;

      try {
        // 3. 尝试获取
        rawResponse = await Promise.race([configPromise, timeoutPromise]);
        console.log('[Plugin] ✅ Configuration received from Host.');
      } catch (e) {
        console.error(
          '[Plugin] ❌ Config API Failed or Timed out. Cannot proceed without configuration.',
          e,
        );
      }

      console.log('[Plugin] [Step 2/4] Parsing plugin options...');

      // 5. 【核心修复】安全解包
      // SDK 可能返回 { data: Config }，也可能在某些版本直接返回 Config
      // 如果 rawResponse 是 null (即上面报错了)，这里会变成空对象 {}，不会报错
      const agentConfig = (rawResponse?.data || rawResponse || {}) as Config;
      const pluginNameStr = PLUGIN_CONFIG_NAME;

      if (!pluginNameStr) {
        console.error(`[Plugin] ❌ Fatal Error: PLUGIN_CONFIG_NAME constant is missing!`);
        return;
      }

      // 6. 调试日志：打印一下到底拿到了什么 (截断防止刷屏)
      // 这能让你一眼看出是 API 没返回数据，还是 Key 写错了
      try {
        const debugStr = JSON.stringify(agentConfig);
        console.log(
          `[Plugin] 🔍 Debug Raw Config Content: ${debugStr.length > 200 ? debugStr.substring(0, 200) + '...' : debugStr}`,
        );
      } catch (e) {}

      // 7. 安全读取多层级数据
      // 即使 agentConfig 是空对象，这里也不会报错，只会得到 undefined -> {}
      const larkConfig = (agentConfig?.agent?.[pluginNameStr]?.options || {}) as Record<
        string,
        any
      >;

      const appId = larkConfig.app_id;
      const appSecret = larkConfig.app_secret;
      const encryptKey = larkConfig?.encrypt_key || '';
      const portStr = larkConfig?.port || '';
      const pathStr = larkConfig?.path || '';
      const mode = (larkConfig.mode || 'ws').toLowerCase();

      console.log(
        `[Plugin] Parsed Options -> Mode: ${mode} | AppID: ${appId ? appId.substring(0, 6) + '******' : 'MISSING'}`,
      );

      if (!appId || !appSecret) {
        console.error(
          `[Plugin] ❌ Startup Failed: Missing 'app_id' or 'app_secret'.\n` +
            `==============================================================\n` +
            `Critical: Since external environment variables are disabled,\n` +
            `you MUST ensure the host 'opencode.json' contains the following structure:\n` +
            `\n` +
            `"agent": {\n` +
            `  "${pluginNameStr}": {\n` +
            `    "options": {\n` +
            `      "app_id": "cli_xxxxxx",\n` +
            `      "app_secret": "xxxxxx",\n` +
            `      "mode": "ws"\n` +
            `    }\n` +
            `  }\n` +
            `}\n` +
            `==============================================================`,
        );
        return; // 强制退出启动流程
      }

      if (mode === 'webhook' && !encryptKey) {
        console.warn('[Plugin] ⚠️ Warning: Webhook mode is on but "encrypt_key" is missing.');
      }

      console.log('[Plugin] [Step 3/4] Initializing internal components...');

      const config: FeishuConfig = {
        appId,
        appSecret,
        port: portStr ? parseInt(portStr, 10) : undefined,
        path: pathStr,
        encryptKey,
        mode: mode as 'ws' | 'webhook',
      };

      const api = buildOpenCodeApi(client);
      const feishuClient = new FeishuClient(config);
      const messageHandler = createMessageHandler(api, feishuClient);

      console.log(`[Plugin] [Step 4/4] Starting service in [${mode.toUpperCase()}] mode...`);

      if (config.mode === 'webhook') {
        await feishuClient.startWebhook(messageHandler);
      } else {
        await feishuClient.startWebSocket(messageHandler);
      }

      console.log(`[Plugin] 🚀 Feishu Bridge Service started successfully!`);
    } catch (error) {
      console.error('[Plugin] ❌ Bootstrap Fatal Error:', error);
    }
  };

  bootstrap();

  return {};
};
