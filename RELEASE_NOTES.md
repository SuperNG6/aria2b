# v2.2.7

## 修复

- secret 错误时日志显示 aria2 返回的错误原因，并提示 secret 与 aria2 的 `rpc-secret` 不一致。aria2 用 HTTP 400 返回 RPC 错误，此前错误信息被丢弃，日志只有 `HTTP 400 Bad Request`。
- 内置识别表以外的 Az 格式客户端代码（例如默认关键词里的 `BN`，以及 `-DL` 等）现在也能被关键词命中。此前它们没有 `origin` 字段，默认的 `BN` 和用户自己添加的表外代码都不会生效。客户端仍按未知客户端处理，`Unknown` 规则不变。
- 封禁时长超过 ipset 上限 2147483 秒（约 24.8 天）时自动调整到上限并警告。此前全新环境会因 `ipset create` 失败进入暂停扫描状态（还给出了不相关的 iptables-legacy 提示），已有 set 时则每次封禁都失败。
- IPv6 关闭（包括启动时自动降级）时跳过 IPv6 peer。此前无进度检测会反复打出"封禁疑似无进度上传"日志，但实际从未封禁。
- `aria2.tellActive` 返回格式异常时按扫描失败处理，不再当作"没有活跃任务"清空无进度累计。
- `--secret`、`-b`、`-u`、`--rpc-ca` 等字符串参数不带值时忽略并警告，不再写入字符串 `"true"`；`-c` 不带路径时提示路径为空。
- aria2.conf 中的 `disable-ipv6=false`（aria2 默认值）不再覆盖系统探测结果强制开启 IPv6。此前在无 IPv6 的主机上会去探测 `ip6tables`，失败后降级并多打 3 行警告；现在 `disable-ipv6` 只用于关闭 IPv6。
- 新建 `bt_blacklist` / `bt_blacklist6` 时显式设置 `maxelem 200000`，与本地缓存上限一致。ipset 默认上限 65536，封禁 IP 过多时会一直报"封禁失败"。已存在的 set 不会被重建，需要执行一次 `aria2b --flush` 才会用上新上限。

## 文档

- npm 上的 `aria2b` 包由上游维护，停留在 v1.0.9，不包含 v2.x 的任何修复。README 改为推荐从本仓库 release 下载单文件，或用 release 附带的 tgz 执行 `npm i -g`；仓库、下载、clone 链接改为 `SuperNG6/aria2b`。

## 其他

- release 附带的 `aria2b.sha256` 只记录文件名，下载后可直接 `sha256sum -c aria2b.sha256`（此前记录的是 `dist/aria2b`，校验会找不到文件）。
- 移除生产代码中已不再使用的 `countOnes`。
- 修正注释与测试：aria2 `system.multicall` 子调用失败返回 `{ code, message }`，不是 `{ faultCode, faultString }`。

## 测试

- 128/128 通过。真实 aria2c 1.37.0 + ipset/iptables 环境验证：错误 secret 的日志、超大封禁时长的启动与建表、`BN` 关键词命中、IPv6 关闭时不再打出无效封禁日志。

# v2.2.6

## 修复

- 修复 `http://[::1]:6800/jsonrpc` 等 IPv6 字面量 RPC 地址被误当作域名解析的问题，支持 IPv6 HTTP 与 HTTPS 连接。

## 性能优化

- 用非零十六进制字符检查替代 bitfield 逐字符 `parseInt`，保留大小写、非法字符和输入类型处理语义。长全零 bitfield 的函数基准测试约快 12 倍；这不是整体 CPU 降幅。
- 同轮扫描中，同一 IP 成功封禁后跳过后续重复封禁，减少 `ipset` 子进程和重复日志；首次失败仍允许重试，封禁到期后可重新封禁。

## 测试

- 118/118 测试通过，lint 和语法检查通过。
- 真实 aria2 验证 IPv6 HTTP/HTTPS RPC、正常 peer 不误封、关键词与无进度封禁、实际防火墙阻断、封禁到期及重启同步。

# v2.2.5

## 性能优化

