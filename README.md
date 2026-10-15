# Doubao Desktop Studio

一个本地优先、跨平台的豆包账号工作台。每个账号使用独立的 Electron `persist:` Partition，Cookie、LocalStorage、缓存和登录状态不会互相混用。

## 当前能力

- 独立账号空间与持久化登录
- 登录后自动确认明确 UID，登录失效时更新账号状态，并阻止重复添加同一账号
- 账号本地备注修改、活动窗口状态和最后确认时间
- 关闭窗口后保留登录状态，账号不会长期占用渲染进程
- 缓存清理不清除登录状态
- 本地 SQLite 账号元数据、任务和设置
- 视频任务保存、提示词复制和指定账号辅助执行
- 应用内存、进程数和活动账号窗口监控
- 可在设置页迁移本地数据目录，账号登录状态、数据库和设置会一起迁移
- 本地滚动诊断日志与脱敏诊断报告导出
- Worker 上限固定在 1–3，默认 2
- Windows x64 与 macOS x64/arm64 构建配置

当前版本不会自动注册账号、处理验证码、导入密码或规避平台限制。请仅使用本人拥有或获授权的账号，并遵守平台规则。

## 技术栈

- Electron 44
- Vue 3 + TypeScript + Vite
- Electron/Node 内置 `node:sqlite`
- electron-builder

采用内置 SQLite，避免 `better-sqlite3` 等原生扩展带来的 Windows/macOS 多架构打包问题。

## 开发

要求 Node.js 24 或更高版本。

```bash
npm install
npm run dev
```

验证：

```bash
npm test
npm run typecheck
npm run build
```

打包：

```bash
npm run dist:win
npm run dist:mac
```

本地构建产物统一放在 `release/current/`。每次打包前会自动清理该目录，打包完成后只保留当前版本的安装包、压缩包和 `SHA256SUMS.txt`；历史版本由 GitHub Releases 保存。

macOS 安装包必须在 macOS 上生成；正式分发前还需要配置 Apple Developer ID、公证，以及 Windows 代码签名。

## 数据与安全

- 应用数据默认放在 Electron 的 `userData` 目录，界面设置页会显示实际路径，也可选择其他磁盘位置。
- 更改目录会在应用重启时复制完整数据，并保留旧目录作为备份；确认新目录正常后可手动删除旧目录。
- Cookie 仅由相应账号 Partition 管理，不写入 SQLite，不通过 IPC 返回给界面。
- 豆包远程页面启用 Chromium sandbox、关闭 Node Integration，并拒绝弹窗和非豆包顶层导航。
- 当前没有本地 HTTP API，控制台只通过最小化的 Electron IPC 调用主进程。
- 删除账号会清除对应 Partition 的本机浏览器数据；任务记录保留但解除账号关联。

## 路线

1. 在 Windows 与 macOS 验证扫码登录、UID 读取和登录持久化。
2. 增加豆包页面适配器，先完成单账号文生视频提交、状态跟踪和下载。
3. 在真实页面压测后启用 1–3 个 Worker 的自动调度。
4. 如确有需求，再提供可选的 Playwright 或外部 CDP/指纹浏览器运行时。

本项目为非官方工具，与豆包或字节跳动无隶属、授权或合作关系。
