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
| **固件仓库**（设备端） | `app_*.c` 固件源码，上游 fork，`feature/dsh-passport` 分支 | [`ai-passport`](https://github.com/slinxiaosun-blip/ai-passport) |

开发时固件 clone 到本目录的 `vendor/ai-passport`（已被 `.gitignore` 排除）：

```bash
git clone -b feature/dsh-passport \
  https://github.com/slinxiaosun-blip/ai-passport.git vendor/ai-passport
```

固件的环境、编译、烧录见 [docs/03-构建与烧录.md](docs/03-构建与烧录.md)。

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

前置：DSH 桌面版、Node ≥ 20。

```bash
# 1) 安装依赖
npm install

# 2) 把插件装进 DSH profile（符号链接方式，源码即生效代码）
./tools/install-plugin-to-dsh.sh            # 默认 desktop
./tools/install-plugin-to-dsh.sh web desktop # 可指定多个 profile

# 3) 无硬件联调（虚拟设备会应答握手、心跳、任务列表、余额）
npm test
```

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
