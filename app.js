#!/usr/bin/env node
/**
 * aria2b by huggy
 * https://github.com/makeding/aria2b
 * 代码写得不好，请多多指教
 */
const fs = require('fs')
const axios = require('axios')
const argv = require('yargs-parser')(process.argv.slice(2))
const get_peer_name = require('@huggycn/bittorrent-peerid')
const https = require('https')
const net = require('net')
let r_rpc = axios.default.create({
    timeout: 60000 // = 60秒
})
const { asyncForEach, decodePercentEncodedString, honsole, execFile, execFileR } = require('./common')

// 默认配置
let config = {
    rpc_url: 'http://127.0.0.1:6800/jsonrpc',
    rpc_options: {
        verify: true
    },
    secret: '',
    timeout: 86400,
    block_keywords: [
        "XL", // 迅雷
        "SD", // 迅雷
        "XF", // 影音先锋
        "QD", // QQ旋风
        "BN" // 不清楚 大概是百度网盘把
    ],
    noprogress_keywords: ['XL', 'SD', 'XF', 'QD', 'BN', 'Unknown'],
    noprogress_piece: 5, // 上传了这么多 piece 的数据还没有进度就开始计数↓。默认：5
    noprogress_wait: 10, // ↑计数到这么多次还是没有进度就 ban。默认：10
    ipv6: false
}
// 记录本进程已经封禁过且尚未过期的 IP，避免重复调用 ipset。
let blocked_ips = new Map()
let cron_processing_flag = true
let peerUploaded = new Map()

function decodeClient(str) {
    return String(str || '').replace(/%[0-9A-Fa-f]{2}/g, match => {
        const charCode = parseInt(match.slice(1), 16);
        // Decode only if the character is printable ASCII
        if (charCode >= 32 && charCode <= 126) {
            return String.fromCharCode(charCode);
        }
        return match; // Preserve the original encoding for unprintable characters
    });
}

function printpeer(peer,c,torrentInfo){
    let out = []
    out.push(decodeClient(peer.peerId).substring(0, 14).padEnd(14, ' '));
    out.push(peer.ip.padEnd(9, ' ').substring(0, 15));
    out.push(c.client.substring(0, 7));
    out.push(String(c.version).substring(0, 7));
    out.push(String(parseInt(peer.uploadSpeed / 1024))); // Uploaded piece
    out.push(`${countOnes(peer.bitfield)}\t${torrentInfo[0]}`);
    honsole.log(out.join('\t'));
}

function countOnes(hexString) {
    // 将十六进制字符串转换为二进制字符串
    let binaryString
    try{
        binaryString = BigInt(`0x${hexString}`).toString(2)
    } catch(e){
        binaryString = "0"
    }
    // 计算二进制字符串中1的个数
    let count = 0;
    for (const char of binaryString) {
        if (char === '1') {
        count++;
        }
    }
    return count;
}

function parseList(value) {
    return String(value || '')
        .split(',')
        .map(x => x.trim())
        .filter(Boolean)
}

function parsePositiveInteger(value, fallback) {
    const parsed = Number(value)
    if (Number.isInteger(parsed) && parsed > 0) {
        return parsed
    }
    return fallback
}

function parseBoolean(value, fallback = true) {
    if (value === undefined || value === null || value === '') {
        return fallback
    }
    if (typeof value === 'boolean') {
        return value
    }
    const normalized = String(value).trim().toLowerCase()
    if (['1', 'true', 'yes', 'on'].includes(normalized)) {
        return true
    }
    if (['0', 'false', 'no', 'off'].includes(normalized)) {
        return false
    }
    return fallback
}

function hasUnknownKeyword(keywords) {
    return keywords.some(keyword => keyword.toLowerCase() === 'unknown')
}

function keywordMatches(keywords, origin) {
    const text = String(origin || '')
    return keywords.some(keyword => keyword.toLowerCase() !== 'unknown' && text.includes(keyword))
}

function peerStateKey(peer, gid) {
    return [gid, peer.peerId || '', peer.ip || ''].join('\0')
}

function getPeerState(key) {
    let state = peerUploaded.get(key)
    if (!state) {
        state = { uploaded: 0, wait: 0 }
        peerUploaded.set(key, state)
    }
    return state
}

function cleanupPeerUploaded(activeKeys) {
    for (const key of peerUploaded.keys()) {
        if (!activeKeys.has(key)) {
            peerUploaded.delete(key)
        }
    }
}

