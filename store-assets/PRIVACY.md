# 隐私政策 · 视频字幕导出（Video Subtitle Exporter）

**最后更新：2026 年 11 月 10 日**

## 一句话摘要

本扩展**不收集、不上传、不存储**任何用户数据。所有处理都在你的浏览器本地完成。

---

## 1. 我们不收集任何数据

本扩展不会收集以下任何信息：

- 个人身份信息（姓名、邮箱、账号）
- 浏览历史
- 视频内容或字幕文本
- 使用统计、行为分析、崩溃报告
- 位置信息
- 设备标识符

**本扩展没有任何自建的服务器，不存在"数据回传"的通道。**

## 2. 数据处理方式

| 环节 | 在哪里发生 | 数据去向 |
|---|---|---|
| 读取视频字幕 | 你的浏览器内（页面上下文） | 仅存在于内存 |
| 文本清洗与分段 | 你的浏览器内 | 仅存在于内存 |
| 生成 txt 文件 | 你的浏览器内 | 保存到你指定的本地目录 |

字幕文本**从不离开你的设备**。扩展关闭标签页后，内存中的数据随之释放。

## 3. 扩展发起的网络请求

扩展本身不发起任何对外请求。它在页面内执行的请求，与你正常打开该视频时浏览器发出的请求完全一致，目标仅限：

- `youtube.com`（读取该视频的字幕数据）
- `bilibili.com` / `hdslb.com`（读取该视频的字幕数据）

不存在向任何第三方域名发送数据的代码路径。

## 4. 权限用途说明

| 权限 | 用途 | 说明 |
|---|---|---|
| `scripting` | 在视频页面注入字幕读取逻辑 | 仅在你主动点击导出时执行 |
| `activeTab` | 访问当前标签页 | 仅限你当前操作的那个标签页 |
| `downloads` | 保存导出的 txt 文件 | 仅写入你本地磁盘 |
| `storage` | 保存扩展设置 | 仅存在本地浏览器存储，不同步 |
| `host_permissions`（youtube.com / bilibili.com / hdslb.com） | 读取这两个视频平台的页面与字幕接口 | 不涉及其他任何网站 |

## 5. 第三方服务

本扩展不使用任何第三方分析、广告、错误上报或 CDN 服务。

## 6. 儿童隐私

本扩展不面向 13 岁以下儿童，也不收集任何年龄相关信息（因为不收集任何信息）。

## 7. 数据删除

由于本扩展不存储任何数据，**无需删除操作**。卸载扩展即可完全移除。

## 8. 政策变更

若未来隐私政策发生变更，将在扩展更新说明中明确告知。

## 9. 联系方式

如有疑问，请联系：

- 邮箱：`<在此填写你的联系邮箱>`

---

## English Summary

This extension does **not** collect, transmit, or store any user data. All subtitle extraction and file generation happen locally in your browser. There is no backend server and no analytics. Network requests are made only to `youtube.com` and `bilibili.com` to read the subtitle data of the video you are currently watching — identical to what your browser already does when you open that video.
