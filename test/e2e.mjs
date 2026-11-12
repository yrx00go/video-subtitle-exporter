// 端到端测试：真实 Chrome 加载扩展 -> 打开视频页 -> 点击导出 -> 校验 txt
// 用法：node test/e2e.mjs <youtube|bilibili> <url>

import { chromium } from 'playwright-core';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const EXT = path.join(ROOT, 'extension');
const OUT = path.join(ROOT, 'output');
const PROFILE = process.env.PROFILE_DIR || '/tmp/sub-exporter-profile';

// Chrome 137+ 移除了 --load-extension 开关，所以优先用 Chrome for Testing / Chromium
function findChrome() {
  const home = process.env.HOME;
  const candidates = [
    process.env.CHROME_BIN,
    `${home}/Library/Caches/ms-playwright/chromium-1248/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
    `${home}/Library/Caches/ms-playwright/chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
    '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean);
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  throw new Error('找不到可用的 Chrome 可执行文件');
}
const CHROME = findChrome();

const [, , platform = 'youtube', urlArg] = process.argv;

const DEFAULT_URLS = {
  youtube: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  bilibili: 'https://www.bilibili.com/video/BV1GJ411x7h7',
};
const url = urlArg || DEFAULT_URLS[platform];

fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(PROFILE, { recursive: true });

const log = (...a) => console.log('[e2e]', ...a);

async function main() {
  log(`平台=${platform}`);
  log(`URL=${url}`);
  log(`扩展=${EXT}`);

  const ctx = await chromium.launchPersistentContext(PROFILE, {
    executablePath: CHROME,
    headless: false,
    acceptDownloads: true,
    viewport: { width: 1366, height: 900 },
    args: [
      `--disable-extensions-except=${EXT}`,
      `--load-extension=${EXT}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-search-engine-choice-screen',
      '--disable-blink-features=AutomationControlled',
      '--mute-audio',
    ],
  });

  // 收集页面日志，便于诊断
  ctx.on('page', (p) => {
    p.on('console', (m) => {
      const t = m.text();
      if (/字幕|subtitle|SUB|失败|Error/i.test(t)) log('  [page console]', m.type(), t.slice(0, 200));
    });
    p.on('pageerror', (e) => log('  [page error]', String(e).slice(0, 200)));
  });

  const page = ctx.pages()[0] || (await ctx.newPage());

  // 捕获所有 console（含 service worker）
  ctx.on('console', (m) => log('  [ctx console]', m.type(), m.text().slice(0, 300)));
  ctx.on('serviceworker', (w) => {
    log('  [sw] 已启动:', w.url());
    w.on('console', (m) => log('  [sw console]', m.type(), m.text().slice(0, 400)));
  });

  // 扩展 service worker 可能懒启动，等一会儿
  await new Promise((r) => setTimeout(r, 2500));
  const workers = ctx.serviceWorkers();
  log(`service worker 数量: ${workers.length}`);
  for (const w of workers) {
    w.on('console', (m) => log('  [sw console]', m.type(), m.text().slice(0, 400)));
    try {
      const info = await w.evaluate(() => ({ href: self.location.href, chromeOk: typeof chrome !== 'undefined' }));
      log('  [sw] info:', JSON.stringify(info));
    } catch (e) { log('  [sw] evaluate 失败', String(e).slice(0, 120)); }
  }

  log('打开页面…');
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

  // 等播放器就绪
  await new Promise((r) => setTimeout(r, 5000));

  const title = await page.title();
  log(`页面标题: ${title}`);

  // 等扩展按钮被注入
  log('等待扩展按钮…');
  try {
    await page.waitForSelector('#subtitle-exporter-btn', { timeout: 30000, state: 'visible' });
    log('扩展按钮已注入 ✓');
  } catch (e) {
    log('❌ 扩展按钮未出现，扩展可能没加载');
    await page.screenshot({ path: path.join(OUT, `${platform}-no-button.png`) });
    await ctx.close();
    process.exit(1);
  }

  await page.screenshot({ path: path.join(OUT, `${platform}-before.png`) });

  // 点击导出并捕获下载
  log('点击导出…');
  const downloadPromise = page.waitForEvent('download', { timeout: 60000 }).catch(() => null);
  await page.click('#subtitle-exporter-btn');

  const download = await downloadPromise;
  if (!download) {
    const btnText = await page.textContent('#subtitle-exporter-btn').catch(() => '');
    const btnTitle = await page.getAttribute('#subtitle-exporter-btn', 'title').catch(() => '');
    log(`❌ 未触发下载`);
    log(`   按钮文本: ${btnText}`);
    log(`   按钮 title（失败原因）: ${btnTitle}`);
    await page.screenshot({ path: path.join(OUT, `${platform}-failed.png`) });
    await ctx.close();
    process.exit(2);
  }

  const suggested = download.suggestedFilename();
  const savePath = path.join(OUT, suggested);
  await download.saveAs(savePath);
  log(`✅ 下载成功: ${suggested}`);
  log(`   保存到: ${savePath}`);

  // 校验内容
  await new Promise((r) => setTimeout(r, 500));
  const content = fs.readFileSync(savePath, 'utf8');
  const bytes = Buffer.byteLength(content, 'utf8');
  log(`   大小: ${bytes} 字节`);
  log('   ---- 前 30 行 ----');
  console.log(
    content
      .split('\n')
      .slice(0, 30)
      .map((l) => '   | ' + l)
      .join('\n')
  );

  await page.screenshot({ path: path.join(OUT, `${platform}-done.png`) });
  await ctx.close();

  // 简单断言
  if (bytes < 200) {
    log('❌ 内容过短，可能不完整');
    process.exit(3);
  }
  log('✅ 测试通过');
}

main().catch(async (e) => {
  log('❌ 异常:', e && e.stack ? e.stack : String(e));
  process.exit(9);
});