- 延迟无进度上传检测中的 bitfield 扫描：普通 peer、非监控客户端、上传速度不达标或 `pieceLength` 不可知时不再扫描整段 bitfield。
- 新增 `hasProgressBit()` 快速判断是否存在任意进度位；对已有进度的 peer 可早停，不再完整 popcount。

## 测试

- 113/113 通过。新增 `hasProgressBit` 单元测试，以及非 noprogress 目标携带长 bitfield 时不创建状态机、不封禁的回归测试。

# v2.2.4

## 修复

- 内置 peerId 识别逻辑，生产运行不再依赖 `@huggycn/bittorrent-peerid`，降低供应链暴露面。
- 显式指定 `-c/--config` 但配置文件不可用时，不再继续用默认 RPC 配置启动；长期运行模式下暂停 aria2b 并保活，`--flush` 一次性命令返回非 0，避免 s6/Docker 中 aria2b 故障拖累同容器 aria2c。
- `system.multicall` 子结果形态异常（例如 `getPeers` 不是数组、`tellStatus` 缺结果）时视为部分失败，不清理 `peerState`，避免无进度累计被误清。
- percent-encoded peerId 只有 `%xx` 完整十六进制时才解码，畸形转义原样保留，避免产生不可见控制字符。

## 测试

- 111/111 通过。

# v2.2.3

## 体验优化

- 日志时间前缀改为固定的本地时间格式 `YYYY/MM/DD HH:mm:ss`，例如 `2026/05/25 00:12:50`，避免 `toLocaleString()` 在不同系统 locale 下输出 `5/25/2026, 12:52:15 PM` 这类不一致格式。

## 测试

- 108/108 通过。新增 `formatLocalTimestamp` 回归测试，覆盖补零、24 小时制和系统时区语义。

# v2.2.2

## 修复

- 修正 Alpine 3.23 legacy iptables 安装提示：`iptables` 包已提供 `ip6tables`，`iptables-legacy` 包已提供 `ip6tables-legacy`；不存在独立的 `ip6tables-legacy` 包。日志、README、release notes 统一改为：

  ```dockerfile
  apk add --no-cache iptables iptables-legacy ipset nodejs
  ```

## 体验优化

- 优化用户可见运行日志，去掉 `Blocked` / `started!` / "累犯" / "idle mode" 等不直观话术。
- 启动环境不可用时明确输出：已暂停扫描并保持进程运行、aria2c / AriaNg 不受影响、修复环境后重启容器。
- 封禁日志改为中文描述，包含 IP、客户端信息、封禁时长；无进度上传封禁日志改用"连续异常/阈值"说明。

## 测试

- 107/107 通过。本版本不改变封禁规则和防火墙行为面。

# v2.2.1

## 修复

- 启动读取 `ipset save` 时通过 `readIpsetSave()` 配置 32MB stdout buffer，避免长期运行黑名单较大时触发 Node `execFile` 默认 1MB `maxBuffer`，从而误进入"暂停扫描并保活"状态。
- `system.multicall` 子调用 fault / 结果缺失现在视为部分失败：本轮跳过异常 gid，但不清理 `peerState`，避免 noprogress 累计被 aria2c 任务状态 race 误清。
- 防火墙行为面不变：仍只维护 `bt_blacklist` / `bt_blacklist6` 两个 ipset，以及引用它们的 INPUT DROP 规则；不 flush 全局防火墙表、不改 Docker chains、不改默认策略。

## 测试

- 107/107 通过。新增 `readIpsetSave` maxBuffer 回归测试，以及 `system.multicall` 子调用 fault 不清 `peerState` 的回归测试。

# v2.2.0

## 概要

**修复群晖 DSM 4.x 等老内核环境下 aria2b 反复 crash 拖死 s6 容器服务的关键问题**：iptables 后端自动探测+切换、IPv6 失败软降级、启动阶段不可恢复错误会暂停扫描并保持进程运行，而不是直接退出。

针对场景：docker-aria2 镜像 + Alpine 3.13+ 的 `iptables` 包默认指向 nft 后端，在群晖 DSM 4.x 内核 / 部分老 NAS 固件上 nft 子系统初始化即失败（`Could not fetch rule set generation id: Invalid argument`），整个 iptables 路径都用不了。v2.1.x 加的 `ensureIptablesRule` 自愈反而把 v1.x"误打误撞跑成"的 race 关死，表现为 aria2b 每秒 crash + s6-overlay 反复重启 service，淹没日志拖慢同容器 aria2c。

