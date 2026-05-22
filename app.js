#!/usr/bin/env node
/**
 * aria2b — 自动封禁 aria2 中吸血/不受欢迎的 BT 客户端
 * https://github.com/makeding/aria2b
 *
 * 通过 aria2 JSON-RPC 周期性检查 peer，命中策略后调用 ipset/iptables 拉黑 IP。
 * 设计目标：Docker（Alpine + s6 + aria2c）中长期稳定运行，无需人工看日志。
 */
'use strict'

const fs = require('fs')
const os = require('os')
const net = require('net')
const http = require('http')
const https = require('https')
const child_process = require('child_process')
const { promisify } = require('util')
const axios = require('axios')
const getPeerName = require('@huggycn/bittorrent-peerid')

// ============================================================================
// 常量
// ============================================================================

// 'standalone' 字面量由 release.yml 在 esbuild 打包前用 sed 替换成实际版本；
// 开发模式下保留 'standalone'，此时回落读取项目 package.json。
let VERSION = 'standalone'
if (VERSION === 'standalone') {
    try { VERSION = require('./package.json').version } catch (_) { /* 单文件 bundle 无 package.json */ }
}

const DEFAULT_SCAN_INTERVAL = 5000
const MIN_SCAN_INTERVAL = 1000
const MAX_SCAN_INTERVAL = 60000
const RPC_HTTP_TIMEOUT = 30000
const MAX_BACKOFF_DELAY = 60000
const MAX_BLOCKED_IPS = 200000   // ipset hash:ip 默认 65536，本地缓存放宽一些
const MAX_PEER_STATE = 50000     // peer 状态机容量上限（防意外膨胀）
const DEFAULT_TIMEOUT_SECONDS = 86400
const PEER_MIN_UPLOAD_BYTES_PER_SEC = 1024
const IPSET_NAME_V4 = 'bt_blacklist'
const IPSET_NAME_V6 = 'bt_blacklist6'

// ============================================================================
// 默认配置 / 运行时状态
// ============================================================================

function defaultConfig() {
    return {
        rpc_url: 'http://127.0.0.1:6800/jsonrpc',
        rpc_options: { rejectUnauthorized: true },
        secret: '',
        timeout: DEFAULT_TIMEOUT_SECONDS,
        scan_interval: DEFAULT_SCAN_INTERVAL,
        block_keywords: ['XL', 'SD', 'XF', 'QD', 'BN'],
        noprogress_keywords: ['XL', 'SD', 'XF', 'QD', 'BN', 'Unknown'],
        noprogress_piece: 5,
        noprogress_wait: 10,
        ipv6: false
    }
}

const config = defaultConfig()
const blockedIps = new Map()   // ip -> expiresAtMs（本进程缓存，避免重复 ipset add）
const peerState = new Map()    // peerStateKey -> { uploaded, wait }

let argv = {}
let rpcClient = null
let consecutiveFailures = 0
let shuttingDown = false
let scanTimer = null
let cronInflight = null

// 间接层：测试时可替换 execFile，便于在没有 ipset 的环境验证调用
const runtime = {
    execFile: promisify(child_process.execFile)
}

// ============================================================================
// logger
// ============================================================================

const honsole = {
    dev(...a) { if (process.env.DEV) console.log('[aria2b]', ...a) },
    log(...a) { console.log('[aria2b]', ...a) },
    logt(...a) {
        if (process.env.HIDE_TIME_PREFIX) console.log('[aria2b]', ...a)
        else console.log('[aria2b]', new Date().toLocaleString('zh'), ...a)
    },
    error(...a) { console.error('[aria2b]', ...a) },
    warn(...a) { console.warn('[aria2b]', ...a)  }
}

// ============================================================================
// 解析 / 转换工具
// ============================================================================

function decodePercentEncodedString(s) {
    if (!s) return 'Unknown'
    let ret = ''
    for (let i = 0; i < s.length; i++) {
        const ch = s.charAt(i)
        if (ch === '%' && i < s.length - 2) {
            const parsed = parseInt(s.substring(i + 1, i + 3), 16)
            if (!Number.isNaN(parsed)) {
                ret += String.fromCharCode(parsed)
                i += 2
            } else {
                ret += ch
            }
        } else {
            ret += ch
        }
    }
    return ret
}

