# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目定位

aria2b 是为 aria2 自动封禁吸血 BT 客户端（迅雷 / 影音先锋 / 未知客户端等）的守护脚本。**主要部署目标是 docker-aria2（Alpine + s6-overlay + aria2c）容器环境**，需要在无人值守的情况下长期稳定运行。

设计哲学：极简、自包含、零运维。运行时只剩 1 个 npm 依赖（`@huggycn/bittorrent-peerid`），构建产物是单文件 bundle（~50KB），不需要 `node_modules` 即可在 OpenWrt / Docker 上 chmod 后直接跑。

## 常用命令

```bash
npm install                  # 装依赖（开发用）
node app.js                  # 直接运行
npm test                     # node --test 'test/*.test.js'
node --test test/rpc.test.js # 跑单个测试文件
node --test --test-name-pattern='cron:' test/cron.test.js  # 跑单个用例
npm run lint                 # eslint app.js test/ eslint.config.js
npm run check                # node --check app.js（语法检查）
```

发布走 GitHub Actions（`release.yml`，手动 `gh workflow run release.yml -f tag=vX.Y.Z` 或 push tag）。Release 流水线会在 esbuild 打包前用 `sed` 把 `app.js` 里 `'standalone'` 字面量替换成实际版本号，因此**绝不要把 `let VERSION = 'standalone'` 这行改成别的形式**。

## 架构总览

整个项目是**一个单文件**：[app.js](app.js)（~1000 行）。所有逻辑都在这里。测试通过 `module.exports._internal` 暴露内部函数访问。新增任何模块拆分前请先与用户确认 —— 单文件是有意为之的设计约束，bundle 大小 / 自包含分发依赖这一点。

数据流：

```
cron() 主循环（scheduleNext → backoffDelay）
  ├─ aria2.tellActive            拿活跃 gid
  ├─ system.multicall            一次批量拿所有 (tellStatus + getPeers)
  ├─ processOnePeer()            对每个 peer 跑策略
  │     ├─ keywordMatches        block_keywords 命中 → ban
  │     └─ noprogress 状态机      累计上传 > N pieces 且 bitfield=0 累犯 wait 次 → ban
  └─ blockIp() → ipset add       顺序 ban（不并发，避免子进程竞争）
```

状态：
- `blockedIps: Map<ip, expiresAtMs>` — 本进程封禁缓存，避免重复 `ipset add`；启动时由 `syncBlockedIpsFromIpset` 从 `ipset save` 同步
- `peerState: Map<key, {uploaded, wait}>` — noprogress 累犯状态机；key 是 `gid\0peerId\0ip`
- 两个 Map 都有容量上限（`MAX_BLOCKED_IPS=200000` / `MAX_PEER_STATE=50000`），超限时 FIFO 淘汰最老条目

配置合并顺序：`defaultConfig()` → 读 aria2.conf 寄生配置（`ab-*` 开头的键） → CLI 参数覆盖。aria2.conf 路径搜索顺序见 `findAria2Config()`。

## 关键不变量（修改时必须保留）

这些是从历史事故里学来的不变量，每条都有具体的 bug 历史。改动相关代码时务必保留语义：

