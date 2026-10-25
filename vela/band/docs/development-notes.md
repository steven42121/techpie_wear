# 小米手环 9 端开发笔记：过程、坑与规范

手环端 = `vela_app/`（Vela JS 快应用，AstroBox 侧载）+ TechPie APK 内的 `BandBridge.kt` / `BandReminders.kt` 桥接。
本文记录整个开发过程沉淀下来的运行时特性、协议、构建与调试方法。离线码（SM2/QR/PNG）细节见 [offline-code.md](offline-code.md)。

- 快应用入口：`vela_app/src/pages/index/index.ux`
- 手机桥：`android/app/src/main/kotlin/club/geekpie/techpie/BandBridge.kt`
- 手机逻辑：`lib/services/band_service.dart`
- 打包产物：`vela_app/dist/club.geekpie.techpie.debug.<version>.rpk`
- 签名验证：`vela_app/tool/verify_rpk.py`

---

## 1. 架构与通信

```
手环快应用 (QuickJS)  ⇄  小米运动健康 (BLE)  ⇄  TechPie APK
        interconnect          XMS SDK            BandBridge.kt → MethodChannel → Dart
```

- 快应用**没有网络**（无 `@system.fetch`），所有数据经 `@system.interconnect` 由手机端提供。
- 消息是 JSON 字符串；单包约 2400 字符，超出必须分片。

### 协议表

| 方向 | 消息 | 说明 |
|---|---|---|
| 手环→手机 | `{t:'schedule.req', date, week:true}` | 请求整周课表 |
| 手机→手环 | `{t:'schedule.week', days:[{date, courses:[{n,loc,s,e,st}]}]}` | 前后 7/6 天 |
| 手机→手环 | `{t:'schedule.snap', courses:[...]}` | 旧版单日快照（兼容路径） |
| 手环→手机 | `{t:'assignments.req'}` | 请求作业 |
| 手机→手环 | `{t:'assignments.snap', items:[{title,course,kind,due,left}]}` | 最近 10 项未交 |
| 手环→手机 | `{t:'ecard.req'}` | 请求在线消费码（QR PNG base64） |
| 手机→手环 | `{t:'ecard.snap', png}` / `{t:'ecard.chunk', seq,total,data}` | 大图分片 |
| 手环→手机 | `{t:'offline.cred.req'}` | 请求离线签名凭证 |
| 手机→手环 | `{t:'offline.cred', privateKey,pubX,pubY,authorInfo,checksum,expiresAt}` | 私钥下发 |
| 手机→手环 | `{t:'offline.cred.clear'}` | 清除手环本地凭证（手机开关关闭时下发） |
| 手机→手环 | `{t:'offline.cred', error:'未授权…'}` | 开关未开启时的拒绝响应，手环显示「未授权」 |
| 双向 | `ping` / `pong` | 链路探活 |
| 通用分片 | `{t:'<类型>.chunk', seq, total, data}` | 手环侧按 `seq` 拼装后递归处理 |

分片参数必须校验上限（`total` ≤ 200、`seq`/`total` 为数字），防止异常消息撑爆内存。

---

## 2. 缓存与刷新策略（v0.15.27 定稿）

- 缓存键：`cache_schedule_week`（7 天 TTL）、`cache_assignments`（24 小时 TTL），存 `system.storage`，格式 `{at: 时间戳, msg: 原始消息}`。
- **TTL 只决定要不要主动发请求，不影响显示**：TTL 内有本地数据 → 直接上屏（不需要连接手机）；过期/无数据 → 显示「尚未同步课表/作业」占位。
- 刷新时机：进入程序（`onInit` 强制刷一次）、切页（`enterPage(1)` 课程 / `enterPage(3)` 作业）、点亮「同步」按钮、`conn.onopen` 重连。
- 空状态不是独立节点：**是 `for` 列表里的一条占位行**（`st:'empty'`），列表永远非空。

---

## 3. 快应用运行时特性与坑（渲染为主，全部真机实证）