function decodeClient(str) {
    return String(str || '').replace(/%[0-9A-Fa-f]{2}/g, m => {
        const code = parseInt(m.slice(1), 16)
        return (code >= 32 && code <= 126) ? String.fromCharCode(code) : m
    })
}

function countOnes(hexString) {
    if (!hexString || typeof hexString !== 'string') return 0
    let count = 0
    for (let i = 0; i < hexString.length; i++) {
        const n = parseInt(hexString[i], 16)
        if (Number.isNaN(n)) continue
        let v = n
        while (v) { v &= v - 1; count++ }
    }
    return count
}

function parseList(value) {
    return String(value || '')
        .split(',')
        .map(x => x.trim())
        .filter(Boolean)
}

function parsePositiveInteger(value, fallback) {
    const n = Number(value)
    return (Number.isInteger(n) && n > 0) ? n : fallback
}

function parseBoolean(value, fallback = true) {
    if (value === undefined || value === null || value === '') return fallback
    if (typeof value === 'boolean') return value
    const v = String(value).trim().toLowerCase()
    if (['1', 'true', 'yes', 'on'].includes(v)) return true
    if (['0', 'false', 'no', 'off'].includes(v)) return false
    return fallback
}

function hasUnknownKeyword(keywords) {
    return keywords.some(k => String(k).toLowerCase() === 'unknown')
}

function keywordMatches(keywords, origin) {
    const text = String(origin || '')
    for (const k of keywords) {
        if (!k || String(k).toLowerCase() === 'unknown') continue
        if (text.includes(k)) return true
    }
    return false
}

function peerStateKey(peer, gid) {
    return `${gid}\0${peer.peerId || ''}\0${peer.ip || ''}`
}

function parseConfigLine(line) {
    const t = line.trim()
    if (!t || t.startsWith('#')) return null
    const i = t.indexOf('=')
    if (i === -1) return null
    return { key: t.slice(0, i).trim(), value: t.slice(i + 1).trim() }
}

function readTlsMaterial(value, name) {
    const input = String(value || '').trim()
    if (!input) return input
    if (fs.existsSync(input)) return fs.readFileSync(input)
    if (input.length > 100 && /^[A-Za-z0-9+/=\r\n]+$/.test(input)) return Buffer.from(input, 'base64')
    throw new Error(`${name} 指向的文件不存在，且不像 base64 内容: ${input}`)
}

function detectIpv6Enabled() {
    try {
        if (fs.existsSync('/sys/module/ipv6/parameters/disable')) {
            return fs.readFileSync('/sys/module/ipv6/parameters/disable', 'utf8').trim() === '0'
        }
        return fs.existsSync('/proc/net/if_inet6')
    } catch (e) {
        honsole.dev('detectIpv6Enabled:', e)
        return false
    }
}

function isLocalHttpsRpcUrl(url) {
    let u
    try { u = new URL(url) }
    catch (_) { throw new Error(`rpc url 格式不正确: ${url}`) }
    if (u.protocol !== 'https:') return false
    // WHATWG URL 对 IPv6 字面量保留方括号
    const host = u.hostname.replace(/^\[|\]$/g, '')
    return host === 'localhost' || host === '::1' || host.startsWith('127.')
}

function hasIpset(saveOutput, setName) {
    if (!saveOutput) return false
    for (const line of saveOutput.split('\n')) {
        if (line.trim().startsWith(`create ${setName} `)) return true
    }
    return false
}

/**
 * 把 axios/Node 错误压缩成短字符串，关键作用：避免把请求体里的
 * `token:secret` 写到日志。容器场景下日志常被采集，这里必须脱敏。
 */
function sanitizeError(e) {
    if (!e) return 'unknown error'
    if (typeof e === 'string') return e
    if (e.code === 'ECONNREFUSED') {
        const addr = (e.address && e.port) ? `${e.address}:${e.port}` : ''
        return `RPC 拒绝连接 ${addr}`.trim()
    }
    if (e.code === 'ECONNRESET') return 'RPC 连接被重置'
    if (e.code === 'ETIMEDOUT' || e.code === 'ECONNABORTED') return 'RPC 请求超时'
    if (e.code === 'ENOTFOUND') return `RPC 域名解析失败: ${e.hostname || ''}`
    if (e.code === 'EHOSTUNREACH') return 'RPC 主机不可达'
    if (e.response) {
        const { status, statusText } = e.response
        return `HTTP ${status} ${statusText || ''}`.trim()
    }
    return e.message || 'unknown error'
}

