# AGENTS.md

本文件给在本仓库工作的编码 agent 提供上下文。代码位置一律用函数名 / 常量名指代，不写行号（行号会随改动失效，用 grep 定位）。

## 项目定位

aria2b 是 aria2 的守护脚本：周期性通过 aria2 JSON-RPC 检查 BT peer，命中策略（迅雷 / 影音先锋 / 未知客户端等吸血客户端）后用 ipset + iptables 封禁 IP。

**主要部署目标是 docker-aria2（Alpine + s6-overlay v2 + aria2c）**，aria2b 是同容器里的一个 s6 service，需要无人值守长期运行。设计哲学：极简、自包含、零运维。生产运行零 npm 依赖，发布物是 esbuild 打出的单文件 bundle，`chmod +x` 后只需 Node.js 即可运行。

## 仓库与分发

- 本仓库 `SuperNG6/aria2b` 是上游 `makeding/aria2b` 的维护分支，v2.x 只在这里发布。
- npm 上的 `aria2b` 包归上游维护者所有，停留在 v1.0.9；本仓库**无法**发布 npm，release.yml 也没有 `npm publish`。README 推荐 release 单文件或 release 附带的 tgz，不要改回 `npm i -g aria2b`。
- 仓库未开启 issues。

## 常用命令

```bash
npm ci                       # 安装开发依赖（esbuild / eslint / globals）
node app.js                  # 直接运行
npm test                     # node --test 'test/*.test.js'
node --test test/rpc.test.js # 单个测试文件
node --test --test-name-pattern='cron:' test/cron.test.js  # 单个用例
npm run lint                 # eslint app.js test/ eslint.config.js
npm run check                # node --check app.js
```

改动完成前至少跑 check、lint 和全部测试。CI 矩阵是 Node 22 / 24，两个版本都要通过。

## 发布流程

1. 版本号改三处：`package.json` 和 `npm-shrinkwrap.json`（顶层 `version` 与 `packages[""].version`）。
2. `RELEASE_NOTES.md` 顶部新增 `# vX.Y.Z` 段落。release.yml 用 awk 截取这一段作为 release 正文，**缺段会让发布失败**。
3. README 顶部版本摘要加一条 `> **vX.Y.Z**：...`。
4. 推 tag `vX.Y.Z`，或 `gh workflow run release.yml -f tag=vX.Y.Z`。tag 必须与 package.json 版本一致。推 tag / 发 release 属于对外操作，先征得用户确认。

release.yml 在打包前用 `sed` 把 `let VERSION = 'standalone'` 替换成实际版本号，**这一行的写法绝不能改**。打包后会在没有 node_modules 的目录里自检 `-v` / `-h`，并附带 `npm pack` 生成的 tgz 和 sha256。

## 架构

整个项目是**一个单文件** [app.js](app.js)，这是有意的设计约束（自包含分发依赖这一点），拆模块前先与用户确认。测试通过 `module.exports._internal` 访问内部函数。

文件分区（按 `// ====` 注释分隔）：

- **BitTorrent peerId 识别**：`getPeerName` 及其客户端表，派生自 `@huggycn/bittorrent-peerid@1.3.4`（保留 MIT 版权声明）。aria2b 依赖其 fork 增加的 `origin` 字段（如 `XL`、`SD`）做关键词匹配。这段保持上游风格（2 空格缩进），除非修 bug 不要重排。
- **配置 / 状态**：`defaultConfig()`、全局 `config` / `blockedIps` / `peerState`，以及测试可替换的 `runtime.execFile`。
- **logger**：`honsole`。`logt` 带 `YYYY/MM/DD HH:mm:ss` 本地时间前缀，`HIDE_TIME_PREFIX=1` 时去掉；`dev` 只在 `DEV=1` 时输出。
- **RPC**：`httpJsonPost`（Node 原生 http/https，返回 axios 风格的 `{ data, status, statusText }`）、`makeRpcClient`（keep-alive Agent）、`rpcPost`（把 aria2 错误还原成可读信息）、`rpcCall`、`rpcMulticall`。
- **ipset / iptables**：`pickIptablesBackendForVersion`、`flushIptablesIpset`、`ensureIptablesRule`、`blockIp`、`readIpsetSave`、`syncBlockedIpsFromIpset`、`runIdleMode`。
- **扫描**：`cron`、`processOnePeer`、`scheduleNext`、`runLoop`、`backoffDelay`。
- **配置加载 / CLI**：`loadConfigFromAria2File`、`findAria2Config`、`parseArgv`、`applyCliConfig`、`helpText`。
- **入口**：`installSignalHandlers`、`initial`。

