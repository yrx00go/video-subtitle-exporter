// 后台调度：抓取 -> 解析 -> 后处理 -> 组装 -> 下载

import { parseAuto } from './lib/parser.js';
import { toParagraphs, totalDuration } from './lib/postprocess.js';
import { toFilename } from './lib/filename.js';
import { buildTxt } from './lib/template.js';
import { grabYouTube, grabBilibili, enableCaptions, installSniffer, grabMeta } from './lib/grabbers.js';

// 嗅探回调（同一时刻只处理一个导出任务）
let sniffHandler = null;

// 提前嗅探缓存：tabId -> [{url, body, ts}]
// content script 一加载就装嗅探器，用户开过字幕的请求都会被这里接住，
// 点导出时直接复用，不用再等播放器重新请求。
const sniffCache = new Map();

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;
  const tabId = sender && sender.tab ? sender.tab.id : null;

  // content script 请求提前安装嗅探器
  if (msg.type === 'ENSURE_SNIFFER') {
    if (tabId) {
      chrome.scripting
        .executeScript({ target: { tabId }, world: 'MAIN', func: installSniffer })
        .catch(() => {});
    }
    return;
  }

  // content script 转发来的嗅探结果
  if (msg.type === 'SNIFFED') {
    if (tabId) {
      const arr = sniffCache.get(tabId) || [];
      arr.push({ url: msg.url, body: msg.body, ts: Date.now() });
      if (arr.length > 10) arr.shift();
      sniffCache.set(tabId, arr);
    }
    if (sniffHandler) sniffHandler(msg);
    return;
  }

  if (msg.type === 'EXPORT') {
    const tabInfo = sender && sender.tab ? { tabId: sender.tab.id, url: sender.tab.url } : {};
    handleExport(tabInfo, msg.options || {})
      .then((r) => sendResponse(r))
      .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
    return true; // 异步响应
  }
});

// 标签页关闭时清理缓存
chrome.tabs.onRemoved.addListener((tabId) => sniffCache.delete(tabId));

