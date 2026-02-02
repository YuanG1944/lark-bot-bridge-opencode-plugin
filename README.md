# Opencode Feishu Bot Plugin

[English](https://www.google.com/search?q=./README.md) | [中文](https://www.google.com/search?q=./README.zh.md)

`opencode-plugin-feishu-bridge` is a plugin specifically designed for **OpenCode Agent**. It aims to help developers quickly connect AI Agents to the Feishu (Feishu/Lark) platform, supporting both WebSocket and Webhook communication modes.

### ✨ Features

* **Plug-and-Play**: Fully compatible with the OpenCode SDK plugin system.
* **Multiple Modes**:
* `ws` (WebSocket): No public IP required, ideal for local development and debugging.
* `webhook`: High performance and stability, suitable for production environments.


* **Configuration Driven**: Manage Feishu credentials directly via `opencode.json`.

---

### 📦 Installation

Run the following command within your OpenCode Agent Config directory (`.config/opencode/`):

```bash
npm install opencode-plugin-feishu-bridge

```

---

### 🚀 Quick Start

#### ⚙️ Configuration (`opencode.json`)

Ensure your `opencode.json` follows the structure below. **Note: It is highly recommended to use string formats for all values to avoid parsing errors.**

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
          "mode": "webhook"
        }
      }
    }
}

```

**WebSocket**

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
          "mode": "ws"
        }
      }
    }
}

```

---

> [!WARNING]
> **Important Note:** Due to a current known issue in OpenCode (["issue: 'fn3 is not a function'"](https://github.com/anomalyco/opencode/issues/7792)), direct npm package referencing is currently unavailable. You must reference the code in development mode. Follow these steps:
> 1. **Clone the repository:**
> ```shell
> git clone https://github.com/YuanG1944/lark-bot-bridge-opencode-plugin.git
> 
> ```
> 
> 
> 2. **Enter the directory:**
> ```shell
> cd lark-bot-bridge-opencode-plugin
> 
> ```
> 
> 
> 3. **Install dependencies:**
> ```shell
> bun install # Bun is recommended as it is the official build tool
> 
> ```
> 
> 
> 4. **Get your absolute path:**
> ```shell
> $: pwd
> $: /your/path/lark-bot-bridge-opencode-plugin
> ```
> 
> 
> 5. **Update `opencode.json` with the local path:**
> 
> ```json
> {
>  "plugin": ["/your/path/lark-bot-bridge-opencode-plugin"], // <== the main change part
>  "agent": {
>    "lark-bridge": {
>      "options": {
>        "mode": "webhook"
>        // ... other config
>      }
>    }
> }
> ```