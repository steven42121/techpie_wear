// 启动 xiaomi_s4 并部署 rpk，保持模拟器常驻（供用户观看 + 后续注入数据）
'use strict'
const path = require('path')
const { execSync } = require('child_process')

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

async function main() {
  const emulator = require('@aiot-toolkit/emulator')
  const { VvdManager, IStartOrigin } = emulator
  const manager = new VvdManager({})
  console.log('starting xiaomi_s4 ...')
  const res = await manager.startVvd({
    vvdName: 'xiaomi_s4',
    origin: IStartOrigin.Terminal
  })
  const inst = res.emulatorInstance
  const serial = 'emulator-' + (res.grpcConfig['port.serial'] || res.grpcConfig['port.adb'])
  console.log('grpc:', res.grpcConfig['grpc.port'], 'serial:', serial)

  for (let i = 0; i < 40; i++) {
    try {
      execSync('adb -s ' + serial + ' shell true', { encoding: 'utf-8', timeout: 3000 })
      break
    } catch (e) {}
    await sleep(1000)
    if (i === 39) throw new Error('adb not ready: ' + serial)
  }
  console.log('adb ready')

  const rpk = path.resolve(__dirname, '../dist/club.geekpie.techpie.debug.0.16.0.rpk')
  const pkg = 'club.geekpie.techpie'
  let target
  for (let i = 0; i < 10; i++) {
    try {
      target = await inst.pushRpk(rpk, pkg)
      break
    } catch (e) {
      console.log('push retry', i)
      await sleep(2000)
    }
  }
  if (!target) throw new Error('push failed')
  await inst.install(target, { packageName: pkg })
  await inst.startApp(pkg, false)
  console.log('app started, emulator kept alive')
  // 常驻：不退出，保持 qemu 存活
  setInterval(() => {}, 60000)
}

main().catch((e) => {
  console.error('FAIL:', e && e.message ? e.message : e)
  process.exit(1)
})
