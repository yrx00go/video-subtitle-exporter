// MAIN world 嗅探器（manifest 直接注入，document_start，早于页面所有脚本）
//
// 作用：
//   1. hook fetch / XHR，捕获平台的字幕请求
//   2. 从 youtubei/v1/player 响应里提取 captionTracks -> window.__SUB_TRACKS__
//   3. 把捕获到的正文存进 window.__SUB_SNIFFED__，供页内抓取函数直接读取
//
// 之所以放在 MAIN world：grabYouTube / grabBilibili 也是注入 MAIN world 执行的，
// 它们可以直接读到这里的全局变量，不依赖 background 中转，链路更短更可靠。

(function () {
  if (window.__SUB_SNIFFER_INSTALLED__) return;
  window.__SUB_SNIFFER_INSTALLED__ = true;

  const PATTERN =
    /timedtext|aisubtitle|\/subtitle\/|player\/v2|player\/wbi\/v2|youtubei\/v1\/player|get_transcript/i;

  const buf = [];
  window.__SUB_SNIFFED__ = buf;

  function handle(url, body) {
    try {
      // player 响应里本身就带字幕轨，这是最可靠的一路来源
      if (/youtubei\/v1\/player/i.test(url)) {
        try {
          const j = JSON.parse(body);
          const ct = j && j.captions && j.captions.playerCaptionsTracklistRenderer && j.captions.playerCaptionsTracklistRenderer.captionTracks;
          if (ct && ct.length) window.__SUB_TRACKS__ = ct;
        } catch (e) {
          /* 不是 JSON */
        }
      }
      buf.push({ url: String(url), body: String(body), ts: Date.now() });
      if (buf.length > 20) buf.shift();
      window.postMessage({ __subtitleSniff: true, url: String(url), body: String(body) }, '*');
    } catch (e) {
      /* ignore */
    }
  }

  // ---- hook fetch ----
  const origFetch = window.fetch;
  if (origFetch) {
    window.fetch = function (...args) {
      const p = origFetch.apply(this, args);
      try {
        const req = args[0];
        const url = typeof req === 'string' ? req : req && req.url;
        if (url && PATTERN.test(url)) {
          p.then((res) => {
            res
              .clone()
              .text()
              .then((body) => handle(url, body))
              .catch(() => {});
          }).catch(() => {});
        }
      } catch (e) {
        /* ignore */
      }
      return p;
    };
  }

  // ---- hook XHR ----
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__subUrl = url;
    return origOpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function (...args) {
    try {
      if (this.__subUrl && PATTERN.test(String(this.__subUrl))) {
        this.addEventListener('load', () => {
          try {
            handle(this.__subUrl, this.responseText);
          } catch (e) {
            /* ignore */
          }
        });
      }
    } catch (e) {
      /* ignore */
    }
    return origSend.apply(this, args);
  };
})();
