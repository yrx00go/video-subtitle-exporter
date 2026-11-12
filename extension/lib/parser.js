// 字幕格式解析：统一输出 [{start, end, text}]（时间单位为秒）
// 注意：MV3 service worker 没有 DOM，所以 XML 用手写正则解析，不能用 DOMParser。

/**
 * YouTube json3 格式
 * {"events":[{"tStartMs":0,"dDurationMs":1500,"segs":[{"utf8":"hello"}]}]}
 */
export function parseJson3(input) {
  const obj = typeof input === 'string' ? safeJson(input) : input;
  const events = obj?.events || [];
  const out = [];
  for (const ev of events) {
    if (!ev.segs) continue;
    const text = normalize(ev.segs.map((s) => s.utf8 || '').join(''));
    if (!text) continue;
    const start = (ev.tStartMs || 0) / 1000;
    out.push({
      start,
      end: start + (ev.dDurationMs || 0) / 1000,
      text,
    });
  }
  return out;
}

/**
 * YouTube srv3 / 旧版 XML
 * <p t="1000" d="2000">hello</p>
 * <text start="1.0" dur="2.0">hello</text>
 */
export function parseXml(input) {
  const out = [];
  const srv3 = /<p\b[^>]*\bt="(\d+)"[^>]*\bd="(\d+)"[^>]*>([\s\S]*?)<\/p>/g;
  let m;
  while ((m = srv3.exec(input))) {
    const text = normalize(stripTags(m[3]));
    if (!text) continue;
    out.push({ start: Number(m[1]) / 1000, end: (Number(m[1]) + Number(m[2])) / 1000, text });
  }
  if (out.length) return out;

  const legacy = /<text\b[^>]*\bstart="([\d.]+)"[^>]*?(?:\bdur="([\d.]+)")?[^>]*>([\s\S]*?)<\/text>/g;
  while ((m = legacy.exec(input))) {
    const text = normalize(stripTags(m[3]));
    if (!text) continue;
    const start = Number(m[1]);
    out.push({ start, end: start + Number(m[2] || 0), text });
  }
  return out;
}

/**
 * B 站字幕
 * {"body":[{"from":1.2,"to":3.4,"content":"内容"}]}
 */
export function parseBilibili(input) {
  const obj = typeof input === 'string' ? safeJson(input) : input;
  return (obj?.body || [])
    .map((x) => ({
      start: Number(x.from) || 0,
      end: Number(x.to) || 0,
      text: normalize(x.content),
    }))
    .filter((x) => x.text);
}

/** 自动识别格式 */
export function parseAuto(raw) {
  const s = String(raw || '').trim();
  if (!s) return [];
  if (s.startsWith('{') || s.startsWith('[')) {
    const obj = safeJson(s);
    if (obj?.events) return parseJson3(obj);
    if (obj?.body) return parseBilibili(obj);
    return [];
  }
  if (s.startsWith('<')) return parseXml(s);
  return [];
}

function safeJson(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function stripTags(s) {
  return s
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

function normalize(s) {
  return String(s || '')
    .replace(/\s+/g, ' ')
    .trim();
}