主循环数据流：

```
runLoop → cron() → scheduleNext（成功按 scan_interval，失败指数退避，上限 60s）
  ├─ aria2.tellActive            拿活跃 gid
  ├─ system.multicall            一次批量拿所有 (tellStatus + getPeers)
  ├─ processOnePeer()            对每个 peer 跑策略
  │     ├─ block_keywords 命中 origin（或配置了 Unknown 且客户端未知）→ 封禁
  │     └─ noprogress 状态机：监控客户端、上传 >1KiB/s、bitfield 全 0，
  │        累计上传 > noprogress_piece 个分片后，对方下载速度为 0 的扫描次数 > noprogress_wait → 封禁
  └─ blockIp() → ipset add       顺序执行（不并发，避免子进程竞争）
```

状态：

- `blockedIps: Map<ip, expiresAtMs>`：本进程封禁缓存，避免重复 `ipset add`；启动时从 `ipset save` 同步。
- `peerState: Map<key, {uploaded, wait}>`：noprogress 状态机，key 是 `gid\0peerId\0ip`。
- 两个 Map 都有容量上限（`MAX_BLOCKED_IPS` / `MAX_PEER_STATE`），超限时淘汰最早插入的条目。

`processOnePeer` 开头会跳过三类 peer：已在 `blockedIps` 里的、IPv6 关闭时的 IPv6 peer、本机 / 私有地址（`isProtectedIp`）。

配置合并顺序：`defaultConfig()` → `detectIpv6Enabled()` → aria2.conf 寄生配置（`rpc-secret` / `rpc-listen-port` / `rpc-secure` / `disable-ipv6` 和 `ab-*` 键）→ CLI 参数覆盖。未指定 `-c` 时按 `findAria2Config()` 的顺序搜索配置文件。

## 关键不变量（修改相关代码时必须保留）

每条都来自真实事故，绝大多数有回归测试。改相关代码前先读对应测试。

### 进程存活

1. **`scanTimer` 绝不能 `.unref()`**（`scheduleNext`）。`http.Agent` 的 keep-alive 空闲 socket 本身是 unref 的，再 unref 扫描定时器的话，cron 跑完后进程会静默 `exit(0)`，s6 不断拉起，`peerState` 每次清零，吸血 peer 永远封不上。
2. **启动阶段环境不可用时进 `runIdleMode()`，绝不 `process.exit`**。进程退出会让 s6-overlay v2 每 1–2 秒重启一次，淹没日志并拖慢同容器的 aria2c。
   - 入口：显式 `-c` 配置文件不可用、`ipset save` 失败、IPv4 iptables 后端不可用、IPv4 flush/ensure 失败、`initial()` 兜底 catch、`uncaughtException` / `unhandledRejection`。
   - `runIdleMode` 会清掉 `scanTimer`、销毁 `rpcClient`，并装一个 1 小时间隔的 refed `setInterval`（**不能** unref，理由同第 1 条）；`scheduleNext` 发现 `idleHeartbeat` 存在时不再调度。
   - 例外：`--flush` 是手动执行的一次性命令，失败时 `exit(1)`。
   - `runIdleMode(reason, fix)` 的日志固定四行：已暂停扫描并保持进程运行 / 原因 / aria2c 不受影响 / 处理。`fix` 由调用方按实际原因给出（缺包、缺 NET_ADMIN、配置文件路径、程序错误各不相同），不能一律提示安装 iptables-legacy。
3. **`installSignalHandlers()` 必须在 `initial()` 的第一个 `await` 之前调用**。否则 docker stop 可能在 `ipset destroy` 之后、`create` 之前杀掉进程。`stop()` 会清 `scanTimer` / `idleHeartbeat`、销毁 `rpcClient`，等当前 cron 结束后 `exit(0)`。

### RPC

