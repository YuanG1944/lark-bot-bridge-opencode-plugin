# OpenCode Plugin: Feishu Bridge

[English](./README.md) | [中文](./README.zh.md)

`opencode-plugin-feishu-bridge` is a specialized plugin designed for the **OpenCode Agent** framework. It enables developers to seamlessly integrate AI Agents with the **Feishu (Lark)** platform, supporting both WebSocket and Webhook communication modes.

### ✨ Features

* **Plug-and-Play**: Fully compatible with the OpenCode SDK plugin system.
* **Dual Modes**:
* **`ws` (WebSocket)**: No public IP required; ideal for local development and debugging.
* **`webhook`**: High performance and stability; built for production environments.


* **Config-Driven**: Manage Feishu credentials directly via `opencode.json`.

### 📦 Installation

Run the following command within your OpenCode Agent Config directory (`.config/opencode/`):

```bash
npm install opencode-plugin-feishu-bridge

```

### 🚀 Quick Start

#### ⚙️ Configuration (`opencode.json`)

Ensure your `opencode.json` follows the structure below. **Note: It is highly recommended to use string values for all fields (including ports) to avoid schema validation errors.**

**Webhook Mode**

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {},
  "plugin": ["opencode-plugin-feishu-bridge"],
  "agent": {
    "lark-bridge": {
      "disable": false,
      "description": "Lark bridge plugin",
      "options": {
        "app_id": "cli_xxxxxxx",
        "app_secret": "xxxxxxxxxx",
        "port": "3000",
        "path": "/webhook",
        "mode": "webhook"
      }
    }
  }
}

```

**WebSocket Mode**

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {},
  "plugin": ["opencode-plugin-feishu-bridge"],
  "agent": {
    "lark-bridge": {
      "disable": false,
      "description": "Lark bridge plugin",
      "options": {
        "app_id": "cli_xxxxxxx",
        "app_secret": "xxxxxxxxxx",
        "mode": "ws"
      }
    }
  }
}

```