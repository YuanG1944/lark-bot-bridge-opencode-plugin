# Opencode 飞书机器人插件

[English](./README.md) | [中文](./README.zh.md)

`opencode-plugin-feishu-bridge` 是一个专为 **OpenCode Agent** 设计的插件，旨在帮助开发者快速将 AI Agent 接入飞书 (Feishu/Lark) 平台。支持 WebSocket 和 Webhook 两种通信模式。

### ✨ 特性

- **即插即用**：完全兼容 OpenCode SDK 的插件系统。
- **多种模式**：
- `ws` (WebSocket): 无需公网 IP，适合本地开发调试。
- `webhook`: 适合生产环境，高性能稳定。

- **配置驱动**：直接通过 `opencode.json` 管理飞书凭证。

### 📦 安装

在你的 OpenCode Agent Config (.config/opencode/)中运行：

```bash
npm install opencode-plugin-feishu-bridge
```

### 🚀 快速开始

#### ⚙️ 配置 (`opencode.json`)

请确保你的 `opencode.json` 包含以下结构。**特别注意：建议所有值均使用字符串格式以避免解析错误。**

**Webhook**
```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {},
    "plugin": ["opencode-plugin-feishu-bridge"],
    "agent": {
      "lark-bridge": {
        "disable": true,
        "description": "lark plugin",
        "options": {
          "app_id": "cli_xxxxxxx",
          "app_secret": "xxxxxxxxxx",
          "port": 3000,
          "path": "127.0.0.1",
          "mode": "webhook",
        }
      }
    }
}
```

**Websocket**

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {},
    "plugin": ["opencode-plugin-feishu-bridge"],
    "agent": {
      "lark-bridge": {
        "disable": true,
        "description": "lark plugin",
        "options": {
          "app_id": "cli_xxxxxxx",
          "app_secret": "xxxxxxxxxx",
          "mode": "ws",
        }
      }
    }
}
```
---

> [!WARNING]
>
> 需要注意：由于现阶段opencode官方现有[" issue: 'fn3 is not a function' "](https://github.com/anomalyco/opencode/issues/7792) 无法使用npm包直接引用，需要引用开发模式下的代码，具体使用方法
>
> **1. Clone代码仓库：**
>
> ```shell
>git clone https://github.com/YuanG1944/lark-bot-bridge-opencode-plugin.git
> ```
> 
> **2. 进入代码目录:**
>
> ```shell
>cd lark-bot-bridge-opencode-plugin
> ```
> 
> **3. 安装依赖:**
>
> ```shell
>bun install # 推荐使用bun，因为官方的构建工具是bun
> ```
> 
> **4. 获取仓库路径:**
>
> ```shell
>$: pwd
> $: /your/path/lark-bot-bridge-opencode-plugin
> ```
> 
> **5. 在`opencode.json`中配置**
>
> ```json
>{
> "plugin": ["/your/path/lark-bot-bridge-opencode-plugin"], // <== 主要需要修改的地方
> "agent": {
> "lark-bridge": {
> "options": {
>   "mode": "webhook"
>     // ... other config
>      }
>    }
>    ```
>    

