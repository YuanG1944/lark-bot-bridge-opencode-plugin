// src/handler/command.ts
import type { FilePartInput, OpencodeClient, TextPartInput } from '@opencode-ai/sdk';
import { DEFAULT_MAX_FILE_MB, DEFAULT_MAX_FILE_RETRY } from '../utils';

type SessionListItem = { id: string; title: string };
export type CommandContext = {
  api: OpencodeClient;
  adapterKey: string;
  chatId: string;
  senderId: string;
  cacheKey: string;
  slash: { command: string; arguments: string };
  normalizedCommand: string;
  targetSessionId: string | null;
  targetAgent: string | null;
  shouldCreateNew: boolean;
  sessionCache: Map<string, string>;
  sessionToAdapterKey: Map<string, string>;
  sessionToCtx: Map<string, { chatId: string; senderId: string }>;
  chatAgent: Map<string, string>;
  chatSessionList: Map<string, Array<SessionListItem>>;
  chatMaxFileSizeMb: Map<string, number>;
  chatMaxFileRetry: Map<string, number>;
  ensureSession: () => Promise<string>;
  createNewSession: () => Promise<string | undefined>;
  sendCommandMessage: (content: string) => Promise<void>;
  sendErrorMessage: (content: string) => Promise<void>;
  sendUnsupported: () => Promise<void>;
  isKnownCustomCommand: (name: string) => Promise<boolean | null>;
};

async function resolveAgentName(
  api: OpencodeClient,
  name: string
): Promise<{ id: string; name: string } | null> {
  try {
    const res = await api.app.agents();
    const data = (res as any)?.data ?? res;
    const list = Array.isArray(data) ? data : [];
    if (list.length === 0) return null;
    const query = name.trim().toLowerCase();
    const tokens = query.split(/\s+/).filter(Boolean);

    const scoreCandidate = (candidate: string): number => {
      const lower = candidate.toLowerCase();
      if (lower === query) return 100;
      if (lower.startsWith(query)) return 80;
      if (tokens.length > 0 && tokens.every(t => lower.includes(t))) return 60;
      if (lower.includes(query)) return 40;
      return -1;
    };

    let best: { id: string; name: string; score: number; matchLen: number } | null = null;
    for (const a of list) {
      const nameVal = String(a?.name || '');
      const idVal = String(a?.id || '');
      const nameScore = nameVal ? scoreCandidate(nameVal) : -1;
      const idScore = idVal ? scoreCandidate(idVal) : -1;
      const score = Math.max(nameScore, idScore);
      if (score < 0) continue;
      const matchLen = Math.min(
        nameScore >= idScore ? nameVal.length : idVal.length,
        200
      );
      if (
        !best ||
        score > best.score ||
        (score === best.score && matchLen < best.matchLen)
      ) {
        best = { id: a?.id, name: a?.name, score, matchLen };
      }
    }

    if (best) return { id: best.id, name: best.name };

    return null;
  } catch {
    return null;
  }
}

