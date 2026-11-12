// 测试 YouTube get_transcript 接口（转录稿面板），它与 timedtext 走不同鉴权路径

import { chromium } from 'playwright-core';
import fs from 'node:fs';

const HOME = process.env.HOME;
const PROFILE = '/tmp/sub-transcript-profile';

function findChrome() {
  const c = [
    `${HOME}/Library/Caches/ms-playwright/chromium-1248/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
    `${HOME}/Library/Caches/ms-playwright/chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
  ];
  for (const x of c) if (fs.existsSync(x)) return x;
  return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
}

const log = (...a) => console.log('[transcript]', ...a);
const url = process.argv[2] || 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';

const ctx = await chromium.launchPersistentContext(PROFILE, {
  executablePath: findChrome(),
  headless: false,
  viewport: { width: 1366, height: 900 },
  args: ['--no-first-run', '--no-default-browser-check', '--disable-search-engine-choice-screen', '--mute-audio'],
});

const page = ctx.pages()[0] || (await ctx.newPage());
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
await new Promise((r) => setTimeout(r, 6000));

// 1. 从页面数据里找 transcript 面板的 params
const found = await page.evaluate(() => {
  const out = { fromInitialData: null, fromPlayer: null, panels: [] };
  try {
    const d = window.ytInitialData;
    const panels = d?.engagementPanels || [];
    for (const p of panels) {
      const r = p?.engagementPanelSectionListRenderer;
      const id = r?.panelIdentifier;
      if (id) out.panels.push(id);
      const ep = r?.content?.continuationItemRenderer?.continuationEndpoint?.getTranscriptEndpoint;
      if (ep?.params) out.fromInitialData = ep.params;
    }
  } catch (e) {
    out.err1 = String(e);
  }
  try {
    const p = document.getElementById('movie_player');
    const pr = p?.getPlayerResponse?.();
    const tracks = pr?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
    out.trackCount = tracks.length;
    out.trackVssId = tracks[0]?.vssId;
  } catch (e) {
    out.err2 = String(e);
  }
  return out;
});
log('页面数据:', JSON.stringify(found).slice(0, 600));

// 2. 直接调 get_transcript
if (found.fromInitialData) {
  const res = await page.evaluate(async (params) => {
    try {
      const cfg = window.ytcfg;
      const key = cfg?.get('INNERTUBE_API_KEY');
      const ctxObj = cfg?.get('INNERTUBE_CONTEXT');
      const r = await fetch(`/youtubei/v1/get_transcript?key=${key}&prettyPrint=false`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ context: ctxObj, params }),
        credentials: 'include',
      });
      const text = await r.text();
      return { status: r.status, len: text.length, head: text.slice(0, 400) };
    } catch (e) {
      return { error: String(e) };
    }
  }, found.fromInitialData);
  log('get_transcript:', JSON.stringify(res, null, 2));
} else {
  log('未找到 transcript params');
}

// 3. 试试点开「显示转录稿」按钮
log('尝试展开转录稿面板…');
const expandResult = await page.evaluate(async () => {
  // 展开描述区
  const expand = document.querySelector('#expand, tp-yt-paper-button#expand');
  if (expand) expand.click();
  await new Promise((r) => setTimeout(r, 1200));
  const btns = Array.from(document.querySelectorAll('button, yt-button-shape button, tp-yt-paper-button'));
  const target = btns.find((b) => /转录稿|Transcript|文字稿|show transcript/i.test(b.textContent || ''));
  if (target) {
    target.click();
    return 'clicked: ' + target.textContent.trim().slice(0, 40);
  }
  return 'not-found: ' + btns.map((b) => (b.textContent || '').trim()).filter(Boolean).slice(0, 15).join(' | ').slice(0, 300);
});
log('  ', expandResult);
await new Promise((r) => setTimeout(r, 4000));

const panelText = await page.evaluate(() => {
  const segs = Array.from(document.querySelectorAll('ytd-transcript-segment-renderer, .ytd-transcript-segment-renderer'))
    .map((e) => e.textContent.trim())
    .filter(Boolean);
  return { count: segs.length, sample: segs.slice(0, 5) };
});
log('转录稿面板内容:', JSON.stringify(panelText).slice(0, 500));

await ctx.close();