function isBlocked(ip) {
    const expiresAt = blocked_ips.get(ip)
    if (!expiresAt) {
        return false
    }
    if (expiresAt <= Date.now()) {
        blocked_ips.delete(ip)
        return false
    }
    return true
}

function rememberBlocked(ip) {
    blocked_ips.set(ip, Date.now() + config.timeout * 1000)
}

function cleanupBlockedIps() {
    for (const [ip, expiresAt] of blocked_ips.entries()) {
        if (expiresAt <= Date.now()) {
            blocked_ips.delete(ip)
        }
    }
}

function parseConfigLine(line) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) {
        return null
    }
    const splitIndex = trimmed.indexOf('=')
    if (splitIndex === -1) {
        return null
    }
    return {
        key: trimmed.slice(0, splitIndex).trim(),
        value: trimmed.slice(splitIndex + 1).trim()
    }
}

function applyPositiveIntegerConfig(name, value) {
    const parsed = parsePositiveInteger(value, null)
    if (parsed === null) {
        honsole.warn(`${name}=${value} 不是有效正整数，已忽略`)
        return
    }
    config[name] = parsed
}

function applyNoVerify(value) {
    config.rpc_options.verify = !parseBoolean(value, true)
}

function readTlsMaterial(value, name) {
    const input = String(value || '').trim()
    if (!input) {
        return input
    }
    if (fs.existsSync(input)) {
        return fs.readFileSync(input)
    }
    if (input.length > 100 && /^[A-Za-z0-9+/=\r\n]+$/.test(input)) {
        return Buffer.from(input, 'base64')
    }
    throw new Error(`${name} 指向的文件不存在，且不像 base64 内容: ${input}`)
}

function detectIpv6Enabled() {
    try {
        if (fs.existsSync('/sys/module/ipv6/parameters/disable')) {
            return fs.readFileSync('/sys/module/ipv6/parameters/disable', 'utf8').trim() === '0'
        }
        return fs.existsSync('/proc/net/if_inet6')
    } catch (error) {
        honsole.dev(error)
        return false
    }
}

function isLocalHttpsRpcUrl(url) {
    try {
        const rpcUrl = new URL(url)
        return rpcUrl.protocol === 'https:' && (rpcUrl.hostname === 'localhost' || rpcUrl.hostname.startsWith('127.') || rpcUrl.hostname === '::1')
    } catch (error) {
        throw new Error(`rpc url 格式不正确: ${url}`)
    }
}

function hasIpset(ipsetSaveOutput, setName) {
    return ipsetSaveOutput
        .split('\n')
        .some(line => line.trim().startsWith(`create ${setName} `))
}

