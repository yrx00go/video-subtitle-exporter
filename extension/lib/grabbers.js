// 注入页面主世界（MAIN world）的抓取函数。
// 约束：这些函数会被 chrome.scripting.executeScript 序列化后注入，
// 函数体内不能引用任何外部变量 / import，所有依赖必须内联。

/**
 * 抓取 YouTube 字幕。
 * 优先读播放器对象，退化为 ytInitialPlayerResponse。
 * 字幕轨优先级：中文手动 > 中文 ASR > 任意手动 > 任意 ASR > 第一条
 */
export async function grabYouTube() {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const getPlayerResponse = () => {
    const p = document.getElementById('movie_player');
    try {
      if (p && typeof p.getPlayerResponse === 'function') {
        const r = p.getPlayerResponse();
        if (r && r.captions) return r;
      }
    } catch (e) {
      /* 播放器可能尚未就绪 */
    }
    return window.ytInitialPlayerResponse || null;
  };

  // 播放器可能还在初始化，最多等 5 秒
  let resp = null;
  for (let i = 0; i < 10; i++) {
    resp = getPlayerResponse();
    if (resp && resp.captions) break;
    await sleep(500);
  }
  if (!resp) return { ok: false, reason: 'NO_PLAYER_RESPONSE' };

  const vd = resp.videoDetails || {};
  const base = {
    title: vd.title || document.title.replace(/\s*-\s*YouTube\s*$/, ''),
    author: vd.author || '',
    duration: Number(vd.lengthSeconds) || 0,
    url: location.href,
    playability: (resp.playabilityStatus && resp.playabilityStatus.status) || '',
    playabilityReason: (resp.playabilityStatus && resp.playabilityStatus.reason) || '',
  };

  // 多路收集字幕轨：不同视频/AB 实验下 captions 可能出现的位置不同
  let tracks = [];
  let trackSource = '';
  const collect = (r, tag) => {
    const plc = r && r.captions && r.captions.playerCaptionsTracklistRenderer;
    const ct = plc && plc.captionTracks;
    if (ct && ct.length) {
      tracks = ct;
      trackSource = tag;
      return true;
    }
    return false;
  };

  collect(resp, 'playerResponse');
  if (!tracks.length) collect(window.ytInitialPlayerResponse, 'initialPlayerResponse');
  // 第三路：嗅探器从 youtubei/v1/player 响应里缓存的字幕轨
  if (!tracks.length && window.__SUB_TRACKS__ && window.__SUB_TRACKS__.length) {
    tracks = window.__SUB_TRACKS__;
    trackSource = 'sniffedPlayerResponse';
  }
  if (!tracks.length) {
    try {
      const yid = window.ytInitialData;
      const panels = (yid && yid.engagementPanels) || [];
      for (const gp of panels) {
        const r = gp && gp.engagementPanelSectionListRenderer;
        const ep = r && r.content && r.content.continuationItemRenderer;
        const gt = ep && ep.continuationEndpoint && ep.continuationEndpoint.getTranscriptEndpoint;
        if (gt && gt.params) {
          // 有转录稿面板说明该视频确实有字幕，但拿不到 baseUrl，仅作为诊断
          trackSource = 'transcriptPanelOnly';
        }
      }
    } catch (e) {
      /* ignore */
    }
  }

  // 第四路（最强）：页内嗅探缓冲区里可能已经有字幕正文了，
  // 播放器能渲染字幕说明它一定成功请求过数据。
  if (!tracks.length && Array.isArray(window.__SUB_SNIFFED__) && window.__SUB_SNIFFED__.length) {
    const parseInline = (raw) => {
      const t = String(raw || '').trim();
      if (!t) return [];
      let o = null;
      try {
        o = JSON.parse(t);
      } catch (e) {
        return [];
      }
      if (o && o.events) {
        return o.events
          .filter((e) => e.segs)
          .map((e) => ({
            start: (e.tStartMs || 0) / 1000,
            end: ((e.tStartMs || 0) + (e.dDurationMs || 0)) / 1000,
            text: e.segs
              .map((x) => x.utf8 || '')
              .join('')
              .replace(/\s+/g, ' ')
              .trim(),
          }))
          .filter((x) => x.text);
      }
      if (o && Array.isArray(o.body)) {
        return o.body
          .map((x) => ({ start: Number(x.from) || 0, end: Number(x.to) || 0, text: String(x.content || '').trim() }))
          .filter((x) => x.text);
      }
      return [];
    };

    for (let i = window.__SUB_SNIFFED__.length - 1; i >= 0; i--) {
      const item = window.__SUB_SNIFFED__[i];
      const sentences = parseInline(item.body);
      if (sentences.length >= 2) {
        return {
          ok: true,
          sentences,
          title: base.title,
          author: base.author,
          duration: base.duration,
          url: base.url,
          lang: '',
          isAsr: /asr|aisubtitle/i.test(item.url),
          sourceLabel: /asr|aisubtitle/i.test(item.url) ? '自动字幕（页内嗅探）' : '字幕（页内嗅探）',
        };
      }
    }
  }

  if (!tracks.length) {
    // 兜底路径：字幕轨读不到时，改走「转录稿」接口。
    // 只要页面上能显示字幕，转录稿面板通常就有数据，它与 captionTracks 是两套数据源。
    let transcript = null;
    try {
      let params = null;
      const yid = window.ytInitialData;
      const panels = (yid && yid.engagementPanels) || [];
      for (const gp of panels) {
        const ep =
          gp &&
          gp.engagementPanelSectionListRenderer &&
          gp.engagementPanelSectionListRenderer.content &&
          gp.engagementPanelSectionListRenderer.content.continuationItemRenderer &&
          gp.engagementPanelSectionListRenderer.content.continuationItemRenderer.continuationEndpoint &&
          gp.engagementPanelSectionListRenderer.content.continuationItemRenderer.continuationEndpoint
            .getTranscriptEndpoint;
        if (ep && ep.params) {
          params = ep.params;
          break;
        }
      }
      if (params) {
        const cfg = window.ytcfg;
        const key = cfg && cfg.get ? cfg.get('INNERTUBE_API_KEY') : null;
        const ctxObj = cfg && cfg.get ? cfg.get('INNERTUBE_CONTEXT') : null;
        const r = await fetch(`/youtubei/v1/get_transcript?key=${key}&prettyPrint=false`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ context: ctxObj, params: params }),
          credentials: 'include',
        });
        if (r.ok) {
          const j = await r.json();
          const act = (j.actions || [])[0] || {};
          const uea = act.updateEngagementPanelAction || {};
          const tr = (uea.content && uea.content.transcriptRenderer) || {};
          const tc = tr.content || {};
          const panel = tc.transcriptSearchPanelRenderer || tc.transcriptRenderer || {};
          const segList =
            (panel.body && panel.body.transcriptSegmentListRenderer && panel.body.transcriptSegmentListRenderer.initialSegments) || [];
          const sentences = segList
            .map((sg) => {
              const t = sg.transcriptSegmentRenderer || {};
              const text = (t.snippet && t.snippet.runs ? t.snippet.runs.map((x) => x.text || '').join('') : '') || '';
              return { start: (t.startMs || 0) / 1000, end: (t.endMs || 0) / 1000, text: text.trim() };
            })
            .filter((x) => x.text);
          if (sentences.length) transcript = sentences;
        }
      }
    } catch (e) {
      /* 转录稿不可用时继续走诊断 */
    }

    if (transcript && transcript.length) {
      return {
        ok: true,
        sentences: transcript,
        title: base.title,
        author: base.author,
        duration: base.duration,
        url: base.url,
        lang: '',
        isAsr: false,
        sourceLabel: '转录稿（YouTube 面板）',
      };
    }

    // 收集诊断信息，便于定位为什么读不到（会显示在错误提示并复制到剪贴板）
    let tracklist = null;
    let optionErr = '';
    try {
      const pl = document.getElementById('movie_player');
      if (pl && typeof pl.getOption === 'function') tracklist = pl.getOption('captions', 'tracklist');
    } catch (e) {
      optionErr = String(e);
    }
    const ccBtn = document.querySelector('.ytp-subtitles-button');
    return {
      ok: false,
      reason: 'NO_CAPTION_TRACKS',
      diag: {
        trackCount: 0,
        trackSource: trackSource || 'none',
        hasPlayerResponse: !!resp,
        playability: (resp.playabilityStatus && resp.playabilityStatus.status) || '',
        playabilityReason: (resp.playabilityStatus && resp.playabilityStatus.reason) || '',
        hasCaptionsField: !!(resp && resp.captions),
        hasRenderer: !!(resp && resp.captions && resp.captions.playerCaptionsTracklistRenderer),
        tracklistCount: Array.isArray(tracklist) ? tracklist.length : -1,
        tracklist: Array.isArray(tracklist) ? tracklist.slice(0, 6) : null,
        optionErr: optionErr,
        domCaptionCount: document.querySelectorAll(
          '.ytp-caption-segment, .caption-window span, .ytp-caption-window-container span'
        ).length,
        hasSniffedTracks: !!(window.__SUB_TRACKS__ && window.__SUB_TRACKS__.length),
        ccPressed: ccBtn ? ccBtn.getAttribute('aria-pressed') : 'no-button',
        href: location.href,
      },
      ...base,
    };
  }

  // 选择优先级：中文手动 > 中文 ASR > 英文手动 > 英文 ASR > 任意手动 > 任意 ASR > 第一条
  // （实测发现：无中文时若直接取第一条，可能选到德语等冷门语种）
  const isZh = (lang) => /^(zh|cmn)/i.test(lang || '');
  const isEn = (lang) => /^en/i.test(lang || '');
  const manual = tracks.filter((t) => t.kind !== 'asr');
  const asr = tracks.filter((t) => t.kind === 'asr');
  const track =
    manual.find((t) => isZh(t.languageCode)) ||
    asr.find((t) => isZh(t.languageCode)) ||
    manual.find((t) => isEn(t.languageCode)) ||
    asr.find((t) => isEn(t.languageCode)) ||
    manual[0] ||
    asr[0] ||
    tracks[0];

  const url = track.baseUrl + '&fmt=json3';
  let body = '';
  let status = 0;
  try {
    const r = await fetch(url, { credentials: 'include' });
    status = r.status;
    body = await r.text();
  } catch (e) {
    return { ok: false, reason: 'FETCH_ERROR', message: String(e), ...base };
  }

  // 关键信号：HTTP 200 但内容为空 = 被 pot 校验静默拒绝。
  // 先交给 background（service worker 有扩展权限，可能绕过页面侧限制），
  // 仍失败再走嗅探兜底。
  if (!body || body.length < 10) {
    return {
      ok: false,
      reason: 'NEED_SERVER_FETCH',
      fetchUrl: url,
      httpStatus: status,
      baseUrl: track.baseUrl,
      lang: track.languageCode || '',
      isAsr: track.kind === 'asr',
      tracks: tracks.map((t) => ({ lang: t.languageCode, asr: t.kind === 'asr' })),
      ...base,
    };
  }

  return {
    ok: true,
    raw: body,
    lang: track.languageCode || '',
    isAsr: track.kind === 'asr',
    sourceLabel: track.kind === 'asr' ? '自动生成（平台 ASR）' : '上传者字幕',
    ...base,
  };
}

