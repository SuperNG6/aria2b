# v2.1.2

## 概要

**纯 CI/Release workflow 维护**，无代码逻辑变更，无新功能、无 bug 修复。`app.js` 与上一版字节一致；测试覆盖、运行时行为、配置兼容性 100% 保持。

## 🔧 改动

- 升级 GitHub Actions 依赖：
  - `actions/checkout@v4` → `@v6`（CI + Release workflow，共 2 处）
  - `actions/setup-node@v4` → `@v6`（CI + Release workflow，共 2 处）

## 🔍 升级原因

v4 用的 Node.js 20 runner，[GitHub 公告](https://github.blog/changelog/2025-09-19-deprecation-of-node-20-on-github-actions-runners/)：

- 2026-06-16 起 runners 默认切到 Node 24
- 2026-09-16 起 Node 20 从 runner 中彻底移除

`@v6` 原生支持 Node 24，提前升级避免 CI 在过渡期出现 deprecation 警告或被强制切换。

## ⬆️ 升级指南

- npm 用户：`npm i -g aria2b@2.1.2`
- 单文件 bundle：到 releases 下载 `aria2b`，`chmod +x` 后即可运行
- 本版本对最终用户无任何运行时差异；只有需要从源码 build 或 fork 后跑 CI 的开发者可能受益

无破坏性 API 变更。
