# v2.1.0

## ⚠️ 强烈建议从 v2.0.0 升级

v2.0.0 在 Docker / s6 / systemd 等进程管理器下会被**反复重启**（每 ~10 秒一次），导致 noprogress 状态机被持续清零、吸血 peer 永远封不上。本次发版修复了该问题以及多个 P0 级别的逻辑/安全 bug。

## 🐛 Bug 修复

| # | 严重 | 影响 |
|-|-|-|
| **B1** | 🔴 P0 | `scanTimer.unref()` 让事件循环在 cron 跑完后判定空闲，进程静默 `exit(0)` → s6/systemd 反复拉起。peerState 也跟着被清，吸血 peer 永封不上 |
| **B2** | 🔴 P0 | `block_keywords` 含 `Unknown` 时不会真正屏蔽未知客户端 —— `keywordMatches` 显式跳过 `Unknown`，未知客户端只能走 noprogress 通道 |
| **B3** | 🔴 P0 | `isLocalHttpsRpcUrl` 的 `host.startsWith('127.')` 允许 `https://127.0.0.1.evil.com/jsonrpc` 绕过 → TLS 校验被默认关闭 |
| **B4** | 🟡 P1 | `_coerceNumeric` 在 CLI 解析阶段把全数字字符串转 `Number`，`--secret 001234` 丢失前导 0；`--rpc-url 1234` 也被改型 |
| **B5** | 🟡 P1 | `--noprogress-wait`（不带值）被解析为 `true` → `Number(true) = 1` → `parsePositiveInteger` 接受 → 静默写入 1 |
| **C1** | 🟡 P1 | RPC 超时仅在 socket 分配后生效，connect 阶段卡住时会被 TCP 内核默认 ~2 分钟超时拖死，30s timeout 形同虚设 |
| **C2** | 🟡 P1 | HTTP 3xx 被当成成功，`data` 解析为 `undefined`，cron 把 `tellActive` 当作空数组 → 静默扫了个寂寞 |
| **C3** | 🟢 P2 | SIGTERM 时不主动 destroy rpcClient，遇到 in-flight RPC 要等最长 30s 才能 exit。容器关停慢 |

## 🚀 重大重构

- **完全移除 axios** —— 改用 60 行 Node 原生 `http/https.request` 封装，维持 `client.post(url, body) → { data, status, statusText }` 同形 API（历史测试 0 改动通过）。运行时依赖从 axios + 27 个传递依赖 → 仅剩 `@huggycn/bittorrent-peerid` 1 个。
- **Bundle 体积：519.8KB → 50.0KB（10× 缩减）**
- 关停延迟：SIGTERM → exit 从最长 30s 降到毫秒级

## 🧪 工程改进

- 新增 ESLint（`npm run lint`）并接入 CI / Release 流程
- 测试数：38 → **86**
  - 新增 `test/rpc.test.js`（17 用例）：HTTP 4xx/3xx/5xx、ECONNREFUSED、绝对超时、JSON 解析失败、64MB body 上限、keep-alive 复用、自签 TLS 实测、`destroy()` 中断 in-flight 请求
  - 新增 `test/iptables.test.js`（10 用例）：IPv6 路径（`ip6tables` / `bt_blacklist6` / `family inet6`）、首次启动 destroy 失败吞错、ipset add 失败不污染本地缓存
  - 新增 `test/parseargv.test.js`（17 用例）：CLI 形态全覆盖 + B4/B5 回归
- `release.yml`：`esbuild` 改走 devDependencies + `npm ci` 缓存，省 5-10s
- `release.yml`：使用 `RELEASE_NOTES.md` 作为 release body（不再依赖 auto-generated notes）

## ⬆️ 升级指南

- npm 用户：`npm i -g aria2b@2.1.0`
- 单文件 bundle：到 [releases](https://github.com/makeding/aria2b/releases/tag/v2.1.0) 下载 `aria2b`，`chmod +x` 后即可运行
- Docker 用户：建议立刻升级，v2.0.0 的反复重启会让 noprogress 永远封不上吸血 peer

无破坏性 API 变更。配置与命令行参数 100% 兼容。
