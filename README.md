# dsh-occlusion-throttle

> DSH 桌面端被其他窗口完全遮挡时，暂停它的动画渲染；重新可见时立刻恢复。

**English**: A DeepSeek Harness desktop plugin. While the app window is fully covered by
another window (notably an exclusive-fullscreen game, which Chromium's own occlusion
detection cannot see), the renderer keeps producing ~60 fps — measured at 0.6–1.0 CPU
cores plus 0.5–0.9 cores in the GPU process. This plugin detects occlusion through Win32
`WindowFromPoint` (with per-monitor DPI awareness, ignored click-through/transparent
overlays and DWM-cloaked windows), then pauses `requestAnimationFrame` and CSS animations
until the window is visible again. Cost: ~0.12% of one core, 15.7 MB. Windows only.

【中文说明见下，安装 / 验证 / 兼容性 / 发布清单都在后面。】

## 为什么需要它

实测（本机，2026-11-05/06）：

| 状态 | 渲染进程 | GPU 进程 | 帧提交 | 备注 |
|---|---|---|---|---|
| 窗口可见（哪怕没焦点） | 65–100% 单核 | 50–90% 单核 | 每秒 6.8–9 MB | 页面里有常驻 rAF 循环 |
| 窗口被全屏游戏完全盖住 | 仍 100% 单核 | 仍 ~97% | 仍 8.6 MB/s | **Chromium 识别不到这种遮挡** |
| 窗口最小化 | **0.0%** | **0.0%** | **0** | Chromium 真的停了 |

结论：只要窗口「没被最小化」，Chromium 就按 60fps 一直出帧。Chromium 自带的
遮挡检测对「独占全屏游戏盖住」这一场景无效（游戏绕过了 DWM），所以只能自己判断。

最小化能立刻把占用清零，但最小化会改变窗口状态。本插件改用另一种方式达到同样效果：
**检测到被遮挡后，在前端把 rAF 闸掉 + 暂停 CSS 动画**，窗口重新露出时立即恢复。

## 工作原理

```
Electron 主进程 (6180)
  └─ 宿主进程 (32428)  ← 插件宿主半边 index.js 在这里
        ├─ 起一个常驻 PowerShell 观察器
        │    · 每 400ms 用 WindowFromPoint 采样窗口内 16 个点
        │    · 只要有点属于 DSH 自己 → visible；全都不属于 → occluded
        │    · 状态变化或每 2.5s 心跳时向 stdout 打一行 JSON
        └─ 暴露 GET /dsh-occlusion-throttle/state
              ↑ 前端半边 client.js 每秒轮询一次
                occluded=true 且文档无焦点 → 挂起 requestAnimationFrame
                                              + <html> 加 .dsh-occlusion-sleep
                恢复可见 / 获得焦点 / 出错 → 立即唤醒并补跑挂起的回调
```

安全策略（宁可少省电，也不搞坏界面）：

- 只有宿主明确返回 `occluded: true`，且 `document.hasFocus() === false`、页面可见时才停；
- 接口 404 / 超时 800ms / JSON 解析失败 / 宿主没就绪 → 一律当作「不遮挡」，正常渲染；
- `pointerdown`、`focus`、`visibilitychange` 都会立刻唤醒并强制刷新状态；
- 宿主观察器崩溃会自动重启（5 秒后）；状态超过 8 秒没心跳就按「未知 = 不降频」处理。

## 自身开销（实测，500ms 轮询）

| 版本 | CPU（单核均值） | 占整机 | 工作集 / 私有内存 | 线程/句柄 |
|---|---|---|---|---|
| **`occlusion-watcher.exe`**（默认） | **0.117 – 0.125%** | **~0.005%** | **15.7 MB / 12.1 MB** | 5 / 187 |
| `occlusion-watcher.ps1`（回退） | 0.586% | ~0.024% | 91.9 MB / 73.9 MB | 16 / 560 |

- 快路径：中心点属于自己就判可见（1 次 `WindowFromPoint`）；只有中心被挡住才扫 16 点。
  实测 16 点全扫也只多 0.008%——成本主要不是采样，是进程本身。
- 换算：exe 版每小时约 **4.2 CPU 秒**；PowerShell 版约 21 CPU 秒。
- 前端每秒 1 次 localhost 请求（响应约 200 B），开销 < 0.1% 单核。
- 删除 `occlusion-watcher.exe` 会自动回退到 PowerShell 版，无需改代码；
  重新编译：`csc -nologo -optimize+ -out:occlusion-watcher.exe watcher-exe.cs`。

> 注：Chromium 自带的遮挡检测对**普通窗口**遮挡是有效的（实测被 Edge 窗口盖住时
> 渲染进程自己就掉到 ~6%）。它失效的是**独占全屏游戏**那种遮挡（实测仍 100%）。
> 这个插件的价值主要体现在后者；对前者只是"无感"。

