// 生成 Chrome Web Store 截图（1280x800）

import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const EXT = path.join(ROOT, 'extension');
const OUT = path.join(ROOT, 'store-assets');
const PROFILE = '/tmp/sub-shot-profile';
const HOME = process.env.HOME;

function findChrome() {
  const c = [
    `${HOME}/Library/Caches/ms-playwright/chromium-1248/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
    `${HOME}/Library/Caches/ms-playwright/chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
  ];
  for (const x of c) if (fs.existsSync(x)) return x;
  return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
}

const log = (...a) => console.log('[shot]', ...a);
fs.mkdirSync(OUT, { recursive: true });
fs.rmSync(PROFILE, { recursive: true, force: true });

const ctx = await chromium.launchPersistentContext(PROFILE, {
  executablePath: findChrome(),
  headless: false,
  acceptDownloads: true,
  viewport: { width: 1280, height: 800 },
  args: [
    `--disable-extensions-except=${EXT}`,
    `--load-extension=${EXT}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-search-engine-choice-screen',
    '--mute-audio',
  ],
});

await new Promise((r) => setTimeout(r, 2500));
const page = ctx.pages()[0] || (await ctx.newPage());

log('打开 B 站视频页…');
await page.goto('https://www.bilibili.com/video/BV1REx46NEc4/', { waitUntil: 'domcontentloaded', timeout: 60000 });
await new Promise((r) => setTimeout(r, 6000));

await page.waitForSelector('#subtitle-exporter-btn', { timeout: 30000, state: 'visible' });
log('按钮已注入，截图…');

await page.screenshot({ path: path.join(OUT, 'screenshot-1.png') });
log('✅ screenshot-1.png');

// 滚到播放器上方，让画面更聚焦
await page.evaluate(() => window.scrollTo(0, 0));
await new Promise((r) => setTimeout(r, 800));
await page.screenshot({ path: path.join(OUT, 'screenshot-2.png') });
log('✅ screenshot-2.png');

await ctx.close();
log('完成');
