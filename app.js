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
const RPC_MAX_BODY_BYTES = 64 * 1024 * 1024
const IPSET_SAVE_MAX_BUFFER_BYTES = 32 * 1024 * 1024
const MAX_BACKOFF_DELAY = 60000
const MAX_BLOCKED_IPS = 200000   // ipset hash:ip 默认 65536，本地缓存放宽一些
const MAX_PEER_STATE = 50000     // peer 状态机容量上限（防意外膨胀）
const DEFAULT_TIMEOUT_SECONDS = 86400
const PEER_MIN_UPLOAD_BYTES_PER_SEC = 1024
const IPSET_NAME_V4 = 'bt_blacklist'
const IPSET_NAME_V6 = 'bt_blacklist6'

// ============================================================================
// BitTorrent peerId 识别
// ============================================================================

/*!
 * Portions of this file are derived from @huggycn/bittorrent-peerid@1.3.4,
 * based on bittorrent-peerid: https://github.com/webtorrent/bittorrent-peerid
 *
 * aria2b 依赖其 fork 增加的 origin 字段做封禁关键词匹配；保持内置可以减少
 * 运行时供应链暴露面，并继续满足单文件、自包含分发约束。
 *
 * The MIT License (MIT)
 *
 * Copyright (c) Travis Fischer and WebTorrent, LLC
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

const peerIdUtils = {
  isAzStyle(peerId) {
    if (peerId.charAt(0) !== '-') return false
    if (peerId.charAt(7) === '-') return true

    /**
     * Hack for FlashGet - it doesn't use the trailing dash.
     * Also, LH-ABC has strayed into "forgetting about the delimiter" territory.
     *
     * In fact, the code to generate a peer ID for LH-ABC is based on BitTornado's,
     * yet tries to give an Az style peer ID... oh dear.
     *
     * BT Next Evolution seems to be in the same boat as well.
     *
     * KTorrent 3 appears to use a dash rather than a final character.
     */
    if (['FG', 'LH', 'NE', 'KT', 'SP'].includes(peerId.substring(1, 3))) return true

    return false
  },

  /**
   * Checking whether a peer ID is Shadow style or not is a bit tricky.
   *
   * The BitTornado peer ID convention code is explained here:
   *   http://forums.degreez.net/viewtopic.php?t=7070
   *
   * The main thing we are interested in is the first six characters.
   * Although the other characters are base64 characters, there's no
   * guarantee that other clients which follow that style will follow
   * that convention (though the fact that some of these clients use
   * BitTornado in the core does blur the lines a bit between what is
   * "style" and what is just common across clients).
   *
   * So if we base it on the version number information, there's another
   * problem - there isn't the use of absolute delimiters (no fixed dash
   * character, for example).
   *
   * There are various things we can do to determine how likely the peer
   * ID is to be of that style, but for now, I'll keep it to a relatively
   * simple check.
   *
   * We'll assume that no client uses the fifth version digit, so we'll
   * expect a dash. We'll also assume that no client has reached version 10
   * yet, so we expect the first two characters to be "letter,digit".
   *
   * We've seen some clients which don't appear to contain any version
   * information, so we need to allow for that.
   */
  isShadowStyle(peerId) {
    if (peerId.charAt(5) !== '-') return false
    if (!isLetter(peerId.charAt(0))) return false
    if (!(isDigit(peerId.charAt(1)) || peerId.charAt(1) === '-')) return false

    // Find where the version number string ends.
    let lastVersionNumberIndex = 4
    for (; lastVersionNumberIndex > 0; lastVersionNumberIndex--) {
      if (peerId.charAt(lastVersionNumberIndex) !== '-') break
    }

    // For each digit in the version string, check if it is a valid version identifier.
    for (let i = 1; i <= lastVersionNumberIndex; i++) {
      const c = peerId.charAt(i)
      if (c === '-') return false
      if (isAlphaNumeric(c) === null) return false
    }

    return true
  },

  isMainlineStyle(peerId) {
    /**
     * One of the following styles will be used:
     *   Mx-y-z--
     *   Mx-yy-z-
     */
    return peerId.charAt(2) === '-' && peerId.charAt(7) === '-' &&
      (peerId.charAt(4) === '-' || peerId.charAt(5) === '-')
  },

  isPossibleSpoofClient(peerId) {
    return peerId.endsWith('UDP0') || peerId.endsWith('HTTPBT')
  },

  decodeNumericValueOfByte,

  getAzStyleVersionNumber(peerId, version) {
    if (typeof version === 'function') {
      return version(peerId)
    }
    return null
  },

  getShadowStyleVersionNumber(peerId) {
    // TODO
    return null
  },

  decodeBitSpiritClient(peerId, buffer) {
    if (peerId.substring(2, 4) !== 'BS') return null
    let version = `${buffer[1]}`
    if (version === '0') version = 1

    return {
      origin: peerId.substring(2, 4),
      client: 'BitSpirit',
      version
    }
  },

  decodeBitCometClient(peerId, buffer) {
    let modName = ''
    if (peerId.startsWith('exbc')) modName = ''
    else if (peerId.startsWith('FUTB')) modName = '(Solidox Mod)'
    else if (peerId.startsWith('xUTB')) modName = '(Mod 2)'
    else return null

    const isBitlord = (peerId.substring(6, 10) === 'LORD')

    // Older versions of BitLord are of the form x.yy, whereas new versions (1 and onwards),
    // are of the form x.y. BitComet is of the form x.yy
    const clientName = (isBitlord) ? 'BitLord' : 'BitComet'
    const majVersion = decodeNumericValueOfByte(buffer[4])
    const minVersionLength = (isBitlord && majVersion !== '0' ? 1 : 2)

    return {
      origin: clientName + (modName ? ` ${modName}` : ''),
      client: clientName + (modName ? ` ${modName}` : ''),
      version: `${majVersion}.${decodeNumericValueOfByte(buffer[5], minVersionLength)}`
    }
  },

  identifyAwkwardClient(peerId, buffer) {
    let firstNonZeroIndex = 20
    let i

    for (i = 0; i < 20; ++i) {
      if (buffer[i] > 0) {
        firstNonZeroIndex = i
        break
      }
    }

    // Shareaza check
    if (firstNonZeroIndex === 0) {
      let isShareaza = true
      for (i = 0; i < 16; ++i) {
        if (buffer[i] === 0) {
          isShareaza = false
          break
        }
      }

      if (isShareaza) {
        for (i = 16; i < 20; ++i) {
          if (buffer[i] !== (buffer[i % 16] ^ buffer[15 - (i % 16)])) {
            isShareaza = false
            break
          }
        }

        if (isShareaza) return { client: 'Shareaza' }
      }
    }

    if (firstNonZeroIndex === 9 && buffer[9] === 3 && buffer[10] === 3 && buffer[11] === 3) { return { origin: 'I2PSnark', client: 'I2PSnark' } }

    if (firstNonZeroIndex === 12 && buffer[12] === 97 && buffer[13] === 97) { return { origin: 'Experimental', client: 'Experimental', version: '3.2.1b2' } }

    if (firstNonZeroIndex === 12 && buffer[12] === 0 && buffer[13] === 0) { return { origin: 'Experimental', client: 'Experimental', version: '3.1' } }

    if (firstNonZeroIndex === 12) { return { origin: 'Mainline', client: 'Mainline' } }

    return null
  }
}

//
// Private helper functions for the public utility functions
//

function isDigit(s) {
  const code = s.charCodeAt(0)
  return code >= '0'.charCodeAt(0) && code <= '9'.charCodeAt(0)
}

function isLetter(s) {
  const code = s.toLowerCase().charCodeAt(0)
  return code >= 'a'.charCodeAt(0) && code <= 'z'.charCodeAt(0)
}

function isAlphaNumeric(s) {
  return isDigit(s) || isLetter(s) || s === '.'
}

function decodeNumericValueOfByte(b, minDigits = 0) {
  let result = `${b & 0xff}`
  while (result.length < minDigits) { result = `0${result}` }
  return result
}

/**
 * Parses and returns the client type and version of a bittorrent peer id.
 * Throws an exception if the peer id is invalid.
 *
 * @param {Buffer|string} peerId (as Buffer or hex/utf8 string)
 */
