// 诊断脚本：观察 YouTube 播放器自身如何加载字幕
// 回答：播放器能不能拿到字幕？请求长什么样？响应多大？

import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'output');
const PROFILE = '/tmp/sub-diag-profile';
const HOME = process.env.HOME;

function findChrome() {
  const c = [
    `${HOME}/Library/Caches/ms-playwright/chromium-1248/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
    `${HOME}/Library/Caches/ms-playwright/chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ];
  for (const x of c) if (fs.existsSync(x)) return x;
  throw new Error('no chrome');
}

const url = process.argv[2] || 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
const log = (...a) => console.log('[diag]', ...a);

fs.mkdirSync(OUT, { recursive: true });

const ctx = await chromium.launchPersistentContext(PROFILE, {
  executablePath: findChrome(),
  headless: false,
  viewport: { width: 1366, height: 900 },
  args: ['--no-first-run', '--no-default-browser-check', '--disable-search-engine-choice-screen', '--mute-audio'],
});

const page = ctx.pages()[0] || (await ctx.newPage());

const hits = [];
page.on('response', async (res) => {
  const u = res.url();
  if (/timedtext|caption|get_transcript|player\?/i.test(u)) {
    let len = -1;
    try {
      len = (await res.body()).length;
    } catch (e) {
      len = -2;
    }
    const rec = { status: res.status(), len, url: u.slice(0, 220) };
    hits.push(rec);
    log(`  [net] ${rec.status} ${len}B ${u.slice(0, 160)}`);
  }
});
page.on('requestfailed', (r) => {
  if (/timedtext|caption/i.test(r.url())) log('  [net fail]', r.failure()?.errorText, r.url().slice(0, 150));
});

log('1) 先访问 YouTube 首页积累 Cookie…');
await page.goto('https://www.youtube.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
await new Promise((r) => setTimeout(r, 4000));
const cookies = await ctx.cookies('https://www.youtube.com');
log(`   Cookie 数量: ${cookies.length}`);
log('   ' + cookies.map((c) => c.name).join(', ').slice(0, 300));

log('2) 打开视频页…');
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
await new Promise((r) => setTimeout(r, 6000));

log('3) 读取播放器状态…');
const state = await page.evaluate(() => {
  const p = document.getElementById('movie_player');
  let resp = null;
  try {
    resp = p && p.getPlayerResponse ? p.getPlayerResponse() : null;
  } catch (e) {}
  if (!resp) resp = window.ytInitialPlayerResponse;
  const ct = resp?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
  return {
    hasPlayer: !!p,
    playability: resp?.playabilityStatus?.status,
    playabilityReason: resp?.playabilityStatus?.reason,
    title: resp?.videoDetails?.title,
    trackCount: ct.length,
    tracks: ct.map((t) => ({ lang: t.languageCode, asr: t.kind === 'asr', baseUrlHasPot: /[?&]pot=/.test(t.baseUrl) })),
    ccBtn: !!document.querySelector('.ytp-subtitles-button'),
    ccPressed: document.querySelector('.ytp-subtitles-button')?.getAttribute('aria-pressed'),
  };
});
log('   状态:', JSON.stringify(state, null, 2));

log('4) 播放视频（3 秒）…');
await page.evaluate(() => {
  const p = document.getElementById('movie_player');
  if (p && p.playVideo) p.playVideo();
});
await new Promise((r) => setTimeout(r, 3000));

log('5) 点击 CC 按钮…');
const clicked = await page.evaluate(() => {
  const btn = document.querySelector('.ytp-subtitles-button');
  if (!btn) return 'no-btn';
  if (btn.getAttribute('aria-pressed') !== 'true') {
    btn.click();
    return 'clicked';
  }
  return 'already-on';
});
log('   ', clicked);

await new Promise((r) => setTimeout(r, 6000));

log('6) 检查 DOM 是否出现字幕文本…');
const domSubs = await page.evaluate(() => {
  const segs = Array.from(document.querySelectorAll('.ytp-caption-segment')).map((e) => e.textContent);
  const btn = document.querySelector('.ytp-subtitles-button');
  return {
    ccPressed: btn?.getAttribute('aria-pressed'),
    segmentCount: segs.length,
    sample: segs.slice(0, 5),
    playerTime: (() => {
      try {
        const p = document.getElementById('movie_player');
        return p && p.getCurrentTime ? p.getCurrentTime() : -1;
      } catch (e) {
        return -2;
      }
    })(),
  };
});
log('   DOM:', JSON.stringify(domSubs, null, 2));

log('7) 主动在页面里 fetch baseUrl 测试…');
const fetchTest = await page.evaluate(async () => {
  const p = document.getElementById('movie_player');
  let resp = null;
  try {
    resp = p?.getPlayerResponse ? p.getPlayerResponse() : null;
  } catch (e) {}
  if (!resp) resp = window.ytInitialPlayerResponse;
  const tracks = resp?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
  if (!tracks.length) return { error: 'no tracks' };
  const t = tracks[0];
  const out = [];
  for (const suffix of ['&fmt=json3', '']) {
    try {
      const r = await fetch(t.baseUrl + suffix, { credentials: 'include' });
      const body = await r.text();
      out.push({ suffix, status: r.status, len: body.length, head: body.slice(0, 80) });
    } catch (e) {
      out.push({ suffix, error: String(e).slice(0, 100) });
    }
  }
  return { baseUrlHead: t.baseUrl.slice(0, 120), results: out };
});
log('   ', JSON.stringify(fetchTest, null, 2));

await page.screenshot({ path: path.join(OUT, 'diag.png') });

log('8) 网络命中汇总:');
for (const h of hits) log(`   ${h.status} ${h.len}B ${h.url.slice(0, 140)}`);

await ctx.close();