/**
 * 抓取 B 站字幕。
 * 优先旧端点 /x/player/v2（免签名），失败再试 wbi 端点。
 */
export async function grabBilibili() {
  const m = location.pathname.match(/\/video\/(BV[0-9A-Za-z]+)/);
  if (!m) return { ok: false, reason: 'NOT_VIDEO_PAGE' };
  const bvid = m[1];
  const pageNum = Number(new URLSearchParams(location.search).get('p') || 1) || 1;

  let view;
  try {
    const r = await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`, {
      credentials: 'include',
    });
    view = await r.json();
  } catch (e) {
    return { ok: false, reason: 'VIEW_FETCH_ERROR', message: String(e) };
  }
  if (!view || view.code !== 0) {
    return {
      ok: false,
      reason: 'VIEW_FAILED',
      code: view && view.code,
      message: (view && view.message) || '',
    };
  }

  const d = view.data;
  const pages = d.pages || [];
  const page = pages[pageNum - 1] || pages[0] || {};
  const cid = page.cid || d.cid;

  const base = {
    title: pageNum > 1 && page.part ? `${d.title}_P${pageNum}_${page.part}` : d.title,
    author: (d.owner && d.owner.name) || '',
    duration: Number(page.duration || d.duration) || 0,
    url: location.href,
  };

  const endpoints = ['/x/player/v2', '/x/player/wbi/v2'];
  let lastError = null;

  for (const ep of endpoints) {
    let j;
    try {
      const r = await fetch(`https://api.bilibili.com${ep}?bvid=${bvid}&cid=${cid}`, {
        credentials: 'include',
      });
      j = await r.json();
    } catch (e) {
      lastError = { reason: 'PLAYER_FETCH_ERROR', message: String(e) };
      continue;
    }

    if (!j || j.code !== 0) {
      lastError = { reason: 'PLAYER_API_FAILED', endpoint: ep, code: j && j.code, message: (j && j.message) || '' };
      continue;
    }

    const subtitle = (j.data && j.data.subtitle) || {};
    const subs = subtitle.subtitles || [];
    if (!subs.length) {
      // 区分"未登录所以看不到字幕"和"视频本身没有字幕"
      let isLogin = null;
      try {
        const nv = await (await fetch('https://api.bilibili.com/x/web-interface/nav', { credentials: 'include' })).json();
        isLogin = !!(nv && nv.data && nv.data.isLogin);
      } catch (e) { /* ignore */ }
      lastError = { reason: 'NO_SUBTITLE', aiStatus: subtitle.ai_status, isLogin };
      continue;
    }

    const pick =
      subs.find((s) => s.lan === 'ai-zh') ||
      subs.find((s) => /^zh/i.test(s.lan || '')) ||
      subs.find((s) => s.lan !== 'ai-en') ||
      subs[0];

    let subUrl = pick.subtitle_url || '';
    if (subUrl.startsWith('//')) subUrl = 'https:' + subUrl;
    if (!subUrl) {
      lastError = { reason: 'NO_SUBTITLE_URL' };
      continue;
    }

    // 字幕 CDN 的 auth_key 已自带鉴权。
    // 注意：跨域 fetch 时不能带 credentials —— CDN 若返回 ACAO:* 会被浏览器拒绝（CORS 错误）。
    let body = '';
    try {
      const r = await fetch(subUrl, { credentials: 'omit' });
      body = await r.text();
    } catch (e) {
      // 页面侧下载失败（CORS / 鉴权头），交回 background 用扩展权限下载
      return {
        ok: false,
        reason: 'NEED_SERVER_FETCH',
        fetchUrl: subUrl,
        subtitleUrl: subUrl,
        lang: pick.lan || '',
        isAsr: /^ai/.test(String(pick.lan || '')) || /aisubtitle/.test(subUrl),
        ...base,
      };
    }

    if (!body || body.length < 10) {
      return {
        ok: false,
        reason: 'NEED_SERVER_FETCH',
        fetchUrl: subUrl,
        subtitleUrl: subUrl,
        lang: pick.lan || '',
        isAsr: /^ai/.test(String(pick.lan || '')) || /aisubtitle/.test(subUrl),
        ...base,
      };
    }

    const isAi = String(pick.lan).startsWith('ai') || /aisubtitle/.test(subUrl);
    return {
      ok: true,
      raw: body,
      lang: pick.lan || '',
      isAsr: isAi,
      sourceLabel: isAi ? 'AI 字幕（平台 ASR）' : 'UP 主上传',
      ...base,
    };
  }

  return { ok: false, ...(lastError || { reason: 'UNKNOWN' }), ...base };
}