## 文件

| 文件 | 作用 |
|---|---|
| `index.js` | 宿主插件：拉起观察器、解析状态、暴露 HTTP 接口 |
| `client.js` | 前端插件：轮询状态、闸断 rAF、暂停 CSS 动画、恢复 |
| `occlusion-watcher.ps1` | 常驻观察器（PowerShell 循环，只做查询，不改系统） |
| `occlusion-watcher.cs` | 上面脚本用到的 Win32 P/Invoke 声明 |
| `cordis.patch.yml` | bundle 挂载声明 |
| `selftest.mjs` | 宿主自检：假 ctx 挂载 + 请求状态接口 |
| `client-selftest.mjs` | 前端自检：DOM 打桩验证 rAF 闸门与恢复 |

## 安装（3 步，需要重启 DSH）

把插件链接进 desktop profile（`$src` 换成你 clone 下来的目录）：

```powershell
$profile = "$env:USERPROFILE\.dsh\profiles\desktop"
$src     = "<你的路径>\dsh-occlusion-throttle"
cmd /c mklink /J "$profile\node_modules\dsh-occlusion-throttle" $src
```

然后编辑 `$profile\package.json`：

1. `dependencies` 里加一行
   `"dsh-occlusion-throttle": "link:D:/Study/DeepSeek Harness Workspace/dsh-occlusion-throttle",`
2. `dsh.profile.bundles` 数组里加一项 `"dsh-occlusion-throttle"`

重启 DSH（托盘退出后重新打开）。

## 验证

**难点**：要测「被遮挡时暂停渲染」，就得先把窗口盖住，盖住后又看不见面板。

三种办法，任选：

1. **看日志（推荐）** —— 在另一块屏或另一个窗口里实时跟：
   ```powershell
   Get-Content "$env:USERPROFILE\.dsh\occlusion-throttle.log" -Wait -Tail 5
   ```
   然后把 DSH 窗口完全盖住 3 秒再放开，日志里会出现
   `client sleep (occluded)` / `client wake`。
2. **看面板回放** —— 设置 → 遮挡降频 → 「最近事件」列出每次暂停/恢复的时间，
   以及「累计暂停 X 秒 · N 次暂停」。盖住几秒再放开，回来看即可。
3. **命令行查状态** —— 端口每次启动都变，用 GUI 地址里的那个：
   ```powershell
   curl.exe -s http://127.0.0.1:<端口>/dsh-occlusion-throttle/state
   ```

看效果：任务管理器里 `DeepSeek Harness (renderer)` 在遮挡期间应掉到接近 0。

前端调试口：`window.__DSH_OCCLUSION_THROTTLE__`（`{ stats, poll, wakeNow }`）。

## 自检（不装也能跑）

```powershell
$node = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
& $node .\selftest.mjs                                  # 宿主：状态接口
& $node .\client-selftest.mjs                           # 前端：rAF 闸门
$env:DSH_OCCLUSION_TARGET_PID = "18248"                 # 可选：盯着别的进程测 occluded 分支
```

## 卸载

1. 从 `package.json` 的 `dependencies` 与 `dsh.profile.bundles` 里删掉对应行；
2. 删掉 `node_modules\dsh-occlusion-throttle` 这个链接；
3. 重启 DSH。

> 发布到 npm / dsh 市场的完整步骤见 [PUBLISHING.md](./PUBLISHING.md)。
> 当前仓库只是暂存点：**尚未发布到 npm，也未提交市场**。

## 兼容性

### 依赖的接口与稳定性

| 依赖 | 稳定性 | 失效后果 |
|---|---|---|
| `WindowFromPoint` / `GetAncestor` / `GetWindowRect` / `EnumWindows` / `IsIconic` / `IsWindowVisible` / `GetForegroundWindow` / `GetSystemMetrics` | Win32 老接口，XP 至今未变 | — |
| `SetProcessDpiAwarenessContext`(Win10 1703+) → `shcore.SetProcessDpiAwareness`(8.1+) → `SetProcessDPIAware`(Vista+) | 三级回退，任一可用即可 | 全是高 DPI 时坐标可能偏，但采样与判定仍在同一坐标系内自洽 |
| `DwmGetWindowAttribute(DWMWA_CLOAKED)` | Win7+ | 取不到时按「未 cloaked」处理 |
| DSH 宿主：`ctx.inject(['webServer'])` / `webServer.register` / `ctx.effect` | **内部契约**，随 DSH 版本可能变 | 路由不注册 → 前端 404 → **永不降频**（安全失败） |
| DSH 前端：`window.__ModuleLoader__.load({id, factory})` | **内部契约** | 前端不加载 → 只有省电失效，不影响 DSH |
| 清单：`dsh.bundle.patch` / `dsh.client` | 半公开 | 插件不加载 |
| 进程模型：宿主是 Electron 主进程的子进程 | 可能变 | 已用 `--pid` + `--name` 双通道兜底；两者都失败则 `nowindow` → 不降频 |

