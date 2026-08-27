const vm = require('vm')
const sb = {
  btoa: (s) => Buffer.from(s, 'utf-8').toString('base64'),
  atob: (s) => Buffer.from(s, 'base64').toString('utf-8'),
  TextEncoder, TextDecoder,
}
vm.createContext(sb)
console.log('types:', vm.runInContext('typeof unescape + "/" + typeof encodeURIComponent', sb))
const r = vm.runInContext("btoa(unescape(encodeURIComponent('こんにちは、世界。')))", sb)
console.log('b64:', r)
console.log('decoded:', Buffer.from(r, 'base64').toString('utf8'))
