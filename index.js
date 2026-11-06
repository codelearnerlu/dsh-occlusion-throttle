/**
 * dsh-occlusion-throttle — host half.
 *
 * 背景：DSH 桌面端是一个 Chromium 窗口，页面里有常驻的 rAF 动画循环。
 * 只要窗口「没被最小化」，Chromium 就一直按 ~60fps 出帧——即使它被别的
 * 全屏窗口（游戏）完全盖住。实测：被挡住时渲染进程仍占 0.6~1.0 个 CPU 核、
 * GPU 进程再占 0.5~0.9 核、每秒 7~9 MB 的帧数据；窗口一最小化立刻归零。
 *
 * 宿主半边负责两件事：
 *   1. 起一个常驻观察器（优先编译版 exe，缺失时回退 PowerShell），
 *      用 Win32 的 WindowFromPoint 判断「DSH 主窗口此刻是否被完全遮挡」；
 *   2. 暴露状态与配置接口，供前端轮询 / 设置页读写。
 */

import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const name = 'occlusion-throttle';

const STATE_PATH = '/dsh-occlusion-throttle/state';
const CONFIG_PATH = '/dsh-occlusion-throttle/config';
const EVENT_PATH = '/dsh-occlusion-throttle/event';
// 桌面端的可执行文件名（不含 .exe）；DSH 改版导致 ppid 不可靠时用它兜底
const WINDOW_NAME = 'DeepSeek Harness';
const DEFAULT_CONFIG = { enabled: true, intervalMs: 500 };
const MIN_INTERVAL = 300;
const MAX_INTERVAL = 2000;
const RESTART_DELAY_MS = 5000;
const STALE_MS = 8000;

function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh');
}

function logPath() {
  return join(dshHome(), 'occlusion-throttle.log');
}

function configPath() {
  return join(dshHome(), 'occlusion-throttle.json');
}

function log(line) {
  try {
    appendFileSync(logPath(), `[${new Date().toISOString()}] ${line}\n`);
  } catch { /* 日志失败不影响功能 */ }
}

function clampInterval(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_CONFIG.intervalMs;
  return Math.min(MAX_INTERVAL, Math.max(MIN_INTERVAL, Math.round(n)));
}

function readConfig() {
  try {
    const raw = JSON.parse(readFileSync(configPath(), 'utf8'));
    return {
      enabled: raw.enabled !== false,
      intervalMs: clampInterval(raw.intervalMs ?? DEFAULT_CONFIG.intervalMs),
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

function writeConfig(config) {
  try {
    writeFileSync(configPath(), `${JSON.stringify(config, null, 2)}\n`, 'utf8');
    return true;
  } catch (error) {
    log(`config write failed: ${error?.message ?? error}`);
    return false;
  }
}

function sendJson(res, status, value) {
  try {
    const body = JSON.stringify(value);
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(body),
      'x-content-type-options': 'nosniff',
    });
    res.end(body);
    return true;
  } catch {
    return false;
  }
}

function isLoopback(req) {
  const address = req?.socket?.remoteAddress;
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function readJsonBody(req, maxBytes = 4096) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch (error) { reject(error); }
    });
    req.on('error', reject);
  });
}