/**
 * 主动打开播放器字幕开关，触发播放器自己去加载字幕。
 * 用于嗅探兜底模式。
 */
export async function enableCaptions() {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // YouTube
  const ytBtn = document.querySelector('.ytp-subtitles-button');
  if (ytBtn) {
    if (ytBtn.getAttribute('aria-pressed') !== 'true') ytBtn.click();
    return { platform: 'youtube', clicked: true };
  }

  // B 站：先展开字幕菜单，再选中文轨
  const cc = document.querySelector('.bpx-player-ctrl-subtitle');
  if (cc) {
    cc.click();
    await sleep(400);
    const items = Array.from(document.querySelectorAll('.bpx-player-ctrl-subtitle-language-item'));
    const pick =
      items.find((el) => (el.getAttribute('data-lan') || '').includes('ai-zh')) ||
      items.find((el) => (el.getAttribute('data-lan') || '').startsWith('zh')) ||
      items[0];
    if (pick) {
      pick.click();
      return { platform: 'bilibili', clicked: true, lan: pick.getAttribute('data-lan') };
    }
    return { platform: 'bilibili', clicked: false, reason: 'NO_LANGUAGE_ITEM' };
  }

  return { platform: 'unknown', clicked: false, reason: 'NO_BUTTON' };
}

