# 发布到 Chrome Web Store · 操作手册

---

## 零、先看风险（很重要）

这类「抓取 YouTube 字幕」的扩展，在 Chrome Web Store **有过被下架的案例**，
常见理由是「违反第三方平台服务条款」或版权相关投诉。这是平台侧的判定，不是技术问题。

**因此建议的发布策略：**

| 场景 | 推荐方式 |
|---|---|
| 只自己 / 小团队用 | **不要上架**，用「开发者模式加载」或「企业私有分发」即可（见附录 A/B） |
| 想公开上架 | 按本文流程走，但要做好被拒/被下架的心理准备 |
| 想留后路 | 先按本文提交，同时保留自行分发的 zip |

**降低被拒概率的几个做法：**
1. 应用名称**不要出现 "YouTube" / "哔哩哔哩"** 等商标（描述里提到没问题）
2. 描述里明确写「仅用于个人学习、研究、无障碍阅读」，并提示遵守平台条款
3. 坚决不收集任何数据，隐私政策写清楚
4. 权限理由必须具体到「为什么要这个域名」，含糊会被打回
5. 功能描述实事求是，不要写「下载视频」「绕过会员」等字样

---

## 一、注册开发者账号

1. 打开 <https://chrome.google.com/webstore/devconsole>
2. 用 Google 账号登录
3. 支付 **一次性注册费 5 美元**（信用卡）
4. 填写开发者名称、联系邮箱

> 注册后建议先完成「发布者验证」（需要验证域名或邮箱），否则部分功能受限。

---

## 二、打包扩展

```bash
cd subtitle-exporter
npm run pack        # 或手动执行下面两条命令

# 手动方式：
mkdir -p dist
cd extension && zip -r ../dist/subtitle-exporter-v0.1.0.zip . -x "*.DS_Store" -x "__MACOSX/*"
```

校验 zip 内容（**第一层必须直接是 manifest.json**，不能多包一层目录）：

```bash
unzip -l dist/subtitle-exporter-v0.1.0.zip | head -20
```

---

## 三、上传

1. 开发者后台 → **新增项目（New item）**
2. 上传 `dist/subtitle-exporter-v0.1.0.zip`
3. 上传后系统会自动校验 manifest

常见报错：

| 报错 | 原因 | 处理 |
|---|---|---|
| `Manifest is not valid JSON` | manifest 有语法错误 | 用 `python3 -m json.tool extension/manifest.json` 检查 |
| `Cannot use 'world' key` | Chrome 版本要求未声明 | manifest 已加 `minimum_chrome_version: "111"` |
| 图标缺失 | 未声明 icons 或路径错 | 已生成在 `extension/icons/` |
| 权限过宽警告 | host_permissions 含通配符 | 属正常，需在后台补充理由 |

---

## 四、填写商店信息

按照 [`STORE-LISTING.md`](STORE-LISTING.md) 逐项复制填写。

### 隐私政策 URL（必填）

`PRIVACY.md` 需要有一个**公网可访问的 URL**。三种最省事的方式：

**方式 1：GitHub Gist（最快）**
1. 打开 <https://gist.github.com>
2. 粘贴 `store-assets/PRIVACY.md` 内容，文件名写 `privacy.md`
3. 创建后点 **Raw**，复制那个 URL

**方式 2：GitHub 仓库 + Pages**
1. 新建仓库，放入 `privacy.md`
2. Settings → Pages → 选择分支 → 保存
3. 得到 `https://<用户名>.github.io/<仓库>/privacy.html`
4. 用 `https://htmlpreview.github.io/?<你的 raw 地址>` 也能直接渲染 markdown

**方式 3：飞书文档**
把隐私政策发布成公开飞书文档，用分享链接即可。

> ⚠️ URL 必须能在**无痕窗口**里直接打开，不能要求登录。

---

## 五、提交审核

1. 检查「商店信息完整性」进度条到 100%
2. 点击 **提交审核（Submit for review）**
3. 首次审核通常 **1~3 个工作日**，也有当天通过的
4. 审核期间状态可在后台查看

### 被拒时的处理

后台会给出具体政策条目。常见：

| 拒绝理由 | 应对 |
|---|---|
| `Spam and Abuse` / 单一用途不明 | 详细描述里把用途收窄到一句话，删掉无关功能描述 |
| `Permissions` 权限过宽 | 在权限理由里写清楚每个域名的具体用途（PRIVACY.md 已有对照表） |
| `Trademark` 商标问题 | 改应用名称，去掉平台商标 |
| `Copyright` / 违反第三方 ToS | 这是最难申辩的一类。可尝试申诉说明「仅导出用户本就有权访问的公开字幕，用于无障碍与个人学习」，但成功率不确定 |

---

## 六、后续更新版本

1. 修改 `extension/manifest.json` 的 `version`（如 `0.1.0` → `0.1.1`）
2. 重新打包
3. 后台上传新 zip → 提交审核

> 版本号必须递增，不允许重复上传相同版本。

---

## 附录 A：不上架的内部分发方式

### A1. 开发者模式（最简单，适合自己用）

```
chrome://extensions → 打开「开发者模式」→「加载已解压的扩展程序」→ 选择 extension/ 目录
```

缺点：每次浏览器重启可能提示「停用开发者模式扩展」，且无法自动更新。

### A2. 打包 zip 分发给同事

同事下载解压后，同样用「加载已解压的扩展程序」加载。

### A3. 企业策略强制安装（适合公司内部几十人）

需要：
1. 将 zip 放到内网可访问地址
2. 配置 `ExtensionInstallSources` + `ExtensionSettings` 策略
3. 通过 MDM（如 Jamf）下发

私有的 `.crx` 需要自行签名，且 Chrome 对企业策略安装的扩展会跳过商店审核。

---

## 附录 B：其他商店

| 商店 | 说明 |
|---|---|
| **Edge 加载项**（microsoftedge.microsoft.com） | 支持同一份 MV3 代码，审核相对宽松，可作为 Chrome 的备选分发渠道 |
| **Firefox Add-ons** | 需要适配，MV3 API 差异较大，暂不适用 |

---

## 附录 C：上架前自检清单

- [ ] `manifest.json` 里 version 已递增
- [ ] 图标 16/32/48/128 齐全且清晰
- [ ] 无 `console.log` 泄露调试信息（可选）
- [ ] 无远程脚本加载（MV3 禁止，当前实现无）
- [ ] 隐私政策 URL 可在无痕窗口打开
- [ ] 截图 ≥1 张，尺寸 1280×800 或 640×400
- [ ] 权限理由逐项填写
- [ ] 描述里没有绝对化承诺（如「100% 成功」「支持所有视频」）
- [ ] 已在干净 profile 里完整测试过一次导出
