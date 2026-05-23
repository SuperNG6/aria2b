# v2.1.1

## 概要

v2.1.0 的稳健性补完。修 4 个 bug + 3 个稳定性改进，全部覆盖回归测试（86 → 92），并在 docker-aria2 镜像中跑了真实 BT 场景对抗测试（伪 `-XL/-SD/-XF` peer 注入，验证完整 ban 链路工作）。

## 🐛 Bug 修复

| # | 严重 | 影响 |
|-|-|-|
| **D1** | 🔴 P0 | RPC 绝对超时在 `req.on('response')` 时就清掉，body 下载阶段失去保护。服务器只回 headers 然后 hang 住不发 body（aria2 内部死锁 / 慢速 attack / 中间链路故障）→ cron 永久挂死，SIGTERM 也要等 keep-alive 期满才能 exit |
| **D2** | 🔴 P0 | `processOnePeer` 触发 ban 后没清 `peerState[stateKey]`。ipset 临时故障时 `rememberBlocked` 不调，下次扫描 `wait` 仍 > 阈值会**立刻再次触发 ban**，每次扫描都打"传输了 X piece"+ ipset add 失败日志，日志刷屏 |
| **D3** | 🟡 P1 | `helpText` 中 `process.argv0 === 'node'` 在 shebang 启动时永远为真（包括 `npm i -g aria2b` 后的全局调用），导致 `aria2b -h` 始终显示 "node app.js ..." 而非 "aria2b ..."。改用 `process.argv[1]` 的正则匹配 |
| **D4** | 🟡 P1 | initial 中冗余调用 `ipset save` 两次 + flush 后从旧快照错位 sync 的潜在缓存/ipset 不一致。复用首次 save 快照，`syncBlockedIpsFromIpset` 新增 `allowedSets` 只同步未 flush 的 set |

## 🛡️ 稳定性改进

- **iptables 规则自愈**（[ensureIptablesRule](app.js)）：前次启动如果在 `ipset create` 之后、`iptables -I` 之前被 SIGKILL 打断，`hasIpset` 返回 true → 跳过 flush → 规则永远不会被装上，aria2b 跑得欢快但实际**一个 IP 都拦不住**。新增 `iptables -C` 检测 + 幂等 `-I` 补装；docker alpine 实测：手动删 iptables 规则后重启 aria2b 服务，新版自动补装日志 `已补装 iptables 规则`，旧版规则缺失继续跑空转。
- **信号处理器前移**：`installSignalHandlers()` 移到 `initial()` 的第一个 `await` 之前。启动阶段会 await `ipset save` / `flushIptablesIpset` 等子进程，没有 handler 时 `docker stop` 会用 default SIGTERM 直接 kill 进程，可能让 ipset 处于半初始化状态。
- **`detectIpv6Enabled` 简化**：删掉 `/sys/module/ipv6/parameters/disable` 多源探测过度防御，只看 `/proc/net/if_inet6`（docker alpine 上唯一稳定信号源）。11 行 → 4 行。

## 🧪 工程改进

- 测试数：86 → **92**（+6 条回归覆盖上述每个修复）
  - `test/rpc.test.js`：headers 已到但 body 永不发完 → 绝对超时仍触发
  - `test/cron.test.js`：ban 触发即清 peerState，ipset 故障时不重复刷屏
  - `test/unit.test.js`：`syncBlockedIpsFromIpset` 的 `allowedSets` 过滤
  - `test/iptables.test.js`：`ensureIptablesRule` IPv4/IPv6 路径、幂等性
- 新增 [CLAUDE.md](CLAUDE.md)：项目架构 + **14 条不变量**（每条来自真实事故/PR）
- ESLint 持续保持 0 警告

## ✅ 真实环境对抗测试

在 [SuperNG6/docker-aria2 dev-refactor-20260521](https://github.com/SuperNG6/docker-aria2/tree/dev-refactor-20260521) 镜像中跑 v2.1.0 / v2.1.1 并行对比：

- **ban 路径完整跑通**：伪 `-XL0012-` / `-SD0100-` / `-XF0001-` peer 注入后，aria2b 正确识别为"迅雷在线"/"影音先锋"并 ipset add → iptables DROP（拦截真实生效，从 host 反向访问 RPC 端口都被自家规则拦了）
- **iptables 自愈实测**：手动删 INPUT 链中的 DROP 规则后重启 aria2b 服务，新版补装日志清晰可见，旧版规则丢失继续跑空转
- **长时间稳定**：两版各跑 14 分钟 0 restart，aria2b 进程 PID 不变（v2.1.0 反复重启修复持续有效）
- **SIGTERM 退出时间**：两版皆 ~3.6s，持平

## ⬆️ 升级指南

- npm 用户：`npm i -g aria2b@2.1.1`
- 单文件 bundle：到 releases 下载 `aria2b`，`chmod +x` 后即可运行
- docker-aria2 用户：建议升级；本版主要价值是 docker 极端情况下（启动被 SIGKILL 打断）的 iptables 规则自愈

无破坏性 API 变更。配置与命令行参数 100% 兼容。