async function cron() {
    cron_processing_flag = false
    const activePeerKeys = new Set()
    try {
        let torrentInfo = []    // [gid] = [numPieces, pieceLength]
        let d = await r_rpc.post(config.rpc_url, {
            jsonrpc: '2.0',
            method: 'aria2.tellActive',
            id: Buffer.from(`aria2b-${+new Date()}`).toString('base64'), // 其实就是随机值了，形式无所谓，大概，所以之前版本把 uuid 包给砍了，不需要
            params: ['token:' + config.secret, ['gid', 'status']]
        })
        await asyncForEach(d.data.result || [], async t => {
            if (t.status == 'active') {
                let d_torr = await r_rpc.post(config.rpc_url, {
                    jsonrpc: '2.0',
                    method: 'system.multicall',
                    id: Buffer.from(`aria2b-${+new Date()}`).toString('base64'),
                    params: [[{ 'methodName': 'aria2.tellStatus', 'params': ['token:' + config.secret, t.gid] }]]
                })
                let d_peer = await r_rpc.post(config.rpc_url, {
                    jsonrpc: '2.0',
                    method: 'system.multicall',
                    id: Buffer.from(`aria2b-${+new Date()}`).toString('base64'),
                    params: [[{ 'methodName': 'aria2.getPeers', 'params': ['token:' + config.secret, t.gid] }]]
                })
                const status = d_torr.data?.result?.[0]?.[0] || {}
                const peers = d_peer.data?.result?.[0]?.[0] || []
                torrentInfo[t.gid] = [t.gid, Number(status.numPieces) || 0, Number(status.pieceLength) || 1]
                await asyncForEach(peers, async peer => {
                    const stateKey = peerStateKey(peer, t.gid)
                    activePeerKeys.add(stateKey)
                    let c = get_peer_name(decodePercentEncodedString(peer.peerId))
                    let toBlock = 0
                    let bitprogress = countOnes(peer.bitfield)
                    //printpeer(peer,c,torrentInfo[t.gid])
                    if (!isBlocked(peer.ip)) {
                        if (keywordMatches(config.block_keywords, c.origin)) toBlock = 1
                        else {
                            const isNoProgressTarget = (hasUnknownKeyword(config.noprogress_keywords) && c.client == 'unknown') || keywordMatches(config.noprogress_keywords, c.origin)
                            if (isNoProgressTarget && Number(peer.uploadSpeed) > 1024 && bitprogress == 0){
                                //初筛：(名称符合) && 上传速度大于1KiB && 进度为0
                                //printpeer(peer,c,torrentInfo[t.gid])
                                const state = getPeerState(stateKey)
                                state.uploaded += Number(peer.uploadSpeed) * scan_interval / 1000  //累加计算上传量
                                let uploadPiece = state.uploaded / torrentInfo[t.gid][2]   //以分片数量为单位
                                if ( uploadPiece > config.noprogress_piece){
                                    //上传量大于noprogress_piece后开始表演节目《老子数到十》
                                    if(bitprogress == 0 && Number(peer.downloadSpeed) == 0){
                                        state.wait += 1
                                        if (state.wait > config.noprogress_wait) {
                                            honsole.log(`往 ${decodeClient(peer.peerId).substring(0, 16).padEnd(16, ' ')}（${peer.ip}）\t传输了 ${String(uploadPiece).substring(0,8)}\t个piece，但它声称进度 ${countOnes(peer.bitfield)}/${torrentInfo[t.gid][1]} ，累犯 ${state.wait} 次，ban了`)
                                            toBlock = 1
                                        }
                                    }
                                    else{
                                        state.wait = 0
                                    }
                                }
                            } else {
                                peerUploaded.delete(stateKey)
                            }
                        }
                        if ((hasUnknownKeyword(config.block_keywords) || toBlock == 1) && c.client == 'unknown') {
                            //这里比较偷懒所以尽可能直接用了huggy的代码，但逻辑好像似乎应该是没有漏洞的
                            await block_ip(peer.ip, {
                                origin: 'Unknown',
                                client: '',
                                version: ''
                            })
                        } else if (toBlock == 1) {
                            await block_ip(peer.ip, c)
                        }
                    }
                })
            }
        })
    } catch (e) {
        console.error('请求错误 日志如下，请检查是否填错 url 和 secret，也有可能是 aria2 进程嗝屁了，或者你的硬盘负载太大已经出现了 I/O hang 的情况。')
        console.error(e)
    } finally {
        cleanupPeerUploaded(activePeerKeys)
        cleanupBlockedIps()
        cron_processing_flag = true
    }
}
// 初始化函数，载入配置之类的
// 包装成匿名函数也行，不过会有 ;
async function initial() {
    if (argv.h || argv.help) {
        let name = process.argv0 === 'node' ? `node app.js` : process.argv0
        let prefix = name.split('').map(x => ' ').join('') + ' '
        // 现在还是中英文混合状态，不知道您有什么想法呢？🙆统一中文还是统一英文又或者保持现状？
        console.log(`aria2b v${require('./package.json').version} by huggy

${name} -c, --config <aria2 config path>
${prefix}-u,--url <rpc url> (default: http://127.0.0.1:6800/jsonrpc)
${prefix}-s, --secret <secret>
${prefix}--timeout <seconds> (default: 86400)
${prefix}--block-keywords <string>
${prefix}--noprogress-keywords <string>
${prefix}--noprogress-piece <int> (default: 5)
${prefix}--noprogress-wait <int> (default: 10)
    Monitors the progress of peers matching the keywords in <noprogress-keywords>. If the upload to the peer exceeds <noprogress-piece> pieces and the peer has not reported progress for <noprogress-wait> times, the peer will be blocked.

${prefix}--flush flush ipset bt_blacklist(6)

-----Advanced Options-----

${prefix}--rpc-no-verify true / false (default: true)

${prefix}--rpc-ca <ca path> / base64 encoded (twice)
${prefix}--rpc-cert <cert path> / base64 encoded (twice)
${prefix}--rpc-key <cert path> / base64 encoded (twice)
Warning: if you use --rpc-ca, --rpc-cert and --rpc-key, you must input them together.
--rpc-no-verify enabled by default when rpc=localhost
https://github.com/makeding/aria2b`)
        process.exit(0)
    }
    if (argv.v || argv.version) {
        console.log(`aria2b v${require('./package.json').version} by huggy`)
        process.exit(0)
    }
    // 载入配置 开始
    // 从 aria2 配置文件自动载入
    config.ipv6 = detectIpv6Enabled()
    let path = argv.c || argv.config || null
    if (!path) {
        if (fs.existsSync(`${process.env.HOME}/.aria2/aria2.conf`)) {
            // 网上的教程一圈都是放这的
            path = `${process.env.HOME}/.aria2/aria2.conf`
        } else if (fs.existsSync('/tmp/etc/aria2/aria2.conf.main')) {
            // openwrt
            path = '/tmp/etc/aria2/aria2.conf.main'
        } else if (fs.existsSync(`/etc/aria2/aria2.conf`)) {
            // 我自己放的地方
            path = `/etc/aria2/aria2.conf`
        } else if (fs.existsSync(`${process.env.PWD}/aria2.conf`)) {
            // 最后从当前目录碰碰运气
            path = `${process.env.PWD}/aria2.conf`
        }
    }
    if (path) {
        await load_config_from_aria2_file(path)
    }
    // cli 给的配置优先度最高
    if (argv.u || argv.url || argv['rpc-url'] || argv.rpcUrl) config.rpc_url = argv.u || argv.url || argv['rpc-url'] || argv.rpcUrl
    if (argv.s || argv.secret) config.secret = argv.s || argv.secret
    if (argv.b || argv['block-keywords']) config.block_keywords = parseList(argv.b || argv['block-keywords'])
    if (argv['noprogress-keywords']) config.noprogress_keywords = parseList(argv['noprogress-keywords'])
    if (argv['noprogress-piece'] !== undefined) applyPositiveIntegerConfig('noprogress_piece', argv['noprogress-piece'])
    if (argv['noprogress-wait'] !== undefined) applyPositiveIntegerConfig('noprogress_wait', argv['noprogress-wait'])
    if (argv.timeout !== undefined) applyPositiveIntegerConfig('timeout', argv.timeout)
    if (argv['rpc-ca']) config.rpc_options.ca = argv['rpc-ca']
    if (argv['rpc-cert']) config.rpc_options.cert = argv['rpc-cert']
    if (argv['rpc-key']) config.rpc_options.key = argv['rpc-key']
    if (argv['rpc-no-verify'] !== undefined) applyNoVerify(argv['rpc-no-verify'])
    ['ca', 'cert', 'key'].forEach(x => {
        if (config.rpc_options[x]) {
            config.rpc_options[x] = readTlsMaterial(config.rpc_options[x], `rpc-${x}`)
        }
    })
    // rpc 为 localhost 默认禁用验证
    // 一个冷知识 127.0.0.1/8 都是 loopback
    if (isLocalHttpsRpcUrl(config.rpc_url)) {
        config.rpc_options.verify = false
    }
    config.rpc_options.rejectUnauthorized = config.rpc_options.verify
    delete config.rpc_options.verify
    r_rpc.defaults.httpsAgent = new https.Agent(config.rpc_options)
    // 载入配置 完毕
    // 这里考虑到有些用户可能在 /etc/sudoers 放行了 ipset 所以这里不再判断是不是有权限用户
    // ~~其实是懒，因为下面运行不成功会报错，大概不需要这一句~~
    // 检查 ipset 配置，如果没有就安排
    let ipset_save = await execFile('ipset', ['save'])
    if (argv.flush || !hasIpset(ipset_save.stdout, 'bt_blacklist')) {
        await flush_iptables_ipset(4)
    }
    if (config.ipv6 && (argv.flush || !hasIpset(ipset_save.stdout, 'bt_blacklist6'))) {
        await flush_iptables_ipset(6)
    }
    // 只刷新表就退出
    if (argv.flush) {
        process.exit(0)
    }
    honsole.log(`${config.rpc_url} secret: ${config.secret.split('').map((x, i) => (i === 0 || i === config.secret.length - 1) ? x : '*').join('')} `)
    honsole.log(`屏蔽客户端列表：${config.block_keywords.join(', ')}`)
    honsole.logt('started!')
    setInterval(() => {
        if (cron_processing_flag) {
            cron()
        }
    }, scan_interval)
    cron()
}
const scan_interval = 5000 // 频率，自己改改，个人感觉不需要太频繁，反正最多被偷一点点流量。单位毫秒
initial().catch(error => {
    honsole.error('启动失败')
    honsole.error(error)
    process.exit(1)
})
/**
 * 从 aria2 配置文件读取配置
 * （写法有点奇妙，可能会有问题）
 * @param {*} path 配置文件路径
 */
