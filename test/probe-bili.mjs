// 探测 B 站视频的字幕可用性（匿名 / 登录态）
// 用真实浏览器页面上下文调用，带完整的匿名 Cookie 与 Referer

import { chromium } from 'playwright-core';
import fs from 'node:fs';

const HOME = process.env.HOME;
const PROFILE = '/tmp/sub-probe-profile';

function findChrome() {
  const c = [
    `${HOME}/Library/Caches/ms-playwright/chromium-1248/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
    `${HOME}/Library/Caches/ms-playwright/chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
  ];
  for (const x of c) if (fs.existsSync(x)) return x;
  return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
}

const log = (...a) => console.log('[probe]', ...a);

const ctx = await chromium.launchPersistentContext(PROFILE, {
  executablePath: findChrome(),
  headless: false,
  viewport: { width: 1366, height: 900 },
  args: ['--no-first-run', '--no-default-browser-check', '--disable-search-engine-choice-screen', '--mute-audio'],
});

const page = ctx.pages()[0] || (await ctx.newPage());

log('1) 打开 B 站首页，建立匿名会话…');
await page.goto('https://www.bilibili.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
await new Promise((r) => setTimeout(r, 4000));

// 先确认匿名接口是否可用
const navCheck = await page.evaluate(async () => {
  const r = await fetch('https://api.bilibili.com/x/web-interface/nav', { credentials: 'include' });
  const j = await r.json();
  return { code: j.code, isLogin: j.data?.isLogin };
});
log('   nav:', JSON.stringify(navCheck));

log('2) 从首页 DOM 抓候选视频…');
const candidates = [];
await page.goto('https://www.bilibili.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
await new Promise((r) => setTimeout(r, 3000));
// 滚动加载更多
for (let i = 0; i < 6; i++) {
  await page.evaluate(() => window.scrollBy(0, 900));
  await new Promise((r) => setTimeout(r, 800));
}
const links = await page.evaluate(() =>
  Array.from(document.querySelectorAll('a[href*="/video/BV"]'))
    .map((a) => {
      const m = a.getAttribute('href').match(/\/video\/(BV[0-9A-Za-z]+)/);
      return m ? { bvid: m[1], title: (a.getAttribute('title') || a.textContent || '').trim().slice(0, 60) } : null;
    })
    .filter(Boolean)
);
const seenLinks = new Set();
for (const l of links) {
  if (seenLinks.has(l.bvid)) continue;
  seenLinks.add(l.bvid);
  candidates.push(l);
}
log(`   抓到候选视频: ${candidates.length} 个`);

log('3) 逐个检查字幕轨…');
const results = [];
const seen = new Set();
for (const c of candidates) {
  if (seen.has(c.bvid)) continue;
  seen.add(c.bvid);
  if (results.length >= 12) break;

  const r = await page.evaluate(async (bvid) => {
    try {
      const v = await (await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`, { credentials: 'include' })).json();
      if (v.code !== 0) return { bvid, err: 'view ' + v.code, msg: v.message };
      const { cid, title, duration } = v.data;
      const out = { bvid, title, cid, duration, eps: {} };
      for (const ep of ['/x/player/v2', '/x/player/wbi/v2']) {
        try {
          const p = await (await fetch(`https://api.bilibili.com${ep}?bvid=${bvid}&cid=${cid}`, { credentials: 'include' })).json();
          out.eps[ep] = {
            code: p.code,
            aiStatus: p?.data?.subtitle?.ai_status,
            subs: (p?.data?.subtitle?.subtitles || []).map((s) => s.lan),
          };
        } catch (e) {
          out.eps[ep] = { err: String(e).slice(0, 60) };
        }
      }
      return out;
    } catch (e) {
      return { bvid, err: String(e).slice(0, 80) };
    }
  }, c.bvid);

  results.push(r);
  const hasSub = Object.values(r.eps || {}).some((e) => (e.subs || []).length > 0);
  log(`   ${r.bvid} ${hasSub ? '✅ 有字幕' : '— 无'} ${JSON.stringify(r.eps)} | ${String(r.title || r.msg || '').slice(0, 30)}`);
}

// 汇总
const withSubs = results.filter((r) => Object.values(r.eps || {}).some((e) => (e.subs || []).length > 0));
log('');
log(`=== 汇总: ${results.length} 个视频中 ${withSubs.length} 个有字幕轨 ===`);
for (const r of withSubs) {
  log(`  ${r.bvid} | ${r.title?.slice(0, 40)} | ${JSON.stringify(r.eps)}`);
}

fs.writeFileSync('/tmp/bili-probe.json', JSON.stringify(results, null, 2));
log('详细结果已写 /tmp/bili-probe.json');

await ctx.close();
