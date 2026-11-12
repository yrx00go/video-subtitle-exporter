// 通用 content script：注入浮层按钮 + 消息中转 + 嗅探转发
//
// 职责：
//   1. 在视频页注入「导出字幕」浮层按钮
//   2. 接收 popup 发来的 EXPORT 消息，转发给 background 并把结果回传（关键链路）
//   3. 把页面里嗅探到的字幕响应转发给 background

(function () {
  // 防止被 executeScript 重复注入（popup 兜底会自动注入一次）。
  // 注意：扩展在 chrome://extensions 重新加载后，旧实例的 chrome.runtime 会失效，
  // 此时必须允许新实例接管，否则用户会卡在旧版本上、必须手动刷新页面。
  let alive = false;
  try {
    alive = !!(window.__SUB_CONTENT_LOADED__ && chrome.runtime && chrome.runtime.id);
  } catch (e) {
    alive = false; // 旧实例的扩展上下文已断开
  }
  if (alive) return;

  // 清理旧实例可能残留的按钮，避免重复
  const staleBtn = document.getElementById('subtitle-exporter-btn');
  if (staleBtn) staleBtn.remove();
  window.__SUB_CONTENT_LOADED__ = true;

  const BTN_ID = 'subtitle-exporter-btn';

  function isVideoPage() {
    const h = location.hostname;
    if (/youtube\.com$/.test(h)) return location.pathname === '/watch';
    if (/bilibili\.com$/.test(h)) return /^\/video\//.test(location.pathname);
    return false;
  }

  // ---------- 消息监听 ----------
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg) return;

    if (msg.type === 'PING') {
      sendResponse({ ok: true, ready: true, video: isVideoPage() });
      return;
    }

    // popup 触发的导出：转发给 background，再把结果回传给 popup
    if (msg.type === 'EXPORT') {
      chrome.runtime
        .sendMessage({ type: 'EXPORT', options: msg.options || {} })
        .then((r) => sendResponse(r))
        .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
      return true; // 保持消息通道打开（异步响应）
    }
  });

  // 页面一加载就装好嗅探器：
  // 用户只要打开过字幕（或自动字幕加载），播放器发出的字幕请求就会被提前接住，
  // 点导出时直接复用，不必等播放器重新请求。
  try {
    chrome.runtime.sendMessage({ type: 'ENSURE_SNIFFER' });
  } catch (e) {
    /* 扩展上下文未就绪 */
  }

  // ---------- 嗅探结果转发给 background ----------
  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    const d = e.data;
    if (d && d.__subtitleSniff) {
      try {
        chrome.runtime.sendMessage({ type: 'SNIFFED', url: d.url, body: d.body });
      } catch (err) {
        /* 扩展上下文可能已失效 */
      }
    }
  });

  // ---------- 浮层按钮 ----------
  function removeButton() {
    const old = document.getElementById(BTN_ID);
    if (old) old.remove();
  }

  function mount() {
    // 非视频页（含 SPA 导航到首页/搜索页）不显示按钮
    if (!isVideoPage()) {
      removeButton();
      return;
    }
    if (document.getElementById(BTN_ID)) return;
    if (!document.body) return;

    const btn = document.createElement('button');
    btn.id = BTN_ID;
    btn.textContent = '导出字幕';
    btn.style.cssText = [
      'position:fixed',
      'right:24px',
      'bottom:120px',
      'z-index:2147483647',
      'padding:10px 16px',
      'border:none',
      'border-radius:8px',
      'background:#1a73e8',
      'color:#fff',
      'font-size:14px',
      'font-family:-apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif',
      'cursor:pointer',
      'box-shadow:0 2px 12px rgba(0,0,0,.25)',
      'opacity:.92',
    ].join(';');

    let busy = false;
    btn.addEventListener('click', async () => {
      if (busy) return;
      busy = true;
      const old = btn.textContent;
      btn.textContent = '导出中…';
      btn.style.background = '#5f6368';
      try {
        const r = await chrome.runtime.sendMessage({ type: 'EXPORT' });
        if (r && r.ok) {
          btn.textContent = `已导出 ${r.chars} 字`;
          btn.style.background = '#188038';
        } else {
          btn.textContent = '失败：' + shortReason(r) + diagSuffix(r);
          btn.style.background = '#d93025';
          btn.title = (r && (r.detail || r.error || r.reason)) || '';
          console.warn('[字幕导出] 失败', r);
          // 把诊断信息复制到剪贴板，方便排查
          if (r && r.diag) {
            try {
              const diagText = JSON.stringify({ reason: r.reason, detail: r.detail, diag: r.diag }, null, 2);
              await navigator.clipboard.writeText(diagText);
              btn.title = '诊断信息已复制到剪贴板，可直接粘贴反馈';
            } catch (e) {
              /* 剪贴板不可用时忽略 */
            }
          }
        }
      } catch (e) {
        btn.textContent = '失败：扩展上下文失效';
        btn.style.background = '#d93025';
      }
      setTimeout(() => {
        btn.textContent = old;
        btn.style.background = '#1a73e8';
        btn.title = '';
        busy = false;
      }, 3500);
    });

    document.body.appendChild(btn);
  }

  // 把关键诊断数字直接写在按钮上，截图即可定位
  function diagSuffix(r) {
    if (!r) return '';
    const d = r.diag || {};
    const parts = [];
    if (typeof d.trackCount === 'number') parts.push('轨' + d.trackCount);
    if (typeof r.sniffCount === 'number') parts.push('嗅' + r.sniffCount);
    if (typeof d.domCaptionCount === 'number') parts.push('幕' + d.domCaptionCount);
    if (typeof d.tracklistCount === 'number') parts.push('表' + d.tracklistCount);
    if (d.hasSniffedTracks) parts.push('P✓');
    return parts.length ? ' [' + parts.join('/') + ']' : '';
  }

  function shortReason(r) {
    if (!r) return '无响应';
    const t = r.reason || '';
    if (t === 'NO_CAPTION_TRACKS' || t === 'NO_SUBTITLE') return '该视频无字幕';
    if (t === 'EMPTY_BODY') return '被平台拦截';
    if (t === 'NO_PLAYER_RESPONSE') return '读取播放器失败';
    if (t === 'PARSE_EMPTY') return '解析为空';
    return (r.detail || t || '未知').slice(0, 12);
  }

  // YouTube / B 站都是 SPA，按钮会被路由切换清掉，需要守护
  mount();
  setInterval(mount, 1500);
})();
