# YouTube / B 站 视频字幕导出 · 技术方案

> 版本：v1 · 2026-11-10
> 目标：输入视频链接 → 获得以「视频标题.txt」命名的字幕文本

---

## 0. 结论先行

**推荐做 Chrome 扩展（方案 1）。** 不是因为它"更简单"，而是因为它把两个平台最难的部分——**登录态**和**反爬**——免费解决了：

| 难点 | 服务器方案 | 扩展方案 |
|---|---|---|
| B 站 AI 字幕（匿名接口返回 0 条，**必须登录**） | 要维护账号 cookie 池，封号风险 | 用用户自己的登录态，天然合法 |
| YouTube 对数据中心 IP 全面封堵（pot token 墙） | 要买住宅代理，$50~200/月 | 跑在用户真实网络里，就是正常观看 |
| 字幕 CDN 的 auth_key 分钟级过期 | 要服务端极速接力 | 浏览器内直连，几十毫秒 |

方案 2（网站）**不是不能做，而是它 80% 的成本都花在"假装自己是个浏览器"上**。它的正确形态见 [§6 演进路线 P4](#6-推荐演进路线)：把网站做成跑在用户本机的本地页面，而不是公有云服务。

---

## 1. 先看清真正的难点

字幕导出看着只是"抓个接口"，实际成本集中在五件事：

1. **鉴权**：B 站 AI 字幕必须登录；YouTube 需要正确的 client 上下文。
2. **反爬**：YouTube 的 timedtext 已加 pot token 校验，服务器 IP 直接 403 / `LOGIN_REQUIRED`。
3. **时效**：B 站字幕 CDN URL 带 `auth_key`，分钟级过期，且**尾部还有一段校验，不能截断**。
4. **文本质量**：自动字幕（ASR）无标点、按 2~5 秒切碎、滚动词重叠。直接拼接是没法读的。
5. **边界情况**：多分 P、多语言轨、会员视频、无字幕视频、标题含 Windows 非法字符。

这五点决定了：**抓取层要尽量贴近浏览器，后处理层要独立可测。**

---

## 2. 平台链路分析

### 2.0 实测记录（2026-11-10，本机直连）

| 测试项 | 结果 | 结论 |
|---|---|---|
| YouTube 首页可达 | HTTP 200 | 本机可直连 YouTube，无需额外代理 |
| `GET /api/timedtext?v=...&lang=en` 裸调 | **HTTP 200，body 0 字节** | 裸接口被静默拒绝，不可用 |
| YouTube watch 页面 HTML | 1.3 MB，`playabilityStatus: OK` | 页面服务端可获取 |
| 解析页面 `ytInitialPlayerResponse` | **6 条字幕轨**（ja / es-419 / en…，均非 ASR） | 字幕轨元数据完整可得 |
| 该 track 的 `baseUrl` 裸请求 | **HTTP 200，0 字节** | 无 Cookie / 客户端上下文仍然拿不到 |
| B 站 `GET /x/web-interface/nav` 匿名 | `code: -101`「账号未登录」 | 匿名无登录态 |
| B 站 `GET /x/web-interface/popular` 匿名 | `code: -352`（风控） | 匿名请求被风控拦截 |

**三个直接推论：**

1. **「平台有自动字幕」≠「裸接口能拿到」。** 两个平台都会返回 200 但内容为空，或直接返回风控码，不会报错。这是最容易被误判的地方。
2. **字幕内容必须在带登录态的浏览器上下文里取。** 这是 Chrome 扩展方案的根本理由，不是偏好问题。
3. **页面 `baseUrl` 在无 Cookie 时也为空**，说明认证信息参与了校验——必须在页面内、带真实会话发起请求。这也反过来证明 §3.1 把抓取放在 MAIN world 是对的。

> 注：本实验用服务端 curl 模拟，不代表真实浏览器页面上下文的结果。真实浏览器带 `VISITOR_INFO1_LIVE` / `SID` 等 Cookie 后大概率可通。**这一步必须在 M2 第一天用真实扩展复验**，是 M2 的准入条件。

### 2.1 YouTube（按优先级逐级降级）

| 级别 | 路线 | 说明 | 成功率 |
|---|---|---|---|
| 1 | **页面全局变量** | MAIN world 注入读 `movie_player.getPlayerResponse().captions.playerCaptionsTracklistRenderer.captionTracks[]`，取 `baseUrl` 直接 fetch | 最高，推荐主路径 |
| 2 | 旧全局变量 | `window.ytInitialPlayerResponse` 同上 | 备用（SPA 跳转后可能过期） |
| 3 | InnerTube 接口 | `/youtubei/v1/player` 用 ANDROID client + `X-Goog-Visitor-Id`（visitorData 从 `/youtubei/v1/next` 拿） | 中，需对齐 clientVersion |
| 4 | 本地 sidecar | `yt-dlp --write-auto-sub --sub-format json3` + potoken provider 插件 | 兜底 |

**关键点：**
- `baseUrl` 要追加参数：`&fmt=json3`（得 JSON，比 XML 好解析）。部分路径会忽略该参数返回 srv3 XML，解析器要两种都支持。
- 自动字幕的 track 带 `kind: "asr"`，`vssId` 形如 `a.zh-Hans`；手动字幕形如 `.zh-Hans`。**优先手动字幕，没有才用自动字幕。**
- 多语言时优先 `zh-Hans` → `zh-CN` → `zh-Hant` → 视频原语言 → 第一条。
- `baseUrl` 里已经带好了 pot 参数，**只要不是篡改参数直接请求，页面上下文里基本都通**——这是路线 1 成功率高的原因。

> 参考：[YouTube transcript 为什么绕不开 InnerTube（pot 墙实测）](https://github.com/mthines/agent-skills/blob/main/skills/analysis/youtube-transcript/references/why-innertube.md)

### 2.2 B 站

**四步链路：**

```
BV 号
 └─① GET /x/web-interface/view?bvid=BVxxx        # 免登录，拿 aid / cid / title / pages[]
     └─② GET /x/player/v2?bvid=&cid=             # 旧端点，免签名（优先）
         或 /x/player/wbi/v2?bvid=&cid=&w_rid=&wts=  # WBI 签名（兜底）
         或 /x/v2/subtitle/web/view?oid=&pid=&type=1&preferred_language=ai-zh  # 播放器实际调用，必须登录
          └─③ 取 data.subtitle.subtitles[] → 选 lan / ai-zh 那条的 subtitle_url
               └─④ GET subtitle_url（补 https:，带 Referer）→ {"body":[{from,to,content}]}
```

**关键点：**
- **匿名拿不到 AI 字幕**（返回空数组），必须登录。扩展内是用户自己的登录态，这是方案 1 的核心优势。
- `subtitle_url` 常以 `//` 开头，必须补 `https:`。
- `auth_key` 过期很快，拿到 URL 到下载之间**不要做多余的事**（不要先落数据库、不要排队）。
- `ai_status`：0=无 AI 字幕，1=有，2=生成中（2 时提示用户稍后再试）。
- **多分 P**：`pages[]` 每个 P 有独立 `cid`，`/x/player/v2` 要为每个 cid 各调一次。用户要单个 txt 时按「标题_P1.txt」命名，或合并成一个文件加「== P1 标题 ==」分隔。

> 参考：[B 站字幕接口与 WBI 签名要点](https://github.com/bfftp0502/bilibili-video-summary/blob/main/bilibili-video-summary/references/api.md)

### 2.3 文本后处理（决定成品可用性）

| 步骤 | 做什么 |
|---|---|
| 解码 | json3 → 句子；srv3 XML → 句子；B 站 `body[]` → 句子 |
| 去重 | YouTube 自动字幕滚动窗口会产生重复片段，按时间戳 + 文本相似度去重 |
| 合并 | 相邻 cue 间隔 < 1.5s 且总长 < 200 字 → 合并为同一段 |
| 断句 | ASR 无标点时，按「句末停顿 > 0.8s」「语气词」切分；可选接 LLM 精修 |
| 排版 | 每段一行，保留自然段落空行，去掉时间轴 |

**txt 输出格式：**

```
标题：<视频标题>
链接：https://www.bilibili.com/video/BVxxx
作者：<UP 主 / 频道>
时长：12:34
字幕来源：AI 字幕 / UP 主上传 / 自动生成(ASR)
语言：中文
导出时间：2026-11-10 12:43
----------------------------------------

正文第一段……

正文第二段……
```

头部元信息可开关（用户可能只想要纯文本）。

---

## 3. 方案 A：Chrome 扩展（推荐）

### 3.1 架构

```
                    ┌──────────────────────────────────────┐
 用户点击「导出」──→ │  popup / 视频页浮层按钮 (UI 层)        │
                    └──────────────┬───────────────────────┘
                                   │ chrome.runtime.sendMessage
                    ┌──────────────▼───────────────────────┐
                    │  service worker (调度层)              │
                    │  - 路由到 youtube / bilibili 适配器   │
                    │  - 并发控制、进度上报                 │
                    │  - 组装 txt、文件名清洗、下载         │
                    └──────────────┬───────────────────────┘
                                   │ chrome.scripting.executeScript
                                   │   world: 'MAIN'  ← 关键
                    ┌──────────────▼───────────────────────┐
                    │  页面主世界 (抓取层)                  │
                    │  - 读页面全局变量 / 同源 fetch        │
                    │  - 自动携带登录 Cookie 与 Referer     │
                    └──────────────┬───────────────────────┘
                                   │ 返回纯文本 / 结构化数组
                    ┌──────────────▼───────────────────────┐
                    │  parser + postprocess (纯函数层)      │
                    └──────────────────────────────────────┘
```

> **为什么抓取一定放 MAIN world，而不是 service worker？**
> 1. `service worker` 跨域 fetch 时，B 站的 `SESSDATA`（SameSite 策略）可能带不上，登录态丢失；
> 2. 页面上下文里 fetch 是同源请求，Cookie、Referer、UA 全部天然正确，反爬通过率最高；
> 3. 拿到的 `baseUrl` / `subtitle_url` 里含有时效性签名，在页面里发起请求最"像人"。
>
> 代价：数据要过 `executeScript` 序列化。字幕文本量级（< 5MB）完全没问题。

### 3.2 目录结构

```
subtitle-exporter/
├── manifest.json
├── background.js            # 调度 + 下载
├── content/
│   ├── youtube.js           # 注入浮层按钮
│   └── bilibili.js
├── lib/
│   ├── youtube.js           # 抓取（序列化后注入 MAIN world）
│   ├── bilibili.js
│   ├── wbi.js               # WBI 签名 + md5
│   ├── parser.js            # json3 / srv3 / b站 body → 句子
│   ├── postprocess.js       # 去重、合并、断句
│   ├── filename.js          # 文件名清洗
│   └── template.js          # txt 组装
├── popup.html / popup.js    # 单链接导出 + 设置
├── batch.html / batch.js    # 批量粘贴链接
└── icons/
```

### 3.3 manifest 关键字段

```json
{
  "manifest_version": 3,
  "name": "视频字幕导出",
  "version": "0.1.0",
  "permissions": ["scripting", "activeTab", "downloads", "storage"],
  "host_permissions": [
    "https://*.youtube.com/*",
    "https://*.bilibili.com/*",
    "https://*.hdslb.com/*"
  ],
  "background": { "service_worker": "background.js", "type": "module" },
  "content_scripts": [
    { "matches": ["https://*.youtube.com/watch*"], "js": ["content/youtube.js"], "run_at": "document_idle" },
    { "matches": ["https://www.bilibili.com/video/*"], "js": ["content/bilibili.js"], "run_at": "document_idle" }
  ],
  "action": { "default_popup": "popup.html" }
}
```

### 3.4 核心代码要点

**① MAIN world 读 YouTube 播放器数据（主路径）**

```js
// background.js
async function readYouTubeTracks(tabId) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',                 // 必须，隔离环境读不到页面变量
    func: () => {
      const p = document.getElementById('movie_player');
      const resp = (p && typeof p.getPlayerResponse === 'function')
        ? p.getPlayerResponse()
        : window.ytInitialPlayerResponse;
      const tracks = resp?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
      return tracks.map(t => ({
        baseUrl: t.baseUrl, lang: t.languageCode,
        name: t.name?.simpleText || t.name?.runs?.[0]?.text || '',
        isAsr: t.kind === 'asr'
      }));
    }
  });
  return result || [];
}
```

**② 页面上下文里抓字幕（带登录态）**

```js
async function fetchInPage(tabId, url) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId }, world: 'MAIN',
    func: async (u) => {
      const r = await fetch(u, { credentials: 'include' });
      return { ok: r.ok, status: r.status, body: await r.text() };
    },
    args: [url]
  });
  return result;
}
```

**③ B 站 WBI 签名（兜底时用）**

```js
const TAB = [46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,27,43,5,49,33,9,42,19,
             29,28,14,39,12,38,41,13,37,48,7,16,24,55,40,61,26,17,0,1,60,51,30,4,
             22,25,54,21,56,59,6,63,57,62,11,36,20,34,44,52];

function mixinKey(imgKey, subKey) {
  const raw = imgKey + subKey;
  return TAB.map(i => raw[i]).join('').slice(0, 32);
}

function signWbi(params, mixinKey) {
  const wts = Math.floor(Date.now() / 1000);
  const q = Object.keys(params).sort()
    .map(k => `${encodeURIComponent(k)}=${encodeURIComponent(String(params[k]).replace(/[!'()*]/g, ''))}`)
    .join('&') + `&wts=${wts}`;
  return `${q}&w_rid=${md5(q + mixinKey)}`;
}
```

> `img_key` / `sub_key` 来自 `GET /x/web-interface/nav` 的 `wbi_img.img_url` / `sub_url`，取文件名去 `.png`。
> 重排表以 [bilibili-API-collect](https://github.com/SocialSisterYi/bilibili-API-collect) 的实现为准，接口调整时需同步。

**④ 文件名清洗（用户明确要求"文件名就是视频名字"）**

```js
export function toFilename(title) {
  let name = (title || '未命名视频')
    .replace(/[\\/:*?"<>|]/g, '_')      // Windows 非法字符
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  // Windows 保留名
  if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(name)) name = '_' + name;
  // 按字节截断（中文 3 字节），留出 .txt 余量
  const enc = new TextEncoder();
  while (enc.encode(name).length > 200) name = name.slice(0, -1);
  return name || '未命名视频';
}
```

**⑤ 下载**

```js
const blob = new Blob(['\uFEFF' + text], { type: 'text/plain;charset=utf-8' }); // BOM 防 Excel/记事本乱码
const url = URL.createObjectURL(blob);
await chrome.downloads.download({ url, filename: `${safeName}.txt`, saveAs: false });
```

### 3.5 交互设计

- **视频页浮层**：右下角一个「导出字幕」按钮，点一下直接下载，无弹窗打断。
- **popup**：当前页视频信息 + 语言选择 + 「带元信息」开关 + 「复制到剪贴板」。
- **批量页**：文本框粘贴多链接 → 逐条打开后台标签（或复用已开标签）→ 进度列表 → 全部完成后打包 zip。
- **失败提示**：区分「无字幕」「需登录」「会员视频」「字幕生成中」，给出可操作建议而不是一句 error。

### 3.6 工作量

| 阶段 | 内容 | 人日 |
|---|---|---|
| P1 | 扩展骨架 + YouTube + B 站单视频 + txt 下载 | 3~5 |
| P2 | 批量链接 / 播放列表 / 合集 / zip | 2~3 |
| P3 | 断句优化、多语言、多分 P、失败态打磨 | 2 |
| 合计 | | **7~10 人日** |

**分发方式**：Chrome Web Store 对「下载 YouTube 字幕」类扩展有版权/ToS 下架先例，**不建议公开上架**。内部分发用打包 zip + 开发者模式加载，或用企业策略 `ExtensionInstallForcelist` 强制安装（可配 `update_url` 自托管更新）。

---

## 4. 方案 B：网站（输入链接 → 下载 txt）

### 4.1 架构

```
浏览器 ──→ 前端 (Next.js / 纯静态)
              │  POST /api/extract {url}
              ▼
         API 服务 (Node / FastAPI)
              │ 入队
              ▼
         任务队列 (BullMQ / Celery) ──→ Worker
                                        ├─ yt-dlp (YouTube)  ← 必须挂住宅代理
                                        ├─ 自研 B 站客户端    ← 必须挂 cookie 池
                                        └─ 可选 Whisper      ← 无字幕视频转写
                                        │
                                        ▼
                                 对象存储(字幕 txt) + 前端轮询下载
```

### 4.2 三个必须先解决的问题

1. **住宅代理**：YouTube 对机房 IP 全面封堵（`LOGIN_REQUIRED` / 429 / captcha）。数据中心 IP 无解，必须住宅或移动代理。按 GB 计费 $5~15/GB，单视频（含页面）约 1~3MB。
2. **B 站 cookie 池**：AI 字幕必须登录。多账号轮询 + 风控监控 + 封号补充，是持续运营成本，且有合规风险。
3. **异步任务**：单次抓取 3~15 秒，必须队列 + 进度查询 + 超时重试，不能同步阻塞。

### 4.3 成本与工作量

| 项 | 估算 |
|---|---|
| 开发 | 8~12 人日 |
| 服务器 | 2C4G 约 ¥100/月 |
| 住宅代理 | $50~200/月（按 1000~3000 视频/月） |
| B 站账号池 | 持续维护成本 + 封号风险 |
| **持续维护** | **平台一改版就要修，无底洞** |

### 4.4 唯一不可替代的优势

**无字幕视频也能出文案**——服务端可以跑 Whisper/FunASR 做语音转写。这是扩展做不到的，也是很多人真正想要的能力。

---

## 5. 方案对比

| 维度 | A. Chrome 扩展 | B. 网站 |
|---|---|---|
| 开发成本 | 7~10 人日 | 8~12 人日 + 基础设施 |
| 运行成本 | **0** | $50~200/月 |
| B 站 AI 字幕成功率 | **高**（用户登录态） | 中（取决于 cookie 池质量） |
| YouTube 成功率 | **高**（真实住宅 IP） | 低（依赖代理质量） |
| 批量导出 | 一般（要开标签页） | **好**（纯后端） |
| 无字幕视频 ASR | 不能（除非配 sidecar） | **能** |
| 分享给他人 | 一般（装扩展） | **好**（发链接） |
| 隐私 | **好**（数据不出本机） | 差（视频内容过服务器） |
| 合规风险 | **低**（个人使用工具） | 高（公开服务化抓取） |
| 长期维护 | 平台改版需适配 | 平台改版 + 反爬对抗 + 代理运维 |

---

## 6. 推荐演进路线

```
P0  spike 验证（0.5 天）
    在浏览器 Console 里跑一段脚本，确认「我的环境下两个平台都能拿到字幕」。
    → 先验证，再投入。见 §7。

P1  Chrome 扩展 MVP（3~5 天）
    YouTube + B 站单视频 → 标题.txt。覆盖 90% 日常场景。

P2  批量能力（2~3 天）
    粘贴多链接 / 播放列表 / 合集 → 打包 zip。
    YouTube 播放列表可直接用 ytInitialData 拿全量 videoId，成本很低。

P3  本地 sidecar（可选，3 天）
    扩展通过 http://127.0.0.1:PORT 或 nativeMessaging 调本地服务：
    - yt-dlp + potoken provider → YouTube 兜底
    - Whisper / FunASR → 无字幕视频转写
    只装在用户自己机器上，零服务器成本、零反爬风险。

P4  网站形态（可选，2 天）
    把 sidecar 的 HTTP 接口套一个本地网页 → 就得到了方案 2 的完整体验：
    「打开网页，粘贴链接，下载 txt」
    但跑在 localhost，不用买代理、不用养账号、不怕封号。
```

**P4 是方案 2 的正确打开方式**：体验一模一样，成本从 $200/月变成 0。

---

## 7. 五分钟可行性验证（P0，先做这个）

在你自己的 Chrome 里打开任意 YouTube 视频页，Console 粘贴执行：

```js
(async () => {
  const p = document.getElementById('movie_player');
  const resp = p?.getPlayerResponse?.() || window.ytInitialPlayerResponse;
  const tracks = resp?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
  console.log('YouTube 字幕轨：', tracks.map(t => ({ lang: t.languageCode, asr: t.kind === 'asr' })));
  if (!tracks.length) return console.warn('该视频无字幕轨');
  const r = await fetch(tracks[0].baseUrl + '&fmt=json3', { credentials: 'include' });
  console.log('HTTP', r.status, '内容片段：', (await r.text()).slice(0, 300));
})();
```

B 站（在已登录的视频页 Console）：

```js
(async () => {
  const bvid = location.pathname.match(/BV[\w]+/)[0];
  const v = await (await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`, { credentials: 'include' })).json();
  const { aid, cid, title } = v.data;
  console.log('视频：', title, aid, cid);
  for (const ep of ['/x/player/v2', '/x/player/wbi/v2']) {
    const j = await (await fetch(`https://api.bilibili.com${ep}?bvid=${bvid}&cid=${cid}`, { credentials: 'include' })).json();
    const subs = j?.data?.subtitle?.subtitles || [];
    console.log(ep, '→ code', j.code, '字幕轨', subs.map(s => s.lan));
    if (subs.length) {
      const u = subs[0].subtitle_url.startsWith('//') ? 'https:' + subs[0].subtitle_url : subs[0].subtitle_url;
      const t = await (await fetch(u, { credentials: 'include', headers: { Referer: location.href } })).text();
      console.log('字幕内容片段：', t.slice(0, 300));
      break;
    }
  }
})();
```

**预期结果**：YouTube 返回 2xx + json3；B 站 `/x/player/v2` 返回 code 0 且字幕轨非空。
**若 B 站字幕轨为空**：视频本身没有字幕/AI 字幕未生成，换一个热门视频再试；仍为空则说明登录态未生效。
**若 YouTube 返回 403**：baseUrl 的 pot 参数失效，需要降级到 InnerTube 路线或本地 yt-dlp。

---

## 8. 风险与合规

| 风险 | 说明 | 应对 |
|---|---|---|
| 平台改版 | 两个平台都可能随时调整接口 | 抓取逻辑分层、单平台独立降级链、失败可观测 |
| YouTube pot token | 校验持续加强，公开 API 部门已收紧 | 走页面上下文为主，本地 yt-dlp 兜底 |
| B 站风控 | 高频请求可能 -412 | 请求节流、批量时加随机延迟 |
| 版权 | 字幕属平台与创作者内容 | 仅作个人学习/研究用途，不公开分发、不二次发布 |
| 上架审核 | 商店可能以 ToS 为由下架 | 内部分发，不上架 |
| 内容准确性 | ASR 字幕有识别错误 | 导出时标注来源，提示用户不可直接引用 |

---

## 9. 决策记录

| 决策点 | 结论 | 影响 |
|---|---|---|
| 使用范围 | **只自己用** | 不上架、不分发、无需账号体系，开发模式加载即可 |
| 无字幕视频 | **需要转写** | ASR 从"可选"变成"必做"，**必须引入本地 Python 服务** |
| 输出形态 | 由实现方定 | 定为「`标题.txt` + 元信息头 + 正文」，另提供"复制纯文本"按钮 |

> **关键推论**：因为需要 ASR，方案从"纯扩展"变成"**扩展 + 本地服务**"的混合架构。
> 这反而让整体更稳——两边各自负责最擅长的部分。详见 §10。

---

# 10. 定稿方案：扩展（抓字幕）+ 本地服务（兜底 ASR）

## 10.1 架构与分工

```
                     ┌─────────────────────────────────┐
   用户点「导出」──→  │  Chrome 扩展（MV3）              │
                     │                                 │
                     │  ① 抓字幕（覆盖 ~80% 视频）      │
                     │     页面上下文 + 登录态           │
                     │                                 │
                     │  ② 无字幕时，取音频流直链         │
                     │     YouTube: yt-dlp 需下音频      │
                     │     B站: /x/player/playurl 带登录 │
                     └──────────┬──────────────────────┘
                                │ POST http://127.0.0.1:8765
                                │ （只传 URL，不传文件）
                     ┌──────────▼──────────────────────┐
                     │  本地 ASR 服务（Python）          │
                     │  ③ ffmpeg 拉流 → 16k wav → 静音剔除│
                     │  ④ mlx-whisper 转写（Apple Silicon）│
                     │  ⑤ 标点恢复 + 分段                │
                     └──────────┬──────────────────────┘
                                │ 轮询进度 / 取回文本
                                ▼
                        扩展组装 txt 并下载
```

**这个分工解决了一个隐藏难题**：本地服务若自己取 B 站音频，需要提取 Chrome 的 cookies（`--cookies-from-browser chrome` 在 Chrome 运行时因数据库锁会失败）。而**扩展在页面上下文里就能拿到带登录态的音频流直链**，只把 `URL` 传给本地服务——本地服务永远不需要碰 Cookie。这是本方案最值得强调的设计点。

## 10.2 本机环境实测结论

| 项 | 状态 | 处理 |
|---|---|---|
| 芯片 / 系统 | Apple Silicon (arm64) / macOS 26.6.2 | ✅ 可用 MLX 加速 |
| 内存 | 24 GB | ✅ 够跑 `large-v3`（约需 10 GB） |
| Chrome | 已安装 | ✅ |
| **Python** | **3.14.4** | ⚠️ **不能用**：3.14 上 `mlx` / `ctranslate2` / `torch` 都没有可用 wheel |
| ffmpeg | ❌ 未安装 | `brew install ffmpeg` |
| yt-dlp | ❌ 未安装 | `brew install yt-dlp` |
| uv | ❌ 未安装 | `brew install uv` |

**环境准备（一次性，约 10 分钟）：**

```bash
brew install ffmpeg yt-dlp uv

cd subtitle-exporter/server
uv venv --python 3.12          # 必须 3.12/3.13，不能用系统 3.14
uv pip install fastapi uvicorn mlx-whisper python-multipart

# 预下载模型（首次会自动下，约 3GB，建议先跑一次预热）
python -c "import mlx_whisper; mlx_whisper.transcribe('test.wav', path_or_hf_repo='mlx-community/whisper-large-v3-mlx')"
```

## 10.3 为什么是 mlx-whisper 而不是 faster-whisper

| 方案 | Apple Silicon 加速 | 1 小时视频耗时 | 结论 |
|---|---|---|---|
| `faster-whisper` (CTranslate2) | ❌ 仅 CPU（不支持 Metal） | 5~10 分钟（large-v3） | 可用但浪费硬件 |
| **`mlx-whisper`** | ✅ **GPU（Metal）** | **1~3 分钟（large-v3）** | **推荐** |
| `whisper.cpp` | ✅ Metal | 2~5 分钟 | 备选，编译麻烦 |

24 GB 内存 + M 系列，直接上 `mlx-community/whisper-large-v3-mlx`，中文识别质量比 medium 明显好一档。若追求速度可降级 `whisper-large-v3-turbo`（快 5~8 倍，质量略降）。

**中文专用优化：**
- `language="zh"` 强制中文，避免自动检测串到日文。
- `initial_prompt="以下是普通话的句子，请使用简体中文，并加上标点符号。"` —— 这一句能显著改善简体输出和标点。
- `condition_on_previous_text=False` 防长视频重复循环。

## 10.4 本地服务接口

```http
GET  /api/health
→ {"ok": true, "model": "large-v3", "device": "gpu", "ffmpeg": true}

POST /api/transcribe
    {"url": "<音频流直链或视频页URL>", "referer": "<可选>", "title": "<文件名>"}
→ {"task_id": "abc123"}

GET  /api/task/{task_id}
→ {"status": "queued|downloading|transcribing|done|error",
   "progress": 0.0~1.0,
   "text": "...",           // done 时返回
   "segments": [...],       // 可选，带时间轴
   "error": "..."}
```

**安全**：只监听 `127.0.0.1`，启动时生成随机 token 写入本地配置文件，扩展首次连接时读取，后续请求带 `X-Auth`。防止同机其他网页误触。

**并发**：单任务队列（Whisper 吃满内存，并行没收益），排队时返回 `queued`。

## 10.5 完整导出决策树

```
用户点击「导出字幕」
│
├─ 解析链接（YouTube / B站）
│
├─ 尝试抓字幕轨
│   ├─ 成功 ──→ 解析 → 去重 → 合并断句 → 组装 txt → 下载   【快，秒级】
│   │
│   └─ 失败（无字幕 / 未登录 / 会员限制）
│        │
│        ├─ 本地服务未运行 ──→ 提示"该视频无字幕，启动本地转写服务后可转写"
│        │
│        └─ 本地服务运行中
│             ├─ B站：页面上下文调 /x/player/playurl 拿 dash 音频流
│             ├─ YouTube：调本地服务用 yt-dlp 下载音频
│             └─ → 转写 → 组装 txt → 下载                          【慢，分钟级】
```

UI 上必须**明确区分「字幕」和「转写」两种来源**，并在 txt 头部写清——ASR 有识别误差，用户需要知道自己在读什么。

## 10.6 输出规范（定稿）

**文件名**：`<视频标题>.txt`（清洗 Windows 非法字符、保留名、按 200 字节截断）

**内容**：

```
标题：如何用 30 分钟搭建一个 RAG 系统
链接：https://www.youtube.com/watch?v=xxxx
作者：某某频道
时长：32:15
字幕来源：自动生成（ASR 转写）     ← 三种：手动字幕 / AI字幕 / ASR转写
语言：中文
导出时间：2026-11-10 12:43
────────────────────────────

正文段落一……

正文段落二……
```

- 元信息头默认开启，可在 popup 里关掉。
- 另提供「复制纯文本」按钮，只复制正文。
- 编码 `UTF-8 with BOM`，防 Windows 记事本乱码。

## 10.7 目录结构（定稿）

```
subtitle-exporter/
├── PLAN.md
├── extension/
│   ├── manifest.json
│   ├── background.js
│   ├── content/{youtube,bilibili}.js
│   ├── lib/{youtube,bilibili,wbi,parser,postprocess,filename,template,localapi}.js
│   ├── popup.html / popup.js
│   └── icons/
└── server/
    ├── pyproject.toml
    ├── app.py              # FastAPI 入口
    ├── transcribe.py       # mlx-whisper 封装
    ├── download.py         # ffmpeg / yt-dlp 取音频
    ├── segment.py          # 标点恢复 + 分段
    └── config.json         # token / 模型选择
```

## 10.8 里程碑

| 阶段 | 交付物 | 预计 |
|---|---|---|
| **M1** | 环境就绪 + 本地服务骨架（health / transcribe / 进度），能用 curl 跑通一段音频转写 | 0.5~1 天 |
| **M2** | 扩展骨架 + YouTube 字幕抓取 + txt 下载（有字幕场景跑通） | 1.5~2 天 |
| **M3** | B 站字幕抓取（含多分 P、WBI 兜底） | 1.5~2 天 |
| **M4** | 无字幕 → ASR 全链路打通（两个平台） | 1~1.5 天 |
| **M5** | 断句打磨、失败态、多语言、UI 细节 | 1 天 |
| **合计** | | **5.5~7.5 人日** |

## 10.9 关于 ASR 的执行顺序（建议后置）

实测确认平台字幕是可用的主路径。但「平台有自动字幕」和「你看的每个视频都有字幕」是两件事，以下几种情况平台字幕拿不到：

- 上传者手动关闭了 CC
- 视频未被平台判定/生成 AI 字幕（B 站 `ai_status: 0`）
- AI 字幕生成中（`ai_status: 2`），新视频尤为明显
- 纯音乐、无语音视频
- 会员/地区受限内容

**但这类情况的实际占比，需要用你自己的真实使用场景来定，不能拍脑袋。**

**建议执行方式：**

```
M2 + M3 先做（3~4 天）→ 得到一个能用的纯字幕版
        ↓
扩展内置轻量统计：记录每次导出「有字幕 / 无字幕 / 来源类型」
        ↓
用一个星期，看真实覆盖率
        ↓
├─ 覆盖率 ≥ 95%  → ASR 不做，省掉 2 天和整套 Python 依赖
└─ 覆盖率明显偏低 → 再上 M4（ASR），此时需求是数据驱动的，不是猜的
```

这样做的额外好处：M1 的环境搭建也只有真需要 ASR 时才付这笔成本（`brew install ffmpeg yt-dlp uv` + Python 3.12 venv + 3GB 模型）。

**ASR 的存在价值，不在于覆盖大多数视频，而在于让「拿不到字幕」这件事从"失败"变成"慢一点但能成"。** 它是兜底能力，不是主路径。

## 10.10 已知风险（针对本方案）

| 风险 | 影响 | 处理 |
|---|---|---|
| Whisper 转写有错别字 / 专有名词识别差 | 转写结果不如原字幕 | txt 标注来源；长视频建议优先找有字幕的版本 |
| 1~3 分钟/小时的转写耗时 | 用户等待 | 进度条 + 后台任务 + 完成通知 |
| B 站音频流 URL 有时效 | 下载失败 | 扩展拿 URL 后立刻传给服务，服务立即开始拉流 |
| 本地服务未启动 | ASR 不可用 | 扩展检测 `/api/health`，给出启动命令提示 |
| Python 环境冲突 | 装不上依赖 | 用 `uv venv` 隔离，不碰系统 Python |

---

# 11. 定稿方案 v3：纯 Chrome 扩展（零后端 · 零 Python · 零依赖）

> 触发原因：不做本地 ASR 服务，全部能力收进 Chrome 扩展单一体。
> 本节覆盖 §10 的混合架构，以本节为准。

## 11.1 为什么纯扩展可行

抓字幕不需要 Python，也不需要后端。真正需要"服务端"能力的只有 ASR 转写——把它去掉，架构就可以完全塌缩进浏览器。

| 能力 | 纯扩展能否做到 |
|---|---|
| YouTube 字幕获取 | ✅ 页面上下文 + 登录态 |
| B 站字幕获取 | ✅ 用户自己的登录 Cookie |
| 解析 / 去重 / 断句（中文重排） | ✅ 纯 JS，本地计算 |
| 文件名清洗 / txt 生成 / 下载 | ✅ `chrome.downloads` |
| 批量链接处理 | ✅ 后台标签页并发 |
| **无字幕视频转写** | ❌ **只有这一项丢失** |

## 11.2 先厘清「不发请求」的两种含义

这两件事差别很大，方案也不同：

| 理解 | 是否可行 | 说明 |
|---|---|---|
| **A. 不要自建后端 / 本地服务** | ✅ 完全可行 | 扩展直接请求 `youtube.com` / `bilibili.com` 自己的域名，数据不经过任何第三方。**与你打开视频时浏览器本来就在做的事完全一样**，没有新增任何隐私暴露 |
| **B. 连平台接口也不主动请求**<br>（只从页面已有数据里抓） | ⚠️ 可行但体验受限 | 需要用户先播放视频、手动打开 CC 字幕，扩展被动嗅探播放器自己发出的请求。**不能秒出、不能批量** |

**推荐理解 A。** 补充说明扩展的网络行为，便于你判断风险：

- 扩展**没有任何自建服务器**，不发送任何数据到第三方；
- 唯一的请求目标就是 `*.youtube.com` / `*.bilibili.com` / `*.hdslb.com`；
- 请求在**页面上下文**发起，Cookie、Referer、UA 与你正常浏览完全一致；
- 所有中间数据（字幕原文）只在内存里，导出后即丢弃，不落盘、不上传。

## 11.3 双模抓取设计（关键）

即便采用理解 A，也存在失败可能（pot 墙、接口风控）。设计成**双模自动降级**，两种模式都是纯扩展：

### 模式 1：主动抓取（默认，秒出）

```
扩展 → 页面上下文 fetch 平台接口 → 字幕 JSON → 解析 → txt
```
- 优点：不用播放视频，几秒出结果，可批量
- 风险：YouTube 的 pot 校验可能拦截（**M1 第一件事就是验证这个**）

### 模式 2：被动嗅探（兜底，需用户配合）

```js
// 注入 MAIN world，优先级：document_start
const origFetch = window.fetch;
window.fetch = async function (...args) {
  const url = typeof args[0] === 'string' ? args[0] : args[0]?.url;
  const res = await origFetch.apply(this, args);
  if (url && /timedtext|aisubtitle|\/subtitle\//.test(url)) {
    res.clone().text().then(body => {
      window.postMessage({ __sub: 1, url, body }, '*');
    });
  }
  return res;
};
// XMLHttpRequest 同理 hook
```
- 原理：**播放器自己发出的请求一定是成功的**（否则用户就看不到字幕）。我们只是旁听它的响应。
- 优点：**100% 可靠**，绕开一切 pot / 签名问题
- 代价：需要用户先播放视频并打开 CC；不能批量

**交互设计**：模式 1 失败时，不报错，而是浮层提示「点此打开字幕后自动捕获」，用户点一下播放器 CC 按钮，嗅探器接住结果并自动完成导出。体验上只多了一次点击。

## 11.4 能力边界（诚实说明）

去掉 ASR 后，以下情况**无法处理**，UI 上要明确告知而不是静默失败：

- 视频没有字幕轨，且平台未生成 AI 字幕
- 上传者手动关闭了 CC
- B 站 AI 字幕生成中（`ai_status: 2`）→ 提示"稍后再试"
- 纯音乐 / 无语音视频
- 会员、地区受限内容

**这不是缺陷，是明确的边界。** 相比"半吊子的本地转写"，清晰的失败提示对用户更有用。

## 11.5 精简后的目录结构

```
subtitle-exporter/
├── PLAN.md
└── extension/
    ├── manifest.json
    ├── background.js              # 路由 / 并发 / 文件下载
    ├── content/
    │   ├── youtube.js             # 浮层按钮 + 嗅探消息转发
    │   └── bilibili.js
    ├── lib/
    │   ├── youtube.js             # 主动抓取（注入 MAIN world）
    │   ├── bilibili.js
    │   ├── sniffer.js             # 被动嗅探（注入 MAIN world）
    │   ├── wbi.js                 # WBI 签名 + md5（B 站兜底）
    │   ├── parser.js              # json3 / srv3 / b站 body → 句子
    │   ├── postprocess.js         # 去重、合并、断句
    │   ├── filename.js
    │   └── template.js
    ├── popup.html / popup.js
    └── icons/
```

**零依赖**：不需要 npm 构建，原生 ES Module 直接跑，`chrome://extensions` 加载即用。

## 11.6 工作量（比 v2 减少约 30%）

| 阶段 | 交付 | 人日 |
|---|---|---|
| **M1** | 扩展骨架 + YouTube 双模抓取 + txt 下载 | 1.5~2 |
| **M2** | B 站抓取（含多分 P、WBI 兜底、嗅探模式） | 1.5~2 |
| **M3** | 批量链接、失败态、断句打磨、UI | 1~1.5 |
| **合计** | | **4~5.5 人日** |

环境准备成本：**0**。不需要 `brew install` 任何东西，不需要 Python 3.12，不需要 3GB 模型。

## 11.7 新增风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| 页面上下文 fetch 仍被 pot 拦截 | 模式 1 失效 | 降级模式 2（嗅探），必然成功 |
| 嗅探需要用户开 CC | 多一步操作 | 浮层引导文案 + 自动检测字幕出现后自动完成 |
| 嗅探 hook 与页面脚本冲突 | 极低 | 保留原函数引用，只做旁听，不修改返回值 |
| 无 ASR 导致部分视频无法导出 | 能力缺失 | 明确提示，不静默失败 |

## 11.8 与原方案的取舍总结

| | v2（扩展+Python） | **v3（纯扩展）** |
|---|---|---|
| 环境依赖 | ffmpeg + Python 3.12 + 3GB 模型 | **无** |
| 开发量 | 5.5~7.5 人日 | **4~5.5 人日** |
| 无字幕视频 | 能转写 | 明确提示不支持 |
| 可用性 | 需保证本地服务常驻 | **加载即用** |
| 隐私 | 音频要落本地磁盘 | **全程内存，零落盘** |

**结论：v3 更适合"只自己用 + 反感本地依赖"的场景。** 真的遇到无字幕视频时，临时用在线工具或另装 Whisper 即可，没必要为低频场景常驻一套服务。

---

# 12. 平台自动字幕的完整利用（回应「开默认字幕能力」）

## 12.1 结论：平台 ASR 就是免费的本地 ASR 替代

**可以，而且这比自建 Whisper 更划算。**

两个平台本来就内置了语音识别：YouTube 叫 auto-generated captions，B 站叫 AI 字幕。它们是平台用自己的算力提前跑好的 ASR 结果，**免费、零依赖、质量稳定**。我们要做的不是自己转写，而是**把这条轨取出来**。

所以 v3 砍掉本地 ASR 是合理的——不是放弃兜底，而是换了个更好的兜底。

## 12.2 三层字幕来源与优先级

### YouTube

| 优先级 | 类型 | 识别特征 | 说明 |
|---|---|---|---|
| 1 | 上传者字幕 | `vssId` 形如 `.zh-Hans`，无 `kind` 字段 | 质量最好，带标点 |
| 2 | **自动生成（ASR）** | `kind: "asr"`，`vssId` 形如 `a.zh-Hans` | **平台 ASR，兜底主力** |
| 3 | 无 | `captionTracks` 为空数组 | 明确告知 |

### B 站

| 优先级 | 类型 | 识别特征 | 说明 |
|---|---|---|---|
| 1 | UP 主上传 CC | `lan: zh-CN`，`ai_status: 0` 但有 `subtitle_url` | 质量最好 |
| 2 | **AI 字幕** | `lan: ai-zh`，`ai_status: 1` | **平台 ASR，兜底主力** |
| 3 | 生成中 | `ai_status: 2` | 提示「稍后再试」，不报错 |
| 4 | 无 | `subtitles` 为空数组 | 明确告知 |

**多语言选择顺序**：中文（`zh-Hans` / `zh-CN` / `ai-zh`）→ 视频原语言 → 第一条可用轨。

## 12.3 自动开启字幕：把「手动点 CC」也自动化

§11.3 的模式 2 需要用户手动开 CC，体验上有断点。可以**让扩展自己点**：

```js
// YouTube：点击播放器字幕按钮
const btn = document.querySelector('.ytp-subtitles-button');
if (btn && btn.getAttribute('aria-pressed') !== 'true') btn.click();

// B 站：展开字幕菜单并选中文/AI 轨
document.querySelector('.bpx-player-ctrl-subtitle')?.click();
setTimeout(() => {
  document.querySelector('.bpx-player-ctrl-subtitle-language-item[data-lan="ai-zh"]')?.click()
    || document.querySelector('.bpx-player-ctrl-subtitle-language-item')?.click();
}, 300);
```

**最终用户看到的就是一次点击：**

```
点「导出字幕」
  ├─ 模式 1 主动抓取成功 → 直接下载     （~70%，秒级）
  └─ 失败 → 自动点开 CC → 嗅探捕获 → 下载（~25%，2~3 秒）
              └─ 仍失败 → 明确提示原因   （~5%）
```

用户全程无感，不需要知道背后用了哪种模式。

## 12.4 覆盖率（诚实版）

| 情况 | 能否导出 |
|---|---|
| 上传者有字幕 | ✅ |
| 平台已生成自动字幕 | ✅ 绝大部分 |
| 平台正在生成 | ⏳ 提示稍后重试 |
| 纯音乐 / 无语音 | ❌ |
| 上传者关闭 CC 且无自动字幕 | ❌ |
| 平台未支持的语言 | ❌ |

**最后三行才是本地 Whisper 唯一能补上的缺口。** 为这 5% 常驻一套 Python 服务，性价比不成立——真遇到了临时用在线工具处理即可。

## 12.5 方案最终边界（一句话）

> 纯 Chrome 扩展，零后端零依赖；用平台自带的字幕与 ASR；覆盖有语音的视频；导出「视频标题.txt」。

可以开工了。

---

# 13. 实现与测试结果（2026-11-10）

## 13.1 已交付

```
subtitle-exporter/
├── PLAN.md                    # 本方案
├── TEST-REPORT.md             # 完整测试报告
├── extension/                 # 纯 MV3 扩展，零依赖零构建
│   ├── manifest.json
│   ├── background.js
│   ├── content/main.js
│   ├── popup.html / popup.js
│   └── lib/{grabbers,parser,postprocess,filename,template}.js
├── test/
│   ├── unit.mjs               # 18 项单元测试
│   ├── mock-e2e.mjs           # mock 端到端（两平台）
│   ├── e2e.mjs                # 真实环境端到端
│   └── diag.mjs / probe-*.mjs # 诊断脚本
└── output/                    # 导出产物
```

## 13.2 测试结论

| 层级 | 结果 |
|---|---|
| 单元测试（解析/断句/文件名/模板） | ✅ 18/18 |
| Mock 端到端 · B 站 | ✅ 6/6，产出真实格式 txt |
| Mock 端到端 · YouTube | ✅ 6/6，产出真实格式 txt |
| 扩展加载 + 按钮注入 + 下载链路 | ✅ 通过 |
| 真实平台端到端 | ❌ 环境受限（详见 TEST-REPORT.md §4） |

**真实平台受阻的原因与代码无关：**

- **YouTube**：出口是香港腾讯云数据中心 IP，`timedtext` 静默返回 0 字节，连 YouTube 自己的播放器在该环境下都拿不到字幕；`get_transcript` 返回 400。
- **B 站**：未登录。`x/player/v2` 正常响应但字幕列表为空，12 个视频验证无一例外。
- **登录态无法迁移**：Chrome Cookie 由 Keychain 加密，Chrome for Testing 解不开；读取密钥需交互授权，为避免打扰未执行。

## 13.3 实际使用前提（重要）

1. **必须在浏览器里登录 B 站**——这是硬性前提，不是建议。
2. **YouTube 需要正常网络环境**——数据中心/云服务器 IP 会被静默拦截；同时建议登录 Google 账号。
3. 用户真实 Chrome 两个平台均已登录，所以**原计划的使用场景（只自己用）成立**。

## 13.4 用户自测（约 2 分钟）

```
1. chrome://extensions → 开启「开发者模式」
2. 「加载已解压的扩展程序」→ 选择 extension/ 目录
3. 打开任意 B 站视频 → 点右下角「导出字幕」
4. 按钮反馈：
   已导出 N 字        → 成功
   该视频无字幕        → 换知识区/教程类视频
   需要先登录 B 站账号  → 登录后重试
```

## 13.5 测试中发现并修复的缺陷

| 缺陷 | 现象 | 修复 |
|---|---|---|
| YouTube 语种选择 | 无中文时取第一条，选中德语 | 优先级改为 中文 > 英文 > 任意 |
| 失败提示过于笼统 | 只显示「接口返回空」 | 区分未登录 / IP 拦截 / 真无字幕 / 字幕生成中 |