4. **`httpJsonPost` 的超时是外层 `setTimeout` 绝对超时**，覆盖 connect、headers、body 全过程，只在 `req` 的 `close` / `error` 时清除。不能只用 `req.setTimeout`（connect 阶段不生效），也不能在收到 `response` 时就清（服务器只发 headers 不发 body 时 cron 会永久挂死）。
5. **HTTP 3xx 必须当错误抛出**。否则空响应会被当成"无活跃任务"。同理，`tellActive` 结果不是数组时也按失败处理，不能当成没有任务。
6. **错误日志一律经过 `sanitizeError`**。请求体里有 `token:secret`，容器日志常被采集，泄漏 secret 是 P0。
7. **`isLocalHttpsRpcUrl` 用 `net.isIPv4` + `127.` 前缀判断**，不能直接对 hostname 做 `startsWith('127.')`，否则 `127.0.0.1.evil.com` 会让 TLS 校验被默认关闭。
8. **IPv6 字面量 RPC 地址要去掉方括号再传给 `request` 的 `hostname`**（`http://[::1]:6800/jsonrpc`）。
9. **aria2 用 HTTP 400 返回 RPC 错误**（错误在 JSON 响应体的 `error` 里，例如 secret 不对时是 `Unauthorized`）。`httpJsonPost` 把 3xx 及以上响应里的 JSON 附在 `e.response.data`，`rpcPost` 再还原成 aria2 的错误信息；不能退回到只记 `HTTP 400 Bad Request`。

### 扫描状态机

10. **只有 `fullySucceeded` 时才调用 `cleanupPeerState`**。RPC 失败、multicall 结果长度不符、子调用失败（aria2 返回 `{ code, message }` 而不是 `[result]`）或结果形态异常，都算部分失败：跳过对应 gid，保留累计状态。
11. **`processOnePeer` 把 peer 放进 `banQueue` 时立即删除它的 `peerState`**。否则 `blockIp` 失败（ipset 临时故障）时，下一轮 `wait` 仍超过阈值，每轮都会重复触发封禁和失败日志。
12. **`keywordMatches` 显式跳过 `unknown` 关键字**。未知客户端只能通过 `hasUnknownKeyword(...) && c.client === 'unknown'` 命中，block 和 noprogress 两条路径都是这样。
13. **关键词只与 `origin` 比对，所以表外的 Az 格式 peerId 也要有 `origin`**。`detectPeerClient` 对内置表没有的 `-XX....-` 代码补上两字母 `origin`，`client` 仍是 `unknown`。否则默认关键词 `BN` 和用户自加的表外代码永远不生效。
14. **`pieceLength` 不可知（0 或缺失）时跳过 noprogress 判定**。旧版兜底为 1，等于按字节计算，几个字节就会误封。
15. **cron 的封禁循环里，同一 IP 只有在成功封禁后才跳过**（`isBlocked` 检查）；失败的 IP 仍允许同一轮的后续条目重试。
16. **IPv6 关闭时 `processOnePeer` 直接跳过 IPv6 peer**。`blockIp` 不会封它们，继续跑无进度判定只会反复打出没有生效的封禁日志。

### 防火墙

17. **aria2b 只管理 `bt_blacklist` / `bt_blacklist6` 两个 set 和引用它们的 INPUT DROP 规则**。不 flush 全局表，不改 Docker 链，不改默认策略。
18. **`ipset add` 必须带 `-exist`**，重复添加时刷新 timeout，让本地缓存与 ipset 的时钟一致。
19. **set 已存在时仍要调用 `ensureIptablesRule()`**（先 `-C` 检查，缺失再 `-I`）。上次启动若在 `ipset create` 之后、`iptables -I` 之前被 SIGKILL，规则会永远缺失，aria2b 正常运行却一个 IP 都拦不住。
20. **iptables 后端探测顺序：默认二进制 → `-legacy`，不自动 `apk add`**。
    - 探针是 `bin -L INPUT -n`：不依赖扩展模块；`-n` 避免容器无 DNS 时阻塞。
    - 探测结果写入 `iptablesBinaries.v4/v6`，后续所有 iptables 调用都从这里读取。
    - 安装提示统一写 `apk add --no-cache iptables iptables-legacy ipset nodejs`。Alpine 3.23 的 `iptables-legacy` 包已包含 `ip6tables-legacy`，不存在单独的 `ip6tables-legacy` 包。
    - `pickIptablesBackendForVersion` 只返回结果不打日志；切换到 legacy 是能正常运行的情况，由 `reportBackendSwitch` 按防火墙类型打一行普通提示（"检测到当前内核不支持 nft 防火墙后端，已切换到 …"），不打警告或报错。不专门识别群晖等具体系统。