function getPeerName(peerId) {
  let buffer

  if (Buffer.isBuffer(peerId)) {
    buffer = peerId
  } else if (typeof peerId === 'string') {
    buffer = Buffer.from(peerId, 'utf8')

  } else {
    throw new Error(`Invalid peerId must be Buffer or hex string: ${peerId}`)
  }
  peerId = buffer.toString('utf8')

  let client = null
  // If the client reuses parts of the peer ID of other peers, then try to determine this
  // first (before we misidentify the client).
  if (peerIdUtils.isPossibleSpoofClient(peerId)) {
    if ((client = peerIdUtils.decodeBitSpiritClient(peerId, buffer))) return client
    if ((client = peerIdUtils.decodeBitCometClient(peerId, buffer))) return client
    return { client: 'BitSpirit?' }
  }

  // See if the client uses Az style identification
  if (peerIdUtils.isAzStyle(peerId)) {
    if ((client = getAzStyleClientName(peerId))) {
      const version = getAzStyleClientVersion(client, peerId)

      // Hack for fake ZipTorrent clients - there seems to be some clients
      // which use the same identifier, but they aren't valid ZipTorrent clients
      if (client.startsWith('ZipTorrent') && peerId.startsWith('bLAde', 8)) {
        return {
          client: 'Unknown [Fake: ZipTorrent]',
          version
        }
      }

      // BitTorrent 6.0 Beta currently misidentifies itself
      if (client === '\u00B5Torrent' && version === '6.0 Beta') {
        return {
          client: 'Mainline',
          version: '6.0 Beta'
        }
      }

      // If it's the rakshasa libtorrent, then it's probably rTorrent
      if (client.startsWith('libTorrent (Rakshasa)')) {
        return {
          client: `${client} / rTorrent*`,
          version
        }
      }

      return {
        origin: peerId.substring(1, 3),
        client,
        version
      }
    }
  }

  // See if the client uses Shadow style identification
  if (peerIdUtils.isShadowStyle(peerId)) {
    if ((client = getShadowStyleClientName(peerId))) {
      // TODO: handle shadow style client version numbers
      return {
        origin: peerId.substring(0, 1),
        client
      }
    }
  }

  // See if the client uses Mainline style identification
  if (peerIdUtils.isMainlineStyle(peerId)) {
    if ((client = getMainlineStyleClientName(peerId))) {
      // TODO: handle mainline style client version numbers
      return {
        origin: peerId.substring(0, 1),
        client
      }
    }
  }

  // Check for BitSpirit / BitComet disregarding spoof mode
  if ((client = peerIdUtils.decodeBitSpiritClient(peerId, buffer))) return client
  if ((client = peerIdUtils.decodeBitCometClient(peerId, buffer))) return client

  // See if the client identifies itself using a particular substring
  const data = getSimpleClient(peerId)
  if (data) {
    client = data.client

    // TODO: handle simple client version numbers
    return {
      origin: client,
      client,
      version: data.version
    }
  }

  // See if client is known to be awkward / nonstandard
  if ((client = peerIdUtils.identifyAwkwardClient(peerId, buffer))) {
    return client
  }

  // TODO: handle unknown az-formatted and shadow-formatted clients
  return { client: 'unknown' }
}

// Az style two byte code identifiers to real client name
const azStyleClients = {}
const azStyleClientVersions = {}

// Shadow's style one byte code identifiers to real client name
const shadowStyleClients = {}
const shadowStyleClientVersions = {}

// Mainline's new style uses one byte code identifiers too
const mainlineStyleClients = {}

// Clients with completely custom naming schemes
const customStyleClients = []

const VER_AZ_THREE_DIGITS = v => // "1.2.3"
  `${v[0]}.${v[1]}.${v[2]}`
const VER_AZ_DELUGE = v => {
  const alphabet = 'ABCDE'
  if (isNaN(v[2])) {
    return `${v[0]}.${v[1]}.1${alphabet.indexOf(v[2])}`
  }
  return `${v[0]}.${v[1]}.${v[2]}`
}
const VER_AZ_THREE_DIGITS_PLUS_MNEMONIC = v => {
  // "1.2.3 [4]"
  let mnemonic = v[3]
  if (mnemonic === 'B') {
    mnemonic = 'Beta'
  } else if (mnemonic === 'A') {
    mnemonic = 'Alpha'
  } else {
    mnemonic = ''
  }
  return `${v[0]}.${v[1]}.${v[2]} ${mnemonic}`
}
const VER_AZ_FOUR_DIGITS = v => // "1.2.3.4"
  `${v[0]}.${v[1]}.${v[2]}.${v[3]}`
const VER_AZ_TWO_MAJ_TWO_MIN = v => // "12.34"
  `${v[0] + v[1]}.${v[2]}${v[3]}`
const VER_AZ_SKIP_FIRST_ONE_MAJ_TWO_MIN = v => // "2.34"
  `${v[1]}.${v[2]}${v[3]}`
const VER_AZ_KTORRENT_STYLE = '1.2.3=[RD].4'
const VER_AZ_TRANSMISSION_STYLE = v => {
  // "transmission"
  if (v[0] === '0' && v[1] === '0' && v[2] === '0') {
    return `0.${v[3]}`
  } else if (v[0] === '0' && v[1] === '0') {
    return `0.${v[2]}${v[3]}`
  }
  return `${v[0]}.${v[1]}${v[2]}${v[3] === 'Z' || v[3] === 'X' ? '+' : ''}`
}
const VER_AZ_WEBTORRENT_STYLE = v => {
  // "webtorrent"
  let version = ''
  if (v[0] === '0') {
    version += `${v[1]}.`
  } else {
    version += `${v[0]}${v[1]}.`
  }
  if (v[2] === '0') {
    version += v[3]
  } else {
    version += `${v[2]}${v[3]}`
  }
  return version
}
const VER_AZ_THREE_ALPHANUMERIC_DIGITS = '2.33.4'
const VER_NONE = 'NO_VERSION'

function addAzStyle(id, client, version = VER_AZ_FOUR_DIGITS) {
  azStyleClients[id] = client
  azStyleClientVersions[client] = version
}

function addShadowStyle(id, client, version = VER_AZ_THREE_DIGITS) {
  shadowStyleClients[id] = client
  shadowStyleClientVersions[client] = version
}

function addMainlineStyle(id, client) {
  mainlineStyleClients[id] = client
}

function addSimpleClient(client, version, id, position) {
  if (typeof id === 'number' || typeof id === 'undefined') {
    position = id
    id = version
    version = undefined
  }

  customStyleClients.push({
    id,
    client,
    version,
    position: position || 0
  })
}

function getAzStyleClientName(peerId) {
  return azStyleClients[peerId.substring(1, 3)]
}

function getShadowStyleClientName(peerId) {
  return shadowStyleClients[peerId.substring(0, 1)]
}

function getMainlineStyleClientName(peerId) {
  return mainlineStyleClients[peerId.substring(0, 1)]
}

function getSimpleClient(peerId) {
  for (let i = 0; i < customStyleClients.length; ++i) {
    const client = customStyleClients[i]

    if (peerId.startsWith(client.id, client.position)) {
      return client
    }
  }

  return null
}

function getAzStyleClientVersion(client, peerId) {
  const version = azStyleClientVersions[client]
  if (!version) return null

  return peerIdUtils.getAzStyleVersionNumber(peerId.substring(3, 7), version)
}

