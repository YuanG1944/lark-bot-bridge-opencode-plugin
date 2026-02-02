import type { Plugin } from '@opencode-ai/plugin';
import type { Config } from '@opencode-ai/sdk';
import { FeishuClient } from './src/feishu';
import { buildOpenCodeApi } from './src/opencode';
// 1. 引入 startGlobalEventListener
import { createMessageHandler, startGlobalEventListener } from './src/handler';
import type { FeishuConfig } from './src/types';
import { PLUGIN_CONFIG_NAME } from './src/constants';

export const FeishuBridgePlugin: Plugin = async ctx => {
  const { client } = ctx;

  console.log('[Plugin] Plugin Loaded.');

  const bootstrap = async () => {
    try {
      // 1. 获取配置
      const configPromise = client.config.get();
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Config Timeout')), 1000)
      );

      let rawResponse: any = null;
      try {
        rawResponse = await Promise.race([configPromise, timeoutPromise]);
      } catch (e) {
        console.error('[Plugin] Config API Failed', e);
      }

      const agentConfig = (rawResponse?.data || rawResponse || {}) as Config;
      const larkConfig = (agentConfig?.agent?.[PLUGIN_CONFIG_NAME]?.options || {}) as Record<
        string,
        any
      >;

      const appId = larkConfig.app_id;
      const appSecret = larkConfig.app_secret;
      const mode = (larkConfig.mode || 'ws').toLowerCase();

      if (!appId || !appSecret) {
        console.error('[Plugin] ❌ Missing app_id or app_secret');
        return;
      }

      // 2. 初始化组件
      const config: FeishuConfig = {
        appId,
        appSecret,
        port: larkConfig.port ? parseInt(larkConfig.port, 10) : undefined,
        path: larkConfig.path,
        encryptKey: larkConfig.encrypt_key,
        mode: mode as 'ws' | 'webhook',
      };

      const api = buildOpenCodeApi(client);
      const feishuClient = new FeishuClient(config);

      // --- 🔥 关键修改开始 🔥 ---

      // 3. 启动全局事件监听 (独立于用户消息循环)
      // 这是“接收端”：负责监听 OpenCode 的流式回复并推送到飞书
      // 使用 .catch 防止监听器启动失败阻塞后续的 Webhook 启动
      startGlobalEventListener(api, feishuClient).catch(err => {
        console.error('[Plugin] ❌ Failed to start Global Event Listener:', err);
      });

      // --- 🔥 关键修改结束 🔥 ---

      // 4. 创建消息处理器 (这是“发送端”：只负责将用户消息转给 OpenCode)
      const messageHandler = createMessageHandler(api, feishuClient);

      // 5. 启动飞书服务
      if (config.mode === 'webhook') {
        await feishuClient.startWebhook(messageHandler);
      } else {
        await feishuClient.startWebSocket(messageHandler);
      }

      console.log(`[Plugin] 🚀 Service started in [${mode}] mode.`);
    } catch (error) {
      console.error('[Plugin] Bootstrap Error:', error);
    }
  };

  bootstrap();

  return {};
};
