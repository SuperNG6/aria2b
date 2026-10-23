'use strict'
/**
 * 启动日志端到端测试：用 shell 脚本冒充 iptables / ip6tables / ipset，按真实报错文本模拟
 * 群晖 DSM 旧内核、镜像缺 iptables-legacy、容器缺 NET_ADMIN 三种环境，检查用户看到的日志：
 * 每条都是单行、正常的后端切换不像报错、处理建议与实际原因对得上。
 */
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const APP = path.resolve(__dirname, '..', 'app.js')

// 只用 sh 内建命令：PATH 只包含假命令目录，不能依赖 basename 等外部命令
const FAKE_COMMAND = `#!/bin/sh
name=\${0##*/}
case "$SIM_MODE:$name" in
  noperm:ipset)
    echo "ipset v7.24: Kernel error received: Operation not permitted" >&2; exit 1 ;;
  noperm:*)
    echo "$name v1.8.11 (nf_tables): Could not fetch rule set generation id: Permission denied (you must be root)" >&2; exit 4 ;;
  *:iptables|*:ip6tables)
    echo "Warning: Extension set revision 0 not supported, missing kernel module?" >&2
    echo "$name v1.8.11 (nf_tables): Could not fetch rule set generation id: Invalid argument" >&2; exit 4 ;;
  *:ip6tables-legacy)
    case "$*" in *"-m set"*)
      echo "ip6tables v1.8.11 (legacy): Couldn't load match \\\`set':No such file or directory" >&2
      echo "" >&2
      echo "Try \\\`ip6tables -h' or 'ip6tables --help' for more information." >&2; exit 2 ;;
    esac ;;
esac
exit 0
`

function startWithFakeCommands(t, mode, commands) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aria2b-startup-'))
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
    const bin = path.join(dir, 'bin')
    fs.mkdirSync(bin)
    for (const name of commands) {
        fs.writeFileSync(path.join(bin, name), FAKE_COMMAND, { mode: 0o755 })
    }
    // HOME / cwd 指向空目录，避免读到本机真实的 aria2.conf；RPC 指向关闭的端口
    const r = spawnSync(process.execPath, [APP, '-u', 'http://127.0.0.1:1/jsonrpc'], {
        cwd: dir,
        env: { PATH: bin, HOME: dir, HIDE_TIME_PREFIX: '1', SIM_MODE: mode },
        encoding: 'utf8',
        timeout: 1500   // 到时发 SIGTERM，aria2b 正常退出
    })
    const lines = `${r.stdout}${r.stderr}`.split('\n').filter(Boolean)
    for (const line of lines) {
        assert.match(line, /^\[aria2b\] /, `每条日志都应是单行，不能夹带原始多行报错：${JSON.stringify(line)}`)
    }
    return { out: lines.join('\n'), stderr: r.stderr }
}

test('启动日志: 内核不支持 nft、已装 iptables-legacy（如群晖）→ 只有普通提示，没有警告和报错', (t) => {
    const { out, stderr } = startWithFakeCommands(t, 'synology',
        ['iptables', 'ip6tables', 'iptables-legacy', 'ip6tables-legacy', 'ipset'])
    assert.match(out, /已初始化 bt_blacklist（IPv4，使用 iptables-legacy）/)
    assert.match(out, /aria2b 已启动/)
    if (fs.existsSync('/proc/net/if_inet6')) {
        assert.match(out, /检测到当前内核不支持 nft 防火墙后端，已切换到 iptables-legacy \/ ip6tables-legacy$/m)
        assert.match(out, /IPv6 封禁未启用：当前内核不支持 ip6tables-legacy 的 ipset 匹配（xt_set），仅启用 IPv4 封禁$/m)
    } else {
        assert.match(out, /检测到当前内核不支持 nft 防火墙后端，已切换到 iptables-legacy$/m)
    }
    // 能正常运行就不能有警告 / 报错：stderr 只允许测试里 RPC 端口关闭导致的扫描失败
    const stderrLines = stderr.split('\n').filter(Boolean)
    assert.ok(stderrLines.every(l => /扫描失败/.test(l)), `不应有警告或报错：${JSON.stringify(stderrLines)}`)
    assert.doesNotMatch(out, /apk add|generation id|暂停扫描|NET_ADMIN/)
})

test('启动日志: 镜像没装 iptables-legacy → 暂停扫描，安装建议只出现一次', (t) => {
    const { out } = startWithFakeCommands(t, 'synology', ['iptables', 'ip6tables', 'ipset'])
    assert.match(out, /原因：IPv4 防火墙不可用：当前内核不支持默认 iptables 使用的 nft 后端，镜像里也没有 iptables-legacy/)
    assert.match(out, /处理：在 Dockerfile 增加 `apk add --no-cache iptables iptables-legacy ipset nodejs` 后重启容器/)
    assert.equal(out.match(/apk add/g).length, 1)
    assert.doesNotMatch(out, /aria2b 已启动/)
})

test('启动日志: 容器缺 NET_ADMIN → 提示加 NET_ADMIN，不提示安装 iptables-legacy', (t) => {
    const { out } = startWithFakeCommands(t, 'noperm',
        ['iptables', 'ip6tables', 'iptables-legacy', 'ip6tables-legacy', 'ipset'])
    assert.match(out, /原因：ipset 无法使用：ipset v7.24: Kernel error received: Operation not permitted/)
    assert.match(out, /处理：给容器加上 NET_ADMIN 能力/)
    assert.doesNotMatch(out, /apk add|iptables-legacy/)
})
