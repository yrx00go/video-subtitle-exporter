// 针对具体视频诊断 YouTube 字幕轨读取
// 用法：node test/probe-yt-video.mjs <videoId>

import { chromium } from 'playwright-core';
import fs from 'node:fs';

const HOME = process.env.HOME;
const PROFILE = '/tmp/sub-ytdiag-profile';
const vid = process.argv[2] || 'r6UJVVCbIH0';

function findChrome() {
  const c = [
    `${HOME}/Library/Caches/ms-playwright/chromium-1248/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
    `${HOME}/Library/Caches/ms-playwright/chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
  ];
  for (const x of c) if (fs.existsSync(x)) return x;
  return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
}

const log = (...a) => console.log('[ytdiag]', ...a);
fs.rmSync(PROFILE, { recursive: true, force: true });

const ctx = await chromium.launchPersistentContext(PROFILE, {
  executablePath: findChrome(),
  headless: false,
  viewport: { width: 1280, height: 860 },
  args: ['--no-first-run', '--no-default-browser-check', '--disable-search-engine-choice-screen', '--mute-audio'],
});

const page = ctx.pages()[0] || (await ctx.newPage());

// 记录所有字幕相关网络请求
const netHits = [];
page.on('response', async (res) => {
  const u = res.url();
  if (/timedtext|caption|get_transcript/i.test(u)) {
    let len = -1;
    try {
      len = (await res.body()).length;
    } catch (e) {
      len = -2;
    }
    netHits.push({ status: res.status(), len, url: u.slice(0, 180) });
  }
});

log('打开视频:', vid);
await page.goto(`https://www.youtube.com/watch?v=${vid}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
await new Promise((r) => setTimeout(r, 8000));

const diag = await page.evaluate(() => {
  const out = {};
  const p = document.getElementById('movie_player');
  out.hasPlayer = !!p;
  out.playerHasGetPlayerResponse = !!(p && typeof p.getPlayerResponse === 'function');

  let pr = null;
  try {
    pr = p && p.getPlayerResponse ? p.getPlayerResponse() : null;
  } catch (e) {
    out.getPlayerResponseError = String(e);
  }
  out.fromPlayer = !!pr;
  out.fromPlayerKeys = pr ? Object.keys(pr).slice(0, 15) : [];

  const initPr = window.ytInitialPlayerResponse;
  out.hasInitial = !!initPr;
  out.initKeys = initPr ? Object.keys(initPr).slice(0, 15) : [];

  const pick = (r, tag) => {
    if (!r) return null;
    const plc = r.captions && r.captions.playerCaptionsTracklistRenderer;
    return {
      tag,
      playability: r.playabilityStatus && r.playabilityStatus.status,
      playabilityReason: r.playabilityStatus && r.playabilityStatus.reason,
      title: r.videoDetails && r.videoDetails.title,
      hasCaptions: !!r.captions,
      hasRenderer: !!plc,
      trackCount: (plc && plc.captionTracks && plc.captionTracks.length) || 0,
      tracks: ((plc && plc.captionTracks) || []).map((t) => ({
        lang: t.languageCode,
        kind: t.kind,
        vssId: t.vssId,
        hasPot: /[?&]pot=/.test(t.baseUrl || ''),
      })),
      audioTracks: ((plc && plc.audioTracks) || []).length,
    };
  };
  out.fromPlayerDiag = pick(pr, 'player');
  out.fromInitialDiag = pick(initPr, 'initial');

  // 播放器 getOption 通道
  try {
    if (p && typeof p.getOption === 'function') {
      out.optionTracklist = p.getOption('captions', 'tracklist');
      out.optionTrack = p.getOption('captions', 'track');
    }
  } catch (e) {
    out.getOptionError = String(e);
  }

  // 播放器状态
  try {
    out.playerState = p && p.getPlayerState ? p.getPlayerState() : null;
    out.currentTime = p && p.getCurrentTime ? p.getCurrentTime() : null;
  } catch (e) {}

  // 页面 DOM 是否有字幕
  out.domCaptionCount = document.querySelectorAll('.ytp-caption-segment').length;
  out.ccButton = !!document.querySelector('.ytp-subtitles-button');
  out.ccPressed = document.querySelector('.ytp-subtitles-button')?.getAttribute('aria-pressed');

  return out;
});

log('诊断结果:');
console.log(JSON.stringify(diag, null, 2));

// 尝试播放 + 开字幕，观察是否会请求字幕
log('');
log('播放视频并开启 CC…');
await page.evaluate(() => {
  const p = document.getElementById('movie_player');
  if (p && p.playVideo) p.playVideo();
});
await new Promise((r) => setTimeout(r, 3000));
const clicked = await page.evaluate(() => {
  const b = document.querySelector('.ytp-subtitles-button');
  if (!b) return 'no-button';
  if (b.getAttribute('aria-pressed') !== 'true') {
    b.click();
    return 'clicked';
  }
  return 'already-on';
});
log('CC 按钮:', clicked);

await new Promise((r) => setTimeout(r, 8000));

const after = await page.evaluate(() => ({
  domCaptionCount: document.querySelectorAll('.ytp-caption-segment').length,
  sample: Array.from(document.querySelectorAll('.ytp-caption-segment')).map((e) => e.textContent).slice(0, 3),
  ccPressed: document.querySelector('.ytp-subtitles-button')?.getAttribute('aria-pressed'),
  currentTime: (() => {
    try {
      return document.getElementById('movie_player')?.getCurrentTime?.();
    } catch (e) {
      return null;
    }
  })(),
}));
log('开启字幕后:', JSON.stringify(after, null, 2));

log('');
log('字幕相关网络请求:');
for (const h of netHits) log(`  ${h.status} ${h.len}B ${h.url}`);
if (!netHits.length) log('  (无)');

await page.screenshot({ path: '/tmp/ytdiag.png' });
await ctx.close();