async function load_config_from_aria2_file(path) {
    let ssl = false
    let port = 6800
    try {
        fs.readFileSync(path).toString().split('\n').forEach(line => {
            const parsed = parseConfigLine(line)
            if (!parsed) {
                return
            }
            const { key, value } = parsed
            if (key === 'rpc-secret') {
                config.secret = value
            }
            if (key === 'rpc-listen-port') {
                port = value
            }
            if (key === 'rpc-secure') {
                ssl = parseBoolean(value, false)
            }
            if (key === 'disable-ipv6') {
                config.ipv6 = !parseBoolean(value, false)
            }
            if (key === 'ab-bt-ban-client-keywords') {
                config.block_keywords = parseList(value)
            }
            if (key === 'ab-bt-noprogress-keywords') {
                config.noprogress_keywords = parseList(value)
            }
            if (key === 'ab-bt-noprogress-piece') {
                applyPositiveIntegerConfig('noprogress_piece', value)
            }
            if (key === 'ab-bt-noprogress-wait') {
                applyPositiveIntegerConfig('noprogress_wait', value)
            }
            // 信任自签 CA 证书
            if (key === 'ab-rpc-ca') {
                config.rpc_options.ca = value
            }
            // 信任自签 cert 证书
            if (key === 'ab-rpc-cert') {
                config.rpc_options.cert = value
            }
            // 信任需要 key 也提供
            // 查看更多： https://nodejs.org/api/tls.html （cert）
            if (key === 'ab-rpc-key') {
                config.rpc_options.key = value
            }
            // 忽略证书校验
            if (key === 'ab-rpc-no-verify') {
                applyNoVerify(value)
            }
            if (key === 'ab-bt-ban-timeout') {
                applyPositiveIntegerConfig('timeout', value)
            }
        })
        // 都本地读取文件了，说明这边大概是 127.0.0.1 ¿
        config.rpc_url = `http${ssl ? 's' : ''}://127.0.0.1:${port}/jsonrpc`
        honsole.log(`读取配置文件(${path})成功`)
    } catch (error) {
        honsole.error(`读取配置文件(${path})失败，请检查配置文件路径以及格式是否正确`)
        honsole.error(error)
    }
}
/**
 * 重置 ipset / iptables
 */