(() => {
  // add known clients alphabetically
  addAzStyle('A~', 'Ares', VER_AZ_THREE_DIGITS)
  addAzStyle('AG', 'Ares', VER_AZ_THREE_DIGITS)
  addAzStyle('AN', 'Ares', VER_AZ_FOUR_DIGITS)
  addAzStyle('AR', 'Ares')// Ares is more likely than ArcticTorrent
  addAzStyle('AV', 'Avicora')
  addAzStyle('AX', 'BitPump', VER_AZ_TWO_MAJ_TWO_MIN)
  addAzStyle('AT', 'Artemis')
  addAzStyle('AZ', 'Vuze', VER_AZ_FOUR_DIGITS)
  addAzStyle('BB', 'BitBuddy', '1.234')
  addAzStyle('BC', 'BitComet', VER_AZ_SKIP_FIRST_ONE_MAJ_TWO_MIN)
  addAzStyle('BE', 'BitTorrent SDK')
  addAzStyle('BF', 'BitFlu', VER_NONE)
  addAzStyle('BG', 'BTG', VER_AZ_FOUR_DIGITS)
  addAzStyle('bk', 'BitKitten (libtorrent)')
  addAzStyle('BR', 'BitRocket', '1.2(34)')
  addAzStyle('BS', 'BTSlave')
  addAzStyle('BT', 'BitTorrent', VER_AZ_THREE_DIGITS_PLUS_MNEMONIC)
  addAzStyle('BW', 'BitWombat')
  addAzStyle('BX', 'BittorrentX')
  addAzStyle('CB', 'Shareaza Plus')
  addAzStyle('CD', 'Enhanced CTorrent', VER_AZ_TWO_MAJ_TWO_MIN)
  addAzStyle('CT', 'CTorrent', '1.2.34')
  addAzStyle('DP', 'Propogate Data Client')
  addAzStyle('DE', 'Deluge', VER_AZ_DELUGE)
  addAzStyle('EB', 'EBit')
  addAzStyle('ES', 'Electric Sheep', VER_AZ_THREE_DIGITS)
  addAzStyle('FC', 'FileCroc')
  addAzStyle('FG', 'FlashGet', VER_AZ_SKIP_FIRST_ONE_MAJ_TWO_MIN)
  addAzStyle('FX', 'Freebox BitTorrent')
  addAzStyle('FT', 'FoxTorrent/RedSwoosh')
  addAzStyle('GR', 'GetRight', '1.2')
  addAzStyle('GS', 'GSTorrent')// TODO: Format is v"abcd"
  addAzStyle('HL', 'Halite', VER_AZ_THREE_DIGITS)
  addAzStyle('HN', 'Hydranode')
  addAzStyle('KG', 'KGet')
  addAzStyle('KT', 'KTorrent', VER_AZ_KTORRENT_STYLE)
  addAzStyle('LC', 'LeechCraft')
  addAzStyle('LH', 'LH-ABC')
  addAzStyle('LK', 'linkage', VER_AZ_THREE_DIGITS)
  addAzStyle('LP', 'Lphant', VER_AZ_TWO_MAJ_TWO_MIN)
  addAzStyle('LT', 'libtorrent (Rasterbar)', VER_AZ_THREE_ALPHANUMERIC_DIGITS)
  addAzStyle('lt', 'libTorrent (Rakshasa)', VER_AZ_THREE_ALPHANUMERIC_DIGITS)
  addAzStyle('LW', 'LimeWire', VER_NONE)// The "0001" bytes found after the LW commonly refers to the version of the BT protocol implemented. Documented here: http://www.limewire.org/wiki/index.php?title=BitTorrentRevision
  addAzStyle('MO', 'MonoTorrent')
  addAzStyle('MP', 'MooPolice', VER_AZ_THREE_DIGITS)
  addAzStyle('MR', 'Miro')
  addAzStyle('MT', 'MoonlightTorrent')
  addAzStyle('NE', 'BT Next Evolution', VER_AZ_THREE_DIGITS)
  addAzStyle('NX', 'Net Transport')
  addAzStyle('OS', 'OneSwarm', VER_AZ_FOUR_DIGITS)
  addAzStyle('OT', 'OmegaTorrent')
  addAzStyle('PC', 'CacheLogic', '12.3-4')
  addAzStyle('PT', 'Popcorn Time')
  addAzStyle('PD', 'Pando')
  addAzStyle('PE', 'PeerProject')
  addAzStyle('pX', 'pHoeniX')
  addAzStyle('qB', 'qBittorrent', VER_AZ_DELUGE)
  addAzStyle('QD', 'qqdownload')
  addAzStyle('RT', 'Retriever')
  addAzStyle('RZ', 'RezTorrent')
  addAzStyle('S~', 'Shareaza alpha/beta')
  addAzStyle('SB', 'SwiftBit')
  addAzStyle('SD', '\u8FC5\u96F7\u5728\u7EBF (Xunlei)')// Apparently, the English name of the client is "Thunderbolt".
  addAzStyle('SG', 'GS Torrent', VER_AZ_FOUR_DIGITS)
  addAzStyle('SN', 'ShareNET')
  addAzStyle('SP', 'BitSpirit', VER_AZ_THREE_DIGITS)// >= 3.6
  addAzStyle('SS', 'SwarmScope')
  addAzStyle('ST', 'SymTorrent', '2.34')
  addAzStyle('st', 'SharkTorrent')
  addAzStyle('SZ', 'Shareaza')
  addAzStyle('TG', 'Torrent GO')
  addAzStyle('TN', 'Torrent.NET')
  addAzStyle('TR', 'Transmission', VER_AZ_TRANSMISSION_STYLE)
  addAzStyle('TS', 'TorrentStorm')
  addAzStyle('TT', 'TuoTu', VER_AZ_THREE_DIGITS)
  addAzStyle('UL', 'uLeecher!')
  addAzStyle('UE', '\u00B5Torrent Embedded', VER_AZ_THREE_DIGITS_PLUS_MNEMONIC)
  addAzStyle('UT', '\u00B5Torrent', VER_AZ_THREE_DIGITS_PLUS_MNEMONIC)
  addAzStyle('UM', '\u00B5Torrent Mac', VER_AZ_THREE_DIGITS_PLUS_MNEMONIC)
  addAzStyle('UW', '\u00B5Torrent Web', VER_AZ_THREE_DIGITS_PLUS_MNEMONIC)
  addAzStyle('WD', 'WebTorrent Desktop', VER_AZ_WEBTORRENT_STYLE)// Go Webtorrent!! :)
  addAzStyle('WT', 'Bitlet')
  addAzStyle('WW', 'WebTorrent', VER_AZ_WEBTORRENT_STYLE)// Go Webtorrent!! :)
  addAzStyle('WY', 'FireTorrent')// formerly Wyzo.
  addAzStyle('VG', '\u54c7\u560E (Vagaa)', VER_AZ_FOUR_DIGITS)
  addAzStyle('XL', '\u8FC5\u96F7\u5728\u7EBF (Xunlei)')// Apparently, the English name of the client is "Thunderbolt".
  addAzStyle('XT', 'XanTorrent')
  addAzStyle('XF', 'Xfplay', '\u5f71\u97f3\u5148\u950b')//xfplay.com
  addAzStyle('XX', 'XTorrent', '1.2.34')
  addAzStyle('XC', 'XTorrent', '1.2.34')
  addAzStyle('ZT', 'ZipTorrent')
  addAzStyle('7T', 'aTorrent')
  addAzStyle('ZO', 'Zona', VER_AZ_FOUR_DIGITS)
  addAzStyle('#@', 'Invalid PeerID')

  addShadowStyle('A', 'ABC')
  addShadowStyle('O', 'Osprey Permaseed')
  addShadowStyle('Q', 'BTQueue')
  addShadowStyle('R', 'Tribler')
  addShadowStyle('S', 'Shad0w')
  addShadowStyle('T', 'BitTornado')
  addShadowStyle('U', 'UPnP NAT')

  addMainlineStyle('M', 'Mainline')
  addMainlineStyle('Q', 'Queen Bee')

  // Simple clients with no version number.
  addSimpleClient('\u00B5Torrent', '1.7.0 RC', '-UT170-')// http://forum.utorrent.com/viewtopic.php?pid=260927#p260927
  addSimpleClient('Azureus', '1', 'Azureus')
  addSimpleClient('Azureus', '2.0.3.2', 'Azureus', 5)
  addSimpleClient('Aria', '2', '-aria2-')
  addSimpleClient('BitTorrent Plus!', 'II', 'PRC.P---')
  addSimpleClient('BitTorrent Plus!', 'P87.P---')
  addSimpleClient('BitTorrent Plus!', 'S587Plus')
  addSimpleClient('BitTyrant (Azureus Mod)', 'AZ2500BT')
  addSimpleClient('Blizzard Downloader', 'BLZ')
  addSimpleClient('BTGetit', 'BG', 10)
  addSimpleClient('BTugaXP', 'btuga')
  addSimpleClient('BTugaXP', 'BTuga', 5)
  addSimpleClient('BTugaXP', 'oernu')
  addSimpleClient('Deadman Walking', 'BTDWV-')
  addSimpleClient('Deadman', 'Deadman Walking-')
  addSimpleClient('External Webseed', 'Ext')
  addSimpleClient('G3 Torrent', '-G3')
  addSimpleClient('GreedBT', '2.7.1', '271-')
  addSimpleClient('Hurricane Electric', 'arclight')
  addSimpleClient('HTTP Seed', '-WS')
  addSimpleClient('JVtorrent', '10-------')
  addSimpleClient('Limewire', 'LIME')
  addSimpleClient('Martini Man', 'martini')
  addSimpleClient('Pando', 'Pando')
  addSimpleClient('PeerApp', 'PEERAPP')
  addSimpleClient('SimpleBT', 'btfans', 4)
  addSimpleClient('Swarmy', 'a00---0')
  addSimpleClient('Swarmy', 'a02---0')
  addSimpleClient('Teeweety', 'T00---0')
  addSimpleClient('TorrentTopia', '346-')
  addSimpleClient('XanTorrent', 'DansClient')
  addSimpleClient('MediaGet', '-MG1')
  addSimpleClient('MediaGet', '2.1', '-MG21')

  /**
   * This is interesting - it uses Mainline style, except uses two characters instead of one.
   * And then - the particular numbering style it uses would actually break the way we decode
   * version numbers (our code is too hardcoded to "-x-y-z--" style version numbers).
   *
   * This should really be declared as a Mainline style peer ID, but I would have to
   * make my code more generic. Not a bad thing - just something I'm not doing right
   * now.
   */
  addSimpleClient('Amazon AWS S3', 'S3-')

  // Simple clients with custom version schemes
  // TODO: support custom version schemes
  addSimpleClient('BitTorrent DNA', 'DNA')
  addSimpleClient('Opera', 'OP')// Pre build 10000 versions
  addSimpleClient('Opera', 'O')// Post build 10000 versions
  addSimpleClient('Burst!', 'Mbrst')
  addSimpleClient('TurboBT', 'turbobt')
  addSimpleClient('BT Protocol Daemon', 'btpd')
  addSimpleClient('Plus!', 'Plus')
  addSimpleClient('XBT', 'XBT')
  addSimpleClient('BitsOnWheels', '-BOW')
  addSimpleClient('eXeem', 'eX')
  addSimpleClient('MLdonkey', '-ML')
  addSimpleClient('Bitlet', 'BitLet')
  addSimpleClient('AllPeers', 'AP')
  addSimpleClient('BTuga Revolution', 'BTM')
  addSimpleClient('Rufus', 'RS', 2)
  addSimpleClient('BitMagnet', 'BM', 2)// BitMagnet - predecessor to Rufus
  addSimpleClient('QVOD', 'QVOD')
  // Top-BT is based on BitTornado, but doesn't quite stick to Shadow's naming conventions,
  // so we'll use substring matching instead.
  addSimpleClient('Top-BT', 'TB')
  addSimpleClient('Tixati', 'TIX')
  // seems to have a sub-version encoded in following 3 bytes, not worked out how: "folx/1.0.456.591" : 2D 464C 3130 FF862D 486263574A43585F66314D5A
  addSimpleClient('folx', '-FL')
  addSimpleClient('\u00B5Torrent Mac', '-UM')
  addSimpleClient('\u00B5Torrent', '-UT') // UT 3.4+
})()

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
let idleHeartbeat = null

