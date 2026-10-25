// 一次性验证脚本：起 xiaomi_s4 → 部署 circle_watch rpk → 唤醒 → gRPC 截屏
// 用法: node tool/verify_s4.js
'use strict'
const path = require('path')
const fs = require('fs')

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

async function main() {
  const emulator = require('@aiot-toolkit/emulator')
  const { VvdManager, IStartOrigin } = emulator
  const manager = new VvdManager({})

  const list = manager.getVvdList().map((v) => v.name)
  if (list.indexOf('xiaomi_s4') < 0) {
    throw new Error('xiaomi_s4 vvd not found: ' + list.join(','))
  }

  console.log('starting xiaomi_s4 ...')
  const res = await manager.startVvd({
    vvdName: 'xiaomi_s4',
    origin: IStartOrigin.Terminal
  })
  const inst = res.emulatorInstance
  console.log('started, grpc:', res.grpcConfig && res.grpcConfig['grpc.port'])

  // 等 adb 桥就绪：必须匹配本实例的 serial（机器上还有用户的 band 模拟器在跑）
  const { execSync } = require('child_process')
  const adbPort = res.grpcConfig && (res.grpcConfig['port.serial'] || res.grpcConfig['port.adb'])
  const serial = 'emulator-' + adbPort
  console.log('waiting for', serial)
  for (let i = 0; i < 40; i++) {
    try {
      // 不只看 devices 列表（有幽灵条目），实际探活
      execSync('adb -s ' + serial + ' shell true', { encoding: 'utf-8', timeout: 3000 })
      break
    } catch (e) {}
    await sleep(1000)
    if (i === 39) throw new Error('adb not ready: ' + serial)
  }
  console.log('adb ready:', serial)

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
  console.log('app started')
  await sleep(2500)

  const agent = res.getAgent()
  const outDir = __dirname

  // 流式截屏：收集帧，取最后一帧
  let lastFrame = null
  let frameCount = 0
  await agent.startStream((buf) => {
    lastFrame = buf
    frameCount += 1
  })
  console.log('screenshot stream started')

  const tap = (x, y) => new Promise((resolve) => {
    agent.client.sendTouch(
      { touches: [{ x, y, identifier: 0, pressure: 1 }], display: 0 },
      agent.authMate,
      () => setTimeout(() => {
        agent.client.sendTouch(
          { touches: [{ x, y, identifier: 0, pressure: 0 }], display: 0 },
          agent.authMate,
          () => resolve()
        )
      }, 120)
    )
  })

  // 抓第1页（表盘）
  let shot = await agent.getScreenshot()
  fs.writeFileSync(path.join(outDir, 's4-shot-0.png'), shot)
  console.log('shot 0 (dial)', shot.length, 'bytes')

  // 左滑到第2页（消费码）
  const swipeLeft = () => new Promise((resolve) => {
    // 慢拖 150px，不甩（上次快速滑动一次飞过两页）
    const steps = [
      { x: 320, y: 233, identifier: 0, pressure: 1 },
      { x: 270, y: 233, identifier: 0, pressure: 1 },
      { x: 220, y: 233, identifier: 0, pressure: 1 },
      { x: 185, y: 233, identifier: 0, pressure: 1 },
      { x: 185, y: 233, identifier: 0, pressure: 0 }
    ]
    let i = 0
    const next = () => {
      agent.client.sendTouch({ touches: [steps[i]], display: 0 }, agent.authMate, () => {
        i += 1
        if (i < steps.length) setTimeout(next, 180)
        else setTimeout(resolve, 1500)
      })
    }
    next()
  })
  await swipeLeft()
  shot = await agent.getScreenshot()
  fs.writeFileSync(path.join(outDir, 's4-shot-1.png'), shot)
  console.log('shot 1 (qr)', shot.length, 'bytes')
  await swipeLeft()
  shot = await agent.getScreenshot()
  fs.writeFileSync(path.join(outDir, 's4-shot-2.png'), shot)
  console.log('shot 2 (assign)', shot.length, 'bytes')

  process.exit(0)
}

main().catch((e) => {
  console.error('FAIL:', e && e.stack ? e.stack : e)
  process.exit(1)
})
