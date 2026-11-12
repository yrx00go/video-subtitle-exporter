# 上架材料清单

> 本目录下的文件已全部准备好，可直接用于 Chrome Web Store 提交。

## 文件说明

| 文件 | 用途 | 怎么用 |
|---|---|---|
| `../dist/subtitle-exporter-v0.1.0.zip` | 上传包 | 开发者后台「新增项目」直接上传 |
| `icon-512.png` | 商店图标 | 后台图标位（可选，主图标从 manifest 读） |
| `screenshot-1.png` / `screenshot-2.png` | 商店截图 | 1280×800，符合要求 |
| `PRIVACY.md` | 隐私政策 | 需托管成公网 URL 后填入后台 |
| `STORE-LISTING.md` | 商店文案 | 逐字段复制到后台表单 |
| `PUBLISH.md` | 发布操作手册 | 按步骤执行 |

## 最短路径

```
1. 注册开发者账号            $5，一次性
   https://chrome.google.com/webstore/devconsole

2. 上传 zip
   dist/subtitle-exporter-v0.1.0.zip

3. 填商店信息
   文案见 STORE-LISTING.md
   截图用 screenshot-1.png

4. 填隐私政策 URL
   把 PRIVACY.md 贴到 GitHub Gist，取 Raw 链接

5. 提交审核
   通常 1~3 个工作日
```

## 截图预览

`screenshot-1.png`：B 站视频页，右下角可见蓝色「导出字幕」按钮，1280×800。

---

## 三个提醒

**1. 先想清楚是否真要上架**

这类扩展在商店有过因「违反第三方平台 ToS」被下架的先例。
如果只是自己和小团队用，用开发者模式加载或企业分发更省事（见 `PUBLISH.md` 附录 A）。

**2. 名称别带商标**

当前名称「视频字幕导出」是安全的。如果改成含 "YouTube" 的名字，
商标政策是常见拒审理由。

**3. 描述别说满**

避免「支持所有视频」「100% 导出成功」这类表述——
硬字幕视频确实导不出，功能描述要留有余地。