function maskSecret(s) {
    const str = String(s || '')
    if (str.length <= 2) return str
    return str[0] + '*'.repeat(Math.max(1, str.length - 2)) + str[str.length - 1]
}

// ============================================================================
// 状态管理（有容量上限，避免长期运行内存膨胀）
// ============================================================================

function getPeerState(key) {
    let s = peerState.get(key)
    if (!s) {
        if (peerState.size >= MAX_PEER_STATE) {
            const first = peerState.keys().next().value
            if (first !== undefined) peerState.delete(first)
        }
        s = { uploaded: 0, wait: 0 }
        peerState.set(key, s)
    }
    return s
}

function cleanupPeerState(activeKeys) {
    for (const key of peerState.keys()) {
        if (!activeKeys.has(key)) peerState.delete(key)
    }
}

function isBlocked(ip) {
    const exp = blockedIps.get(ip)
    if (!exp) return false
    if (exp <= Date.now()) { blockedIps.delete(ip); return false }
    return true
}

function rememberBlocked(ip) {
    if (blockedIps.size >= MAX_BLOCKED_IPS && !blockedIps.has(ip)) {
        const first = blockedIps.keys().next().value
        if (first !== undefined) blockedIps.delete(first)
    }
    blockedIps.set(ip, Date.now() + config.timeout * 1000)
}

function cleanupBlockedIps() {
    const now = Date.now()
    for (const [ip, exp] of blockedIps) {
        if (exp <= now) blockedIps.delete(ip)
    }
}

// ============================================================================
// RPC
// ============================================================================

function makeRpcClient() {
    const agentOpts = { keepAlive: true, keepAliveMsecs: 30000, maxSockets: 4 }
    return axios.create({
        timeout: RPC_HTTP_TIMEOUT,
        httpAgent: new http.Agent(agentOpts),
        httpsAgent: new https.Agent({ ...agentOpts, ...config.rpc_options }),
        // 默认情况下，axios 在 status >= 400 时会抛错；让它抛，由上层处理
        // 关闭自动 transform 也无所谓，性能影响很小
        maxContentLength: 64 * 1024 * 1024,
        maxBodyLength: 64 * 1024 * 1024
    })
}

let _rpcIdCounter = 0
function rpcId() {
    _rpcIdCounter = (_rpcIdCounter + 1) >>> 0
    return `aria2b-${_rpcIdCounter}`
}

async function rpcCall(method, params = []) {
    const body = {
        jsonrpc: '2.0',
        id: rpcId(),
        method,
        params: [`token:${config.secret}`, ...params]
    }
    const { data } = await rpcClient.post(config.rpc_url, body)
    if (data && data.error) {
        const msg = data.error.message || 'unknown'
        const err = new Error(`aria2 RPC ${method} 错误：${msg}`)
        err.rpcError = data.error
        throw err
    }
    return data ? data.result : undefined
}

async function rpcMulticall(calls) {
    if (!calls.length) return []
    const wrapped = calls.map(c => ({
        methodName: c.method,
        params: [`token:${config.secret}`, ...(c.params || [])]
    }))
    const body = {
        jsonrpc: '2.0',
        id: rpcId(),
        method: 'system.multicall',
        params: [wrapped]
    }
    const { data } = await rpcClient.post(config.rpc_url, body)
    if (data && data.error) {
        throw new Error(`aria2 system.multicall 错误：${data.error.message || 'unknown'}`)
    }
    return (data && Array.isArray(data.result)) ? data.result : []
}

// ============================================================================
// ipset / iptables
// ============================================================================

