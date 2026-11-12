// popup：检测当前标签页并触发导出

const statusEl = document.getElementById('status');
const goBtn = document.getElementById('go');
const headerEl = document.getElementById('header');

let currentTab = null;

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTab = tab;
  const url = (tab && tab.url) || '';

  if (/youtube\.com\/watch/.test(url)) {
    statusEl.textContent = '已识别：YouTube 视频页';
    goBtn.disabled = false;
  } else if (/bilibili\.com\/video\//.test(url)) {
    statusEl.textContent = '已识别：B 站视频页';
    goBtn.disabled = false;
  } else {
    statusEl.textContent = '请打开 YouTube 或 B 站视频播放页';
  }
  statusEl.className = '';
}

/**
 * 向 content script 发消息；若未注入（扩展安装前打开的页面、或 SPA 导航后），
 * 主动注入一次再重试，让用户不需要手动刷新。
 */
async function sendToContent(tabId, msg) {
  try {
    return await chrome.tabs.sendMessage(tabId, msg);
  } catch (e) {
    // content script 不存在 → 主动注入
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content/main.js'],
    });
    // 等 listener 注册完成
    await new Promise((r) => setTimeout(r, 250));
    return await chrome.tabs.sendMessage(tabId, msg);
  }
}

goBtn.addEventListener('click', async () => {
  if (!currentTab) return;
  goBtn.disabled = true;
  statusEl.className = '';
  statusEl.textContent = '导出中…';

  try {
    const r = await sendToContent(currentTab.id, {
      type: 'EXPORT',
      options: { withHeader: headerEl.checked },
    });

    if (r && r.ok) {
      statusEl.className = 'ok';
      statusEl.textContent = `已导出：${r.filename}\n${r.chars} 字 / ${r.paragraphs} 段 / ${r.sentences} 句\n来源：${r.source}`;
    } else {
      statusEl.className = 'err';
      statusEl.textContent = '导出失败：' + ((r && (r.detail || r.error || r.reason)) || '未知原因');
    }
  } catch (e) {
    statusEl.className = 'err';
    statusEl.textContent =
      '无法与页面通信。请确认：\n1. 当前是视频播放页\n2. 已在 chrome://extensions 重新加载扩展\n3. 刷新页面后重试';
  }
  goBtn.disabled = false;
});

init();
