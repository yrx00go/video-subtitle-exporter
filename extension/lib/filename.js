// 文件名清洗：用户要求「txt 文件名就是视频名字」

const ILLEGAL = /[\\/:*?"<>|\u0000-\u001f]/g;
const RESERVED = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;

/**
 * @param {string} title 视频标题
 * @param {number} maxBytes 字节上限（默认 200，为 .txt 后缀留余量）
 */
export function toFilename(title, maxBytes = 200) {
  let name = String(title || '')
    .replace(ILLEGAL, '_')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '') // 首尾的点和空格（Windows 不允许）
    .trim();

  if (!name) name = '未命名视频';
  if (RESERVED.test(name)) name = '_' + name;

  // 按 UTF-8 字节截断，避免超出文件系统限制
  const enc = new TextEncoder();
  while (enc.encode(name).length > maxBytes) {
    name = name.slice(0, -1);
  }
  return name.trim() || '未命名视频';
}