21. **IPv6 初始化失败只降级 IPv6，不影响 IPv4**。探测失败或 flush/ensure 抛错时设 `config.ipv6 = false`，下游都读这个值。`reportIpv6Unavailable` 负责提示：内核不支持（用户无法改变、也不影响运行）只打普通日志；只有确实缺软件包时才用警告并给出修复方法。刚 flush 过、或初始化失败的 set 不能从启动快照同步（`v4Flushed` / `v6Flushed` 控制），否则缓存显示"已封"而 ipset 实际为空，这些 peer 永远拦不住。
22. **启动读取 `ipset save` 必须走 `readIpsetSave()`，并保留 32MB `maxBuffer`**。host 网络模式下能看到宿主机的全部 ipset，Node 默认 1MB buffer 会让 aria2b 误进暂停状态。
23. **新建 set 带 `maxelem MAX_BLOCKED_IPS`**，与本地缓存上限一致（ipset 默认 65536）。已存在的 set 不会重建，只有 `--flush` 才会用上新参数。
24. **iptables / ipset 的失败要先归类再提示**（`classifyFirewallError`）：权限 → 提示 NET_ADMIN；nft 不支持且没装 legacy → 提示安装；内核缺 xt_set → 说明容器内无法修复。**必须先判断权限**：缺 NET_ADMIN 时 nft 后端同样报 `Could not fetch rule set generation id`，误判成 nft 会让用户去装已经没用的包。子进程错误经 `sanitizeError`（`summarizeCommandError`）压成一行，原始多行 stderr 只在 `DEV=1` 时输出。
25. **封禁时长不能超过 `MAX_TIMEOUT_SECONDS`（2147483，ipset 上限）**。`applyCliConfig` 在配置文件和 CLI 合并完之后夹到上限并警告；超出时 `ipset create` 会失败并误进暂停状态，`ipset add` 则每次都失败。

### 配置 / CLI

26. **`parseArgv` 不做类型转换**，值只会是字符串或 `true`。`--secret 001234` 必须保留前导 0；数字字段在 `applyCliConfig` 里通过 `applyPositiveIntegerConfig` 各自转换。
27. **不带值的参数（值为 `true`）不能写进配置**：`parsePositiveInteger` 拒绝 boolean（`Number(true) === 1`）；字符串参数经 `cliString` 忽略并警告（否则 secret 会变成 `"true"`）；`-c` 不带路径按"路径为空"处理。
28. **aria2.conf 的 `disable-ipv6` 只能关闭 IPv6**，不能覆盖 `detectIpv6Enabled()` 的结果去强制开启。`disable-ipv6=false` 是 aria2 的默认值。
29. **显式 `-c` 指定的配置文件不可用时进入暂停状态**（`--flush` 时 exit 1），不回落到默认 RPC 配置继续运行。
30. **寄生配置不支持行尾 `#` 注释**（`parseConfigLine` 只跳过整行注释），README 已说明。
31. **默认关键词名单有四处要同步**：`defaultConfig()` 的 `block_keywords` / `noprogress_keywords`（后者 = 前者 + `Unknown`）、README 配置表、README「blocklist 参考」表、[test/config.test.js](test/config.test.js) 的断言。unit.test.js 里有回归测试，检查每个默认代码都能命中、不误伤常见正常客户端。名单参考 qBittorrent-Enhanced-Edition 的 `peer_blacklist.hpp` 和 PeerBanHelper 的 `profile.yml`，只取 peer-id 规则，因为 aria2 RPC 拿不到客户端名称。以下几项不要加入默认名单：
    - `TT`：`keywordMatches` 是子串匹配，会命中 `HTTP Seed`。
    - `LT1220` / `LT2070`：参考项目要配合 GeoIP 才封，直接加会误封正常的 libtorrent 客户端。
    - `RN`：只想封 Rain 的 `0.0.0` 默认版本号，写成 `RN` 会把所有 Rain 客户端都封掉。

