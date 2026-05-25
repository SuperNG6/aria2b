# 未发布

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
