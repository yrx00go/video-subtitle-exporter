// 验证 NEED_SERVER_FETCH 兜底：页面侧下载字幕失败后，由扩展权限重新下载
// 模拟用户遇到的 SUBTITLE_FETCH_ERROR 场景

import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const EXT = path.join(ROOT, 'extension');
const OUT = path.join(ROOT, 'output');
const PROFILE = '/tmp/sub-fallback-profile';
const HOME = process.env.HOME;

function findChrome() {
  const c = [
    `${HOME}/Library/Caches/ms-playwright/chromium-1248/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
    `${HOME}/Library/Caches/ms-playwright/chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
  ];
  for (const x of c) if (fs.existsSync(x)) return x;
  return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
}

const log = (...a) => console.log('[fallback]', ...a);
fs.mkdirSync(OUT, { recursive: true });
fs.rmSync(PROFILE, { recursive: true, force: true });

const SUB = {
  body: [
    { from: 0.5, to: 3.0, content: '页面侧下载失败后由扩展兜底拿到的第一句。' },
    { from: 3.0, to: 6.0, content: '第二句，验证 NEED_SERVER_FETCH 链路。' },
  ],
};

const ctx = await chromium.launchPersistentContext(PROFILE, {
  executablePath: findChrome(),
  headless: false,
  acceptDownloads: true,
  viewport: { width: 1280, height: 860 },
  args: [
    `--disable-extensions-except=${EXT}`,
    `--load-extension=${EXT}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-search-engine-choice-screen',
    '--mute-audio',
  ],
});

let subAttempts = 0;
// 第一次（页面侧 fetch）直接失败；第二次（扩展 service worker）返回数据
await ctx.route('**/mock/sub.json*', async (route) => {
  subAttempts++;
  if (subAttempts === 1) {
    log('  第 1 次字幕请求（页面侧）-> 模拟失败');
    return route.abort('failed');
  }
  log('  第 2 次字幕请求（扩展侧）-> 返回数据');
  return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SUB) });
});

await ctx.route('**/x/player/v2*', async (route) => {
  const u = route.request().url();
  if (u.includes('/x/player/v2?')) {
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        code: 0,
        data: { subtitle: { ai_status: 1, subtitles: [{ lan: 'ai-zh', subtitle_url: 'https://aisubtitle.hdslb.com/mock/sub.json' }] } },
      }),
    });
  }
  return route.continue();
});

await new Promise((r) => setTimeout(r, 2500));
const sw = ctx.serviceWorkers()[0];
const extId = sw ? new URL(sw.url()).host : null;
log('扩展 ID:', extId);

const video = await ctx.newPage();
video.on('console', (m) => {
  if (/字幕|失败|fallback/i.test(m.text())) log('  [console]', m.text().slice(0, 200));
});

log('打开 B 站视频页…');
await video.goto('https://www.bilibili.com/video/BV1REx46NEc4/', { waitUntil: 'domcontentloaded', timeout: 60000 });
await new Promise((r) => setTimeout(r, 5000));

const popup = await ctx.newPage();
await popup.goto(`chrome-extension://${extId}/popup.html`, { waitUntil: 'domcontentloaded' });

const dlPromise = video.waitForEvent('download', { timeout: 40000 }).catch(() => null);

const result = await popup.evaluate(async () => {
  const tabs = await chrome.tabs.query({});
  const target = tabs.find((t) => t.url && /bilibili\.com\/video\//.test(t.url));
  if (!target) return { error: '未找到视频页' };
  try {
    return await chrome.tabs.sendMessage(target.id, { type: 'EXPORT', options: { withHeader: true } });
  } catch (e) {
    return { error: String(e).slice(0, 200) };
  }
});

log('返回:', JSON.stringify(result));
const dl = await dlPromise;

let content = '';
if (dl) {
  const p = path.join(OUT, 'FALLBACK-' + dl.suggestedFilename());
  await dl.saveAs(p);
  content = fs.readFileSync(p, 'utf8');
  log('✅ 已下载:', dl.suggestedFilename());
  console.log(content.split('\n').map((l) => '  | ' + l).join('\n'));
}

await ctx.close();

const ok = result && result.ok && /扩展兜底/.test(content);
log(ok ? '✅ NEED_SERVER_FETCH 兜底链路验证通过' : '❌ 兜底链路验证失败');
process.exit(ok ? 0 : 2);
