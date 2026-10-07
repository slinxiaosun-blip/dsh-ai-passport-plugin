const noble = require('@stoprocent/noble')
const TX = 'a90050415353544f524f5350f0a90003'
let done = false
noble.on('discover', async (p) => {
  const a = p.advertisement || {}
  if (!(a.localName || '').includes('Folo') || done) return
  done = true
  noble.stopScanning(() => {})
  await new Promise((r) => p.connect(r))
  console.log('  [主机] 已连接')
  p.discoverAllServicesAndCharacteristics((err, svc, chars) => {
    const tx = chars.find((c) => String(c.uuid).toLowerCase() === TX)
    tx.on('data', (d) => console.log(`  [主机] ← ${d.length} 字节: ${d.subarray(4).toString('utf8')}`))
    tx.subscribe((e) => console.log('  [主机] 订阅:', e ? e.message : 'OK'))
    setTimeout(() => { p.disconnect(); setTimeout(() => process.exit(0), 300) }, 10000)
  })
})
const go = () => noble.startScanning([], false, () => {})
if (noble.state === 'poweredOn') go(); else noble.on('stateChange', (s) => s === 'poweredOn' && go())
setTimeout(() => process.exit(1), 40000)