async function flushIptablesIpset(version) {
    const iptables = version === 6 ? 'ip6tables' : 'iptables'
    const setName = version === 6 ? IPSET_NAME_V6 : IPSET_NAME_V4
    try {
        // 删除旧规则与 ipset；首次运行没有这些是正常的，吞错误
        await runtime.execFile(iptables, ['-D', 'INPUT', '-m', 'set', '--match-set', setName, 'src', '-j', 'DROP']).catch(() => {})
        await runtime.execFile('ipset', ['destroy', setName]).catch(() => {})

        const createArgs = ['create', setName, 'hash:ip', 'timeout', String(config.timeout)]
        if (version === 6) createArgs.push('family', 'inet6')
        await runtime.execFile('ipset', createArgs)
        await runtime.execFile(iptables, ['-I', 'INPUT', '-m', 'set', '--match-set', setName, 'src', '-j', 'DROP'])

        honsole.log(`已初始化 ${setName}（IPv${version}）`)
    } catch (e) {
        honsole.error(`初始化 ${setName} 失败：${sanitizeError(e)}`)
        honsole.error('请确认：容器具备 NET_ADMIN，已安装 iptables/ipset，且内核已加载对应模块')
        throw e
    }
}

/**
 * 从 `ipset save` 输出中把已存在的 IP 同步到本地缓存。
 * 进程重启后避免对已封 IP 再次 `ipset add`，减少子进程开销与日志噪音。
 */
function syncBlockedIpsFromIpset(saveOutput) {
    if (!saveOutput) return 0
    let count = 0
    for (const line of saveOutput.split('\n')) {
        const t = line.trim()
        if (!t.startsWith('add ')) continue
        const parts = t.split(/\s+/)
        if (parts.length < 3) continue
        const setName = parts[1]
        if (setName !== IPSET_NAME_V4 && setName !== IPSET_NAME_V6) continue
        const ip = parts[2]
        if (!net.isIP(ip)) continue
        const idx = parts.indexOf('timeout')
        const remain = (idx >= 0 && parts[idx + 1] !== undefined) ? Number(parts[idx + 1]) : config.timeout
        const remainSec = (Number.isFinite(remain) && remain > 0) ? remain : config.timeout
        if (blockedIps.size >= MAX_BLOCKED_IPS) break
        blockedIps.set(ip, Date.now() + remainSec * 1000)
        count++
    }
    return count
}

async function blockIp(ip, info) {
    const v = net.isIP(ip)
    if (!v) { honsole.warn('跳过无效 IP:', ip); return }
    if (v === 6 && !config.ipv6) { honsole.dev('IPv6 已禁用，跳过:', ip); return }

    const setName = v === 6 ? IPSET_NAME_V6 : IPSET_NAME_V4
    try {
        // -exist 让重复添加也刷新 timeout，本地缓存与 ipset 时钟保持一致
        await runtime.execFile('ipset', ['add', '-exist', setName, ip, 'timeout', String(config.timeout)])
        rememberBlocked(ip)
        honsole.logt('Blocked:', ip, info.origin || '', info.client || '', info.version || '')
    } catch (e) {
        honsole.warn('封禁失败:', ip, sanitizeError(e))
    }
}

// ============================================================================
// cron 主扫描
// ============================================================================

function processOnePeer(peer, gid, status, activeKeys, banQueue) {
    const stateKey = peerStateKey(peer, gid)
    activeKeys.add(stateKey)

    if (isBlocked(peer.ip)) return

    const decoded = decodePercentEncodedString(peer.peerId)
    const c = getPeerName(decoded) || { client: 'unknown', origin: '', version: '' }
    const bitprogress = countOnes(peer.bitfield)
    let toBlock = false

    if (keywordMatches(config.block_keywords, c.origin)) {
        toBlock = true
    } else {
        const isNoProgTarget =
            (hasUnknownKeyword(config.noprogress_keywords) && c.client === 'unknown') ||
            keywordMatches(config.noprogress_keywords, c.origin)
        const uploadSpeed = Number(peer.uploadSpeed) || 0
        const downloadSpeed = Number(peer.downloadSpeed) || 0
        const pieceLength = Number(status.pieceLength) || 0

        // pieceLength 不可知就跳过 noprogress 判定。
        // 旧版兜底为 1，等于把字节当 piece 算，几个字节就触发误封。
        if (isNoProgTarget && uploadSpeed > PEER_MIN_UPLOAD_BYTES_PER_SEC && bitprogress === 0 && pieceLength > 0) {
            const s = getPeerState(stateKey)
            s.uploaded += uploadSpeed * config.scan_interval / 1000
            const uploadPiece = s.uploaded / pieceLength
            if (uploadPiece > config.noprogress_piece) {
                if (downloadSpeed === 0) {
                    s.wait += 1
                    if (s.wait > config.noprogress_wait) {
                        const human = decodeClient(peer.peerId).substring(0, 16).padEnd(16, ' ')
                        const np = Number(status.numPieces) || 0
                        honsole.log(`往 ${human}（${peer.ip}）传输了 ${uploadPiece.toFixed(2)} 个 piece，但它声称进度 ${bitprogress}/${np}，累犯 ${s.wait} 次，ban 了`)
                        toBlock = true
                    }
                } else {
                    s.wait = 0
                }
            }
        } else {
            peerState.delete(stateKey)
        }
    }

    if (!toBlock) return

    if (hasUnknownKeyword(config.block_keywords) && c.client === 'unknown') {
        banQueue.push({ ip: peer.ip, info: { origin: 'Unknown', client: '', version: '' } })
    } else {
        banQueue.push({ ip: peer.ip, info: c })
    }
}