/**
 * 安装请求嗅探器：旁听播放器自己发出的字幕请求。
 * 播放器自己发出的请求一定是成功的（否则用户看不到字幕），
 * 因此这条路可以绕过所有 pot / 签名校验。
 */
export function installSniffer() {
  if (window.__SUB_SNIFFER_INSTALLED__) return { installed: true, reused: true };
  window.__SUB_SNIFFER_INSTALLED__ = true;

  const PATTERN =
    /timedtext|aisubtitle|\/subtitle\/|player\/v2|player\/wbi\/v2|youtubei\/v1\/player|get_transcript/i;
  const emit = (url, body) => {
    // 关键：player 响应里本身就带 captionTracks。
    // 很多情况下页面上的 getPlayerResponse() 读不到 captions，但这条网络响应里有。
    if (/youtubei\/v1\/player/i.test(String(url))) {
      try {
        const j = JSON.parse(body);
        const ct =
          j &&
          j.captions &&
          j.captions.playerCaptionsTracklistRenderer &&
          j.captions.playerCaptionsTracklistRenderer.captionTracks;
        if (ct && ct.length) window.__SUB_TRACKS__ = ct;
      } catch (e) {
        /* 非 JSON 或结构不符 */
      }
    }
    try {
      window.postMessage({ __subtitleSniff: true, url: String(url), body: String(body) }, '*');
    } catch (e) {
      /* ignore */
    }
  };

  const origFetch = window.fetch;
  if (origFetch) {
    window.fetch = function (...args) {
      const p = origFetch.apply(this, args);
      try {
        const req = args[0];
        const url = typeof req === 'string' ? req : req && req.url;
        if (url && PATTERN.test(url)) {
          p.then((res) => {
            res
              .clone()
              .text()
              .then((body) => emit(url, body))
              .catch(() => {});
          }).catch(() => {});
        }
      } catch (e) {
        /* ignore */
      }
      return p;
    };
  }

  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__subUrl = url;
    return origOpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function (...args) {
    try {
      if (this.__subUrl && PATTERN.test(String(this.__subUrl))) {
        this.addEventListener('load', () => {
          try {
            emit(this.__subUrl, this.responseText);
          } catch (e) {
            /* ignore */
          }
        });
      }
    } catch (e) {
      /* ignore */
    }
    return origSend.apply(this, args);
  };

  return { installed: true, reused: false };
}

