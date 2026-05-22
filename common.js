// 用于解码 peerid 名称
// 代码来自 https://github.com/mayswind/AriaNg/blob/a091ee850ff45a56ab033f821727c1ad24049a60/src/scripts/services/ariaNgCommonService.js#L91
function decodePercentEncodedString(s) {
  if (!s) {
    return 'Unknown'
  }
  var ret = ''
  for (var i = 0; i < s.length; i++) {
    var ch = s.charAt(i)
    if (ch === '%' && i < s.length - 2) {
      var code = s.substring(i + 1, i + 3)
      var parsed = parseInt(code, 16)
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

// foreach + async 
async function asyncForEach(array, callback) {
  for (let index = 0; index < array.length; index++) {
    await callback(array[index], index, array)
  }
}
function dt() {
  return new Date().toLocaleString('zh')
}

const honsole = {
  dev: function (...args) {
    if (process.env.DEV) {
      console.log('[aria2b]', ...args)
    }
  },
  log: function (...args) {
    console.log('[aria2b]', ...args)
  },
  logt: function (...args) {
    if (process.env.HIDE_TIME_PREFIX) {
      return this.log(...args)
    }
    console.log('[aria2b]', dt(), ...args)
  },
  error: function (...args) {
    console.error('[aria2b]', ...args)
  },
  warn: function (...args) {
    console.warn('[aria2b]', ...args)
  }
}
const child_process = require('child_process')
const exec = require('util').promisify(child_process.exec)
const execFile = require('util').promisify(child_process.execFile)
// const exec = (cmd)=>{
//   console.log(cmd)
//   return {
//     stdout: '1'
//   }
// }

const execR = async (cmd) => {
  try {
    return await exec(cmd)
  } catch (error) {
    honsole.dev(error)
    return 'error'
  }
}

const execFileR = async (file, args = []) => {
  try {
    return await execFile(file, args)
  } catch (error) {
    honsole.dev(error)
    return 'error'
  }
}

module.exports = {
  decodePercentEncodedString,
  asyncForEach,
  dt,
  honsole,
  exec,
  execR,
  execFile,
  execFileR
}
