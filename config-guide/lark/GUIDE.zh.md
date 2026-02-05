## 🚀 快速开始 --- 飞书


[安装教程视频](https://www.bilibili.com/video/BV1jcFqz7EFW/?spm_id_from=333.1391.0.0&vd_source=eb4b8afe50082dead4e939bc4c55440b)
录的不好请轻喷😅


### ⚙️ Opencode 配置 (`opencode.json`)

> **注意：**
> 强烈建议所有配置项均使用 **字符串类型**，以避免解析问题。

### 飞书（Webhook 模式）

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["message-bridge-opencode-plugin"], // 由于官方issue 填[/your/path/message-bridge-opencode-plugin]
  "agent": {
    "lark-bridge": {
      "disable": false,
      "description": "Message Bridge Plugin",
      "options": {
        "platform": "feishu",
        "mode": "webhook",
        "app_id": "cli_xxxxxxx",
        "app_secret": "xxxxxxxxxx",
        "callback_url": "127.0.0.1:3000"
      }
    }
  }
}
```

### 飞书（WebSocket 模式）

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["message-bridge-opencode-plugin"], // 由于官方issue 填[/your/path/message-bridge-opencode-plugin]
  "agent": {
    "lark-bridge": {
      "disable": false,
      "description": "Message Bridge Plugin",
      "options": {
        "platform": "feishu",
        "mode": "ws",
        "app_id": "cli_xxxxxxx",
        "app_secret": "xxxxxxxxxx"
      }
    }
  }
}
```



### ⚙️ 飞书配置 

### 访问 [飞书开放平台](https://open.feishu.cn/app?lang=zh-CN)

1. #### 创建企业自建应用

2. #### 🔒权限管理 -> 批量导入/导出权限 -> 导入 -> 复制下列权限 -> 确认新增权限

   ```json
   {
     "scopes": {
       "tenant": [
         "im:chat:readonly",
         "im:message",
         "im:message.group_at_msg:readonly",
         "im:message.p2p_msg:readonly",
         "im:resource"
       ],
       "user": []
     }
   }
   ```

3. #### ➕事件与回调 -> 事件配置 -> 添加事件 -> `im.message.receive_v1` -> 确认添加

   **所需权限：**

   - 读取用户发给机器人的单聊消息 

   - 接收群聊中@机器人消息事件

4. #### 启动 `opencode`

   ```shell
   opencode web
   ```

5. #### ➕事件与回调 -> 事件配置 -> 订阅方式

   1. 如果是Webhook 模式

      - 选择：将事件发送至 **开发者服务器**

        - 如果你有服务器，直接上域名

        - 如果你没有服务器: 推荐使用 `cloudflared` cli （请自行查阅安装方法）

          ```shell
          cloudflared tunnel --url http://127.0.0.1:3000 // 和你的callback_url 保持一致
          ```

        - 从`log`中找到url
        
          ```
          ➜  opencode cloudflared tunnel --url http://127.0.0.1:3000
          2026-02-05T12:32:30Z INF Thank you for trying Cloudflare Tunnel. Doing so, without a Cloudflare account, is a quick way to experiment and try it out. However, be aware that these account-less Tunnels have no uptime guarantee, are subject to the Cloudflare Online Services Terms of Use (https://www.cloudflare.com/website-terms/), and Cloudflare reserves the right to investigate your use of Tunnels for violations of such terms. If you intend to use Tunnels in production you should use a pre-created named tunnel by following: https://developers.cloudflare.com/cloudflare-one/connections/connect-apps
          2026-02-05T12:32:30Z INF Requesting new quick Tunnel on trycloudflare.com...
          2026-02-05T12:32:35Z INF +--------------------------------------------------------------------------------------------+
          2026-02-05T12:32:35Z INF |  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):  |
          2026-02-05T12:32:35Z INF |  https://truly-muslim-jpeg-shareholders.trycloudflare.com                                  |
          ```
        
        - 填入**请求地址**中 （注意opencode需在运行中）
        
        - 点击保存

   2. 如果是WebSocket 模式，直接点击保存

6. #### ➕事件与回调 -> 事件配置 -> 回调配置 

      操作同上



---