## 🐛 修复

- **iptables 后端自动探测 + 切换**（`pickIptablesBackendForVersion`）：启动时用 `bin -L INPUT -n` 作为最小探针测试默认 `iptables` 能否工作，不行则自动切到 `iptables-legacy`（要求镜像装了 `iptables-legacy` 包；Alpine 3.23 中它同时提供 `iptables-legacy` 与 `ip6tables-legacy` 二进制）。`-n` 跳过反向 DNS 防容器无 DNS 时阻塞 30s+。
- **IPv6 setup 失败软降级**：群晖 DSM 4.4 内核 + xt_set 残缺时 `ip6tables -m set` 即便切到 legacy 也可能失败。v6 探测失败 → `config.ipv6=false`；v6 flush/ensure 抛错 → catch 兜底再降级。IPv4 不受影响。
- **启动环境不可用时暂停扫描并保活**：aria2b 在 docker-aria2 镜像里是 s6-overlay v2 service，进程退出会被 s6 无限重启拖垮容器。任何启动阶段不可恢复的环境问题（IPv4 后端不可用 / ipset 缺失 / 启动兜底异常 / uncaughtException / unhandledRejection）→ 暂停扫描、销毁 RPC client、保留 1h 心跳让进程存活，并定时提示修复。同容器里 aria2c / AriaNg 不受影响。`--flush` 一次性 CLI 维护命令保留 `exit(1)` 行为。

## 🆕 新增

- 错误日志识别 iptables-nft / xt_set 不兼容特征（`nf_tables` / `generation id` / `Extension set` / `Couldn't load match` / `missing kernel module`），自动追加 "在 Dockerfile 增加 `apk add --no-cache iptables iptables-legacy ipset nodejs`" 的修复指引。
- 全局 `iptablesBinaries.v4/v6` 保存当前选用的二进制名；`flushIptablesIpset` / `ensureIptablesRule` 都从这里读，自动跟随切换结果。

## 🧪 测试

- 105/105 通过（新增 13 条回归测试覆盖：iptables 后端探测、自动切换、`--flush` 模式、`scheduleNext` idle 跳过、`_reset` 清 idleHeartbeat、`runIdleMode` 幂等、nft 错误识别等）。

## ⬆️ 升级指南

- **docker-aria2 群晖 / 老内核 NAS 用户必须做**：在 Dockerfile 增加 `iptables-legacy` 才能真正跑通；Alpine 3.23 中 `iptables-legacy` 包已经提供 `ip6tables-legacy` 二进制，不存在独立的 `ip6tables-legacy` 包：

  ```dockerfile
  apk add --no-cache iptables iptables-legacy ipset nodejs
  ```

  装上后 aria2b 启动时会自动探测默认 nft 不可用 → 切到 legacy → 正常工作，无需任何手工 alternatives / 软链。

- **新内核主机**（大多数现代 Linux）：默认 nft 后端就能跑，aria2b 不会切换。
- **不装 iptables-legacy 但内核老**：aria2b 不再 crash 拖死容器；会暂停扫描并保持进程运行，在日志里指引用户安装 legacy 包。
- npm 用户：`npm i -g aria2b@2.2.0`
- 单文件 bundle：到 releases 下载 `aria2b`，`chmod +x` 后即可运行。

无破坏性 API 变更；CLI 参数、aria2.conf `ab-*` 配置键、ipset / iptables 规则名（`bt_blacklist` / `bt_blacklist6`）全部向后兼容。

## 不变量补充

CLAUDE.md 补 3 条来自本次的不变量（第 1 条 scanTimer 不能 unref 的姊妹规则）：

- #15：启动阶段环境失败必须进 `runIdleMode()`，绝不 `process.exit(1)`，否则会触发 s6-overlay v2 crash-loop。
- #16：iptables 后端探测优先级 默认 → legacy，不自动 `apk add`（违反零运维原则）。
- #17：IPv6 setup 失败必须软降级，绝不让 IPv4 跟着挂。
