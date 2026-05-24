# aria2b

aria2 自动 ban 掉迅雷等不受欢迎客户端的脚本（仅限 Linux）

由 [aria2_ban_thunder](https://github.com/makeding/aria2_ban_thunder) 改名而来

> **v2.2.2**：修正 Alpine 3.23 legacy iptables 安装提示：`iptables-legacy` 包已经提供 `ip6tables-legacy`，不要安装不存在的 `ip6tables-legacy` 包；优化运行日志，去掉 `Blocked` / `started!` / "累犯" / "idle mode" 等不直观话术。
>
> **v2.2.1**：启动同步 ipset 状态时给 `ipset save` 配置更大的 stdout buffer，避免长期运行黑名单较大时触发 Node 默认 1MB `maxBuffer`；`system.multicall` 子调用 fault / 结果缺失会被视为部分失败，不清理 `peerState`，避免 noprogress 累计被误清。防火墙行为面不变，仍只维护 `bt_blacklist` / `bt_blacklist6` 及对应 INPUT 规则。
>
> **v2.1.0**：修复 v2.0.0 的 `scanTimer.unref()` 导致进程在 Docker/s6 下被反复拉起的关键 bug；修复 `block_keywords=Unknown` 不生效、`isLocalHttpsRpcUrl` 子域绕过、CLI 数字 secret 丢前导 0 等问题；**完全移除 axios**，改用 Node 原生 `http/https.request`，bundle 从 520KB → 50KB（10× 缩减），运行依赖仅剩 1 个；新增 ESLint、IPv6 / RPC / parseArgv 全面回归测试（38 → 86）。
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
自行参考[Node.js 官方教程](https://github.com/nodesource/distributions/blob/master/README.md)

Docker 内运行时需要容器具备 `NET_ADMIN` 能力来操作 `ipset` / `iptables`，不建议使用 `--privileged`。

IPv6 默认根据系统 `/proc/net/if_inet6` 自动启用，对应使用 `bt_blacklist6` + `ip6tables`；
若 aria2 配置里写了 `disable-ipv6=true` 则跟随关闭。

开机自动启动 `ipset` `iptables` 按照自己需求来安排
### Alpine

    apk add --no-cache iptables ipset nodejs

若运行在群晖 DSM 4.x 等老内核环境，建议同时安装 legacy 后端：

    apk add --no-cache iptables iptables-legacy ipset nodejs

Alpine 3.23 中 `iptables` 包已提供 `ip6tables`，`iptables-legacy` 包已提供 `ip6tables-legacy`；不需要安装 `ip6tables-legacy` 这个包名。
### Ubuntu / Debian
    apt-get install ipset
### ArchLinux
    pacman -S ipset

### Centos
    yum install ipset

## 下载
三选一
### 稳定版（强烈推荐）
> 同时也是更新命令

    npm i -g aria2b
    aria2b
### 稳定版但是单文件
> 适合 OpenWrt / Docker 单文件部署或者不想使用包管理器的你

到 [releases](https://github.com/makeding/aria2b/releases) 下载最新版本（自 v2.0.0 起为单文件 bundle，不依赖 node_modules）

    chmod +x aria2b
    ./aria2b

### 开发版

    git clone https://github.com/makeding/aria2b.git # 克隆
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
| ban 客户端关键字 | -b --block-keywords | ab-bt-ban-client-keywords | XL,SD,XF,QD,BN | 以,为分割符
| 需监视进度的客户端关键字 | --noprogress-keywords | ab-bt-noprogress-keywords | XL,SD,XF,QD,BN,Unknown | 以,为分割符
| 进度阈值 | --noprogress-piece| ab-bt-noprogress-piece | 5 | 单位：种子的分片数
| 超过阈值等待次数 | --noprogress-wait | ab-bt-noprogress-wait | 10 |
| 扫描间隔 | --scan-interval | ab-bt-scan-interval | 5000 | 单位毫秒，范围 1000~60000，超出会被夹到边界
| IP 解除封禁时间 | --timeout | ab-bt-ban-timeout | 86400 | 单位秒，应 >> scan-interval（否则刚封就过期）
| 关闭证书校验 | --rpc-no-verify | ab-rpc-no-verify| N/A | rpc 为本地 https 时默认关闭证书校验
| 自定义信任ca证书 | --rpc-ca | ab-rpc-ca | N/A | 路径/base64两次编码
| 自定义信任证书 | --rpc-cert | ab-rpc-cert | N/A | 路径/base64两次编码
| 自定义信任私钥 | --rpc-key | ab-rpc-key | N/A | 路径/base64两次编码

环境变量：
- `DEV=1` 输出 debug 日志
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
| 影音先锋 | XF |
| qq旋风 | QD |
| 百度网盘 | BN（可能） |
| 未知 | Unknown （请注意大写） |

以上吸血 peer 参考了来自隔壁的 [qBittorrent-Enhanced-Edition](https://github.com/c0re100/qBittorrent-Enhanced-Edition/blob/ebe908f186be5fa2aba8710a543b3ac5c92b92fa/src/base/bittorrent/session.cpp#L2226) 项目的源码，在这里表示感谢  
如果还想屏蔽更多的 bt 客户端，可以参考 参考[这边的源码](https://github.com/makeding/bittorrent-peerid/blob/master/index.js#L249)  （没有什么必要啦 就迅雷之类的会吸血）  
ban 未知的 peer 按照需求添加

# Enjoy～ 
如果你觉得好用请推荐给别人  
有什么问题 发 issue 就可以了，或者自己改改 发个 PR 吧
# License
MIT
