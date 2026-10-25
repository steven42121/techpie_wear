# 小米手环 9 离线消费码：制作经历与实现笔记

手环端（Vela 快应用）在**不联网、不依赖手机**的情况下本地生成离线消费码：
纯 JS 完成 SM2 签名 + QR 编码 + PNG 渲染，从点按到出码 **9 秒**（真机实测，耗时显示在二维码下方；
优化前约 38 秒）。

- 手环快应用：`vela_app/`（AstroBox 侧载）
- 手机端导出凭证：`lib/services/campus_card_service.dart` → `exportOfflineCredentialForBand()`
- 协议与 Dart 参考实现：`lib/features/campus_card/data/crypto/sm2_offline_crypto.dart`

---

## 1. 背景与约束

| 约束 | 事实 | 影响 |
|---|---|---|
| 运行时 | QuickJS 解释执行，**无 BigInt、无 JIT** | 大数运算必须手写 limb |
| 能力边界 | 只有 `system.*`（interconnect/file/storage/brightness…），**无 fetch、无原生插件** | 签名、QR、PNG 全部纯 JS |
| 通信 | 与手机经小米运动健康 BLE 中转（XMS 穿戴 SDK），单包约 2400 字符 | 大消息必须分片 |
| 性能 | naive 256-bit 模乘实测 **213 ms**，模逆 421 ms | 首版估算一次签名 ≈ **13 分钟**，不可用 |
| 稳定性 | 长同步 JS 块会冻结手环（无侧键，需去小米之家恢复） | 重计算必须分片执行 |

第一版「手机渲染 QR 图片推给手环」的方案一直保留为兜底（`ecard.req` 链路）。
本笔记记录的是第二条路：**凭证下发 + 手环本地签名**。

## 2. 总体架构

```
┌─────────────┐  offline.cred.req   ┌──────────────────┐
│ 手环 rpk     │ ──────────────────► │ 手机 APK          │
│ (Vela JS)   │ ◄────────────────── │ BandBridge.kt     │
│             │  offline.cred       │   ↕ MethodChannel │
│ 本地 SM2 签名│                     │ BandService (Dart) │
│ 本地 QR/PNG │                     │ exportForWatch()   │
└─────────────┘                     └──────────────────┘
```

1. 手环首次使用点「同步离线凭证」，手机把 **私钥 + 公钥坐标 + authorInfo + 设备校验和 + 过期时间** 发给手环；
2. 手环存入 `system.storage`（`offline_cred`），之后**离线**可用；
3. 每次生成消费码时本地签名（确定性 k），整个载荷编码成 QR 显示。

注意：本地签名**不消耗**手机端 `reserveUse` 一次一码配额（配额只在手机生成路径计数）。

## 3. 离线码协议（逐字节）

载荷 = 原始字节（不是 hex 文本），QR 用 byte 模式编码：

```
authorInfo (N 字节，服务端下发的 hex 串解码)
|| timeCrc (5 字节)
|| SM2 签名 r||s (64 字节，r、s 各 32 字节大端)
```

`timeCrc` 构造（与 Dart `buildTimeCrc` / iOS `OfflineCode.timeCRC` 一致）：

```
[秒级 Unix 时间戳 4 字节大端] || [XOR 折叠校验字节]
校验字节 = deviceChecksum ^ ts[0] ^ ts[1] ^ ts[2] ^ ts[3]
deviceChecksum = SM3(deviceCode) 全部字节 XOR 折叠
```

签名方案（GM/T 0003 SM2，输出必须与 Dart 逐字节一致）：

```
ZA = SM3(ENTL || ID || a || b || Gx || Gy || Px || Py)   ID 默认 "1234567812345678"
e  = SM3(ZA || message)  按 256 位大整数解释
r  = (e + x1) mod n        (x1 = k·G 的 x 坐标)
s  = (k - r·d) · (1+d)⁻¹ mod n
输出 = uppercase hex(r || s)，128 个字符
```

## 4. SM2 纯 JS 移植与算法优化

### 4.1 性能演进（手环实测 / QuickJS 标定）

| 版本 | 做法 | 模乘耗时 | 一次签名 |
|---|---|---|---|
| v1 | BigInt | — | 运行即冻结（QuickJS 无 BigInt） |
| v2 | 16-bit limb 移位累加模乘 + 仿射点运算 | 213 ms | ≈ 13 分钟 |
| v3 | Montgomery CIOS + Jacobian + 4-bit 窗口 + 确定性 k | ~11 ms（19×） | ≈ 35 s |
| v4 | 同上，标量乘改 **Lim–Lee 固定基 comb（d=8）** | 同上 | ≈ 9 s |
| v5（现行） | comb + montMul 内循环 4× 展开 + 收尾 mod-n 乘法 Montgomery 化 + 预计算表离线转 Montgomery（启动零乘法） | ~9 ms | **≈ 7 s** |