### 3.1 swiper 面板预算 300px
每个 `.panel` 高度 300px，**子元素总高（标题 28 + 间距 6 + 列表视口）必须 ≤ 300**。
超出时表现为：盒子缩成内容高度、位移响应反向（margin-top 让盒子反向上移）。
→ 列表视口安全值：课程 236 / 作业 260（`.panel-scroll.tall`），**不要超过 266**。
这是「格子太矮 / 缩到一格 / 怎么改都没变化」持续数小时的总根因（旧 `.panel-scroll.wide` 286px 溢出）。

### 3.2 scroll 的直接子元素不做盒模型布局
`<scroll>` 不是 div，其子元素的 `flex` 属性、固定 `height` 都可能失效（横排 / 缩内容）。
→ 列表内容必须包一层 `<div class="rows">`（`flex-direction: column`），行放在 div 里高度才生效。

### 3.3 条件子树与首次更新会丢
- `if` 条件节点在数据异步到达后可能**不重新求值**：首帧画出的默认内容会一直卡在屏幕上。
- 数据到达后的**第一次界面更新可能被吞掉**（不重画），任何后续用户交互都会把它带出来。
- 结论/对策：
  - 空状态、占位不要用 `if` 切换，用 `for` 列表的占位行；
  - `for` 列表避免求值为空；
  - 数据应用后补一次延迟重绘（`setTimeout(renderDay, 100)`）；
  - **每个页面在 `enterPage` 时主动触发一次本页数据刷新**（课程/作业对称）。

### 3.4 文本
- `<text>` 的子组件**只支持 `<span>`**；span 只支持字号/颜色/粗细等，**不支持 line-height**。
- 行距只能在 `<text>` 上设 `line-height`。
- 标题与副行分两行：用**两个独立 `<text>` 节点**，不要依赖数据里的 `\n`（未文档化、不可靠）。
- 文本盒给显式高度 + `lines` 上限，避免被内容“吞高”。

### 3.5 其它
- `flex` 系列属性只在父容器为 `<div>` / `<list-item>` 时生效；`flex-shrink` 默认 1。
- 固定尺寸盒子避免与其 padding 混用（内容溢出）；改用 wrapper 的 padding/margin。
- `position: fixed` 在此运行时不可用，控件保持普通流。
- `swiper` 独占横向手势：分页与「左滑退出」互斥，退出用空面板 + `onchange` 实现。
- 亮度：`system.brightness` 0–255；**切页动画结束后 ~500ms 再操作**，自动亮度模式要先记原值再临时切手动，恢复时反序；否则**冻机**。
- `interconnect`：`MessageApi.addListener` 对同一 nodeId 只能注册一次（重复抛 `IllegalStateException`），桥内去重。
- `storage.get` 回调值可能是字符串也可能是对象，解析两者都兼容。
- 运行时只有 `system.*` 能力；QuickJS 无 BigInt/无 JIT，重计算必须在手机侧。

---

## 4. UI 结构规范

```html
<swiper class="swiper" ...>            <!-- 192×300，indicator=false -->
  <div class="panel exit-panel"></div> <!-- 索引 0：空面板，滑到即退出 -->
  <div class="panel">                  <!-- 课程 -->
    <text class="section-title">{{ dayLabel }}</text>
    <div class="day-actions">…前一天/后一天…</div>
    <scroll class="panel-scroll" scroll-y="true">
      <div class="rows">
        <div class="row {{ $item.st }}" for="courses">
          <text class="row-name">{{ $item.t2 }}</text>
          <text class="row-sub">{{ $item.sub }}</text>
        </div>
      </div>
    </scroll>
  </div>
  <div class="panel qr-panel">…</div>  <!-- 消费码（自动提亮） -->
  <div class="panel">…作业，结构同课程…</div>
</swiper>
```

- 屏 192×490、`designWidth: 192`（1 CSS px ≈ 1 物理 px）；正文 22–26px；内容列 176px。
- 行盒 180px，名称 26px 纯白加粗、副行 22px 次白；两个列表**共用**同一套类与 `decorateRows` 渲染管线。
- 空状态 = 列表占位行（`st:'empty'`），文案经 `presentRows` 注入。
- 圆点指示器自绘（激活实心 8px `#4c9aff`，未激活空心 1px 边），仅展示不可点。