async function cron() {
    if (shuttingDown) return
    const activeKeys = new Set()
    const banQueue = []
    let fullySucceeded = false

    try {
        // 1) 拿活跃任务 gid 列表
        const active = await rpcCall('aria2.tellActive', [['gid']])
        const gids = Array.isArray(active) ? active.map(t => t && t.gid).filter(Boolean) : []

        // 2) 一次 multicall 把所有 tellStatus + getPeers 拿回
        //    旧版每个 torrent 单独跑 2 个 multicall（且只塞一条调用），完全没用上批量
        let results = []
        if (gids.length > 0) {
            const calls = []
            for (const gid of gids) {
                calls.push({ method: 'aria2.tellStatus', params: [gid, ['numPieces', 'pieceLength']] })
                calls.push({ method: 'aria2.getPeers',  params: [gid] })
            }
            results = await rpcMulticall(calls)
        }

        // 3) 解析处理
        for (let i = 0; i < gids.length; i++) {
            const gid = gids[i]
            // multicall 子调用：成功返回 [result]，失败返回 { faultCode, faultString }
            const statusRes = results[i * 2]
            const peersRes  = results[i * 2 + 1]
            const status = Array.isArray(statusRes) ? (statusRes[0] || {}) : {}
            const peers  = Array.isArray(peersRes)  ? (peersRes[0]  || []) : []
            if (!Array.isArray(peers)) continue
            for (const peer of peers) {
                if (!peer || !peer.ip) continue
                processOnePeer(peer, gid, status, activeKeys, banQueue)
            }
        }

        // 4) 顺序 ban，避免对 ipset 子进程的并发竞争
        for (const { ip, info } of banQueue) {
            if (shuttingDown) break
            await blockIp(ip, info)
        }

        consecutiveFailures = 0
        fullySucceeded = true
    } catch (e) {
        consecutiveFailures += 1
        // 抑制刷屏：只在 1/2/5/10/20/30… 次失败时打日志
        if (consecutiveFailures === 1 || consecutiveFailures === 2 ||
            consecutiveFailures === 5 || consecutiveFailures % 10 === 0) {
            honsole.error(`扫描失败（连续 ${consecutiveFailures} 次）：${sanitizeError(e)}`)
        }
    } finally {
        // 只在完全成功时清理 peerState：
        // 部分失败时活跃集合不完整，全清会把 noprogress 累计计数白白重置
        if (fullySucceeded) cleanupPeerState(activeKeys)
        cleanupBlockedIps()
    }
}

function backoffDelay() {
    if (consecutiveFailures === 0) return config.scan_interval
    const factor = Math.min(consecutiveFailures, 6)
    return Math.min(MAX_BACKOFF_DELAY, config.scan_interval * (1 << factor))
}

function scheduleNext() {
    if (shuttingDown) return
    scanTimer = setTimeout(runLoop, backoffDelay())
    if (typeof scanTimer.unref === 'function') scanTimer.unref()
}

async function runLoop() {
    scanTimer = null
    cronInflight = cron()
    try { await cronInflight } catch (_) { /* cron 内部已经吞了所有错误 */ }
    cronInflight = null
    scheduleNext()
}

// ============================================================================
// 配置加载
// ============================================================================

