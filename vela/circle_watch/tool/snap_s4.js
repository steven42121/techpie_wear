// 连接已运行的 xiaomi_s4 模拟器并截屏
'use strict'
const path = require('path')
const fs = require('fs')

async function main() {
  const emulator = require('@aiot-toolkit/emulator')
  const { getRunningAvdConfig } = require('@aiot-toolkit/emulator/lib/emulatorutil/running')
  const cfgs = getRunningAvdConfig()
  const cfg = cfgs.find((c) => c['avd.name'] === 'xiaomi_s4')
  if (!cfg) {
    throw new Error('xiaomi_s4 not running; configs: ' + cfgs.map((c) => c['avd.name']).join(','))
  }
  const agent = emulator.createGrpcClient ? emulator.createGrpcClient(cfg) : null
  const client = agent || new (require('@aiot-toolkit/emulator/lib/vvd/grpc').default)(cfg,
    path.join(path.dirname(require.resolve('@aiot-toolkit/emulator')), 'static/proto/emulator_controller.proto'))
  await client.waitForReady()
  const tag = process.argv[2] || 'snap'
  const swipeN = parseInt(process.argv[3] || '0', 10)
  const swipe = () => new Promise((res) => {
    const steps = [{x:320,y:233,pressure:1},{x:270,y:233,pressure:1},{x:220,y:233,pressure:1},{x:185,y:233,pressure:1},{x:185,y:233,pressure:0}]
    let i = 0
    const next = () => client.client.sendTouch({ touches: [steps[i]], display: 0 }, client.authMate, () => {
      i += 1
      if (i < steps.length) setTimeout(next, 180)
      else setTimeout(res, 1500)
    })
    next()
  })
  for (let s = 0; s < swipeN; s++) await swipe()
  const shot = await client.getScreenshot()
  const file = path.resolve(__dirname, 's4-' + tag + '.png')
  fs.writeFileSync(file, shot)
  console.log('saved', file, shot.length, 'bytes')
  client.close()
  process.exit(0)
}

main().catch((e) => {
  console.error('FAIL:', e && e.message ? e.message : e)
  process.exit(1)
})
