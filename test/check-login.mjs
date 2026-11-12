// 检查测试 profile 的登录态是否生效（Chrome 能否解密复制的 Cookie）

import { chromium } from 'playwright-core';
import fs from 'node:fs';

const HOME = process.env.HOME;
const PROFILE = '/tmp/sub-exporter-profile';

function findChrome() {
  const c = [
    `${HOME}/Library/Caches/ms-playwright/chromium-1248/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
    `${HOME}/Library/Caches/ms-playwright/chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
  ];
  for (const x of c) if (fs.existsSync(x)) return x;
  return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
}

const ctx = await chromium.launchPersistentContext(PROFILE, {
  executablePath: findChrome(),
  headless: false,
  viewport: { width: 1366, height: 900 },
  args: ['--no-first-run', '--no-default-browser-check', '--disable-search-engine-choice-screen', '--mute-audio'],
});

const log = (...a) => console.log('[login]', ...a);

// YouTube
const yt = await ctx.newPage();
await yt.goto('https://www.youtube.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
await new Promise((r) => setTimeout(r, 4000));
const ytState = await yt.evaluate(() => {
  const cfg = window.ytcfg;
  return {
    loggedIn: cfg ? cfg.get('LOGGED_IN') : 'no-ytcfg',
    sessionIndex: cfg ? cfg.get('SESSION_INDEX') : null,
    hasSignInLink:
      !!document.querySelector('a[href*="accounts.google.com/ServiceLogin"]') ||
      /Sign in|登录/.test(document.body.innerText.slice(0, 2000)),
  };
});
log('YouTube:', JSON.stringify(ytState));

// B 站
const bili = await ctx.newPage();
await bili.goto('https://www.bilibili.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
await new Promise((r) => setTimeout(r, 3000));
const biliState = await bili.evaluate(async () => {
  try {
    const r = await fetch('https://api.bilibili.com/x/web-interface/nav', { credentials: 'include' });
    const j = await r.json();
    return { code: j.code, isLogin: j.data?.isLogin, uname: j.data?.uname, mid: j.data?.mid };
  } catch (e) {
    return { error: String(e) };
  }
});
log('Bilibili:', JSON.stringify(biliState));

await ctx.close();
