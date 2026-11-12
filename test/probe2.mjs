// 探测 2：在真实 B 站页面上下文调用播放器实际使用的字幕接口
// 同时验证 Blob + a.download 下载链路

import { chromium } from 'playwright-core';
import fs from 'node:fs';

const HOME = process.env.HOME;
const PROFILE = '/tmp/sub-probe2-profile';

function findChrome() {
  const c = [
    `${HOME}/Library/Caches/ms-playwright/chromium-1248/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
    `${HOME}/Library/Caches/ms-playwright/chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
  ];
  for (const x of c) if (fs.existsSync(x)) return x;
  return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
}

const log = (...a) => console.log('[probe2]', ...a);

const ctx = await chromium.launchPersistentContext(PROFILE, {
  executablePath: findChrome(),
  headless: false,
  acceptDownloads: true,
  viewport: { width: 1366, height: 900 },
  args: ['--no-first-run', '--no-default-browser-check', '--disable-search-engine-choice-screen', '--mute-audio'],
});

const page = ctx.pages()[0] || (await ctx.newPage());

// 选一个知识区视频（更可能有字幕）
const BV = process.argv[2] || 'BV1REx46NEc4'; // 【全网最全】DeepSeek Harness 超详细教程
log('打开视频页:', BV);
await page.goto(`https://www.bilibili.com/video/${BV}/`, { waitUntil: 'domcontentloaded', timeout: 60000 });
await new Promise((r) => setTimeout(r, 5000));

const result = await page.evaluate(async () => {
  const out = { steps: [] };
  const st = window.__INITIAL_STATE__;
  const aid = st?.aid || st?.videoData?.aid;
  const cid = st?.videoData?.cid || st?.cid;
  out.aid = aid;
  out.cid = cid;
  out.videoTitle = st?.videoData?.title;

  // 1) 播放器实际接口
  const q = `oid=${aid}&pid=${aid}&context_ext=${encodeURIComponent(JSON.stringify({ video_type: 1 }))}&type=1&cur_production_type=0&preferred_language=ai-zh&playlist_switch=0`;
  try {
    const r = await fetch(`https://api.bilibili.com/x/v2/subtitle/web/view?${q}`, { credentials: 'include' });
    const text = await r.text();
    out.playerSubtitleApi = { status: r.status, len: text.length, head: text.slice(0, 300) };
  } catch (e) {
    out.playerSubtitleApi = { error: String(e) };
  }

  // 2) player/v2 再确认
  try {
    const r = await fetch(`https://api.bilibili.com/x/player/v2?bvid=${st?.bvid || location.pathname.split('/').pop()}&cid=${cid}`, { credentials: 'include' });
    const j = await r.json();
    out.playerV2 = { code: j.code, aiStatus: j?.data?.subtitle?.ai_status, subs: (j?.data?.subtitle?.subtitles || []).map((s) => s.lan) };
  } catch (e) {
    out.playerV2 = { error: String(e) };
  }

  // 3) 检查播放器 DOM 上的 CC 按钮
  out.hasCcBtn = !!document.querySelector('.bpx-player-ctrl-subtitle, .bpx-player-ctrl-cc');
  return out;
});

log(JSON.stringify(result, null, 2));

// ---------- 验证下载链路 ----------
log('验证 Blob + a.download 下载链路…');
const downloadPromise = page.waitForEvent('download', { timeout: 15000 }).catch(() => null);
await page.evaluate(() => {
  const content = '这是一段测试文本\n第二行内容';
  const blob = new Blob(['\uFEFF' + content], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = '测试视频标题.txt';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1000);
});

const dl = await downloadPromise;
if (dl) {
  const name = dl.suggestedFilename();
  const savePath = '/tmp/dl-test-' + name;
  await dl.saveAs(savePath);
  const c = fs.readFileSync(savePath, 'utf8');
  log(`✅ 下载链路正常: ${name} (${Buffer.byteLength(c)} 字节)`);
  log(`   内容: ${JSON.stringify(c.slice(0, 40))}`);
} else {
  log('❌ 下载链路失败：未捕获到 download 事件');
}

await ctx.close();