---

## 5. 离线码（摘要）

手机生成凭证 → 手环本地 SM2 签名 + QR + PNG：真机 **9 秒**出码（详见 [offline-code.md](offline-code.md)）。
要点：加密/二维码模块全部**懒加载**（`ensureCrypto()`，首次生成离线码时才 require），不拖慢启动；
QR 生成必须在二维码页自动提亮屏幕。

---

## 6. 构建、签名与验证

```bash
cd vela_app
npx aiot build                     # 产出 dist/club.geekpie.techpie.debug.<ver>.rpk
python3 tool/verify_rpk.py dist/club.geekpie.techpie.debug.<ver>.rpk
```

- **包名必须等于 APK applicationId**（`club.geekpie.techpie`），**rpk 证书必须与已装 APK 一致**（debug keystore `7acf9493…0bd2`）；重签 APK 后必须重打 rpk。
- `verify_rpk.py` 验证：文件哈希、双签名（RPK Sig Block 42）、证书与 `vela_app/sign/debug/certificate.pem` 配对。
- **并发构建会互相破坏**：工具链默认共享临时目录 `../.temp_vela_app`，两个 aiot 进程同时跑会把对方的 src 清空（`ENOENT manifest.json`）。已给 `node_modules/@aiot-toolkit/aiotpack/lib/config/UxConfig.js` 的 `get output` 打补丁改为 `../.temp_<name>_<pid>`（**npm install 后需重打**）。
- 出真包前把 `index.ux` 顶部 `const TEST_DATA` 改为 `false`。
- 版本：`manifest.json` 的 `versionName`/`versionCode` 与页面 `syncLabel` 同步递增；手环按 `versionCode` 缓存应用图标。

---

## 7. 调试方法论（血泪教训）

1. **编译产物 grep 只能证明代码进包，不能证明渲染正确**——渲染问题必须看屏幕。改 2 轮不见效就必须拿到截图。
2. **在可见 UI 上钉探针**：把状态写进空状态副行这类必定显示的位置（如「（已过期）」「（未连接）」），一张截图定位整条数据链。
3. **对照实验**：把已知正常的页面整块克隆到异常位置（曾把课程面板逐字节复制到第三页），一次实验排除一大类假设（面板位置）。
4. **位移探针**：给元素加 `margin-top: 100px`，看动不动，判断样式是否生效、几何是否被挤爆。
5. 用 AIoT-IDE **实时预览**改 UI；不要在后台自行启动模拟器或并发跑 `aiot` 命令（会与用户构建竞态）。
6. 构建失败先看输出的**第一条完整错误**（loader 报错可能来自某个文件里一个断裂的表达式）。

---

## 8. 发布检查清单

- [ ] `TEST_DATA = false`
- [ ] `syncLabel` 与 `manifest.json` 版本已递增
- [ ] `python3 tool/verify_rpk.py` 全绿、证书配对 OK
- [ ] 真机验证：进程序自动刷新、切页刷新、本地缓存显示、过期占位、同步按钮、离线码生成、亮度恢复
- [ ] 共享 worktree 下只提交自己的文件（`git status` 确认）

---

## 9. 关键版本演进

| 版本 | 变更 |
|---|---|
| v0.9.2 | swiper 三页定稿（课程/消费码/作业）、自绘圆点、接受左滑退出不可用 |
| v0.9.7 | scroll 子元素横排修复：`.rows` 纵向容器 |
| v0.10–0.14 | 整周快照 + TTL 缓存、离线消费码、课程/作业/消费码页面成型 |
| v0.15.x | SM2 优化 38s→9s；UI 大型排障（见 §3.1/3.3） |
| v0.15.27 | 作业页按课程页重建、300px 面板预算定稿、占位行空状态、进页刷新、懒加载与去重优化 |
