# TechPie Wear

TechPie 穿戴端快应用（Xiaomi Vela QuickApp）仓库。一套源码，三个设备目标，通过 GitHub Actions 打包出可安装的 RPK。

## 项目结构

```
vela/
├── band/         小米手环 7/8/9/10/11（单 rpk 多机型适配，designWidth 192）
├── band_pro/     小米手环 9 Pro（336×480，designWidth 336）
├── circle_watch/ 小米手表 S4 圆形表盘
└── docs/         模拟器截图自验证等通用文档
```

每个子项目都是独立的快应用工程：`src/` 源码、`sign/` 签名证书、`tool/verify_rpk.py` 签名校验脚本。

## 构建产物（CI）

推送 / PR 触发 [.github/workflows/build-rpk.yml](.github/workflows/build-rpk.yml)，三个产物分别打包并作为 Artifact 上传：

| 产物 | 源码目录 | 目标设备 |
| --- | --- | --- |
| `xiaomi_band.rpk` | `vela/band` | 小米手环 7/8/9/10/11 |
| `xiaomi_band_pro.rpk` | `vela/band_pro` | 小米手环 9 Pro |
| `xiaomi_circle_band.rpk` | `vela/circle_watch` | 小米手表 S4（圆形） |

推送 `v*` 标签时，三个 RPK 会自动附加到 GitHub Release。

每个 RPK 在上传前都会用 `tool/verify_rpk.py` 做完整的签名校验（Sig Block 42、逐文件摘要、RSA-SHA256）。

## 签名

产物使用 **debug 签名**（`sign/debug` 密钥）打包：该签名与手机端 APK 配对，换成 release 签名必须连 APK 一起重签。要做正式 release 包，先处理 APK 侧再执行 `npm run release`。

`sign/*/private.pem` 是签名私钥，**不入库**（仓库公开）。CI 通过仓库 Secrets 还原到 `sign/debug/` 和 `sign/release/`：

- `SIGN_CERTIFICATE_PEM` — PEM 格式证书（`sign/debug/certificate.pem` 的内容）
- `SIGN_PRIVATE_PEM` — PEM 格式私钥（`sign/debug/private.pem` 的内容）

配置一次即可（三个项目共用同一套密钥）：

```bash
gh secret set SIGN_CERTIFICATE_PEM < vela/band/sign/debug/certificate.pem
gh secret set SIGN_PRIVATE_PEM     < vela/band/sign/debug/private.pem
```

- **已配置 Secrets**：产物用应用自身 debug 密钥签名，APK 配对有效；CI 同时比对证书指纹。
- **未配置 Secrets**：回退到 aiot-toolkit 内置 debug 证书（**与 APK 不配对**，仅供模拟器调试），CI 会给出 notice 提示。

## 本地构建

```bash
cd vela/band          # 或 band_pro / circle_watch
npm ci
npm run build         # debug 包（APK 配对签名）→ dist/*.debug.<version>.rpk
npm run release       # release 包 → dist/*.release.<version>.rpk（需 sign/release/ 私钥 + 重签手机 APK）
npm start             # 起调试服务 + 模拟器
```

要求 Node.js ≥ 20。构建由 `aiot-toolkit` 完成，产物名由 `src/manifest.json` 的 package / versionName 决定，CI 才会重命名为上表的固定文件名。

校验产物签名：

```bash
python3 tool/verify_rpk.py dist/xxx.rpk                       # 只验签名完整性
python3 tool/verify_rpk.py dist/xxx.rpk sign/release/certificate.pem   # 同时比对证书指纹
```

## 文档

- [模拟器截图自验证](vela/docs/emulator-verification.md) — 用模拟器 + 截图做 UI 自验的流程与皮肤选择
- `vela/band/docs/development-notes.md` — 开发笔记
- `vela/band/docs/offline-code.md` — 离线凭证 / 离线码实现
