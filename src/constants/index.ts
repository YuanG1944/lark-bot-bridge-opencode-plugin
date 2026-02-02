// src/constants/index.ts

export const AGENT_LARK = 'lark-bridge';
export const AGENT_IMESSAGE = 'imessage-bridge';
export const AGENT_TELEGRAM = 'telegram-bridge';

export const LOADING_EMOJI = 'Typing';

// 流式更新节流
export const UPDATE_INTERVAL = 900;

// 展示裁剪上限（飞书卡片有长度限制，务必裁剪）
export const MAX_REASONING_CHARS = 4000;
export const MAX_TEXT_CHARS = 16000;
export const MAX_TOOL_OUTPUT_CHARS = 4000;
export const MAX_TOOL_INPUT_CHARS = 2000;
