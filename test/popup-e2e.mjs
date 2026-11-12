// 验证 popup -> content script -> background -> 下载 的完整链路
// 这正是用户从扩展弹窗点「导出为 txt」的路径

import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const EXT = path.join(ROOT, 'extension');
const OUT = path.join(ROOT, 'output');
const PROFILE = '/tmp/sub-popup-profile';
const HOME = process.env.HOME;

function findChrome() {
  const c = [
    `${HOME}/Library/Caches/ms-playwright/chromium-1248/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
    `${HOME}/Library/Caches/ms-playwright/chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
  ];
  for (const x of c) if (fs.existsSync(x)) return x;
  return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
}

const log = (...a) => console.log('[popup]', ...a);
fs.mkdirSync(OUT, { recursive: true });
fs.rmSync(PROFILE, { recursive: true, force: true });

const BILI_SUB = {
  body: [
    { from: 0.5, to: 3.0, content: '这是通过扩展弹窗导出的第一句。' },
    { from: 3.0, to: 6.0, content: '第二句，用来验证链路。' },
    { from: 15.0, to: 18.0, content: '中间隔了很久，应该分段。' },
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

await ctx.route('**/x/player/v2*', async (route) => {
  const u = route.request().url();
  if (u.includes('/x/player/v2?')) {
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        code: 0,
        data: { subtitle: { ai_status: 1, subtitles: [{ lan: 'ai-zh', subtitle_url: 'https://api.bilibili.com/mock/sub.json' }] } },
      }),
    });
  }
  return route.continue();
});
await ctx.route('**/mock/sub.json*', (route) =>
  route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(BILI_SUB) })
);

await new Promise((r) => setTimeout(r, 2500));
const sw = ctx.serviceWorkers()[0];
if (!sw) {
  log('❌ 扩展 service worker 未启动');
  await ctx.close();
  process.exit(1);
}
const extId = new URL(sw.url()).host;
log('扩展 ID:', extId);

// 1) 打开视频页
const video = await ctx.newPage();
video.on('console', (m) => {
  if (/字幕|popup|失败/i.test(m.text())) log('  [video console]', m.text().slice(0, 200));
});
log('打开 B 站视频页…');
await video.goto('https://www.bilibili.com/video/BV1REx46NEc4/', { waitUntil: 'domcontentloaded', timeout: 60000 });
await new Promise((r) => setTimeout(r, 5000));

// 2) 打开 popup 页，取得扩展 API 上下文
log('打开 popup 页面…');
const popup = await ctx.newPage();
await popup.goto(`chrome-extension://${extId}/popup.html`, { waitUntil: 'domcontentloaded' });

const dlPromise = video.waitForEvent('download', { timeout: 40000 }).catch(() => null);

// 3) 从 popup 上下文向视频页发 EXPORT（完全模拟用户点击弹窗按钮）
log('从 popup 向视频页发送 EXPORT…');
const result = await popup.evaluate(async () => {
  const tabs = await chrome.tabs.query({});
  const target = tabs.find((t) => t.url && /bilibili\.com\/video\//.test(t.url));
  if (!target) return { error: '未找到视频标签页', urls: tabs.map((t) => t.url).slice(0, 5) };

  // 先 PING 确认 content script 就绪
  let ping = null;
  try {
    ping = await chrome.tabs.sendMessage(target.id, { type: 'PING' });
  } catch (e) {
    ping = { pingError: String(e).slice(0, 100) };
  }

  try {
    const r = await chrome.tabs.sendMessage(target.id, { type: 'EXPORT', options: { withHeader: true } });
    return { ping, export: r };
  } catch (e) {
    return { ping, error: String(e).slice(0, 200) };
  }
});

log('popup 侧返回:', JSON.stringify(result, null, 2));

const dl = await dlPromise;
let downloadOk = false;
if (dl) {
  const name = dl.suggestedFilename();
  const savePath = path.join(OUT, 'POPUP-' + name);
  await dl.saveAs(savePath);
  const content = fs.readFileSync(savePath, 'utf8');
  downloadOk = true;
  log(`✅ 文件已下载: ${name}`);
  log('-------- 内容 --------');
  console.log(content.split('\n').map((l) => '  | ' + l).join('\n'));
} else {
  log('❌ 未捕获到下载');
}

await ctx.close();

const ok = !!(result && result.export && result.export.ok) && downloadOk;
log(ok ? '✅ popup 链路验证通过' : '❌ popup 链路验证失败');
process.exit(ok ? 0 : 2);