export function apply(ctx) {
  if (process.platform !== 'win32') {
    log('not win32, disabled');
    return;
  }

  let scriptFile = '';
  let exeFile = '';
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    scriptFile = join(here, 'occlusion-watcher.ps1');
    exeFile = join(here, 'occlusion-watcher.exe');
  } catch {
    return;
  }

  // 默认盯住自己的父进程（Electron 主进程）；环境变量仅用于本地调试/自检
  const overridePid = Number.parseInt(process.env.DSH_OCCLUSION_TARGET_PID ?? '', 10);
  const targetPid = Number.isFinite(overridePid) && overridePid > 0 ? overridePid : process.ppid;

  let config = readConfig();
  let child = null;
  let buffer = '';
  let restartTimer = null;
  let stopped = false;

  const state = {
    ok: false,
    state: 'unknown',
    focused: false,
    hits: 0,
    total: 0,
    rect: '',
    cover: '',
    coverPid: 0,
    pid: targetPid,
    updatedAt: 0,
  };

  function watcherKind() {
    if (existsSync(exeFile)) return 'exe';
    if (existsSync(scriptFile)) return 'powershell';
    return 'none';
  }

  function onLine(line) {
    const text = line.trim();
    if (!text) return;
    let parsed;
    try { parsed = JSON.parse(text); } catch { return; }
    state.ok = true;
    state.state = typeof parsed.state === 'string' ? parsed.state : 'unknown';
    state.focused = parsed.focused === true;
    state.hits = Number(parsed.hits) || 0;
    state.total = Number(parsed.total) || 0;
    state.rect = typeof parsed.rect === 'string' ? parsed.rect : '';
    state.cover = typeof parsed.cover === 'string' ? parsed.cover : '';
    state.coverPid = Number(parsed.coverPid) || 0;
    state.updatedAt = Date.now();
  }

  function scheduleRestart() {
    if (stopped || restartTimer) return;
    restartTimer = setTimeout(() => {
      restartTimer = null;
      start();
    }, RESTART_DELAY_MS);
    restartTimer.unref?.();
  }

  function start() {
    if (stopped || child) return;
    if (!config.enabled) return;
    if (!targetPid) return;
    const interval = String(config.intervalMs);
    try {
      if (existsSync(exeFile)) {
        // pid 与进程名同时给，观察器取并集：
        //   · DSH 若调整进程模型（宿主不再是 Electron 主进程的子进程），按名字仍能找到窗口
        //   · 若名称枚举受权限限制，按 pid 仍能工作
        child = spawn(exeFile, ['--pid', String(targetPid), '--name', WINDOW_NAME, '--interval', interval], {
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'ignore'],
        });
      } else if (existsSync(scriptFile)) {
        child = spawn(
          'powershell.exe',
          [
            '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden',
            '-ExecutionPolicy', 'Bypass',
            '-File', scriptFile,
            '-TargetPid', String(targetPid),
            '-IntervalMs', interval,
          ],
          { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] },
        );
      } else {
        log('no watcher available (missing exe and ps1)');
        return;
      }
    } catch (error) {
      log(`spawn failed: ${error?.message ?? error}`);
      child = null;
      scheduleRestart();
      return;
    }
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        onLine(buffer.slice(0, index));
        buffer = buffer.slice(index + 1);
      }
      if (buffer.length > 8192) buffer = '';
    });
    child.on('error', (error) => {
      log(`watcher error: ${error?.message ?? error}`);
      child = null;
      scheduleRestart();
    });
    child.on('exit', (code) => {
      child = null;
      state.ok = false;
      state.state = 'unknown';
      state.updatedAt = Date.now();
      if (!stopped) {
        log(`watcher exited (${code}), restarting in ${RESTART_DELAY_MS}ms`);
        scheduleRestart();
      }
    });
    log(`watcher started (${watcherKind()}) for pid ${targetPid}, interval ${interval}ms`);
  }

  function stop() {
    stopped = true;
    if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
    if (child) {
      try { child.kill(); } catch { /* ignore */ }
      child = null;
    }
  }

  function restart() {
    stop();
    stopped = false;
    state.ok = false;
    state.state = 'unknown';
    start();
  }

  function snapshot() {
    const fresh = state.updatedAt > 0 && (Date.now() - state.updatedAt) < STALE_MS;
    return {
      ok: fresh,
      enabled: config.enabled,
      watcher: watcherKind(),
      state: !config.enabled ? 'disabled' : (fresh ? state.state : 'unknown'),
      occluded: config.enabled && fresh && state.state === 'occluded',
      // 只有跑在桌面端外壳里才可能为 true；浏览器里打开同一份 GUI 时用它挡掉误判
      desktop: Boolean(process.versions.electron),
      focused: state.focused,
      hits: state.hits,
      total: state.total,
      rect: state.rect,
      cover: state.cover,
      coverPid: state.coverPid,
      pid: state.pid,
      intervalMs: config.intervalMs,
      ageMs: state.updatedAt > 0 ? Date.now() - state.updatedAt : null,
      now: Date.now(),
    };
  }

  ctx.inject(['webServer'], (webCtx) => {
    const webServer = webCtx.webServer;
    if (!webServer || typeof webServer.register !== 'function') {
      log('webServer unavailable, endpoints disabled');
      return;
    }
    webCtx.effect(() => {
      start();

      const offState = webServer.register({
        kind: 'exact',
        path: STATE_PATH,
        handler(req, res) {
          if (!isLoopback(req)) return sendJson(res, 403, { error: 'loopback access only' });
          if (req.method !== 'GET') {
            res.writeHead(405, { allow: 'GET', 'content-type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ error: 'method not allowed' }));
            return;
          }
          sendJson(res, 200, snapshot());
        },
      });

      const offConfig = webServer.register({
        kind: 'exact',
        path: CONFIG_PATH,
        async handler(req, res) {
          if (!isLoopback(req)) return sendJson(res, 403, { error: 'loopback access only' });
          if (req.method === 'GET') { sendJson(res, 200, config); return; }
          if (req.method !== 'POST') {
            res.writeHead(405, { allow: 'GET, POST', 'content-type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ error: 'method not allowed' }));
            return;
          }
          let body;
          try { body = await readJsonBody(req); }
          catch (error) { sendJson(res, 400, { error: String(error?.message ?? error) }); return; }

          const next = {
            enabled: typeof body.enabled === 'boolean' ? body.enabled : config.enabled,
            intervalMs: clampInterval(body.intervalMs ?? config.intervalMs),
          };
          const changedInterval = next.intervalMs !== config.intervalMs;
          const changedEnabled = next.enabled !== config.enabled;
          config = next;
          writeConfig(config);
          if (changedInterval || changedEnabled) {
            log(`config changed: enabled=${config.enabled} interval=${config.intervalMs}ms, restarting watcher`);
            restart();
          }
          sendJson(res, 200, { ok: true, ...config, restarted: changedInterval || changedEnabled });
        },
      });

      const offEvent = webServer.register({
        kind: 'exact',
        path: EVENT_PATH,
        async handler(req, res) {
          if (!isLoopback(req)) return sendJson(res, 403, { error: 'loopback access only' });
          if (req.method !== 'POST') {
            res.writeHead(405, { allow: 'POST', 'content-type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ error: 'method not allowed' }));
            return;
          }
          let body;
          try { body = await readJsonBody(req, 1024); }
          catch (error) { sendJson(res, 400, { error: String(error?.message ?? error) }); return; }
          const kind = body?.kind === 'sleep' ? 'sleep' : (body?.kind === 'wake' ? 'wake' : null);
          if (!kind) { sendJson(res, 400, { error: 'kind must be sleep|wake' }); return; }
          // 前端事件写进同一个日志，方便在应用外面（终端 / 另一块屏）回看
          log(`client ${kind}${body?.state ? ` (${body.state})` : ''}`);
          sendJson(res, 200, { ok: true });
        },
      });

      return () => {
        try { offEvent?.(); } catch { /* ignore */ }
        try { offConfig?.(); } catch { /* ignore */ }
        try { offState?.(); } catch { /* ignore */ }
        stop();
      };
    }, 'occlusion-throttle: endpoints');
  });
}
