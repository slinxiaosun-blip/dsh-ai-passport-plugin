# Windows 反馈清单

Windows 适配的目标：**插件安装自动适配 macOS 与 Windows 两个 DSH 客户端，
设备固件一次烧录、两端通用**。本页是 Windows 用户的实测反馈清单 ——
逐项跑一遍，把不通的项按文末「反馈时请附带」回报即可。

## 一、适配内容速览

| 环节 | 适配方式 |
| --- | --- |
| 安装 | `npm run install-plugin` 自动识别平台：macOS 符号链接 / Windows 目录 junction（免管理员权限），junction 被机器策略禁止时自动降级复制并提示 |
| 安装（PowerShell 入口） | `powershell -ExecutionPolicy Bypass -File tools\install-plugin-to-dsh.ps1`，与 bash 入口同一份实现 |
| 桥进程 | 按平台探测 Node：`%ProgramFiles%\nodejs`、nvm-windows/volta/scoop 落点、PATH 扫描，全部落空才回退 Electron；可用 `DSH_PASSPORT_NODE` 显式指定 |
| BLE | noble 的 WinRT 后端（Windows 10 1703+），与 macOS CoreBluetooth 走同一套协议 v1，扫描过滤逻辑相同 |
| 路径 | `%USERPROFILE%\.dsh\profiles\<profile>\node_modules\dsh-ai-passport`，与 macOS 的 `~/.dsh` 同构 |
| 设备固件 | **不需要**为 Windows 重新烧录：广播包带设备名（不依赖 scan response）、TX 分片按协商 MTU 动态计算、配对是应用层 6 位码（不依赖系统 bonding） |

## 二、已知边界（不算 bug）

- **Windows 10 1703（build 15063）之前**没有 WinRT BLE 后端，扫不到设备属预期。
- **Windows on ARM64**：`@stoprocent/noble` 没有预编译产物。需要 VS Build Tools
  （Desktop development with C++）后在 profile 目录 `pnpm install` 源码编译。
- 安装输出 `copy 模式：改源码不会生效` 说明 junction 被机器策略禁止、已降级复制；
  改完源码重跑一次安装命令即可，不是故障。
- 首次连接时 Windows 可能弹「配对」系统弹窗 —— 本项目的配对是应用层 6 位配对码，
  不依赖系统 bonding，系统弹窗可取消；设备端配对流程照常走。

## 三、反馈清单（逐项过）

| # | 项目 | 预期现象 | 结果（✓/✗） |
| --- | --- | --- | --- |
| 1 | `npm install` | 无编译错误（win32-x64 走 noble 预编译） | |
| 2 | `npm run install-plugin` | 输出「已链接（junction）」或明确的 copy 降级提示 | |
| 3 | 重启 DSH 客户端 | 挂件出现在输入框旁，诊断行显示 `noble win`（或类似后端名） | |
| 4 | 打开面板 `http://127.0.0.1:19387/dsh-passport` | 页面正常，「适配器」一栏显示 poweredOn | |
| 5 | 扫描 | 能发现 `Folo-PSP` / `FoloPassport-DSH`，信号一栏有数值 | |
| 6 | 连接 | 状态到「已连接」，设备端出现任务台 | |
| 7 | 配对 | 设备显示 6 位码，挂件输入后 `state.pairing.paired=true` | |
| 8 | 任务列表 / 新建任务 | 设备上能看到任务与 step 实时推进 | |
| 9 | 完成提醒 | 横幅 + 提示音 + 未读点 | |
| 10 | 任务审批 | 设备端弹审批页，允许/拒绝生效 | |
| 11 | DeepSeek 余额 | 大字显示；取不到时显式报错（不显示伪造 0） | |
| 12 | 语音输入 | 录音 → 识别 → 回填输入框；面板能看到识别耗时 | |
| 13 | 断连自愈 | 关设备电源再开，自动重连 | |

## 四、反馈时请附带

1. **环境**：Windows 版本（`winver`）、是否 ARM64、DSH 客户端版本、`node --version`。
2. **诊断行**：挂件浮层底部那一行
   （形如 `适配器 xxx · 桥进程 运行中 · noble xxx`）。
3. **插件日志**：`%USERPROFILE%\.dsh\dsh-ai-passport.log`（加载心跳与报错）；
   桥进程日志在 DSH 的插件日志里，搜 `[bridge]` / `[ble-bridge]`。
4. **面板快照**（可选，最有用）：`http://127.0.0.1:19387/dsh-passport/state.json` 存一份。
5. **设备侧**：固件版本（设置页）与当时的屏幕截图（手机拍照即可）。

## 五、出了问题先自查

| 症状 | 先检查 |
| --- | --- |
| 挂件显示「桥进程 未运行」 | 诊断行里的解释器路径是否存在；`DSH_PASSPORT_NODE` 指向真实 `node.exe` |
| 扫不到设备 | 系统蓝牙是否开启、是否在「设置 → 蓝牙和其他设备」里、Windows 是否 ≥ 1703；设备是否已在别的电脑连着（BLE 单连接） |
| 能扫到但连接超时 | 设备屏幕是否停在连接中；把设备断电重开再试；日志里搜 `stale-cache` |
| 权限类报错 | macOS：隐私与安全性 → 蓝牙；Windows：设置 → 蓝牙和其他设备，改完重启 DSH |
| 改了源码没生效 | 安装是否为 copy 模式（看安装输出或 `.dsh-passport-install.json`）；重跑 `npm run install-plugin` 后重启 DSH |