function applyPositiveIntegerConfig(name, value) {
    const p = parsePositiveInteger(value, null)
    if (p === null) { honsole.warn(`${name}=${value} 不是有效正整数，已忽略`); return }
    config[name] = p
}

function applyNoVerify(value) {
    const noVerify = parseBoolean(value, true)
    config.rpc_options.rejectUnauthorized = !noVerify
}

function loadConfigFromAria2File(path) {
    let ssl = false
    let port = 6800
    let text
    try { text = fs.readFileSync(path, 'utf8') }
    catch (e) {
        honsole.error(`读取配置文件 (${path}) 失败：${sanitizeError(e)}`)
        return false
    }
    for (const line of text.split('\n')) {
        const p = parseConfigLine(line)
        if (!p) continue
        const { key, value } = p
        switch (key) {
            case 'rpc-secret':                  config.secret = value; break
            case 'rpc-listen-port':             { const n = parsePositiveInteger(value, null); if (n) port = n; break }
            case 'rpc-secure':                  ssl = parseBoolean(value, false); break
            case 'disable-ipv6':                config.ipv6 = !parseBoolean(value, false); break
            case 'ab-bt-ban-client-keywords':   config.block_keywords = parseList(value); break
            case 'ab-bt-noprogress-keywords':   config.noprogress_keywords = parseList(value); break
            case 'ab-bt-noprogress-piece':      applyPositiveIntegerConfig('noprogress_piece', value); break
            case 'ab-bt-noprogress-wait':       applyPositiveIntegerConfig('noprogress_wait', value); break
            case 'ab-bt-ban-timeout':           applyPositiveIntegerConfig('timeout', value); break
            case 'ab-bt-scan-interval':         applyPositiveIntegerConfig('scan_interval', value); break
            case 'ab-rpc-ca':                   config.rpc_options.ca = value; break
            case 'ab-rpc-cert':                 config.rpc_options.cert = value; break
            case 'ab-rpc-key':                  config.rpc_options.key = value; break
            case 'ab-rpc-no-verify':            applyNoVerify(value); break
        }
    }
    config.rpc_url = `http${ssl ? 's' : ''}://127.0.0.1:${port}/jsonrpc`
    honsole.log(`读取配置文件 (${path}) 成功`)
    return true
}

function findAria2Config() {
    const home = os.homedir()
    const candidates = [
        home ? `${home}/.aria2/aria2.conf` : null,
        '/tmp/etc/aria2/aria2.conf.main',
        '/etc/aria2/aria2.conf',
        `${process.cwd()}/aria2.conf`
    ].filter(Boolean)
    for (const p of candidates) {
        try { if (fs.existsSync(p)) return p } catch (_) { /* ignore */ }
    }
    return null
}

/**
 * 极简 CLI 解析器。支持：
 *   --key value      --key=value      --key（无值视为 true）
 *   -k value         -kv 不支持（避免歧义）
 * 数字串自动转 Number；short alias 映射到 long key（保持 kebab-case）。
 * 自行实现是为了：① 砍掉 yargs-parser 依赖让 bundle 真正自包含；
 *                  ② 简单、稳定、可测、零运行时风险。
 */
const ARG_ALIAS = {
    c: 'config', u: 'url', s: 'secret', b: 'block-keywords',
    h: 'help', v: 'version'
}

function _coerceNumeric(s) {
    if (typeof s !== 'string' || s === '') return s
    if (!/^-?\d+(\.\d+)?$/.test(s)) return s
    const n = Number(s)
    return Number.isFinite(n) ? n : s
}

function parseArgv(args) {
    const out = { _: [] }
    for (let i = 0; i < args.length; i++) {
        const a = args[i]
        if (typeof a !== 'string') continue
        if (!a.startsWith('-') || a === '-' || a === '--') { out._.push(a); continue }
        let key, val
        if (a.startsWith('--')) {
            const eq = a.indexOf('=')
            if (eq >= 0) {
                key = a.slice(2, eq)
                val = _coerceNumeric(a.slice(eq + 1))
            } else {
                key = a.slice(2)
                const next = args[i + 1]
                if (next !== undefined && (typeof next !== 'string' || !next.startsWith('-'))) {
                    val = _coerceNumeric(next); i++
                } else {
                    val = true
                }
            }
        } else {
            const shortKey = a.slice(1)
            key = ARG_ALIAS[shortKey] || shortKey
            const next = args[i + 1]
            if (next !== undefined && (typeof next !== 'string' || !next.startsWith('-'))) {
                val = _coerceNumeric(next); i++
            } else {
                val = true
            }
        }
        out[key] = val
    }
    return out
}