被否决/试过无效的方向（都有实测依据）：
- **专用平方 montSqr**（136 字乘 vs 256）：QuickJS 上进位开销吃掉收益，整体反而慢 12%——已回退。
- **零倍点移位表**（b·16^j·G 全预计算）：只比 comb 再快 ~10%，常量表却要 960 点（rpk +135 KB）。
- **15-bit limb**（让所有中间量 <2³¹ 避免 QuickJS float64 装箱）：微基准证明本引擎对 >2³¹ 乘积**没有惩罚**（16 位值乘法反而快 20%）——不成立，弃。
- **Uint32Array 存 limb**：只快 ~4%，不值得动全部算术代码。
- **后台预签名**：被否决（耗电）。

### 4.4 管线剖析（QuickJS 实测，手环同源引擎）

| 阶段 | 优化前 | 优化后 | 手段 |
|---|---|---|---|
| SM2 标量乘 + 收尾 | 165 ms（4-bit 窗口） | 28 ms | comb + montMul 全展开 + mod-n Montgomery |
| QR 编码 | 14 ms | 7 ms | 矩阵只建一次按掩码复制；罚分函数去闭包 + 首位快速拒绝 |
| PNG 渲染 | 8 ms | 4 ms | Uint8Array 预分配、`fill` 行段写入 |
| 合计（到出码） | ≈187 ms ≈ 38 s | ≈46 ms ≈ **9 s（真机实测）** | |

教训：**先剖析再动手**——标量乘之外的 QR 罚分一度占总耗时 19%，却不在任何「算法优化」的直觉里。

### 4.2 现行实现（`vela_app/src/common/sm2.js`）

1. **Montgomery CIOS 模乘**：16 个 16-bit limb，两层循环各 16 次字乘，进位用 `v >>> 16`
   （`v < 2^32`，安全）；结果 < 2M，条件减一次。R = 2²⁵⁶，`n0inv = -M⁻¹ mod 2¹⁶`。
2. **Jacobian 坐标**：点加/倍点全程不求模逆；dbl-2007-bl（a = -3 特化为 `M = 3(XX - Z⁴)`，
   9 次 Montgomery 乘）+ madd-2007-bl（混合加，11 次）。
3. **Lim–Lee 固定基 comb（d=8，L=32）**：签名只需要 k·G，基点固定，
   于是把 255 个组合点 `P_m = Σ_{i∈bits(m)} 2^{32i}·G`（m = 1..255）**离线预计算硬编码**。
   256 位标量拆成 8 条 32 位列，逐位取 8-bit 掩码查表求值：**31 次倍点 + ≤32 次混合加**
   （≈ 640 次模乘，比 4-bit 窗口的 ~2960 次快 4.6×）。表只让 rpk 增大 ~21 KB（压缩后）。
   为什么不用「零倍点移位表」（b·16^j·G 全预计算）：速度只再快 ~10%，
   但常量表要 960 点（rpk +135 KB），性价比不如 comb。
4. **确定性 k**：`k = SM3(d || e || message || counter)`，counter 递增直到落在 [1, n-1]。
   手环无密码学随机数，`Math.random` 签名会**泄露私钥**，不能用。
5. **归约细节**：`x1 < p` 可能 ≥ n（概率 2⁻³²），入 r 前先减一次 n；
   `r == 0 || r+k == n || s == 0` 时换 counter 重来（与 Dart 重试语义一致）。

### 4.3 执行模型：分片防冻机

签名拆成 32 个求值步（每步一次倍点 + 一次查表混合加，~0.3 s），
用 `setTimeout(..., 0)` 链驱动，UI 显示进度；QR/PNG 生成也放在独立滴答。
**任何长同步块都可能冻结手环**——这是用一次变砖换来的教训。
（后台预签已被否决：耗电。）

## 5. QR / PNG 本机生成

- `vela_app/src/common/qr.js`：byte 模式、EC-M、版本 1-10 自动选择，8 种掩码取罚分最低。
  校验方式：与 npm `qrcode` 库强制同版本/同掩码逐模块对比，**80/80 矩阵位级一致**。
- `vela_app/src/common/png.js`：8-bit 灰度 PNG，deflate 用 stored 块（不引 zlib），
  180×180、4 模块静区、整数倍缩放。jsQR 解码回环验证 8/8。