### 封禁范围

32. **本机 / 私有地址永不封禁**（`isProtectedIp`）：回环、RFC1918 私网、`169.254/16`、IPv6 `::1` / `fc00::/7` / `fe80::/10`，以及内嵌这些地址的 IPv4 映射地址。`processOnePeer` 直接跳过（不进状态机、不打日志），`blockIp` 再兜底一次。**不含 `100.64.0.0/10`**：同一运营商内的真实 peer 会以运营商级 NAT 地址出现。启动时从 ipset 同步缓存不做这层过滤。

## 审查与评估须知

审查代码、评估问题严重程度时，先对照下面的实际情况，**不要只凭读代码推断后果**。2026-11 的一次审查里，13 条"问题"经实测只有少数成立，其余是脱离实际部署的想象。拿不准的先实测或查 aria2 源码，没验证过的要明说"未验证"。

### 实际部署（docker-aria2）

- 启动命令是 `aria2b -c /config/aria2.conf -u <本地 rpc url> -s "$SECRET"`；`aria2.conf` 默认不写 `rpc-secret`，secret 只来自 `-s`。
- 推荐 `network_mode: host` + `cap_add: NET_ADMIN`。bridge 模式下 Docker 默认用 DNAT，peer 的源地址是真实公网 IP。
- **cron 默认每 2 小时重启一次 aria2b**（`CRA2B=2h`）。重启会补装 iptables 规则、从 ipset 重新同步缓存，所以"运行期间规则被清掉"、"缓存与 ipset 不一致"这类问题最多持续 2 小时；`peerState` 也随之清零。
- docker-aria2 不会在服务运行时调用 `--flush`。
- 本地 https RPC 就是自签证书、跳过校验的场景。

### aria2 的真实行为（1.37.0 源码 + 实测）

- `getPeers` 的 `uploadSpeed` / `downloadSpeed` 是 **10 秒滑动窗口均值**，被 choke 后要过几秒才降下来。
- **每段上传刚开始时速度会虚高**（窗口内只有零点几秒的数据），实测读到过限速值的数倍。`processOnePeer` 用"速度 × 扫描间隔"估算上传量，会被放大几十倍，日志里的"已上传约 N 个分片"不可信。
- choke 每 10 秒一轮。peer 多、或 aria2 自己还在下载时，单个 peer 的连续上传通常只有 10–35 秒。
- 握手完成前的 peer 也会出现在 `getPeers` 里，`peerId` 是 20 个 `%00`，识别结果是 `unknown`。
- aria2 自己的 peerId（`A2-1-37-0-…`）不在内置表里，识别结果是 `unknown`，默认属于无进度监控对象。

### 已确认存在、尚未修复的问题（改动涉及扫描状态机，需先定方案）

- **无进度判定会误封正常的慢速 peer**。实测：真 aria2c 下载者以 10–200KB/s 接收、第一个分片 60 秒内下不完，5 次里有 4 次在约 60 秒时被封；当时真实上传不到 1 个分片，估算值却是 5–78 个分片（上面说的速度虚高所致）。`noprogress_piece` 这道保护实际上形同虚设。
- **无进度累计被 choke 轮换清零**。速度一旦 ≤ 1KiB/s 就删除整个 `peerState`，而封禁需要连续约 12 次扫描。实测 3 个吸血 peer 时 60 秒内全封；20 个时 5 分钟只封了 6 个，另有 5 个各拿走 7–35MiB 没被封；aria2 处于下载状态时 8 个全封但最晚要 290 秒。后果是封得慢、漏一部分，不是完全失效。
- `block_keywords` 含 `Unknown`（非默认）时，握手未完成的连接会被当成未知客户端封掉。不能简单地跳过全 0 peerId，否则吸血方用全 0 peerId 就能绕过。
- secret 以 `-` 开头时 `-s <secret>` 会被当成缺值丢弃。[test/parseargv.test.js](test/parseargv.test.js) 明确要求 `--secret` 后面跟选项时不吞掉它，所以修法应是调用方改用 `--secret=<值>`。

### 评估过、结论是不用处理的