1. **`scanTimer` 绝不能 `.unref()`**（[app.js:676-684](app.js#L676-L684)）。Node 的 `http.Agent` keep-alive socket 自带 unref，如果再把扫描定时器也 unref，cron 跑完事件循环就静默 `exit(0)`，s6/systemd 看起来像"反复重启"，peerState 一并被清零导致吸血 peer 永远封不上。SIGTERM 处理器有显式 `clearTimeout(scanTimer)` + `process.exit(0)`，不需要 unref 来辅助退出。

2. **`isLocalHttpsRpcUrl` 必须用 `net.isIPv4` + `127/8` 判断**（[app.js:206-221](app.js#L206-L221)），不能 `host.startsWith('127.')` —— 否则 `127.0.0.1.evil.com` 这种子域可以让 TLS 校验被默认关闭。

3. **`keywordMatches` 显式跳过 `'unknown'` 关键字**（[app.js:165-172](app.js#L165-L172)）。未知客户端的 ban 路径必须由 `hasUnknownKeyword(...) + c.client === 'unknown'` 显式接管（见 [app.js:562-567](app.js#L562-L567) 和 [app.js:602-606](app.js#L602-L606)）。否则 `block_keywords` 里写 `Unknown` 只是装饰。

4. **`parsePositiveInteger` 显式拒绝 `boolean`**（[app.js:144-150](app.js#L144-L150)）。CLI 解析 `--key`（不带值）会得到 `true`，`Number(true)=1` 会被静默写入正整数字段。

5. **`parseArgv` 不做类型转换，value 始终是 string 或 `true`**（[app.js:774-808](app.js#L774-L808)）。`--secret 001234` 必须保留前导 0；`--rpc-url 1234` 不应被改型。数字字段在 `applyCliConfig` 里各自显式 `Number()`。

6. **RPC 超时用外层 `setTimeout` 包整个请求**（[app.js:401-411](app.js#L401-L411)），不能只用 `req.setTimeout` —— 那只在 socket 分配后才生效，connect 阶段卡住时会被 TCP 内核默认 ~2 分钟超时拖死。

7. **`httpJsonPost` 3xx 必须当错误抛**（[app.js:380-384](app.js#L380-L384)），不能静默把 `data` 当 `undefined` —— 否则 cron 会把异常空响应当成"无活跃任务"。

8. **错误日志必须经 `sanitizeError`**（[app.js:240-258](app.js#L240-L258)）。请求体里有 `token:secret`，容器日志常被采集，泄漏 secret 是 P0。

9. **cron 部分失败时不能清 `peerState`**（[app.js:662-667](app.js#L662-L667)），只有 `fullySucceeded` 才调 `cleanupPeerState`。部分失败时活跃集合不完整，全清会把 noprogress 累计计数白白重置。

10. **`ipset add` 用 `-exist`**（[app.js:539](app.js#L539)），让重复添加刷新 timeout，本地缓存与 ipset 时钟保持一致。

11. **`processOnePeer` 进入 `banQueue` 即清 `peerState[stateKey]`**（[app.js:609-614](app.js#L609-L614)）。否则 `blockIp` 失败（ipset 临时故障）时 `rememberBlocked` 不会被调用，下次扫描 `wait` 仍 > 阈值会立刻再次触发 ban，每次扫描重复打"传输了 X piece"+"ipset add 失败"。清 state 给重试一个 `noprogress_wait` 次的回退窗口。

12. **RPC 绝对超时必须覆盖到 body 收完**（[app.js:402-417](app.js#L402-L417)），不能在 `req.on('response')` 就清 timer。服务器可能只回 headers 然后 hang 住不发 body（aria2 内部死锁 / 慢速攻击 / 中间链路故障），那样 cron 会永久挂死。只在 `req.on('close')` / `req.on('error')` 清。

13. **`installSignalHandlers` 必须在 `initial()` 的第一个 `await` 之前装好**（[app.js:914-919](app.js#L914-L919)）。启动阶段会 await `ipset save` / `flushIptablesIpset` 等子进程，没有 handler 时 docker stop 会用 default SIGTERM 直接 kill 进程，可能让 ipset 处于半初始化状态（destroy 完成但 create 未跑）。`stop()` 引用的 `scanTimer` / `rpcClient` / `cronInflight` 都是 null-safe，可以提前装。

14. **iptables 规则自愈：set 存在时仍要 `ensureIptablesRule()`**（[app.js:502-518](app.js#L502-L518)）。前次启动如果在 `ipset create` 之后、`iptables -I` 之前被 SIGKILL 打断，`hasIpset` 返回 true → 跳过 flush → 规则永远不会被装上，aria2b 跑得欢快但实际一个 IP 都拦不住。`iptables -C` 检查规则在不在，不在则幂等 `-I` 补装。`-C` 是 docker alpine 上的标准选项。

15. **启动阶段环境不可用时必须进 `runIdleMode()`，绝不 `process.exit(1)`**（[app.js:642-678](app.js#L642-L678)）。aria2b 在 docker-aria2 镜像里是 s6-overlay v2 的一个 service，进程退出会触发 s6 默认策略"无限重启" —— 每 1-2 秒拉起一次。如果环境本身不兼容（群晖 DSM 4.x 内核 + iptables-nft、缺 NET_ADMIN、ipset 二进制缺失、未捕获异常），exit 会把日志淹没、占满 fork 配额、拖慢同容器里的 aria2c。`runIdleMode` 用一个 refed `setInterval`（1h 心跳，**不**能 unref，否则进程会因无 refed handle 静默 exit 重蹈第 1 条覆辙）让事件循环保活、每小时打一次修复提示；同时清掉 `scanTimer` + destroy `rpcClient` 停止 cron 调度。相关入口：IPv4 后端探测失败 / ipset save 失败 / `initial()` 兜底 catch / uncaughtException / unhandledRejection。`scheduleNext` 也要看 `idleHeartbeat` 跳过装回 timer。SIGTERM/SIGINT 处理器要 `clearInterval(idleHeartbeat)` 后正常 exit(0)。

16. **iptables 后端探测优先级：默认 → legacy，不自动 apk add**（[app.js:538-571](app.js#L538-L571)）。Alpine 3.13+ 的 `iptables` 包默认指向 nft 后端；群晖 DSM 4.x 内核上 nft 子系统初始化即失败（`Could not fetch rule set generation id`）。`pickIptablesBackendForVersion()` 先用 `bin -L INPUT -n` 作为最小探针（不依赖 ipset/任何扩展模块，且 `-n` 跳过反向 DNS 防容器无 DNS 时阻塞 30s+）探测默认；失败再探 `iptables-legacy`。结果写入全局 `iptablesBinaries.v4/v6`，后续 `flushIptablesIpset` / `ensureIptablesRule` 都读这个 map。设计选择：**不在 aria2b 里自动 `apk add iptables-legacy`** —— 违反零运维原则（需要网络 + root + 增加启动延迟），只让用户在 Dockerfile 里装好，aria2b 自己探测切换。

17. **IPv6 setup 失败必须软降级，绝不让 IPv4 跟着挂**（[app.js:1130-1156](app.js#L1130-L1156)）。群晖 DSM 4.4 内核环境下 `ip6tables -m set` 即便切到 legacy 也可能因 xt_set 模块对 IPv6 路径残缺而失败。v2.1 之前 v6 抛错让进程 exit，s6 重启第二轮 IPv4 才幸运通过 —— 这是 v1.x"误打误撞跑成"的 race 路径，v2.1 加 `ensureIptablesRule` 自愈反而把这个 race 关死了。现在：v6 探测失败 → `config.ipv6=false`；v6 flush/ensure 抛错 → catch + `config.ipv6=false`。降级信号统一通过 `config.ipv6` 传给下游（`blockIp` / `syncBlockedIpsFromIpset` / cron 都读它）。已被 flush 但中途失败的 v6 set 不能 sync（`v6Flushed=false` 后续 syncTargets 跳过），否则缓存说"已封"但 ipset 已空 → cron `isBlocked=true` 跳过 peer → 永远拦不住。

## 测试约定

- 用 `node:test` + `node:assert/strict`，不用第三方框架（保持依赖最少）
- [test/cron.test.js](test/cron.test.js) 通过 `http.createServer` 起 mock aria2 RPC + monkey-patch `runtime.execFile` spy 来端到端验证主循环
- [test/rpc.test.js](test/rpc.test.js) 直接测 `httpJsonPost`：4xx/3xx/5xx、ECONNREFUSED、绝对超时、JSON 解析失败、64MB body 上限、keep-alive 复用、自签 TLS、`destroy()` 中断 in-flight
- 上面列的每个"关键不变量"都有对应回归测试，改相关代码必须先看测试再动
- `_internal._reset()` 在测试 setup 里调用，重置全局 config / blockedIps / peerState

## 环境与运行依赖

- **Node.js ≥ 22**（package.json engines: `>=22 <25`）。CI 矩阵覆盖 22 / 24
- 系统依赖：`ipset` `iptables`（以及 IPv6 的 `ip6tables`）。Docker 内需要 `NET_ADMIN` capability，**不**用 `--privileged`
- IPv6 由 `detectIpv6Enabled()` 自动探测 `/sys/module/ipv6/parameters/disable` / `/proc/net/if_inet6`；aria2.conf 里 `disable-ipv6=true` 时跟随关闭
- 环境变量：`DEV=1` 打 debug 日志；`HIDE_TIME_PREFIX=1` 让日志不带时间前缀（s6/journalctl 外部 logger 已经加时间）