/**
 * 只取页面元信息（标题/作者/时长），不请求字幕。
 * 用于「嗅探缓存命中」时补全文件名等信息 —— 这条路径不经过抓取函数，拿不到元数据。
 */
export function grabMeta() {
  const isYT = /youtube\.com$/.test(location.hostname);
  if (isYT) {
    const p = document.getElementById('movie_player');
    let resp = null;
    try {
      if (p && typeof p.getPlayerResponse === 'function') resp = p.getPlayerResponse();
    } catch (e) {
      /* ignore */
    }
    if (!resp) resp = window.ytInitialPlayerResponse;
    const vd = (resp && resp.videoDetails) || {};
    return {
      title: vd.title || document.title.replace(/\s*-\s*YouTube\s*$/, ''),
      author: vd.author || '',
      duration: Number(vd.lengthSeconds) || 0,
    };
  }

  // B 站
  const st = window.__INITIAL_STATE__ || {};
  const vd = st.videoData || {};
  const pnum = Number(new URLSearchParams(location.search).get('p') || 1) || 1;
  const page = (vd.pages || [])[pnum - 1];
  return {
    title: page && page.part ? `${vd.title}_P${pnum}_${page.part}` : vd.title || document.title,
    author: (vd.owner && vd.owner.name) || '',
    duration: Number(vd.duration) || 0,
  };
}
