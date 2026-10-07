# DSH AI Passport

把 [FoloToy AI Passport](https://ai-passport.folotoy.cn/)（ESP32-C3 掌上设备）做成
[DeepSeek Harness](https://github.com/deepseek-ai)（DSH）的**随身任务终端**：

在设备上新建/选择 DSH 任务、看执行状态、收完成提醒、做任务审批、查 DeepSeek 余额、
用语音下指令。设备与 Mac 之间走 BLE 蓝牙无线联机，无需 Wi-Fi。

```
┌─ AI Passport（设备） ─┐   BLE 5（GATT，自定义帧 + JSON）   ┌─ Mac + DSH ────────┐
│  ESP32-C3 固件        │ ◄──────────────────────────────► │  本插件（npm 包）   │
│  app_*.c / LVGL UI   │      协议 v1 · 双端常量同步        │  ble/bridge/panel  │
└──────────────────────┘                                   └───────────────────┘
```

## 双仓库结构

本项目拆成两个 git 仓库，各自独立构建与发版：

| 仓库 | 内容 | 地址 |
| --- | --- | --- |
| **本仓库**（挂件端） | DSH 插件（npm 包）+ 跨端文档 `docs/` + 主机侧工具 | `dsh-ai-passport-plugin` |
| **固件仓库**（设备端） | `app_*.c` 固件源码，独立仓库，基于上游二次开发 | [`ai-passport-dsh`](https://github.com/slinxiaosun-blip/ai-passport-dsh) |

开发时固件 clone 到本目录的 `vendor/ai-passport`（已被 `.gitignore` 排除）：

```bash
git clone -b feature/dsh-passport \
  https://github.com/slinxiaosun-blip/ai-passport-dsh.git vendor/ai-passport
```

固件的环境、编译、烧录见 [docs/03-构建与烧录.md](docs/03-构建与烧录.md)。

不打算自己编译固件的话，直接从 [Releases](https://github.com/slinxiaosun-blip/ai-passport-dsh/releases/latest)
下载 `FoloToy-AI-Passport-full.bin`，从 `0x0` 一次性刷入即可。

## 功能

| 能力 | 说明 |
| --- | --- |
| 任务台 | 设备上浏览/新建 DSH 任务，实时 step 与工具名推送 |
| 完成提醒 | 横幅 + 提示音 + 未读点，成功/失败/中断区分 |
| 任务审批 | `approval/request` 瀑布拦截，设备端允许/拒绝（高风险工具默认停在拒绝） |
| 配对 | 6 位配对码（每次上电换），NVS 密钥 + 常量时间比较 + 限流 |
| DeepSeek 余额 | 大字显示，取不到时明确报错，不显示伪造的 0 |
| 语音输入 | 设备录音 → BLE 上行 ADPCM → 本地 SenseVoice 离线识别 → 回填输入框 |
| 桌面挂件 | DSH 输入框旁的连接状态挂件 + 180px 浮层（`lib/client.js`） |
| Web 面板 | 本地控制面板（回环限定 + SSE 实时推送） |

## 快速开始

前置：DSH 桌面版、Node ≥ 20、macOS（BLE 依赖 noble 原生模块，暂仅支持 Apple Silicon）。

```bash
# 0) clone 本仓库（固件不需要时可不 clone）
git clone https://github.com/slinxiaosun-blip/dsh-ai-passport-plugin.git
cd dsh-ai-passport-plugin

# 1) 安装依赖
npm install

# 2) 把插件装进 DSH profile（符号链接方式，源码即生效代码）
./tools/install-plugin-to-dsh.sh            # 默认 desktop
./tools/install-plugin-to-dsh.sh web desktop # 可指定多个 profile

# 3) 无硬件联调（虚拟设备会应答握手、心跳、任务列表、余额）
npm test
```

> 脚本对每个 profile 做 `node_modules/dsh-ai-passport -> 本仓库源码` 的符号链接，
> 改源码即时生效。`desktop` profile 由 Electron 独占管理（`dsh plugin` CLI 拒绝操作），
> 因此不走 CLI，手工链接是唯一可靠的开发安装方式。

装好后打开控制面板（DSH 内置 webserver）：

```
http://127.0.0.1:19387/dsh-passport
```

常用配置（DSH 设置界面或 `cordis.patch.yml`）：

| 配置 | 默认 | 说明 |
| --- | --- | --- |
| `transport` | `bridge` | `bridge`（子进程）/ `mock`（无硬件联调）/ `noble`（进程内） |
| `autoConnect` | `true` | 插件加载后自动扫描连接 |
| `tasks.maskTitles` | `false` | 设备上只显示"任务 xxxx"，适合公共场合 |
| `voice.autoSend` | `false` | 识别完直接下发，省掉设备上再按一次确定 |

完整配置表与语音识别（SenseVoice 本地模型）启用方式见
[docs/03-构建与烧录.md](docs/03-构建与烧录.md) 与 [docs/04-桌面客户端集成.md](docs/04-桌面客户端集成.md)。

## 版本与兼容性

当前实测环境（2026-10-07）：

| 组件 | 版本 | 说明 |
| --- | --- | --- |
| DSH 桌面版 | `0.2.0-rc.2` | 插件 API 基线，开发时以它为准 |
| dsh CLI | `0.1.7-rc.2` | `dsh --version` 实测 |
| 插件（本仓） | `1.0.0` | `packages/dsh-ai-passport/package.json` |
| 设备固件 | `1.0.0` + git 短哈希 | 固件仓 `version.txt`，构建期自动追加 `git describe` |
| BLE 协议 | `v1` | 双端常量 `PROTOCOL_VERSION` ↔ `AP_PROTOCOL_VERSION`，取较小值运行 |
| 固件基线 | `main @ 0b9e4c8` | 上游 [FoloToy/ai-passport](https://github.com/FoloToy/ai-passport) |
| Node | ≥ 20 | 开发机 22.22.2；DSH 桌面版内置 Node 24.21.0 |

> 插件依赖 DSH `0.2.0-rc.x` 的 `ctx.webServer` / `speechToText` / `deepseekAccount`
> 等宿主 API。DSH 升级前先跑 `npm test`（mock 联调）+ [docs/07](docs/07-设备端验收用例.md)
> 真机验收，通过再升级。

## 目录结构

```
├── packages/dsh-ai-passport/   DSH 插件（npm 包，独立可 link 安装）
│   ├── lib/ble/                transport 抽象 + noble / 桥进程 / mock 三驱动
│   ├── lib/protocol/           帧编解码（协议 v1）
│   ├── lib/bridge/             session / watch / approval / balance / voice / pairing
│   ├── lib/panel/              Web 控制面板
│   ├── lib/client.js           桌面客户端输入框挂件
│   └── cordis.patch.yml         DSH 配置树补丁
├── docs/                       跨端文档（见下方索引）
├── tools/                      主机侧工具（插件安装 / 截图 / 布局校验 / 字体子集化）
├── assets/fonts/               字体源文件（含 LICENSE）
└── vendor/ai-passport/         固件仓库（独立 git，clone 进来，不入库）
```

## 文档索引

| 文档 | 内容 |
| --- | --- |
| [01-方案设计](docs/01-方案设计.md) | 系统架构、BLE 协议、设备端交互、语音链路 |
| [02-进展与下一步](docs/02-进展与下一步.md) | 开发日志：阶段 A/B/C 全记录 |
| [03-构建与烧录](docs/03-构建与烧录.md) | 环境、固件编译、烧录、插件安装、版本号机制 |
| [04-桌面客户端集成](docs/04-桌面客户端集成.md) | 输入框挂件形态、语音回填、桌面端行为 |
| [05-语音发送-设计](docs/05-语音发送-设计.md) | 语音链路设计 |
| [06-设备端问答与语音直发-设计](docs/06-设备端问答与语音直发-设计.md) | 设备端问答与语音直发 |
| [07-设备端验收用例](docs/07-设备端验收用例.md) | 逐项验收表与真机实测记录 |

## 开发须知

- **协议常量双端同步**：`packages/dsh-ai-passport/lib/protocol/constants.js` 的
  `PROTOCOL_VERSION` 与固件仓 `main/app_proto.h` 的 `AP_PROTOCOL_VERSION` 手工保持一致，
  改协议必须两侧同时 bump，并跑双端 parity 测试。
- **测试**：`npm test`（顶层 workspace 转发；固件侧逻辑测试在固件仓
  `./tools/validate.sh --static`）。
- **版本**：固件 `version.txt` + 构建期 `git describe`；插件版本在本仓 `package.json`。

## License

MIT（上游 [FoloToy/ai-passport](https://github.com/FoloToy/ai-passport) 亦为 MIT）。
