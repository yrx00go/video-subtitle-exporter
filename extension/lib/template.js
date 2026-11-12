// txt 组装：元信息头 + 正文

import { formatDuration } from './postprocess.js';

/**
 * @param {object} meta
 * @param {string} meta.title
 * @param {string} meta.url
 * @param {string} meta.author
 * @param {string} meta.lang
 * @param {string} meta.source  手动字幕 / AI字幕 / 自动生成(ASR)
 * @param {number} meta.duration 秒
 * @param {string[]} paragraphs
 * @param {boolean} withHeader
 */
export function buildTxt(meta, paragraphs, withHeader = true) {
  const body = (paragraphs || []).join('\n\n');
  if (!withHeader) return body + '\n';

  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const exported = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(
    now.getHours()
  )}:${pad(now.getMinutes())}`;

  const lines = [
    `标题：${meta.title || ''}`,
    `链接：${meta.url || ''}`,
    `作者：${meta.author || ''}`,
    `时长：${formatDuration(meta.duration)}`,
    `字幕来源：${meta.source || ''}`,
    `语言：${meta.lang || ''}`,
    `导出时间：${exported}`,
    '─'.repeat(40),
    '',
  ];
  return lines.join('\n') + body + '\n';
}