**所有失效路径都是「不生效」，没有一条会拖慢或搞坏 DSH。**

### Windows 更新

- 功能更新（如 24H2 → 26H2）：上面那批 user32 API 不受影响；每次 tick 重新枚举窗口，
  分辨率、缩放、多屏排列变化都能自适应。
- 若 Windows 把游戏改成「窗口化全屏 / 全屏优化」：Chromium 自己的遮挡检测会生效，
  本插件变成 no-op —— 正确且安全。
- 虚拟桌面切换 / RDP 断开：窗口会被 DWM cloaked，已过滤，不会误判成遮挡。
- `.NET Framework 4.8` 的 `csc.exe` 路径（`%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\`）
  在 26H2 上仍存在；它只用于**重新编译**观察器，编译不了就自动用 .ps1。

### NVIDIA 驱动更新

插件完全不碰 GPU，所以驱动本身不会破坏它。真正相关的是**覆盖层**：

- GeForce Experience / NVIDIA app 会常驻 `NVIDIA Overlay`（本机实测 5 个进程，窗口覆盖整屏）。
  这类窗口是 layered + 点穿，若被当成遮挡会导致误停。
  **已防护**：`WS_EX_TRANSPARENT`、`WS_EX_LAYERED` 且 alpha < 250、以及 cloaked 的窗口都
  不算「盖住」。
- 驱动设置里的 MPO / VRR / 全屏优化开关，只影响游戏走独占还是 borderless，
  进而影响「插件是否被需要」，不影响判定正确性。
- 换驱动后建议跑一次排查命令，看 `cover` 字段是不是覆盖层：
  `occlusion-watcher.exe --pid <DSH 主进程 pid> --interval 500`

### DSH 版本更新

- 已声明 `engines.dsh: ^0.2.1-rc.2`（市场用它做兼容性标记；顶层优先于 `peerDependencies`）。
- 升级 DSH 后建议跑一次自检：
  ```powershell
  & $node .\selftest.mjs
  & $node .\client-selftest.mjs
  curl.exe -s http://127.0.0.1:6982/dsh-occlusion-throttle/state
  ```

## 发布到 dsh 市场要准备什么

1. **上架路径**：市场客户端本身不收条目。插件目录在
   [`awesome-dsh-plugin/awesome-dsh-plugin`](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)，
   去那边提 **一个 PR**，往列表里加一条（npm 包名 + 仓库地址 + 描述）；
   dshmarket.com 与市场客户端会在一两天内自动收录。
   市场只允许安装该 registry 里列出的源，其它一律拒绝。
2. **必须能装**：发布到 npm（或 GitHub 源）。包内需带
   - `engines.dsh`（没有它，市场不显示兼容性标记）
   - `dsh.bundle.patch` 指向的 `cordis.patch.yml`
   - `dsh.client`（`platform: "web"`）
3. **元数据**：`name`（建议 `dsh-` 前缀）、`version`、中英 `description`、
   `license`、`repository` / `homepage` / `bugs`、`keywords`（含 `dsh-plugin`）、
   `icon.png`、`files` 白名单。
4. **不要打包预编译 exe**（供应链角度最容易被质疑）。建议：
   - npm 包只带 `watcher-exe.cs` + `occlusion-watcher.ps1`；
   - README 里给一条 `csc -nologo -optimize+ -out:occlusion-watcher.exe watcher-exe.cs`；
   - 用户本地生成后宿主自动优先使用（代码已经是「有 exe 用 exe，没有用 ps1」）。
5. **不要带 postinstall / prepack 脚本**：市场对构建脚本有额外处理，容易踩坑。
6. **写清权限**：只读窗口几何、只与本机 `127.0.0.1` 通信、不上传任何数据、不联网。
7. **平台声明**：`os: ["win32"]`；非 Windows 直接 no-op（宿主已判断 `process.platform`）。
8. **建议补一个设置分区**（enabled / 轮询间隔 / 是否允许编译观察器）。
   市场里绝大多数插件都有设置页，没有也能上，但体验差一截。
9. **版本语义**：0.1.0 起；破坏性变化升 minor（0.x 阶段）。

## 已知边界

- 只支持 Windows（依赖 Win32 `WindowFromPoint`）。
- 判断是「整窗被遮挡」；**部分遮挡**（有任何一个采样点露出来）视为可见，不降频。
- 暂停 rAF 只影响动画；文本流式更新走 React 直接提交 DOM，仍会正常刷新，但**动画类效果在遮挡期间不动**。
- 观察器是一个常驻 PowerShell 进程（只做查询，实测开销 < 0.5% 单核）。
- 如果将来 DSH 自己支持了遮挡检测，这个插件可以直接删掉。