function applyCliConfig() {
    const v = argv
    if (v.url || v['rpc-url']) config.rpc_url = v.url || v['rpc-url']
    if (v.secret !== undefined) config.secret = String(v.secret)
    if (v['block-keywords']) config.block_keywords = parseList(v['block-keywords'])
    if (v['noprogress-keywords']) config.noprogress_keywords = parseList(v['noprogress-keywords'])
    if (v['noprogress-piece'] !== undefined) applyPositiveIntegerConfig('noprogress_piece', v['noprogress-piece'])
    if (v['noprogress-wait']  !== undefined) applyPositiveIntegerConfig('noprogress_wait',  v['noprogress-wait'])
    if (v.timeout !== undefined) applyPositiveIntegerConfig('timeout', v.timeout)
    if (v['scan-interval'] !== undefined) applyPositiveIntegerConfig('scan_interval', v['scan-interval'])
    if (v['rpc-ca'])   config.rpc_options.ca   = v['rpc-ca']
    if (v['rpc-cert']) config.rpc_options.cert = v['rpc-cert']
    if (v['rpc-key'])  config.rpc_options.key  = v['rpc-key']
    if (v['rpc-no-verify'] !== undefined) applyNoVerify(v['rpc-no-verify'])

    for (const x of ['ca', 'cert', 'key']) {
        if (config.rpc_options[x]) {
            config.rpc_options[x] = readTlsMaterial(config.rpc_options[x], `rpc-${x}`)
        }
    }

    // 本地 https 默认关验证；用户显式给了 --rpc-no-verify 时尊重用户
    if (v['rpc-no-verify'] === undefined && isLocalHttpsRpcUrl(config.rpc_url)) {
        config.rpc_options.rejectUnauthorized = false
    }

    config.scan_interval = Math.max(MIN_SCAN_INTERVAL, Math.min(MAX_SCAN_INTERVAL, config.scan_interval))
}

function helpText() {
    const name = process.argv0 === 'node' ? 'node app.js' : 'aria2b'
    const pad = ' '.repeat(name.length + 1)
    return `aria2b v${VERSION} by huggy

${name} -c, --config <aria2 config path>
${pad}-u, --url <rpc url> (default: http://127.0.0.1:6800/jsonrpc)
${pad}-s, --secret <secret>
${pad}--timeout <seconds> (default: 86400)
${pad}--scan-interval <ms> (default: 5000, range: 1000-60000)
${pad}--block-keywords <string>
${pad}--noprogress-keywords <string>
${pad}--noprogress-piece <int> (default: 5)
${pad}--noprogress-wait  <int> (default: 10)
${pad}--flush flush ipset ${IPSET_NAME_V4}(6) and exit

----- Advanced -----
${pad}--rpc-no-verify <true|false> (default: true when rpc=localhost https)
${pad}--rpc-ca   <path or base64>
${pad}--rpc-cert <path or base64>
${pad}--rpc-key  <path or base64>
${pad}-h, --help / -v, --version

Env:
  DEV=1               输出 debug 日志
  HIDE_TIME_PREFIX=1  日志不带时间前缀（方便外部加时间）

https://github.com/makeding/aria2b`
}

// ============================================================================
// 信号 / 异常处理
// ============================================================================

function installSignalHandlers() {
    const stop = async (signal) => {
        if (shuttingDown) return
        shuttingDown = true
        honsole.log(`收到 ${signal}，等待当前扫描结束后退出`)
        if (scanTimer) { clearTimeout(scanTimer); scanTimer = null }
        if (cronInflight) {
            try { await cronInflight } catch (_) { /* ignore */ }
        }
        process.exit(0)
    }
    process.on('SIGTERM', () => { stop('SIGTERM').catch(() => process.exit(0)) })
    process.on('SIGINT',  () => { stop('SIGINT').catch(()  => process.exit(0)) })
    process.on('SIGHUP',  () => { stop('SIGHUP').catch(()  => process.exit(0)) })
    process.on('uncaughtException', e => {
        try { honsole.error('uncaughtException:', sanitizeError(e)) } catch (_) {}
        process.exit(1)
    })
    process.on('unhandledRejection', e => {
        try { honsole.error('unhandledRejection:', sanitizeError(e)) } catch (_) {}
        process.exit(1)
    })
}

