# aria2b

aria2 自动 ban 掉迅雷等不受欢迎客户端的脚本（仅限 Linux）

由 [aria2_ban_thunder](https://github.com/makeding/aria2_ban_thunder) 改名而来。本仓库是 [makeding/aria2b](https://github.com/makeding/aria2b) 的维护分支，v2.x 版本只在本仓库发布。

> **v2.2.8**：默认屏蔽关键词新增 `DL,TS,DT,HP,XM,FG,NX`（迅雷系新内核 `dt/torrent` / `hp/torrent`、`xm/torrent`、快车、影音传送带、TorrentStorm 等），参考 qBittorrent-Enhanced-Edition 与 PeerBanHelper 的最新规则；在 aria2.conf 自定义过关键词的用户需手动更新。
>
> **v2.2.7**：群晖等老内核上防火墙后端切换、IPv6 不可用改为普通提示，不再输出报错；secret 错误时日志直接提示与 aria2 的 rpc-secret 不一致（此前只显示 `HTTP 400 Bad Request`）；默认关键词 `BN` 等内置表以外的客户端代码现在能命中；封禁时长超过 ipset 上限（2147483 秒）时自动调整而不是无法封禁；IPv6 关闭时不再反复打出未生效的封禁日志；`disable-ipv6=false` 不再强制开启 IPv6；新建 ipset 的 `maxelem` 调到 200000；修正安装说明（npm 上的 `aria2b` 仍是上游 v1.0.9）。
>
> **v2.2.6**：修复 IPv6 字面量 RPC 地址无法连接；加速无进度 bitfield 检查，并跳过同轮已成功封禁的重复 IP，减少 CPU 开销、子进程和重复日志。
>
> **v2.2.5**：优化无进度上传检测的 bitfield 扫描路径，非监控客户端、上传速度不达标或已有进度的 peer 不再做完整 popcount，降低长期运行时的周期性 CPU 开销。
>
> **v2.2.4**：内置 peerId 识别逻辑，生产运行不再依赖任何 npm 包；显式指定的配置文件不可用时会暂停 aria2b 并保持进程运行，避免在 s6/Docker 中反复重启影响同容器 aria2c。
>
> **v2.2.3**：日志时间前缀改为固定本地格式 `YYYY/MM/DD HH:mm:ss`，例如 `2026/05/25 00:12:50`，避免不同系统 locale 输出不一致。
>
> **v2.2.2**：修正 Alpine 3.23 legacy iptables 安装提示：`iptables-legacy` 包已经提供 `ip6tables-legacy`，不要安装不存在的 `ip6tables-legacy` 包；优化运行日志，去掉 `Blocked` / `started!` / "累犯" / "idle mode" 等不直观话术。
>
> **v2.2.1**：启动同步 ipset 状态时给 `ipset save` 配置更大的 stdout buffer，避免长期运行黑名单较大时触发 Node 默认 1MB `maxBuffer`；`system.multicall` 子调用 fault / 结果缺失会被视为部分失败，不清理 `peerState`，避免 noprogress 累计被误清。防火墙行为面不变，仍只维护 `bt_blacklist` / `bt_blacklist6` 及对应 INPUT 规则。
>
> **v2.1.0**：修复 v2.0.0 的 `scanTimer.unref()` 导致进程在 Docker/s6 下被反复拉起的关键 bug；修复 `block_keywords=Unknown` 不生效、`isLocalHttpsRpcUrl` 子域绕过、CLI 数字 secret 丢前导 0 等问题；**完全移除 axios**，改用 Node 原生 `http/https.request`，bundle 从 520KB → 50KB（10× 缩减）；新增 ESLint、IPv6 / RPC / parseArgv 全面回归测试（38 → 86）。
>
> **v2.0.0**：稳定性大修。RPC 改 keep-alive 长连接 + system.multicall 批量；增加指数退避、SIGTERM 优雅退出、本地缓存 LRU、启动同步 ipset 状态、错误日志脱敏 secret；发布物改为单文件 bundle（无需 node_modules，curl 下来 chmod 即可跑），适合 Docker / OpenWrt。要求 Node.js 22+。

# 原理
通过 aria2 RPC （就是API）自动查找不受欢迎的 peer 然后使用 iptables + ipset 来封禁其 IP （所以 Windows / macOS 不魔改是没法用的）

这是不修改 aria2 源码（其实就是自己太菜了 改不动 C++）而 ban 掉这些客户端的一个办法。
## 客户端屏蔽规则
### 关键字
应该好理解吧，就是客户端名称符合关键字就ban
### 监视进度
- 初筛（也就是最长那行if）
  - 名称符合config.noprogress_keywords
  - 上传速度大于1KiB/s（太少就不管了吧，节约点性能，毕竟我写的应该一言难尽）
  - 汇报进度为0（```aria2.getPeers```的```bitfield```全为0）
    - TODO：不为0时也可以算下增幅够不够

符合的再进行下列判断
- 判断进度不对劲的规则
  - 上传了超过5个块的量
  - 进度为0（以后可以改成各种进度不对劲的都算）
  - 持续超过10次扫描
  
> **_注：_** 此处使用扫描时的瞬时速度当作扫描间隔里的平均速度，统计对每个peer的上传量（因为没找到aria2c RPC怎么获取现成/精确的每个peer的上传量，transmission倒是有）
## 依赖
`Node.js >= 22` `ipset` `iptables`

生产运行无 npm 依赖；npm 依赖只用于开发、测试和 release 打包。

自行参考[Node.js 官方教程](https://github.com/nodesource/distributions/blob/master/README.md)

Docker 内运行时需要容器具备 `NET_ADMIN` 能力来操作 `ipset` / `iptables`，不建议使用 `--privileged`。

IPv6 默认根据系统 `/proc/net/if_inet6` 自动启用，对应使用 `bt_blacklist6` + `ip6tables`；
若 aria2 配置里写了 `disable-ipv6=true` 则跟随关闭。

开机自动启动 `ipset` `iptables` 按照自己需求来安排
### Alpine

    apk add --no-cache iptables ipset nodejs

若运行在群晖 DSM 等老内核环境，建议同时安装 legacy 后端：

    apk add --no-cache iptables iptables-legacy ipset nodejs

aria2b 启动时会自动探测防火墙后端。在这类内核上看到下面两条提示属于正常情况，IPv4 封禁照常工作：

    检测到当前内核不支持 nft 防火墙后端，已切换到 iptables-legacy / ip6tables-legacy
    IPv6 封禁未启用：当前内核不支持 ip6tables-legacy 的 ipset 匹配（xt_set），仅启用 IPv4 封禁

Alpine 3.23 中 `iptables` 包已提供 `ip6tables`，`iptables-legacy` 包已提供 `ip6tables-legacy`；不需要安装 `ip6tables-legacy` 这个包名。
### Ubuntu / Debian
    apt-get install ipset
### ArchLinux
    pacman -S ipset

### Centos
    yum install ipset

## 下载
> **_注意：_** npm 上的 `aria2b` 包由上游维护，停留在 v1.0.9，**不包含** v2.x 的任何修复，请不要再用 `npm i -g aria2b` 安装。

### 单文件（推荐）
> 适合 OpenWrt / Docker / 一般 Linux；同时也是更新命令

自 v2.0.0 起发布物为单文件 bundle，不依赖 node_modules，只需要 Node.js：

    curl -fL -o /usr/local/bin/aria2b https://github.com/SuperNG6/aria2b/releases/latest/download/aria2b
    chmod +x /usr/local/bin/aria2b
    aria2b

也可以到 [releases](https://github.com/SuperNG6/aria2b/releases) 手动下载。v2.2.7 起附带的 `aria2b.sha256` 可以在下载目录直接用 `sha256sum -c aria2b.sha256` 校验。

### npm 全局安装
每个 release 都附带 npm 包 `aria2b-X.Y.Z.tgz`，把 `X.Y.Z` 换成 [releases](https://github.com/SuperNG6/aria2b/releases) 里的最新版本号：

    npm i -g https://github.com/SuperNG6/aria2b/releases/download/vX.Y.Z/aria2b-X.Y.Z.tgz

### 开发版

    git clone https://github.com/SuperNG6/aria2b.git # 克隆
    cd aria2b
    npm install        # 安装依赖
    node app.js

    npm test           # 运行测试
    npm run lint       # 代码风格检查（ESLint）
    git pull           # 更新

## GitHub Actions / gh CLI

使用 GitHub CLI 触发构建与测试：

    gh workflow run ci.yml
    gh run watch

发布 release：

    gh workflow run release.yml -f tag=vX.Y.Z
## 配置
目前版本已经默认开箱即用了，欢迎报告 bug  
* 使用aria2的配置文件
aria2b支持寄生配置。会读取aria2本体的配置文件来找 aria2 RPC 端口以及 secret 等各种参数。因此仅需一个配置文件即可对同时 aria2 和 aria2b 做修改。
  * 默认读取的路径为 `$HOME/.aria2/aria2.conf` -> `/tmp/etc/aria2/aria2.conf.main` (OpenWRT)-> `/etc/aria2/aria2.conf` -> `./aria2.conf`  
主机若为本地则默认关闭证书校验（自行 `update-ca-trust` 让本地系统信任之类的其实更好）  
  * 也可以使用 -c 来指定 aria2 的配置文件
    ```
    aria2b -c <path>
    ```
* 使用命令行
也可以在命令行中设置aria2b的各种参数。例如：
    ```
    aria2b -u <url> -s <secret>
    ```

所有配置如下表所示：
| 描述 | cli |  aria2 config 寄生配置  | 默认值 | 备注
|-|-|-|-|-|
| rpc url | -u --url | N/A | http://127.0.0.1:6800/jsonrpc 
| rpc secret | -s --secret | rpc-secret | N/A | 与 aria2 共享同一字段
| ban 客户端关键字 | -b --block-keywords | ab-bt-ban-client-keywords | XL,SD,XF,QD,BN,DL,TS,DT,HP,XM,FG,NX | 以,为分割符
| 需监视进度的客户端关键字 | --noprogress-keywords | ab-bt-noprogress-keywords | XL,SD,XF,QD,BN,DL,TS,DT,HP,XM,FG,NX,Unknown | 以,为分割符
| 进度阈值 | --noprogress-piece| ab-bt-noprogress-piece | 5 | 单位：种子的分片数
| 超过阈值等待次数 | --noprogress-wait | ab-bt-noprogress-wait | 10 |
| 扫描间隔 | --scan-interval | ab-bt-scan-interval | 5000 | 单位毫秒，范围 1000~60000，超出会被夹到边界
| IP 解除封禁时间 | --timeout | ab-bt-ban-timeout | 86400 | 单位秒，应 >> scan-interval（否则刚封就过期）；最大 2147483（约 24.8 天，ipset 上限），超出会被调整到上限
| 关闭证书校验 | --rpc-no-verify | ab-rpc-no-verify| N/A | rpc 为本地 https 时默认关闭证书校验
| 自定义信任ca证书 | --rpc-ca | ab-rpc-ca | N/A | 路径/base64两次编码
| 自定义信任证书 | --rpc-cert | ab-rpc-cert | N/A | 路径/base64两次编码
| 自定义信任私钥 | --rpc-key | ab-rpc-key | N/A | 路径/base64两次编码

环境变量：
- `DEV=1` 输出 debug 日志
- 默认日志时间前缀使用系统时区，格式为 `YYYY/MM/DD HH:mm:ss`，例如 `2026/05/25 00:12:50`
- `HIDE_TIME_PREFIX=1` 日志不带时间前缀（外部 logger/journalctl 通常自己加时间，避免重复）

> **_注意：_** ⚠️寄生配置**不**支持结尾带 # 注释

`--rpc-ca` `--rpc-cert` `--rpc-key` 需要同时配置，不然还是会不信任，这是 Node.js 的[设定](https://nodejs.org/api/tls.html)，这里推荐系统去手动信任 ca 证书来完成而不是这么麻烦（搜索关键词 `update-ca-trust`）
## 守护
推荐直接放进 Docker / s6-overlay 之类的进程管理器，进程收到 `SIGTERM` 会等当前扫描完再退出，
失败时会指数退避并节流日志。下面是 systemd 的最小化示例（仍然可用）。
### systemd
参考配置
```
[Unit]
Description=aria2 ban unwelcome clients via ipset
After=network.target aria2.service

[Service]
Type=simple
User=root
Restart=on-failure
RestartSec=5s

# 这里的路径自己改改，默认应该是这个
ExecStart=/usr/local/bin/aria2b

[Install]
WantedBy=multi-user.target
```
命令：
```
systemctl edit aria2b --full --force
systemctl enable aria2b.service --now
```
### pm2
```
# 自己安装
# yarn global add pm2 
# pacman -S pm2 # ArchLinux
pm2 start --name 'aria2b' aria2b
pm2 save
pm2 startup
```
# blocklist 参考 (--block-keywords)
| 客户端 |  Peer名称 |
|-|-|
| 迅雷 | XL SD |
| 迅雷系新内核（`dt/torrent`、`hp/torrent`） | DT HP |
| `xm/torrent`（刷流量客户端） | XM |
| 影音先锋 | XF |
| qq旋风 | QD |
| 百度网盘 | BN（可能） |
| 快车 FlashGet | FG |
| 影音传送带 Net Transport | NX |
| TorrentStorm | TS |
| 其他（qBEE / PeerBanHelper 均封禁） | DL |
| 未知 | Unknown （请注意大写） |

以上吸血 peer 参考了 [qBittorrent-Enhanced-Edition](https://github.com/c0re100/qBittorrent-Enhanced-Edition/blob/v5_1_x/src/base/bittorrent/peer_blacklist.hpp) 与 [PeerBanHelper](https://github.com/PBH-BTN/PeerBanHelper/blob/dev/src/main/resources/profile.yml) 的 peer-id 规则，在这里表示感谢。aria2 RPC 只提供 peerId，拿不到客户端名称，所以只采用了按 peer-id 前缀识别的那部分。

未默认加入的：
- `TT`（土豆）：关键字按子串匹配，`TT` 会误命中 `HTTP Seed`。
- `-LT1220-` / `-LT2070-`（PikPak、迅雷的离线下载）：两个参考项目都只封 CN/NL 的 IP，aria2b 没有 GeoIP，直接加入会误封大量正常的 libtorrent 客户端。
- `-RN0.0.0`（Rain 默认版本号）：关键字只能写到 `RN`，会把所有 Rain 客户端都封掉。

如果还想屏蔽更多的 bt 客户端，可以参考本项目 `app.js` 中内置的 BitTorrent peerId 识别表（没有什么必要啦，就迅雷之类的会吸血）
ban 未知的 peer 按照需求添加

# Enjoy～ 
如果你觉得好用请推荐给别人  
有什么问题 发 issue 就可以了，或者自己改改 发个 PR 吧
# License
MIT