async function flush_iptables_ipset(ipversion = 4) {
    // 检查 ipset 配置，如果没有就安排
    const suffix = ipversion == 6 ? '6' : ''
    const iptables = ipversion == 6 ? 'ip6tables' : 'iptables'
    const setName = `bt_blacklist${suffix}`
    try {
        // 感觉还不如 if else ....
        await execFileR(iptables, ['-D', 'INPUT', '-m', 'set', '--match-set', setName, 'src', '-j', 'DROP'])
        await execFileR('ipset', ['destroy', setName])
        await execFile('ipset', ['create', setName, 'hash:ip', 'timeout', '600'].concat(ipversion == 6 ? ['family', 'inet6'] : [])) // default 10min = 600s
        await execFile(iptables, ['-I', 'INPUT', '-m', 'set', '--match-set', setName, 'src', '-j', 'DROP'])
        if (argv.flush) {
            honsole.log(`清空 ${setName} 规则成功`)
        }
    } catch (error) {
        honsole.error(error)
        honsole.error('请检查 iptables 与 ipset 是否正常，或者是否以有权限的用户运行的')
        honsole.error('另外也可以试试将 ipset 的 bt_blacklist* 手动删除试试')
        // 规则如果不正常的话程序也没必要运行下去了
        process.exit(1)
    }

}
async function block_ip(ip, c) {
    // ipv6 
    const ipVersion = net.isIP(ip)
    if (!ipVersion) {
        honsole.warn('跳过无效 IP:', ip)
        return
    }
    if (ipVersion === 6 && !config.ipv6) {
        honsole.dev('IPv6 已禁用，跳过:', ip)
        return
    }
    config.timeout = parsePositiveInteger(config.timeout, 86400)
    const setName = ipVersion === 6 ? 'bt_blacklist6' : 'bt_blacklist'
    try {
        // 可能需要 ban 段，不过一般不会有这种情况。
        await execFile('ipset', ['add', setName, ip, 'timeout', String(config.timeout)])
        rememberBlocked(ip)
        honsole.logt('Blocked:', ip, c.origin, c.client, c.version)
    } catch (error) {
        // if(!error.stderr.includes('already added')){
        if (JSON.stringify(error).includes('already added')) {
            rememberBlocked(ip)
        } else {
            console.warn(error)
        }
    }
}