// 间接层：测试时可替换 execFile，便于在没有 ipset 的环境验证调用
const runtime = {
    execFile: promisify(child_process.execFile)
}

// ============================================================================
// logger
// ============================================================================

function pad2(n) {
    return String(n).padStart(2, '0')
}

function formatLocalTimestamp(d = new Date()) {
    return `${d.getFullYear()}/${pad2(d.getMonth() + 1)}/${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
}

const honsole = {
    dev(...a) { if (process.env.DEV) console.log('[aria2b]', ...a) },
    log(...a) { console.log('[aria2b]', ...a) },
    logt(...a) {
        if (process.env.HIDE_TIME_PREFIX) console.log('[aria2b]', ...a)
        else console.log('[aria2b]', formatLocalTimestamp(), ...a)
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
            const code = s.substring(i + 1, i + 3)
            if (/^[0-9A-Fa-f]{2}$/.test(code)) {
                const parsed = parseInt(code, 16)
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

function unknownPeerClient() {
    return { client: 'unknown', origin: '', version: '' }
}

function detectPeerClient(peerId) {
    try {
        return getPeerName(peerId) || unknownPeerClient()
    } catch (e) {
        honsole.dev('peerId 识别失败，按 unknown 处理:', sanitizeError(e))
        return unknownPeerClient()
    }
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
    // 显式拒绝 boolean / null / undefined / object：避免 `--key` 不带值时
    // value=true 被 Number() 转成 1 静默落入配置（B5）。
    if (typeof value !== 'string' && typeof value !== 'number') return fallback
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
    // /proc/net/if_inet6 是 per-netns 的：容器内禁用 IPv6（--sysctl net.ipv6.conf.all.disable_ipv6=1
    // 或 boot-time `ipv6.disable=1`）时内核根本不创建这个文件，否则一定存在。
    // 只看这一个信号源就够了 —— docker alpine 上行为稳定。
    return fs.existsSync('/proc/net/if_inet6')
}

function isLocalHttpsRpcUrl(url) {
    let u
    try { u = new URL(url) }
    catch (_) { throw new Error(`rpc url 格式不正确: ${url}`) }
    if (u.protocol !== 'https:') return false
    // WHATWG URL 对 IPv6 字面量保留方括号
    const host = u.hostname.replace(/^\[|\]$/g, '')
    if (host === 'localhost' || host === '::1') return true
    // 必须是合法 IPv4 字面量，且在 127/8 段内。
    // 不能简单用 `host.startsWith('127.')`，否则 `127.0.0.1.evil.com`
    // 也会被当成本地 → 攻击者控制的子域可让 TLS 校验被默认关闭。
    if (net.isIPv4(host)) {
        return host.startsWith('127.')
    }
    return false
}

function hasIpset(saveOutput, setName) {
    if (!saveOutput) return false
    for (const line of saveOutput.split('\n')) {
        if (line.trim().startsWith(`create ${setName} `)) return true
    }
    return false
}

/**
 * 把 Node 网络错误压缩成短字符串，关键作用：避免把请求体里的
 * `token:secret` 写到日志。容器场景下日志常被采集，这里必须脱敏。
 *
 * 兼容字段（由 makeRpcClient/httpJsonPost 抛出，与历史 axios 错误形态一致）：
 *   e.code: ECONNREFUSED / ECONNRESET / ETIMEDOUT / ECONNABORTED / ENOTFOUND / EHOSTUNREACH / EMSGSIZE
 *   e.address / e.port:  Node 原生附带（ECONNREFUSED 等）
 *   e.response.{status, statusText}: HTTP 非 2xx 状态码
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
    if (e.code === 'EMSGSIZE') return 'RPC 响应体超出上限'
    if (e.code === 'EBADRESPONSE') return e.message || 'RPC 响应解析失败'
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

/**
 * 用 Node 原生 http/https.request 发 JSON POST，返回 axios 风格的
 * `{ data, status, statusText }`。失败时抛出的 error 形态与 sanitizeError
 * 的兼容契约：
 *   - 连接层错误透传原生 e.code / e.address / e.port（ECONNREFUSED 等）
 *   - HTTP 状态码 >= 400 时抛带 `e.response = { status, statusText }` 的错误
 *   - 超时抛 `{ code: 'ECONNABORTED' }`，与 axios 风格对齐
 *   - 响应体超过 RPC_MAX_BODY_BYTES 时抛 `EMSGSIZE`，并主动 abort 连接
 *
 * 不实现：重定向跟随（aria2 RPC 不会重定向）、代理（localhost RPC 不需要）、
 * multipart（我们只发 JSON）。砍掉这些是替换 axios 的全部价值。
 */
function httpJsonPost(opts, url, body) {
    return new Promise((resolve, reject) => {
        let parsed
        try { parsed = new URL(url) }
        catch (_) { return reject(new Error(`rpc url 格式不正确: ${url}`)) }

        const isHttps = parsed.protocol === 'https:'
        const lib = isHttps ? https : http
        const agent = isHttps ? opts.httpsAgent : opts.httpAgent

        const payload = Buffer.from(JSON.stringify(body), 'utf8')

        const reqOpts = {
            method: 'POST',
            protocol: parsed.protocol,
            hostname: parsed.hostname,
            port: parsed.port || (isHttps ? 443 : 80),
            path: (parsed.pathname || '/') + (parsed.search || ''),
            agent,
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': payload.length,
                'Accept': 'application/json',
                // 主动让对端用 close 还是 keep-alive 由 Agent 决定
            }
        }

        const req = lib.request(reqOpts, (res) => {
            const chunks = []
            let received = 0
            let aborted = false

            res.on('data', (chunk) => {
                if (aborted) return
                received += chunk.length
                if (received > RPC_MAX_BODY_BYTES) {
                    aborted = true
                    // 销毁 res 而不是 req — 销毁 req 在某些 Node 版本会触发
                    // 二次 'error' 事件；销毁 res 的 socket 即可中断接收
                    res.destroy()
                    const err = new Error(`响应体超过 ${RPC_MAX_BODY_BYTES} 字节上限`)
                    err.code = 'EMSGSIZE'
                    return reject(err)
                }
                chunks.push(chunk)
            })
            res.on('end', () => {
                if (aborted) return
                const text = Buffer.concat(chunks).toString('utf8')
                const status = res.statusCode
                const statusText = res.statusMessage || ''
                // 3xx 在 aria2 RPC 里也不应出现；当作错误抛而不是静默把 data 当 undefined
                // 处理，否则 cron 会把异常的空响应当成"无活跃任务"——隐患远大于收益。
                if (status >= 300) {
                    const err = new Error(`HTTP ${status} ${statusText}`.trim())
                    err.response = { status, statusText }
                    return reject(err)
                }
                let data
                try { data = text ? JSON.parse(text) : undefined }
                catch (e) {
                    const err = new Error(`RPC 响应不是合法 JSON: ${sanitizeError(e)}`)
                    err.code = 'EBADRESPONSE'
                    return reject(err)
                }
                resolve({ data, status, statusText })
            })
            res.on('error', reject)
        })

        // 绝对超时：用外层 setTimeout 包整个请求，覆盖 connect / headers / body 全阶段。
        // 不能只用 req.setTimeout —— 那只是 socket 分配后才生效，
        // connect 卡住时会被 TCP 内核默认的 ~2 分钟超时拖死。
        // 也不能在 'response' 一到就清超时 —— 服务器可能只回 headers 然后 hang 住不发 body
        // （aria2 内部死锁 / 慢速 attack / 中间链路故障），那样会卡死整个 cron。
        // 只在请求结束（'close' / 'error'）时清，让超时覆盖到 body 收完为止。
        // 用 ECONNABORTED 对齐 axios 风格，sanitizeError 不用改。
        let absoluteTimer = null
        const clearAbsoluteTimer = () => {
            if (absoluteTimer) { clearTimeout(absoluteTimer); absoluteTimer = null }
        }
        if (opts.timeout && opts.timeout > 0) {
            absoluteTimer = setTimeout(() => {
                const err = new Error('RPC 请求超时')
                err.code = 'ECONNABORTED'
                req.destroy(err)
            }, opts.timeout)
        }
        req.on('error', (err) => { clearAbsoluteTimer(); reject(err) })
        req.on('close', clearAbsoluteTimer)
        req.end(payload)
    })
}

function makeRpcClient() {
    const agentOpts = { keepAlive: true, keepAliveMsecs: 30000, maxSockets: 4 }
    const opts = {
        timeout: RPC_HTTP_TIMEOUT,
        httpAgent: new http.Agent(agentOpts),
        httpsAgent: new https.Agent({ ...agentOpts, ...config.rpc_options })
    }
    return {
        // 维持 axios 风格 .post(url, body) → { data, status, statusText }，
        // 让历史测试与 sanitizeError 的错误形态兼容不变。
        post(url, body) { return httpJsonPost(opts, url, body) },
        // 给关停 / 测试用：销毁 agent，释放 keep-alive sockets
        destroy() {
            try { opts.httpAgent.destroy() } catch (_) {}
            try { opts.httpsAgent.destroy() } catch (_) {}
        }
    }
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

// 当前选用的 iptables 二进制名（启动时由 pickIptablesBackendForVersion 探测后更新）。
// Alpine 3.13+ 的 `iptables` 包默认指向 nft 后端；群晖 DSM 4.x 内核 / 部分老 NAS 内核
// 上 nft 子系统初始化即失败（`Could not fetch rule set generation id`），整个 ipset/iptables
// 路径都用不了 —— 必须切换到 `iptables-legacy`（前提是镜像装了 `iptables-legacy` 包）。
// 这里只做"探测+切换"，不自动 apk add（违反零运维原则）；缺包时给用户明确指引。
const iptablesBinaries = {
    v4: 'iptables',
    v6: 'ip6tables'
}

/**
 * 在 iptables/ipset 子进程报错文本里识别 iptables-nft 后端在老内核（Synology DSM 4.x
 * 内核 / 部分 NAS 固件）下的特征错误，给用户一个可操作的修复路径。
 * 命中任意一条特征就在日志里追加"切到 legacy 后端"的建议，不命中则保持原错误信息。
 *
 * 这些特征都来自实战日志：
 *   `nf_tables`                                — iptables-nft 后端 banner
 *   `Could not fetch rule set generation id`   — nft 内核子系统未初始化好
 *   `Extension set revision 0 not supported`   — xt_set 内核模块缺失/版本不匹配
 *   `Couldn't load match 'set'`                — 同上，老 ip6tables 报错形态
 *   `missing kernel module`                    — iptables 兜底提示
 */
function looksLikeNftBackendIssue(err) {
    const text = `${err && err.stderr || ''}\n${err && err.message || ''}`
    return /nf_tables|generation id|Extension set|missing kernel module|Couldn't load match/i.test(text)
}

function logIptablesBackendHint() {
    honsole.error('诊断：错误信号疑似 iptables-nft 后端 / xt_set 内核模块不兼容（常见于 Synology DSM 4.x 等老内核）。')
    honsole.error('修复：在镜像里安装 iptables-legacy 后 aria2b 会自动探测并切换：')
    honsole.error('      apk add --no-cache iptables iptables-legacy ipset nodejs')
}

/**
 * 探测某个 iptables 二进制能否在当前内核上工作。
 *
 * 采用 `bin -L INPUT -n` 作为最小探针：
 *   - 不依赖任何 ipset 或扩展模块，能列规则就说明 backend 本身能跑通
 *   - nft 后端在老内核上会在这步就报 `Could not fetch rule set generation id`
 *   - legacy 后端在新内核上也能跑（兼容性最好）
 *
 * `-n` 跳过反向 DNS 解析，避免容器在没有 DNS 时阻塞 30s+。
 */
async function probeIptablesBinary(bin) {
    await runtime.execFile(bin, ['-L', 'INPUT', '-n'])
}

/**
 * 给指定 version 选一个能用的 iptables 二进制。
 *
 * 候选顺序：默认（`iptables` / `ip6tables`，可能是 nft 也可能是 legacy 看 alpine 版本）
 *           → 显式 legacy（`iptables-legacy` / `ip6tables-legacy`，需要 iptables-legacy 包）。
 *
 * 默认能用 → 不切换；默认坏 + legacy 能用 → 切到 legacy 并 log；都不行 → 返回 false。
 * 不会抛错 —— 上层决定 IPv4 致命还是 IPv6 软降级。
 */
async function pickIptablesBackendForVersion(version) {
    const isV6 = version === 6
    const defaultBin = isV6 ? 'ip6tables' : 'iptables'
    const legacyBin  = isV6 ? 'ip6tables-legacy' : 'iptables-legacy'
    const key = isV6 ? 'v6' : 'v4'

    let defaultErr = null
    try {
        await probeIptablesBinary(defaultBin)
        iptablesBinaries[key] = defaultBin
        return true
    } catch (e) {
        defaultErr = e
        // 默认探测失败的两种情况都试 legacy 兜底：
        //   1. 二进制不存在（ENOENT）—— 不太可能，但保留
        //   2. nft 后端实际工作不了（typical 群晖 DSM 4.x）
        // 非 nft 错误（例如 NET_ADMIN 缺失导致权限报错）也试一下 legacy，
        // 因为 legacy 也会在同样原因下失败，那时统一返回 false 给上层提示。
    }

    try {
        await probeIptablesBinary(legacyBin)
        iptablesBinaries[key] = legacyBin
        honsole.log(`IPv${version} iptables 后端切换到 ${legacyBin}（默认 ${defaultBin} 在此内核不可用：${sanitizeError(defaultErr)}）`)
        return true
    } catch (legacyErr) {
        honsole.warn(`IPv${version} iptables 探测失败：${defaultBin} 报 "${sanitizeError(defaultErr)}"，${legacyBin} 报 "${sanitizeError(legacyErr)}"`)
        if (looksLikeNftBackendIssue(defaultErr) || looksLikeNftBackendIssue(legacyErr)) {
            logIptablesBackendHint()
        }
        return false
    }
}

async function flushIptablesIpset(version) {
    const iptables = version === 6 ? iptablesBinaries.v6 : iptablesBinaries.v4
    const setName = version === 6 ? IPSET_NAME_V6 : IPSET_NAME_V4
    try {
        // 删除旧规则与 ipset；首次运行没有这些是正常的，吞错误
        await runtime.execFile(iptables, ['-D', 'INPUT', '-m', 'set', '--match-set', setName, 'src', '-j', 'DROP']).catch(() => {})
        await runtime.execFile('ipset', ['destroy', setName]).catch(() => {})

        const createArgs = ['create', setName, 'hash:ip', 'timeout', String(config.timeout)]
        if (version === 6) createArgs.push('family', 'inet6')
        await runtime.execFile('ipset', createArgs)
        await runtime.execFile(iptables, ['-I', 'INPUT', '-m', 'set', '--match-set', setName, 'src', '-j', 'DROP'])

        honsole.log(`已初始化 ${setName}（IPv${version}，使用 ${iptables}）`)
    } catch (e) {
        honsole.error(`初始化 ${setName} 失败：${sanitizeError(e)}`)
        honsole.error('请确认：容器具备 NET_ADMIN，已安装 iptables/ipset，且内核已加载对应模块')
        if (looksLikeNftBackendIssue(e)) logIptablesBackendHint()
        throw e
    }
}

/**
 * 幂等地确保 iptables INPUT 链中存在引用本 set 的 DROP 规则。
 *
 * 自愈场景：前次启动如果在 `ipset create` 后、`iptables -I` 前被 SIGKILL 打断，
 * 重启时 hasIpset() 返回 true → 跳过 flushIptablesIpset() → 规则永远不被装上，
 * 整个 aria2b 跑得欢快但实际上一个 IP 都拦不住。`iptables -C` 检查规则是否存在，
 * 不存在则补 `-I`。docker alpine 上 -C 是标准选项，行为稳定。
 */
async function ensureIptablesRule(version) {
    const iptables = version === 6 ? iptablesBinaries.v6 : iptablesBinaries.v4
    const setName = version === 6 ? IPSET_NAME_V6 : IPSET_NAME_V4
    const ruleArgs = ['INPUT', '-m', 'set', '--match-set', setName, 'src', '-j', 'DROP']
    try {
        await runtime.execFile(iptables, ['-C', ...ruleArgs])
        return false   // 已存在，无需补装
    } catch (_) {
        // -C 在规则不存在时退出码非 0；这是预期分支，继续补装。
        // 在 iptables-nft + 老内核上 -C 也会因 "Could not fetch rule set generation id" 抛错；
        // 那种情况后续的 -I 也会失败并抛出更明确的 nft 信号，由 initial() 的 IPv6 try/catch
        // 决定降级/退出，这里不必区分 -C 失败的根因。
    }
    try {
        await runtime.execFile(iptables, ['-I', ...ruleArgs])
    } catch (e) {
        honsole.error(`补装 ${iptables} 规则（${setName}）失败：${sanitizeError(e)}`)
        if (looksLikeNftBackendIssue(e)) logIptablesBackendHint()
        throw e
    }
    honsole.log(`已补装 ${iptables} 规则（${setName} 引用，前次启动可能被中断）`)
    return true
}

/**
 * 启动阶段环境致命错误（IPv4 后端不可用 / ipset 缺失 等）时暂停扫描并保活。
 *
 * 不变量 #15：进程必须保持存活，绝不 process.exit。
 *
 * aria2b 在 docker-aria2 镜像里是 s6-overlay v2 的一个 service，s6 默认会无限重启
 * 退出的 service —— 一旦 aria2b 因环境问题（群晖 DSM 老内核 + iptables-nft 不兼容、
 * 缺 NET_ADMIN、ipset 二进制缺失等）crash，s6 立刻拉起，每 1-2 秒一次循环，导致：
 *   1. 容器日志被淹没（每次重启刷出几十行错误）
 *   2. 占满 CPU 和 fork 配额，拖慢同容器里的 aria2c
 *   3. 用户没法看到真正的修复指引，因为它被滚动日志冲掉
 *
 * 暂停扫描并保活：进程不退出，只保留一个 refed setInterval 当作"心跳"让事件循环 alive，
 * 不再执行任何 ipset/iptables 操作。aria2c 主服务不受影响。
 * 每小时打一次提醒日志告诉用户问题仍未修复 —— 避免日志膨胀，又不让人遗忘。
 */
function runIdleMode(reason) {
    if (idleHeartbeat) return   // 防止重复进入

    // `--flush` 是一次性 CLI 维护命令（手动跑，不是 s6 service），失败时应该 exit 非 0
    // 让调用者立刻知道，而不是静默保活让用户怀疑命令卡死。runIdleMode 只服务于 s6 长期托管路径。
    if (argv && argv.flush) {
        honsole.error(`--flush 失败：${reason}`)
        process.exit(1)
        return   // 测试里 process.exit 被 mock 时让函数提前结束，避免继续装 idleHeartbeat
    }

    honsole.error('aria2b 启动环境不可用，已暂停扫描并保持进程运行，避免容器反复重启。')
    honsole.error(`原因：${reason}`)
    honsole.error('影响：aria2b 暂时不会封禁 peer；aria2c / AriaNg 不受影响。')
    honsole.error('处理：修复环境后重启容器。常见修复：在 Dockerfile 增加 `apk add --no-cache iptables iptables-legacy ipset nodejs`。')

    // 暂停扫描并保活可能在 cron 运行期间被 uncaughtException 触发：必须立刻停掉调度循环，
    // 否则 cron 会在 idleHeartbeat 装好后继续每 N 秒跑一次，徒增 RPC / 子进程开销。
    // scheduleNext() 同样检查 idleHeartbeat 防止重新装上 scanTimer。
    if (scanTimer) { clearTimeout(scanTimer); scanTimer = null }
    // 主动 destroy rpcClient：让飞行中的 RPC 立刻 ECONNRESET 收尾，避免 cronInflight
    // 在 idle 启动后还卡 30s 才解开。与 SIGTERM stop() 的清理路径语义一致。
    if (rpcClient && typeof rpcClient.destroy === 'function') {
        try { rpcClient.destroy() } catch (_) { /* ignore */ }
    }

    const HOUR = 60 * 60 * 1000
    idleHeartbeat = setInterval(() => {
        // 不 unref：CLAUDE.md 第 1 条不变量说事件循环里必须有 refed handle，
        // 否则 Node 会在 keep-alive 池超时后静默 exit(0) → s6 重启 → crash-loop 复发。
        honsole.error(`aria2b 仍因启动环境不可用而暂停扫描（${reason}）—— 修复后请重启容器`)
    }, HOUR)
}

/**
 * 从 `ipset save` 输出中把已存在的 IP 同步到本地缓存。
 * 进程重启后避免对已封 IP 再次 `ipset add`，减少子进程开销与日志噪音。
 */
function syncBlockedIpsFromIpset(saveOutput, allowedSets) {
    if (!saveOutput) return 0
    // 默认 sync 两个 set；调用方可传子集（例如某个 set 刚被 flush，就不要同步它的旧条目，
    // 否则缓存说"已封"但 ipset 已空，cron 会因 isBlocked=true 跳过这些 peer → 实际未拦截。）
    const sets = allowedSets || [IPSET_NAME_V4, IPSET_NAME_V6]
    let count = 0
    for (const line of saveOutput.split('\n')) {
        const t = line.trim()
        if (!t.startsWith('add ')) continue
        const parts = t.split(/\s+/)
        if (parts.length < 3) continue
        const setName = parts[1]
        if (!sets.includes(setName)) continue
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

async function readIpsetSave() {
    const r = await runtime.execFile('ipset', ['save'], { maxBuffer: IPSET_SAVE_MAX_BUFFER_BYTES })
    return r.stdout || ''
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
        const clientInfo = [info.origin, info.client, info.version].filter(Boolean).join(' ')
        const suffix = clientInfo ? `（客户端：${clientInfo}，时长：${config.timeout}s）` : `（时长：${config.timeout}s）`
        honsole.logt(`已封禁 IP：${ip}${suffix}`)
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
    const c = detectPeerClient(decoded)
    const bitprogress = countOnes(peer.bitfield)
    let toBlock = false

    if (keywordMatches(config.block_keywords, c.origin) ||
        (hasUnknownKeyword(config.block_keywords) && c.client === 'unknown')) {
        // keywordMatches 显式跳过 'unknown' 关键字，未知客户端的 ban 路径必须由
        // hasUnknownKeyword + c.client==='unknown' 显式接管，否则 block_keywords
        // 里加 Unknown 就只是个装饰。
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
                        const human = decodeClient(peer.peerId).substring(0, 16) || 'unknown'
                        const np = Number(status.numPieces) || 0
                        honsole.log(`封禁疑似无进度上传 BT peer：${peer.ip}（${human}）；已上传约 ${uploadPiece.toFixed(2)} 个分片，对方进度仍为 ${bitprogress}/${np}，连续异常 ${s.wait} 次（阈值 ${config.noprogress_wait}）`)
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
    // 进入 banQueue 即清状态机：
    // 1) 成功 ban → rememberBlocked 后下次 isBlocked 拦截，state 本来也会被 cleanupPeerState 清。
    // 2) blockIp 失败（ipset 临时故障）→ rememberBlocked 不会被调用，旧版会让下次扫描
    //    因 wait 仍 > 阈值而立刻再次进 banQueue，每次扫描重复打 "传输了 X 个 piece" + 'ipset add 失败'。
    //    清掉 state 给重试一个 noprogress_wait 次的回退窗口，节制日志的同时也避免基于陈旧累计的误判。
    peerState.delete(stateKey)
}

async function cron() {
    if (shuttingDown) return
    const activeKeys = new Set()
    const banQueue = []
    let fullySucceeded = false
    let partialFailure = false

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
            if (results.length !== calls.length) partialFailure = true
        }

        // 3) 解析处理
        for (let i = 0; i < gids.length; i++) {
            const gid = gids[i]
            // multicall 子调用：成功返回 [result]，失败返回 { faultCode, faultString }
            const statusRes = results[i * 2]
            const peersRes  = results[i * 2 + 1]
            if (!Array.isArray(statusRes) || !Array.isArray(peersRes)) {
                partialFailure = true
                continue
            }
            const status = statusRes[0]
            const peers  = peersRes[0]
            if (!status || typeof status !== 'object' || Array.isArray(status) || !Array.isArray(peers)) {
                partialFailure = true
                continue
            }
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
        fullySucceeded = !partialFailure
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
    // 暂停扫描并保活一旦启用，cron 永久停止调度 —— idleHeartbeat 是该状态的 source of truth。
    // 否则 cron 内部抛 uncaughtException 触发 runIdleMode 后，下一轮 scheduleNext 还会装回
    // scanTimer，每 N 秒空跑一次拖资源。
    if (idleHeartbeat) return
    // 不要对 scanTimer 调 unref：
    // Node 的 http.Agent keep-alive 空闲 socket 自带 unref，cron 跑完后没有任何
    // refed handle，如果再把 scanTimer 也 unref，事件循环会立刻判定无事可做、
    // 进程静默 exit(0)，被外面的 s6 / systemd 不断拉起，看起来像"反复重启"。
    // SIGTERM 处理器已经显式 clearTimeout(scanTimer) + process.exit(0)，无需 unref。
    scanTimer = setTimeout(runLoop, backoffDelay())
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
 * 不做类型转换：value 始终是字符串（或 true）。
 * 数字字段由 applyPositiveIntegerConfig / parseBoolean 在 applyCliConfig 里
 * 各自显式 Number()，避免把 secret/path/url 这种纯数字字面量在解析阶段
 * 静默改值（例如 --secret 001234 不应丢前导 0）。
 * 自行实现是为了：① 砍掉 yargs-parser 依赖让 bundle 真正自包含；
 *                  ② 简单、稳定、可测、零运行时风险。
 */
const ARG_ALIAS = {
    c: 'config', u: 'url', s: 'secret', b: 'block-keywords',
    h: 'help', v: 'version'
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
                val = a.slice(eq + 1)
            } else {
                key = a.slice(2)
                const next = args[i + 1]
                if (next !== undefined && (typeof next !== 'string' || !next.startsWith('-'))) {
                    val = next; i++
                } else {
                    val = true
                }
            }
        } else {
            const shortKey = a.slice(1)
            key = ARG_ALIAS[shortKey] || shortKey
            const next = args[i + 1]
            if (next !== undefined && (typeof next !== 'string' || !next.startsWith('-'))) {
                val = next; i++
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
    // process.argv0 在 shebang 启动时始终是 'node'（包括 npm i -g 后用 `aria2b` 命令调用）。
    // 用 process.argv[1] 判断更可靠：'/usr/local/bin/aria2b' 或单文件 bundle 路径都以 'aria2b' 结尾。
    const arg1 = process.argv[1] || ''
    const name = /(?:^|[\\/])aria2b$/.test(arg1) ? 'aria2b' : 'node app.js'
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
        if (idleHeartbeat) { clearInterval(idleHeartbeat); idleHeartbeat = null }
        // 主动销毁 rpcClient agent：让飞行中的 RPC 立刻 ECONNRESET 收尾，
        // cron 会进 catch 分支并 return。否则要等最长 30s 的 RPC 超时
        // 才能 await cronInflight 解开。容器关停从秒级降到毫秒级。
        if (rpcClient && typeof rpcClient.destroy === 'function') {
            try { rpcClient.destroy() } catch (_) { /* ignore */ }
        }
        if (cronInflight) {
            try { await cronInflight } catch (_) { /* ignore */ }
        }
        process.exit(0)
    }
    process.on('SIGTERM', () => { stop('SIGTERM').catch(() => process.exit(0)) })
    process.on('SIGINT',  () => { stop('SIGINT').catch(()  => process.exit(0)) })
    process.on('SIGHUP',  () => { stop('SIGHUP').catch(()  => process.exit(0)) })
    // uncaughtException / unhandledRejection 是程序内部 bug，不是环境问题；
    // 暂停扫描并保活（s6-overlay v2 反复重启会拖垮容器；让 aria2b 静默存活，
    // 同容器里 aria2c / AriaNg 继续工作；用户能从日志里看到 stack trace 修 bug）。
    process.on('uncaughtException', e => {
        try { honsole.error('uncaughtException:', sanitizeError(e)) } catch (_) {}
        if (!idleHeartbeat) runIdleMode(`uncaughtException: ${sanitizeError(e)}`)
    })
    process.on('unhandledRejection', e => {
        try { honsole.error('unhandledRejection:', sanitizeError(e)) } catch (_) {}
        if (!idleHeartbeat) runIdleMode(`unhandledRejection: ${sanitizeError(e)}`)
    })
}

// ============================================================================
// 入口
// ============================================================================

async function initial() {
    argv = parseArgv(process.argv.slice(2))

    if (argv.help)    { console.log(helpText()); return }
    if (argv.version) { console.log(`aria2b v${VERSION} by huggy`); return }

    // 信号处理器要在第一个 await 之前装好。
    // initial() 中后续会 await ipset save / flushIptablesIpset 等子进程，
    // 这些 await 期间如果没有 handler，docker stop 会用 default SIGTERM 直接 kill 进程，
    // 可能让 ipset 处于半初始化状态（destroy 完成但 create 还没跑 / 规则未装）。
    // stop() 引用的所有全局对象（scanTimer/rpcClient/cronInflight）都是 null-safe。
    installSignalHandlers()

    config.ipv6 = detectIpv6Enabled()

    const explicitConfigPath = argv.config !== undefined
    const cfgPath = explicitConfigPath ? String(argv.config) : findAria2Config()
    if (cfgPath) {
        const loaded = loadConfigFromAria2File(cfgPath)
        if (!loaded && explicitConfigPath) {
            return runIdleMode(`显式指定的配置文件不可用：${cfgPath}`)
        }
    } else if (explicitConfigPath) {
        return runIdleMode('显式指定的配置文件路径为空')
    }

    applyCliConfig()

    rpcClient = makeRpcClient()

    // 读 ipset 当前状态
    let ipsetSave = ''
    try {
        ipsetSave = await readIpsetSave()
    } catch (e) {
        honsole.error(`执行 ipset save 失败：${sanitizeError(e)}`)
        honsole.error('请确认容器具备 NET_ADMIN 能力且已安装 ipset')
        return runIdleMode(`ipset 不可用：${sanitizeError(e)}`)
    }

    // 探测 iptables 后端：Alpine 3.13+ 的 `iptables` 包默认指向 nft 后端，
    // 在群晖 DSM 4.x 老内核 / 部分老 NAS 上 nft 子系统初始化即失败，整个 iptables 路径都用不了。
    // 这里探测默认能否工作，不行就尝试切到 `iptables-legacy`（前提是镜像装了 iptables-legacy 包）。
    //   IPv4 失败 → 暂停扫描并保活（绝不 process.exit，否则会触发 s6 crash-loop 拖死容器）
    //   IPv6 失败 → 软降级：仅 IPv4 仍然能干活，给用户明确提示
    if (!await pickIptablesBackendForVersion(4)) {
        return runIdleMode('IPv4 iptables 后端不可用（默认 nft 与 iptables-legacy 都无法工作）。修复：在镜像里装 iptables-legacy 包；若已装请检查容器 NET_ADMIN capability 与内核 ipset 模块')
    }
    if (config.ipv6 && !await pickIptablesBackendForVersion(6)) {
        honsole.warn('IPv6 iptables 后端不可用，自动降级为仅 IPv4 模式继续运行（IPv4 拦截不受影响）。')
        honsole.warn('若需启用 IPv6 拦截，请在镜像里装 iptables-legacy（Alpine 3.23 中它同时提供 ip6tables-legacy）；')
        honsole.warn('若本就不需要 IPv6，可在 aria2.conf 设 disable-ipv6=true 消除此警告。')
        config.ipv6 = false
    }

    let v4Flushed = false
    let v6Flushed = false
    try {
        if (argv.flush || !hasIpset(ipsetSave, IPSET_NAME_V4)) {
            await flushIptablesIpset(4)
            v4Flushed = true
        } else {
            // set 已存在 → 跳过 flush 保留已封 IP，但仍需幂等检查 iptables 规则在不在，
            // 防止前次启动被打断后规则缺失、aria2b 跑空转。
            await ensureIptablesRule(4)
        }
    } catch (e) {
        // 探测通过但 flush/ensure 阶段失败（典型场景：xt_set 模块在该内核完全残缺，
        // 即便 legacy 后端也救不了）→ 同样暂停扫描并保活而不是 crash。
        return runIdleMode(`IPv4 ipset/iptables 初始化失败：${sanitizeError(e)}`)
    }
    // IPv6 setup 即便后端探测通过，xt_set 实际加载 `-m set` 仍可能失败（内核 xt_set 模块
    // 残缺）。这里再套一层 try/catch 兜底：v6 在 flush/ensure 阶段抛错时同样软降级为仅 IPv4。
    // 不变量：这与上面的探测降级共用 `config.ipv6=false` 信号；下游 cron / blockIp / sync
    // 都已经看 config.ipv6 决定是否走 v6 路径。
    if (config.ipv6) {
        try {
            if (argv.flush || !hasIpset(ipsetSave, IPSET_NAME_V6)) {
                await flushIptablesIpset(6)
                v6Flushed = true
            } else {
                await ensureIptablesRule(6)
            }
        } catch (_e) {
            honsole.warn('IPv6 ipset/iptables 初始化失败（后端探测通过但 xt_set 实际加载失败），自动降级为仅 IPv4 模式。')
            config.ipv6 = false
            v6Flushed = false   // 没初始化过的 set 别 sync，避免假装"已封"
        }
    }
    if (argv.flush) {
        honsole.log('已清空 ipset/iptables 规则')
        return
    }

    // 启动时把 ipset 中已存在的 IP 同步进本地缓存。
    // 刚被 flush 的 set 实际是空的，绝不能从 flush 前的快照里同步它的旧条目 ——
    // 否则缓存里"已封"但 ipset 中没有，cron 会因 isBlocked=true 跳过这些 peer，
    // 它们就永远拦不住了。只 sync 没被 flush 的 set。复用上面已有的 ipsetSave 快照，省一次 fork。
    const syncTargets = []
    if (!v4Flushed) syncTargets.push(IPSET_NAME_V4)
    if (!v6Flushed && config.ipv6) syncTargets.push(IPSET_NAME_V6)
    if (syncTargets.length > 0) {
        const synced = syncBlockedIpsFromIpset(ipsetSave, syncTargets)
        if (synced > 0) honsole.log(`已从 ipset 同步 ${synced} 个已封禁 IP 到本地缓存`)
    }

    honsole.log(`${config.rpc_url} secret: ${maskSecret(config.secret)}`)
    honsole.log(`屏蔽客户端：${config.block_keywords.join(', ')}`)
    honsole.log(`无进度上传监控：${config.noprogress_keywords.join(', ')}（累计上传 >${config.noprogress_piece} 个分片且进度仍为 0，连续命中 ${config.noprogress_wait} 次后封禁）`)
    honsole.log(`扫描间隔 ${config.scan_interval}ms，封禁时长 ${config.timeout}s，IPv6 ${config.ipv6 ? '启用' : '禁用'}`)
    honsole.logt('aria2b 已启动，开始扫描 aria2 peer')

    runLoop()
}

if (require.main === module) {
    initial().catch(e => {
        try { honsole.error('启动失败：', sanitizeError(e)) } catch (_) {}
        // 启动阶段未捕获异常（initial 内部应该都 try 过了，这里是兜底）：暂停扫描并保活
        // 而不是 exit，避免 s6-overlay v2 反复重启容器服务（参见 runIdleMode 注释）。
        runIdleMode(`启动异常：${sanitizeError(e)}`)
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
        getPeerName, detectPeerClient,
        formatLocalTimestamp,
        parseList, parsePositiveInteger, parseBoolean,
        hasUnknownKeyword, keywordMatches,
        peerStateKey, parseConfigLine, readTlsMaterial,
        isLocalHttpsRpcUrl, hasIpset,
        sanitizeError, maskSecret,
        // state mgmt
        getPeerState, cleanupPeerState,
        isBlocked, rememberBlocked, cleanupBlockedIps,
        syncBlockedIpsFromIpset, readIpsetSave,
        // CLI
        parseArgv, applyCliConfig, applyNoVerify, loadConfigFromAria2File,
        // ipset / iptables
        iptablesBinaries,
        looksLikeNftBackendIssue,
        probeIptablesBinary, pickIptablesBackendForVersion,
        flushIptablesIpset, ensureIptablesRule, blockIp,
        runIdleMode,
        // RPC
        httpJsonPost,
        // cron
        processOnePeer, cron, backoffDelay, scheduleNext,
        // 状态控制（测试用）
        _reset() {
            blockedIps.clear()
            peerState.clear()
            Object.assign(config, defaultConfig())
            // 测试期间各用例可能伪造 iptables 后端切换；统一重置回默认二进制，
            // 避免上一个用例污染下一个用例的断言（spy.calls 期望命中 'iptables'）。
            iptablesBinaries.v4 = 'iptables'
            iptablesBinaries.v6 = 'ip6tables'
            // 暂停扫描并保活在测试里被触发会留下 refed setInterval，会让 node --test 不退出。
            if (idleHeartbeat) { clearInterval(idleHeartbeat); idleHeartbeat = null }
            consecutiveFailures = 0
            shuttingDown = false
        },
        _getIdleHeartbeat() { return idleHeartbeat },
        _getFailures() { return consecutiveFailures },
        _setFailures(n) { consecutiveFailures = n },
        _getScanTimer() { return scanTimer },
        _clearScanTimer() { if (scanTimer) { clearTimeout(scanTimer); scanTimer = null } },
        _setArgv(v) { argv = v },
        _getArgv() { return argv },
        _setRpcClient(c) { rpcClient = c },
        _makeRpcClient: makeRpcClient
    }
}