export async function handleSlashCommand(ctx: CommandContext): Promise<boolean> {
  const {
    api,
    chatId,
    cacheKey,
    slash,
    normalizedCommand,
    targetSessionId,
    targetAgent,
    shouldCreateNew,
    sessionCache,
    sessionToAdapterKey,
    sessionToCtx,
    chatAgent,
    chatSessionList,
    chatMaxFileSizeMb,
    ensureSession,
    createNewSession,
    sendCommandMessage,
    sendUnsupported,
    isKnownCustomCommand,
  } = ctx;

  if (normalizedCommand === 'help') {
    const res = await api.command.list();
    const data = (res as any)?.data ?? res;
    const list = Array.isArray(data) ? data : [];

    const lines: string[] = [];
    lines.push('## Command');
    lines.push('### Help');
    lines.push('/help - 查看命令与用法');
    lines.push('/models - 查看可用模型');
    lines.push('/new - 新建会话并切换');
    lines.push('/sessions - 列出会话（用 /sessions <id> 或 /sessions <序号> 切换）');
    lines.push('/maxFileSize <xmb> - 设置上传文件大小限制（默认10MB）');
    lines.push('/maxFileRetry <n> - 设置资源下载重试次数（默认3）');
    lines.push('/share - 分享当前会话');
    lines.push('/unshare - 取消分享');
    lines.push('/compact - 压缩/总结当前会话');
    lines.push('/init - 初始化项目（生成 AGENTS.md）');
    lines.push('/agent <name> - 切换 Agent（支持模糊匹配）');

    if (list.length > 0) {
      lines.push('### Custom Commands');
      list.forEach((cmd: any) => {
        const desc = cmd?.description ? `- ${cmd.description}` : '';
        lines.push(`/${cmd?.name} ${desc}`);
      });
    }
    await sendCommandMessage(lines.join('\n'));
    return true;
  }

  if (normalizedCommand === 'models') {
    const res = await api.config.providers();
    const data = (res as any)?.data ?? res;
    const providers = data?.providers ?? [];
    const defaults = data?.default ?? {};

    if (!Array.isArray(providers) || providers.length === 0) {
      await sendCommandMessage('暂无可用模型信息。');
      return true;
    }

    const lines: string[] = [];
    lines.push('## Command');
    lines.push('### Models');

    const defaultLines: string[] = [];
    Object.keys(defaults || {}).forEach(key => {
      defaultLines.push(`${key} -> ${defaults[key]}`);
    });
    if (defaultLines.length > 0) {
      lines.push('Default:');
      defaultLines.forEach(l => lines.push(l));
    }

    providers.forEach((p: any) => {
      const id = p?.id || p?.name || 'unknown';
      const models = p?.models ? Object.keys(p.models) : [];
      lines.push(`${p?.name || id} (${id})`);
      lines.push(`Models: ${models.join(', ') || '-'}`);
    });

    await sendCommandMessage(lines.join('\n'));
    return true;
  }

  if (normalizedCommand === 'maxfilesize') {
    const current = chatMaxFileSizeMb.get(chatId) ?? DEFAULT_MAX_FILE_MB;
    if (!slash.arguments) {
      await sendCommandMessage(`当前文件大小限制：${current}MB`);
      return true;
    }
    const m = slash.arguments.trim().match(/(\d+(?:\.\d+)?)/);
    const value = m ? Number(m[1]) : NaN;
    if (!Number.isFinite(value) || value <= 0) {
      await sendCommandMessage('❌ 请输入有效数值，例如 /maxFileSize 10');
      return true;
    }
    chatMaxFileSizeMb.set(chatId, value);
    await sendCommandMessage(`✅ 已设置文件大小限制：${value}MB`);
    return true;
  }

  if (normalizedCommand === 'maxfileretry') {
    const current = chatMaxFileRetry.get(chatId) ?? DEFAULT_MAX_FILE_RETRY;
    if (!slash.arguments) {
      await sendCommandMessage(`当前重试次数：${current}`);
      return true;
    }
    const m = slash.arguments.trim().match(/(\d+)/);
    const value = m ? Number(m[1]) : NaN;
    if (!Number.isFinite(value) || value < 0) {
      await sendCommandMessage('❌ 请输入有效整数，例如 /maxFileRetry 3');
      return true;
    }
    chatMaxFileRetry.set(chatId, value);
    await sendCommandMessage(`✅ 已设置重试次数：${value}`);
    return true;
  }

  if (normalizedCommand === 'agent' && targetAgent) {
    const agent = await resolveAgentName(api, targetAgent);
    if (!agent) {
      await sendCommandMessage(`❌ 未找到 Agent: ${targetAgent}`);
      return true;
    }
    chatAgent.set(cacheKey, agent.name || agent.id);
    await sendCommandMessage(`✅ 已切换 Agent: ${agent.name || agent.id}`);
    return true;
  }

  if (normalizedCommand === 'agent' && !targetAgent) {
    const res = await api.app.agents();
    const data = (res as any)?.data ?? res;
    const list = Array.isArray(data) ? data : [];
    if (list.length === 0) {
      await sendCommandMessage('暂无可用 Agent。');
      return true;
    }
    const agents = list.slice(0, 20).map((a: any) => a?.name || a?.id).filter(Boolean);
    const lines = [
      '## Command',
      '### Agents',
      '请输入 /agent <name> 切换（支持模糊匹配）：',
    ];
    agents.forEach(a => {
      lines.push(`- ${a}`);
    });
    await sendCommandMessage(lines.join('\n'));
    return true;
  }

  if (normalizedCommand === 'sessions' && !targetSessionId) {
    const res = await api.session.list({});
    const data = (res as any)?.data ?? res;
    const sessions = Array.isArray(data) ? data : [];
    if (sessions.length === 0) {
      await sendCommandMessage('暂无会话，请使用 /new 创建。');
      return true;
    }
    const list = sessions.slice(0, 20).map((s: any) => ({
      id: s?.id,
      title: s?.title || 'Untitled',
    }));
    chatSessionList.set(cacheKey, list);
    const lines = ['## Command', '### Sessions', '请输入 /sessions <序号> 切换：'];
    list.forEach((s, idx) => {
      lines.push(`${idx + 1}. ${s.title}`);
    });
    await sendCommandMessage(lines.join('\n'));
    return true;
  }

  if (normalizedCommand === 'sessions' && targetSessionId) {
    let targetId = targetSessionId;
    if (/^\d+$/.test(targetSessionId)) {
      const list = chatSessionList.get(cacheKey) || [];
      const idx = Number(targetSessionId) - 1;
      if (idx >= 0 && idx < list.length) {
        targetId = list[idx].id;
      } else {
        await sendCommandMessage(`❌ 无效序号: ${targetSessionId}`);
        return true;
      }
    }
    sessionCache.set(cacheKey, targetId);
    sessionToAdapterKey.set(targetId, ctx.adapterKey);
    sessionToCtx.set(targetId, { chatId: ctx.chatId, senderId: ctx.senderId });
    chatAgent.delete(cacheKey);
    await sendCommandMessage(`✅ 已切换到会话: ${targetId}`);
    return true;
  }

  if (normalizedCommand === 'share') {
    const sessionId = await ensureSession();
    const res = await api.session.share({ path: { id: sessionId } });
    const data = (res as any)?.data ?? res;
    const url = data?.share?.url;
    await sendCommandMessage(url ? `✅ 分享链接: ${url}` : '✅ 已分享会话。');
    return true;
  }

  if (normalizedCommand === 'unshare') {
    const sessionId = await ensureSession();
    await api.session.unshare({ path: { id: sessionId } });
    await sendCommandMessage('✅ 已取消分享。');
    return true;
  }

  if (normalizedCommand === 'compact') {
    const sessionId = await ensureSession();
    await api.session.summarize({ path: { id: sessionId } });
    await sendCommandMessage('✅ 已触发会话压缩。');
    return true;
  }

  if (normalizedCommand === 'init') {
    const sessionId = await ensureSession();
    await api.session.init({ path: { id: sessionId } });
    await sendCommandMessage('✅ 已触发初始化（AGENTS.md）。');
    return true;
  }

  if (normalizedCommand === 'new') {
    const sessionId = await createNewSession();
    if (sessionId) {
      await sendCommandMessage(`✅ 已切换到新会话: ${sessionId}`);
    } else {
      await sendCommandMessage('❌ 新会话创建失败，请稍后重试。');
    }
    return true;
  }

  const unsupportedCommands = new Set([
    'connect',
    'details',
    'editor',
    'export',
    'exit',
    'quit',
    'q',
    'theme',
    'themes',
    'thinking',
  ]);
  if (unsupportedCommands.has(normalizedCommand || '')) {
    await sendUnsupported();
    return true;
  }

  const sessionId = await ensureSession();
  const isCustom = await isKnownCustomCommand(slash.command);
  if (isCustom === false) {
    await sendCommandMessage(`❌ 无效指令: /${slash.command}`);
    return true;
  }
  await api.session.command({
    path: { id: sessionId },
    body: { command: slash.command, arguments: slash.arguments },
  });
  console.log(
    `[Bridge] [${ctx.adapterKey}] [Session: ${sessionId}] 🚀 Command /${slash.command} Sent.`
  );
  return true;
}
