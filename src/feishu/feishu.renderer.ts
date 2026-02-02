// src/feishu/feishu.renderer.ts

type FeishuCard = {
  config?: { wide_screen_mode?: boolean };
  header?: { title: { tag: 'plain_text'; content: string }; template?: string };
  elements: any[];
};

function trimSafe(s: string) {
  return (s || '').trim();
}

/**
 * 构造 Lark Markdown 组件
 */
function larkMd(content: string) {
  return {
    tag: 'div',
    text: { tag: 'lark_md', content: content },
  };
}

/**
 * 构造折叠面板
 * background_style: 'grey' 用于区分辅助信息（Thinking/Tools）
 */
function collapsiblePanel(title: string, content: string, expanded = false) {
  const c = trimSafe(content);
  if (!c) return null;

  return {
    tag: 'collapsible_panel',
    expanded: expanded,
    background_style: 'grey', // 灰色背景，表示这是“后台过程”
    header: {
      title: { tag: 'plain_text', content: title },
    },
    border: {
      top: true,
      bottom: true,
    },
    elements: [larkMd(c)],
  };
}

/**
 * 构造 Status 区域的小字
 */
function getStatusWithEmoji(statusText: string): string {
  const s = statusText.toLowerCase();
  const isDone =
    s.includes('done') || s.includes('stop') || s.includes('finish') || s.includes('idle');

  // 状态图标：完成用 ✅，进行中用 ⚡️
  const emoji = isDone ? '✅' : '⚡️';

  const cleanText = statusText.replace(/\n/g, ' | ').slice(0, 100);
  return `${emoji} ${cleanText}`;
}

/**
 * 解析 Markdown 分段
 */
function parseSections(md: string) {
  const sectionMap: Record<string, string> = {
    thinking: '',
    answer: '',
    tools: '',
    status: '',
  };

  let cleanMd = md;

  // 1. 预处理 Thinking (> ...)
  const thinkingBlockRegex = /^(\s*> [^]*?)(?=\n[^>]|$)/;
  const thinkingMatch = md.match(thinkingBlockRegex);

  if (thinkingMatch && !md.includes('## Thinking')) {
    sectionMap.thinking = thinkingMatch[1];
    cleanMd = md.slice(thinkingMatch[0].length);
  }

  // 2. 正则拆分 Sections
  const headerRegex = /(?:^|\n)(##+|(?:\*\*))\s*(.*?)(?:(?:\*\*|:)?)(?=\n|$)/g;
  let match;

  const firstMatch = headerRegex.exec(cleanMd);
  if (firstMatch && firstMatch.index > 0) {
    sectionMap.answer = cleanMd.slice(0, firstMatch.index);
  }
  headerRegex.lastIndex = 0;

  while ((match = headerRegex.exec(cleanMd)) !== null) {
    const rawTitle = match[2].toLowerCase().trim();
    const startIndex = match.index + match[0].length;
    const nextMatch = headerRegex.exec(cleanMd);
    const endIndex = nextMatch ? nextMatch.index : cleanMd.length;
    headerRegex.lastIndex = endIndex;

    const content = cleanMd.slice(startIndex, endIndex);

    if (rawTitle.includes('think') || rawTitle.includes('思')) {
      sectionMap.thinking += content;
    } else if (
      rawTitle.includes('tool') ||
      rawTitle.includes('step') ||
      rawTitle.includes('工具')
    ) {
      sectionMap.tools += content;
    } else if (rawTitle.includes('status') || rawTitle.includes('状态')) {
      sectionMap.status += content;
    } else if (rawTitle.includes('answer') || rawTitle.includes('回答')) {
      sectionMap.answer += content;
    } else {
      sectionMap.answer += `\n\n**${match[2]}**\n${content}`;
    }

    if (!nextMatch) break;
    headerRegex.lastIndex = nextMatch.index;
  }

  if (!sectionMap.answer && !sectionMap.thinking && !sectionMap.status) {
    sectionMap.answer = cleanMd;
  }

  return sectionMap;
}

export function renderFeishuCardFromHandlerMarkdown(handlerMarkdown: string): string {
  const { thinking, answer, tools, status } = parseSections(handlerMarkdown);

  const elements: any[] = [];

  // --- 1. Header Title 逻辑 ---
  let headerTitle = '🤖 AI Assistant';
  let headerColor = 'blue'; // 默认蓝色

  if (trimSafe(answer)) {
    headerTitle = '📝 Answer';
    headerColor = 'blue';
  } else if (trimSafe(tools)) {
    headerTitle = '🧰 Tools / Steps'; // 工具执行中
    headerColor = 'wathet'; // 浅蓝色
  } else if (trimSafe(thinking)) {
    headerTitle = '🤔 Thinking Process'; // 思考中
    headerColor = 'turquoise'; // 青色
  }

  // --- 2. Body: 过程区 (灰色折叠块) ---

  // Thinking -> 改为 "💭 Thinking"
  if (thinking.trim()) {
    elements.push(collapsiblePanel('💭 Thinking', thinking, false));
  }

  // Tools -> 改为 "⚙️ Execution" (避免和标题 Tools 重复)
  if (tools.trim()) {
    // 加一点间距
    if (elements.length > 0) elements.push({ tag: 'div', text: { tag: 'lark_md', content: ' ' } });
    elements.push(collapsiblePanel('⚙️ Execution', tools, false));
  }

  // --- 3. Body: 正文区 (白色展开区) ---
  const finalAnswer = trimSafe(answer);
  if (finalAnswer) {
    // 分割线：将灰色过程区和白色正文区隔开
    if (elements.length > 0) elements.push({ tag: 'hr' });

    // 💡 尝试视觉优化：直接渲染 Markdown
    // 注意：飞书标准卡片无法通过参数调整正文字号。
    // 它是自适应的。我们确保它在独立的 div 中，周围留白，视觉上会显得“舒展”一些。
    elements.push({
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: finalAnswer,
      },
    });
  } else if (!status.trim() && !thinking.trim()) {
    elements.push({
      tag: 'div',
      text: { tag: 'lark_md', content: 'Allocating resources...' },
    });
  }

  // --- 4. Footer: Status (小字) ---
  if (status.trim()) {
    elements.push({ tag: 'hr' });

    elements.push({
      tag: 'note',
      elements: [{ tag: 'plain_text', content: getStatusWithEmoji(status.trim()) }],
    });
  }

  const card: FeishuCard = {
    config: { wide_screen_mode: true },
    header: {
      template: headerColor,
      title: { tag: 'plain_text', content: headerTitle },
    },
    elements: elements.filter(Boolean),
  };

  return JSON.stringify(card);
}

export class FeishuRenderer {
  render(markdown: string): string {
    return renderFeishuCardFromHandlerMarkdown(markdown);
  }
}