- 封掉 Docker 网关：host 模式和默认 bridge 下都不会发生；现在另有私有地址白名单兜底。
- ipset 写满（旧 set 的 `maxelem` 65536）后刷屏：需要 24 小时内封 6.5 万个 IP。
- `-lt....-`（rTorrent）等少数分支没有 `origin`、含高位字节的 peerId 按 Buffer 下标解析会错位：只影响没人会去封的客户端。
- 启动阶段收到 SIGTERM 时 `stop()` 会直接退出、不等初始化做完：下次启动由不变量 19 自愈。
- 运行期间规则丢失、手动 `--flush` 后缓存失效：见上面的 2 小时重启。
- `noprogress_wait=N` 实际是第 N+1 次才封：启动日志已写成"连续命中超过 N 次"，行为不改。

### 实测方法

用 `superng6/aria2:a2b-latest` 镜像（自带 aria2c、Node、ipset/iptables），`--cap-add NET_ADMIN --entrypoint bash` 启动，容器内跑真 aria2c 做种、挂载当前 `app.js` 运行，再用脚本模拟 peer（握手 → interested → 不停 request，不发 bitfield / have 即为吸血 peer；正常 peer 直接用第二个 aria2c）。注意：

- 模拟 peer 的源地址不能用回环或私有地址（白名单会跳过），先 `ip addr add 198.51.100.x/32 dev lo` 再从这些地址出站。
- 镜像里是 busybox，`grep` 没有 `--line-buffered`；aria2b 的输出直接重定向到文件，不要接管道，否则进程会因管道断开而停止扫描，得到"没有封禁"的假结果。
- 每组至少跑 2–5 分钟，结论里写明跑了几次、是什么条件。

## 测试约定

- 只用 `node:test` + `node:assert/strict`，不引入第三方测试框架。
- 每个用例的 setup 调用 `_internal._reset()`，重置 config / 两个 Map / iptables 后端 / idle 心跳 / 失败计数。会装定时器的用例要自行清理，否则 `node --test` 不会退出。
- [test/cron.test.js](test/cron.test.js)：用 `http.createServer` 模拟 aria2 RPC，把 `runtime.execFile` 换成 spy，端到端验证主循环。
- [test/rpc.test.js](test/rpc.test.js)：`httpJsonPost` 的错误契约（3xx/4xx/5xx、ECONNREFUSED、各阶段超时、非法 JSON、64MB 上限、keep-alive、`destroy()`、自签 TLS、IPv6 字面量）。
- [test/iptables.test.js](test/iptables.test.js)：ipset / iptables 初始化、后端探测与切换、IPv6 路径、暂停状态、`ipset save` buffer。
- [test/config.test.js](test/config.test.js) / [test/parseargv.test.js](test/parseargv.test.js)：寄生配置、CLI 解析与合并。
- [test/cli.test.js](test/cli.test.js)：以子进程运行 `-h` / `-v` / `--flush`。
- [test/startup.test.js](test/startup.test.js)：用 shell 脚本冒充 iptables / ipset，按真实报错模拟内核不支持 nft、镜像缺 iptables-legacy、容器缺 NET_ADMIN，检查用户看到的完整启动日志。改启动提示时先改这里的断言。
- [test/unit.test.js](test/unit.test.js)：纯函数与状态管理。
- 修 bug 时补一条能复现原问题的回归测试。

## 环境与运行依赖

- Node.js 22–24（`engines: >=22 <25`），CI 覆盖 22 / 24；release 以 `--target=node22` 打包。
- 系统依赖：`ipset`、`iptables`（IPv6 还需要 `ip6tables`）。Docker 内需要 `NET_ADMIN` capability，**不**用 `--privileged`。
- IPv6 启用判断：`detectIpv6Enabled()` 只检查 `/proc/net/if_inet6` 是否存在（该文件按网络命名空间区分，内核没有 IPv6 协议栈时不存在；仅用 sysctl `disable_ipv6=1` 关闭时文件仍在，会多建一个用不上的 `bt_blacklist6`，不影响运行）；aria2.conf 里 `disable-ipv6=true` 时跟随关闭。
- 环境变量：`DEV=1` 输出 debug 日志；`HIDE_TIME_PREFIX=1` 日志不带时间前缀。
- 面向用户的日志和文档用中文，直接描述现象与修复方法。
