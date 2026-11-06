# 发布清单（等用一段时间后再做）

> 先把插件在自己机器上跑一段时间，记录问题与调优；确认稳定后再按本清单发布。
> 当前状态：**代码已推到 GitHub，尚未发布到 npm，也未提交市场。**

仓库：https://github.com/codelearnerlu/dsh-occlusion-throttle

---

## 0. 发布前自检

在仓库根目录执行：

```powershell
# 用本机 Node（见下方「本机环境」）
& "D:\Software\AI\node\node.exe" selftest.mjs
& "D:\Software\AI\node\node.exe" client-selftest.mjs
```

期望：宿主 3 条路由 OK、前端 6 项 PASS、设置页渲染 PASS。

打包预演（确认没有把 exe / 无关文件带进去）：

```powershell
& "D:\Software\AI\node\node.exe" "C:\Users\lbx\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.mjs" pack
```

目前实测：**31 KB / 16 个文件，不含 `occlusion-watcher.exe`**（它是构建产物，`.gitignore` 已排除）。

---

## 1. 版本号

- 现在是 `0.1.0`。
- 之后每次改代码：修 bug → `0.1.x`；加功能/改行为 → `0.x.0`。
- 改完同步更新 `CHANGELOG.md`，然后：

```powershell
git add -A
git commit -m "release: v0.1.1"
git tag v0.1.1
git push && git push --tags
```

---

## 2. 发布到 npm

包名 `dsh-occlusion-throttle` 已确认在 npm registry **未被占用**（返回 404）。

```powershell
$env:Path = "D:\Software\AI\node;$env:Path"
npm login                                    # 浏览器授权
cd "D:\Study\DeepSeek Harness Workspace\dsh-occlusion-throttle"
npm publish --access public
```

验证：

```powershell
npm view dsh-occlusion-throttle version      # 应为 0.1.0
```

不想用浏览器登录时，可以在 npmjs.com 建一个 **Automation token**，写进 `%USERPROFILE%\.npmrc`：

```
//registry.npmjs.org/:_authToken=<token>
```

之后也可以用 DSH 自带的 pnpm 发布（等价于 npm publish）：

```powershell
& "D:\Software\AI\node\node.exe" `
  "C:\Users\lbx\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.mjs" publish --access public
```

> 72 小时内可以用 `npm unpublish dsh-occlusion-throttle@0.1.0` 撤回。

---

## 3. 提交到 dsh 市场

市场的插件列表来自精选仓库 [awesome-dsh-plugin/awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)
（**不是** dshmarket 仓库）。市场只允许安装该 registry 中列出的源。

流程：向上面那个仓库提一个 PR，在 README 对应分类里加一条（README 有 3 MB / 9000+ 条，
用网页编辑 + Ctrl+F 定位分类段落，照相邻条目格式写）。

可直接使用的条目：

```json
{
  "name": "dsh-occlusion-throttle",
  "owner": "codelearnerlu",
  "url": "https://github.com/codelearnerlu/dsh-occlusion-throttle",
  "category": "ui",
  "description": {
    "en": "Pauses the DSH desktop renderer while its window is fully occluded by another window (notably an exclusive-fullscreen game) and resumes immediately when visible. Detects occlusion through Win32 WindowFromPoint, ignores click-through overlays and DWM-cloaked windows, then gates requestAnimationFrame and CSS animations. Costs about 0.12% of one core. Windows only.",
    "zh": "DSH 桌面端被其他窗口（尤其独占全屏游戏）完全遮挡时暂停动画渲染，重新可见立刻恢复：用 Win32 WindowFromPoint 判断遮挡、过滤点穿覆盖层与 cloaked 窗口，再闸断 requestAnimationFrame 与 CSS 动画；自身开销约 0.12% 单核。仅 Windows。"
  },
  "npm": "dsh-occlusion-throttle",
  "install": "dsh plugin --profile web add dsh-occlusion-throttle"
}
```

PR 标题（照现有 PR 的写法）：

```
Add codelearnerlu/dsh-occlusion-throttle: pause rendering while occluded
```

收录后安装命令即 `dsh plugin --profile web add dsh-occlusion-throttle`。
站点与市场通常一两天内自动刷新。

---

## 4. 可选加分项

- README 里放设置页截图（市场没有策展截图时会从 README 抽取），建议放 `docs/screenshots/settings.png`。
- 仓库 About 已填 Description 与 Topics（dsh / dsh-plugin / deepseek-harness / performance / windows / electron）。
- `engines.dsh` 目前是 `^0.2.1-rc.2`；DSH 升级并验证后再放宽。

---

## 本机环境备忘（这台机器）

| 用途 | 路径 |
|---|---|
| 独立 Node.js v24.22.2 + npm 11.19.1 | `D:\Software\AI\node\`（免安装，未进 PATH） |
| DSH 自带 Node（**别动，DSH 在用**） | `C:\Users\lbx\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe` |
| DSH 自带 pnpm 11.28.5 | `C:\Users\lbx\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.mjs` |
| 插件源码 | `D:\Study\DeepSeek Harness Workspace\dsh-occlusion-throttle` |
| 装进 DSH 的方式 | `node_modules\dsh-occlusion-throttle` 目录链接 + profile `package.json` 的 dependencies/bundles |

**已知坑**：本机 `hosts` 把 `api.github.com` 指到了 `127.0.0.1`（广告屏蔽列表），
所以 `curl https://api.github.com` 会失败。需要调用 GitHub API 时可以临时绕过：

```powershell
curl.exe --resolve api.github.com:443:<真实IP> ...
```