function detectPlatform(url) {
  if (/youtube\.com\/watch/.test(url)) return 'youtube';
  if (/bilibili\.com\/video\//.test(url)) return 'bilibili';
  return null;
}

async function handleExport(tabInfo, options) {
  const { tabId, url } = tabInfo;
  if (!tabId) return { ok: false, error: '未找到标签页' };

  const platform = detectPlatform(url || '');
  if (!platform) return { ok: false, error: '当前页面不受支持（需要 YouTube 或 B 站视频页）' };

  let result = { ok: false };
  let mode = '';

  // ---------- 模式 0：复用提前嗅探到的字幕（最快、最可靠） ----------
  const cached = sniffCache.get(tabId) || [];
  for (let i = cached.length - 1; i >= 0; i--) {
    const sentences = parseAuto(cached[i].body);
    if (sentences.length >= 2) {
      const u = cached[i].url || '';
      let lang = '';
      try {
        lang = new URL(u).searchParams.get('lang') || new URL(u).searchParams.get('tlang') || '';
      } catch (e) {
        /* ignore */
      }
      result = {
        ok: true,
        sentences,
        title: '',
        author: '',
        duration: 0,
        url,
        lang,
        isAsr: /asr|aisubtitle|ai-zh/i.test(u),
        sourceLabel: /aisubtitle|ai-zh/i.test(u) ? 'AI 字幕（嗅探捕获）' : '平台字幕（嗅探捕获）',
      };
      mode = 'sniff-cache';
      break;
    }
  }

  // 嗅探缓存命中的路径不经过抓取函数，需要单独补标题等元信息（文件名依赖它）
  if (result.ok && !result.title) {
    const meta = await runMeta(tabId);
    if (meta && meta.title) {
      result.title = meta.title;
      result.author = meta.author || result.author;
      result.duration = meta.duration || result.duration;
    }
  }

  // ---------- 模式 1：主动抓取 ----------
  if (!result.ok) {
    result = await runGrabber(tabId, platform);
    mode = 'active';
  }

  // ---------- 模式 1.5：页面下载失败，交给扩展权限下载 ----------
  if (!result.ok && result.reason === 'NEED_SERVER_FETCH' && result.fetchUrl) {
    const body = await fetchFromBackground(result.fetchUrl, platform);
    if (body) {
      result = {
        ok: true,
        raw: body,
        title: result.title || '',
        author: result.author || '',
        duration: result.duration || 0,
        url: result.url || url,
        lang: result.lang || '',
        isAsr: !!result.isAsr,
        sourceLabel: result.isAsr ? 'AI 字幕（平台 ASR）' : result.sourceLabel || '平台字幕',
      };
      mode = 'server-fetch';
    }
  }

  // ---------- 模式 2：嗅探兜底（现场触发） ----------
  if (!result.ok) {
    const sniffed = await sniffFallback(tabId, result);
    if (sniffed) {
      result = sniffed.result;
      mode = 'sniff';
    }
  }

  if (!result.ok) {
    return {
      ok: false,
      platform,
      mode,
      reason: result.reason,
      detail: buildReasonText(result),
      aiStatus: result.aiStatus,
      diag: result.diag || null,
      sniffCount: (sniffCache.get(tabId) || []).length,
      sniffUrls: (sniffCache.get(tabId) || []).slice(-4).map((c) => String(c.url).slice(0, 90)),
    };
  }

  // ---------- 解析与后处理 ----------
  const sentences = result.sentences || parseAuto(result.raw);
  if (!sentences.length) {
    return { ok: false, platform, mode, reason: 'PARSE_EMPTY', detail: '拿到字幕数据但解析为空' };
  }

  // 嗅探路径拿不到标题等信息，从抓取结果或页面补全
  let title = result.title;
  let author = result.author;
  let duration = result.duration;
  let pageUrl = result.url || url;

  if (!title && !result.ok) title = '';

  const paragraphs = toParagraphs(sentences, { isAsr: !!result.isAsr });
  if (!duration) duration = totalDuration(sentences);

  const txt = buildTxt(
    {
      title,
      url: pageUrl,
      author,
      lang: result.lang,
      source: result.sourceLabel,
      duration,
    },
    paragraphs,
    options.withHeader !== false
  );

  const filename = toFilename(title) + '.txt';
  await downloadInPage(tabId, filename, txt);

  return {
    ok: true,
    platform,
    mode,
    filename,
    title,
    source: result.sourceLabel,
    lang: result.lang,
    sentences: sentences.length,
    paragraphs: paragraphs.length,
    chars: txt.length,
    duration,
  };
}

/** 用扩展权限下载（service worker 不受页面 CORS 限制） */
async function fetchFromBackground(fetchUrl, platform) {
  try {
    const isYt = /youtube\.com/.test(fetchUrl);
    const r = await fetch(fetchUrl, {
      credentials: isYt ? 'include' : 'omit',
      cache: 'no-store',
    });
    if (!r.ok) return null;
    const text = await r.text();
    return text && text.length >= 10 ? text : null;
  } catch (e) {
    return null;
  }
}

async function runMeta(tabId) {
  try {
    const res = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: grabMeta,
    });
    return (res && res[0] && res[0].result) || null;
  } catch (e) {
    return null;
  }
}

async function runGrabber(tabId, platform) {
  const fn = platform === 'youtube' ? grabYouTube : grabBilibili;
  try {
    const res = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: fn,
    });
    return (res && res[0] && res[0].result) || { ok: false, reason: 'NO_RESULT' };
  } catch (e) {
    return { ok: false, reason: 'INJECT_FAILED', message: String(e) };
  }
}

/**
 * 嗅探兜底：注入 hook -> 主动开字幕 -> 等播放器自己请求成功
 */