- 版本信息块（v≥7）、16 位字符计数（v≥10）都实现了——authorInfo 是服务端任意长度 hex，
  初版只支持到 v6，载荷超 106 字节就抛「二维码太长」，这就是「签名 64 步后失败」的根因。

## 6. 正确性验证方法（层层对照）

新实现不要信任「看起来对」，按以下顺序对照：

1. **夹具逐字节**：`ios/WatchSupport/Tests/.../Fixtures/dart-sm2.json`（d=1、固定 k 向量）。
   由 r、s 反推 k = (2s + r) mod n，重放签名必须与夹具**完全相同**——
   一步覆盖 SM3、ZA、点乘、r/s、编码全部环节。
2. **Dart 交叉验证**：随机 8 组密钥/消息，用仓库 `Sm2OfflineCrypto.verify()` 验签。
   回归夹具固化在 `test/fixtures/vela-sm2.json` + `test/campus_card/data/vela_sm2_fixture_test.dart`。
3. **QR/PNG 回环**：走手环真实代码路径生成 PNG → jsQR 解码 → 与载荷逐字节比对。
4. **算法内核**：Montgomery/limb 层与 BigInt 参考随机对照（p、n 各 300 组）。
5. **产物验证**：`vela_app/tool/verify_rpk.py` 校验 RPK Sig Block 42
   （三段 zip 分区摘要 + signdata/filelist 双 RSA-SHA256 + 文件逐项 SHA-256 + 证书配对）。

## 7. 手环端工程经验（踩坑清单）

- **padding 不是 margin**：固定盒子里 padding 不撑开盒子；滚动范围只认 padding。
- **scroll 子元素默认横向布局**：列表行必须包在 `flex-direction: column` 容器里。
- **swiper 独占横滑手势**：翻页与「左划退出」互斥，鱼与熊掌不可兼得。
- **条件子树反复切换会丢节点**（按钮消失）：保持常驻结构，用数据驱动内容。
- **系统 API 别在切页动画里调**：亮度等调用延迟 500 ms + 串行 + token 守卫。
- **setTimeout 链在本工程可用**（签名 64 步、亮度延迟都靠它），但同步长块一律禁止。
- **消息日志要脱敏**：`offline.cred` 含私钥，手机侧与手环侧日志都只打类型不打内容。

## 8. 排错记录

| 现象 | 根因 | 修复 |
|---|---|---|
| 签名到 64 步左右失败 | authorInfo 超长时 QR 载荷 > v6 容量；异常被吞只显示「签名失败」 | QR 扩到 v10；错误信息带异常详情；收尾工作拆滴答 |
| 离线课表没有 | 每个日期单独缓存，换个日期就要重新同步；且周快照单包超限静默丢失 | 整周快照（前 7 后 6 天）+ 7 天缓存；大消息通用分片（`type.chunk`） |
| 签名与 App 不兼容（早期） | `toAffine` 返回 Montgomery 域坐标未还原；「减 n 归约」写成了减 0 | 夹具逐字节对照暴露，两处修正 |
| SM3 全错 | IV 记错（后 6 个常量） | 以仓库 gmssl `sm3.c` 为准 |
| format info 转置 | QR 格式信息位序记反 | 与 `qrcode` 库逐模块对照修正 |
| 手环变砖（历史） | BigInt 自测长同步块 | 分片执行铁律 |

## 9. 文件索引

| 文件 | 职责 |
|---|---|
| `vela_app/src/common/sm2.js` | SM3 + Montgomery/Jacobian SM2（由 /tmp/sm2opt 打包生成） |
| `vela_app/src/common/qr.js` | QR 编码器（byte 模式，EC-M，v1-10） |
| `vela_app/src/common/png.js` | 灰度 PNG 编码器（stored deflate） |
| `vela_app/src/pages/index/index.ux` | 消费码页：签名状态机、进度、QR 显示、周课表 |
| `vela_app/tool/verify_rpk.py` | RPK 签名验证器 |
| `lib/features/campus_card/data/crypto/sm2_offline_crypto.dart` | Dart 参考实现（字节对齐基准） |
| `lib/services/campus_card_service.dart` | `exportOfflineCredentialForBand()` 凭证导出 |
| `lib/services/band_service.dart` | `offlineCredRequest` / 周快照 |
| `android/.../BandBridge.kt` | 消息路由 + 2400 字符通用分片 |
| `test/fixtures/vela-sm2.json` | 手环签名回归夹具 |

常用命令：

```bash
# 手环构建 + 签名验证
cd vela_app && npx aiot build
python3 tool/verify_rpk.py dist/club.geekpie.techpie.debug.<版本>.rpk

# 回归（夹具验签）
flutter test test/campus_card/data/vela_sm2_fixture_test.dart
```
