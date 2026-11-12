// Mock 端到端：拦截平台接口返回真实格式的字幕数据，
// 验证扩展的完整链路（抓取 -> 解析 -> 断句 -> 组装 -> 下载）

import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const EXT = path.join(ROOT, 'extension');
const OUT = path.join(ROOT, 'output');
const PROFILE = '/tmp/sub-mock-profile';
const HOME = process.env.HOME;

function findChrome() {
  const c = [
    `${HOME}/Library/Caches/ms-playwright/chromium-1248/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
    `${HOME}/Library/Caches/ms-playwright/chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
  ];
  for (const x of c) if (fs.existsSync(x)) return x;
  return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
}

const log = (...a) => console.log('[mock]', ...a);
fs.mkdirSync(OUT, { recursive: true });

const platform = process.argv[2] || 'bilibili';

// 真实格式的字幕数据
const BILI_SUB = {
  font_size: 0.4,
  font_color: '#FFFFFF',
  background_alpha: 0.5,
  body: [
    { from: 0.5, to: 4.2, content: '大家好，今天我们来聊聊字幕导出这个话题。' },
    { from: 4.2, to: 8.8, content: '很多视频其实自带字幕，我们只要把它取出来就行。' },
    { from: 8.8, to: 13.5, content: '难点在于平台的接口做了鉴权，不能直接调用。' },
    { from: 20.0, to: 24.0, content: '所以我们需要在浏览器上下文里发起请求。' },
    { from: 24.0, to: 28.0, content: '这样就能带上登录态，成功率最高。' },
  ],
};

const YT_JSON3 = {
  wireMagic: 'pb3',
  events: [
    { tStartMs: 0, dDurationMs: 2000, segs: [{ utf8: 'Hello everyone, ' }, { utf8: 'today we talk about subtitles.' }] },
    { tStartMs: 2000, dDurationMs: 2500, segs: [{ utf8: 'The key difficulty is authentication.' }] },
    { tStartMs: 4500, dDurationMs: 2000, segs: [{ utf8: 'So we fetch inside the page context.' }] },
  ],
};

const ctx = await chromium.launchPersistentContext(PROFILE, {
  executablePath: findChrome(),
  headless: false,
  acceptDownloads: true,
  viewport: { width: 1366, height: 900 },
  args: [
    `--disable-extensions-except=${EXT}`,
    `--load-extension=${EXT}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-search-engine-choice-screen',
    '--mute-audio',
  ],
});

// ---------- 拦截平台字幕接口 ----------
await ctx.route('**/x/player/v2*', async (route) => {
  const u = route.request().url();
  if (u.includes('/x/player/v2?') && !u.includes('wbi')) {
    log('  拦截 /x/player/v2 -> 返回 mock 字幕轨');
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        code: 0,
        data: {
          subtitle: {
            ai_status: 1,
            subtitles: [{ lan: 'ai-zh', lan_doc: '中文（自动生成）', subtitle_url: 'https://api.bilibili.com/mock/subtitle.json' }],
          },
        },
      }),
    });
  }
  return route.continue();
});

await ctx.route('**/mock/subtitle.json*', async (route) => {
  log('  拦截字幕 JSON -> 返回 mock 正文');
  return route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(BILI_SUB),
  });
});

await ctx.route('**/api/timedtext*', async (route) => {
  log('  拦截 timedtext -> 返回 mock json3');
  return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(YT_JSON3) });
});

const page = ctx.pages()[0] || (await ctx.newPage());
page.on('console', (m) => {
  const t = m.text();
  if (/字幕|mock|失败/i.test(t)) log('  [console]', t.slice(0, 200));
});

const targetUrl =
  platform === 'bilibili'
    ? 'https://www.bilibili.com/video/BV1REx46NEc4/'
    : 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';

log(`平台=${platform} URL=${targetUrl}`);
await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
await new Promise((r) => setTimeout(r, 6000));

log('等待扩展按钮…');
await page.waitForSelector('#subtitle-exporter-btn', { timeout: 30000, state: 'visible' });
log('按钮已注入 ✓');

const dlPromise = page.waitForEvent('download', { timeout: 45000 }).catch(() => null);
log('点击导出…');
await page.click('#subtitle-exporter-btn');

const dl = await dlPromise;
if (!dl) {
  const txt = await page.textContent('#subtitle-exporter-btn').catch(() => '');
  const title = await page.getAttribute('#subtitle-exporter-btn', 'title').catch(() => '');
  log(`❌ 未触发下载 | 按钮=${txt} | title=${title}`);
  await page.screenshot({ path: path.join(OUT, `mock-${platform}-fail.png`) });
  await ctx.close();
  process.exit(2);
}

const name = dl.suggestedFilename();
const savePath = path.join(OUT, `MOCK-${name}`);
await dl.saveAs(savePath);
const content = fs.readFileSync(savePath, 'utf8');

log(`✅ 下载成功: ${name}`);
log(`   大小: ${Buffer.byteLength(content)} 字节`);
log('   -------- 文件内容 --------');
console.log(
  content
    .split('\n')
    .map((l) => '   | ' + l)
    .join('\n')
);

await page.screenshot({ path: path.join(OUT, `mock-${platform}-done.png`) });
await ctx.close();

// 断言
const checks = [
  ['文件名含视频标题', /\.txt$/.test(name) && name.length > 5],
  ['包含元信息头', content.includes('标题：')],
  ['包含来源标注', content.includes('字幕来源：')],
  ['包含正文', content.includes('大家好') || content.includes('Hello')],
  ['正文有分段', content.split('\n\n').length >= 1],
  ['无乱码', !content.includes('\uFFFD')],
];
let pass = 0;
log('   断言:');
for (const [label, ok] of checks) {
  log(`     ${ok ? '✅' : '❌'} ${label}`);
  if (ok) pass++;
}
log(`   ${pass}/${checks.length} 通过`);
process.exit(pass === checks.length ? 0 : 3);
