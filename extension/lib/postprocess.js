// 后处理：去重、合并、断句。纯函数，可单独测试。

const GAP_MERGE = 1.5; // 相邻句间隔小于该秒数则倾向合并
const MAX_PARA = 200; // 单段最大字数
const HARD_GAP = 6.0; // 间隔超过该秒数强制分段

/**
 * 主流程：句子数组 -> 段落数组
 * @param {{start:number,end:number,text:string}[]} sentences
 * @param {{isAsr?:boolean}} opts
 */
export function toParagraphs(sentences, opts = {}) {
  const cleaned = dedupe(sentences || []);
  if (!cleaned.length) return [];

  const paras = [];
  let buf = '';
  let prevEnd = null;

  for (const s of cleaned) {
    const text = String(s.text || '').trim();
    if (!text) continue;

    const gap = prevEnd == null ? 0 : s.start - prevEnd;
    const needBreak = buf && (gap > HARD_GAP || (gap > GAP_MERGE && buf.length > 20) || buf.length > MAX_PARA);

    if (needBreak) {
      paras.push(buf.trim());
      buf = '';
    }

    buf = joinText(buf, text);
    prevEnd = s.end || s.start;
  }
  if (buf.trim()) paras.push(buf.trim());
  return paras.filter(Boolean);
}

/** 拼接两段文本，中文不加空格，英文加空格 */
function joinText(a, b) {
  if (!a) return b;
  const last = a.slice(-1);
  const first = b.slice(0, 1);
  const cjk = /[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/;
  if (cjk.test(last) || cjk.test(first)) return a + b;
  if (/[.,!?;:)\]"']$/.test(a)) return a + ' ' + b;
  return a + ' ' + b;
}

/**
 * 去重：YouTube 自动字幕滚动窗口会产生大量重复片段
 */
export function dedupe(sentences) {
  const out = [];
  let prev = '';
  for (const s of sentences) {
    const t = String(s.text || '').trim();
    if (!t) continue;
    if (t === prev) continue; // 完全重复
    // 当前是上一条的后缀/前缀重复（滚动字幕常见）
    if (prev && t.startsWith(prev) && t.length - prev.length < 20) {
      out[out.length - 1] = { ...s, text: t };
      prev = t;
      continue;
    }
    if (prev && prev.endsWith(t) && prev.length - t.length < 20) {
      prev = prev;
      continue;
    }
    out.push(s);
    prev = t;
  }
  return out;
}

/**
 * 估算时长（秒），用于元信息头
 */
export function totalDuration(sentences) {
  if (!sentences?.length) return 0;
  return Math.max(...sentences.map((s) => s.end || s.start || 0));
}

export function formatDuration(sec) {
  const s = Math.round(sec || 0);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const mm = h ? String(m).padStart(2, '0') : String(m);
  const rr = String(r).padStart(2, '0');
  return h ? `${h}:${mm}:${rr}` : `${mm}:${rr}`;
}