async function sniffFallback(tabId, prev) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: installSniffer,
    });
  } catch (e) {
    return null;
  }

  const waiter = waitForSubtitle(12000);

  // 触发播放器加载字幕
  let clickInfo = null;
  try {
    const res = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: enableCaptions,
    });
    clickInfo = res && res[0] && res[0].result;
  } catch (e) {
    /* ignore */
  }

  const hit = await waiter;
  if (!hit) return null;

  const base = {
    title: prev.title || '',
    author: prev.author || '',
    duration: prev.duration || 0,
    url: prev.url || '',
  };

  let lang = '';
  let isAsr = false;
  try {
    const u = new URL(hit.url);
    lang = u.searchParams.get('lang') || u.searchParams.get('tlang') || '';
    isAsr = /asr|aisubtitle/i.test(hit.url);
  } catch (e) {
    /* ignore */
  }

  return {
    result: {
      ok: true,
      sentences: hit.sentences,
      title: base.title,
      author: base.author,
      duration: base.duration,
      url: base.url,
      lang,
      isAsr,
      sourceLabel: isAsr ? '自动生成（嗅探捕获）' : '播放器字幕（嗅探捕获）',
    },
    note: clickInfo && clickInfo.platform ? `已自动开启 ${clickInfo.platform} 字幕` : '',
  };
}

function waitForSubtitle(timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      sniffHandler = null;
      resolve(null);
    }, timeoutMs);

    sniffHandler = (msg) => {
      const sentences = parseAuto(msg.body);
      if (!sentences.length) return; // 不是正文（比如字幕轨列表），继续等
      clearTimeout(timer);
      sniffHandler = null;
      resolve({ url: msg.url, sentences });
    };
  });
}

/** 在页面里用 Blob + a.download 下载（service worker 不支持 createObjectURL） */
async function downloadInPage(tabId, filename, text) {
  await chrome.scripting.executeScript({
    target: { tabId },
    func: (name, content) => {
      const blob = new Blob(['\uFEFF' + content], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        URL.revokeObjectURL(url);
        a.remove();
      }, 1500);
      return true;
    },
    args: [filename, text],
    world: 'ISOLATED',
  });
}

function buildReasonText(r) {
  const map = {
    NO_CAPTION_TRACKS: '该视频没有字幕轨（上传者未提供，平台也未生成自动字幕）',
    NO_SUBTITLE: '该视频没有可用的字幕',
    EMPTY_BODY: '字幕接口返回空内容',
    NO_PLAYER_RESPONSE: '未能读取播放器数据，请刷新页面后重试',
    NOT_VIDEO_PAGE: '当前不是视频播放页',
    VIEW_FAILED: '视频信息获取失败',
    PARSE_EMPTY: '字幕解析为空',
  };

  if (r.reason === 'NO_SUBTITLE' && r.aiStatus === 2) {
    return '该视频的 AI 字幕仍在生成中，请稍后再试';
  }
  if (r.reason === 'NO_SUBTITLE' && r.isLogin === false) {
    return '需要先在浏览器登录 B 站账号——未登录时 B 站不返回字幕数据';
  }
  if (r.reason === 'NEED_SERVER_FETCH') {
    return '字幕文件下载失败（页面侧与扩展侧都被拒绝），请尝试播放视频后再导出';
  }
  if (r.reason === 'NO_CAPTION_TRACKS' && r.playability === 'LOGIN_REQUIRED') {
    return 'YouTube 要求登录后才能访问该视频，请先登录 Google 账号';
  }
  if (r.reason === 'NO_CAPTION_TRACKS') {
    const d = r.diag || {};
    // 关键判断：画面有字幕、但既没有字幕轨、DOM 里也没有 CC 渲染的字幕元素
    // => 画面上的文字是烧录进视频的「硬字幕」，不存在可提取的文本数据
    if (d.domCaptionCount === 0 || d.ccPressed === 'no-button') {
      return '未找到可提取的字幕数据。若画面有字幕、但播放器 CC 菜单里没有字幕选项，说明这是烧录在视频里的硬字幕，无法导出文本';
    }
    return '未能读取到字幕轨：请先在播放器里打开一次字幕（CC），再点导出';
  }
  return map[r.reason] || r.reason || '未知原因';
}