// ============================================================================
// 入口
// ============================================================================

async function initial() {
    argv = parseArgv(process.argv.slice(2))

    if (argv.help)    { console.log(helpText()); return }
    if (argv.version) { console.log(`aria2b v${VERSION} by huggy`); return }

    config.ipv6 = detectIpv6Enabled()

    const cfgPath = argv.config || findAria2Config()
    if (cfgPath) loadConfigFromAria2File(cfgPath)

    applyCliConfig()

    rpcClient = makeRpcClient()

    // 读 ipset 当前状态
    let ipsetSave = ''
    try {
        const r = await runtime.execFile('ipset', ['save'])
        ipsetSave = r.stdout || ''
    } catch (e) {
        honsole.error(`执行 ipset save 失败：${sanitizeError(e)}`)
        honsole.error('请确认容器具备 NET_ADMIN 能力且已安装 ipset')
        process.exit(1)
    }

    if (argv.flush || !hasIpset(ipsetSave, IPSET_NAME_V4)) {
        await flushIptablesIpset(4)
    }
    if (config.ipv6 && (argv.flush || !hasIpset(ipsetSave, IPSET_NAME_V6))) {
        await flushIptablesIpset(6)
    }
    if (argv.flush) {
        honsole.log('已清空 ipset/iptables 规则')
        return
    }

    // 启动时把 ipset 中已存在的 IP 同步进本地缓存
    try {
        const r = await runtime.execFile('ipset', ['save'])
        const synced = syncBlockedIpsFromIpset(r.stdout || '')
        if (synced > 0) honsole.log(`已从 ipset 同步 ${synced} 个已封禁 IP 到本地缓存`)
    } catch (_) { /* 同步失败不致命 */ }

    honsole.log(`${config.rpc_url} secret: ${maskSecret(config.secret)}`)
    honsole.log(`屏蔽客户端：${config.block_keywords.join(', ')}`)
    honsole.log(`监视进度：${config.noprogress_keywords.join(', ')}（>${config.noprogress_piece} pieces，累犯 ${config.noprogress_wait} 次）`)
    honsole.log(`扫描间隔 ${config.scan_interval}ms，封禁时长 ${config.timeout}s，IPv6 ${config.ipv6 ? '启用' : '禁用'}`)
    honsole.logt('started!')

    installSignalHandlers()
    runLoop()
}

if (require.main === module) {
    initial().catch(e => {
        try { honsole.error('启动失败：', sanitizeError(e)) } catch (_) {}
        process.exit(1)
    })
}

// 测试入口：仅暴露内部，不应被生产代码依赖
module.exports = {
    _internal: {
        // state
        config, blockedIps, peerState, runtime,
        defaultConfig,
        // helpers
        decodePercentEncodedString, decodeClient, countOnes,
        parseList, parsePositiveInteger, parseBoolean,
        hasUnknownKeyword, keywordMatches,
        peerStateKey, parseConfigLine, readTlsMaterial,
        isLocalHttpsRpcUrl, hasIpset,
        sanitizeError, maskSecret,
        // state mgmt
        getPeerState, cleanupPeerState,
        isBlocked, rememberBlocked, cleanupBlockedIps,
        syncBlockedIpsFromIpset,
        // CLI
        parseArgv, applyCliConfig, applyNoVerify, loadConfigFromAria2File,
        // ipset / iptables
        flushIptablesIpset, blockIp,
        // cron
        processOnePeer, cron, backoffDelay,
        // 状态控制（测试用）
        _reset() {
            blockedIps.clear()
            peerState.clear()
            Object.assign(config, defaultConfig())
            consecutiveFailures = 0
            shuttingDown = false
        },
        _getFailures() { return consecutiveFailures },
        _setFailures(n) { consecutiveFailures = n },
        _setArgv(v) { argv = v },
        _getArgv() { return argv },
        _setRpcClient(c) { rpcClient = c },
        _makeRpcClient: makeRpcClient
    }
}
