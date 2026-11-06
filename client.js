/**
 * dsh-occlusion-throttle — client half.
 *
 * 两件事：
 *   1. 轮询宿主给出的「窗口是否被遮挡」，被挡住时挂起 requestAnimationFrame、
 *      暂停 CSS 动画；重新可见时立刻恢复并补跑挂起的回调。
 *   2. 在设置里提供一个分区：开关、轮询间隔、实时状态。
 *
 * 安全策略：
 *   · 只有宿主明确返回 occluded=true、且当前文档没有焦点、且确认是桌面端外壳时才睡；
 *   · 接口 404 / 超时 / 解析失败 / 宿主没就绪 / 用户停用 → 一律按「不遮挡」处理；
 *   · 窗口获得焦点、pointerdown、visibilitychange 都会立刻唤醒并强制刷新一次状态。
 */

window.__ModuleLoader__.load({
  id: 'dsh-occlusion-throttle',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const NS = 'occlusion-throttle';
    const STATE_URL = '/dsh-occlusion-throttle/state';
    const CONFIG_URL = '/dsh-occlusion-throttle/config';
    const EVENT_URL = '/dsh-occlusion-throttle/event';
    const POLL_MS = 1000;
    const FETCH_TIMEOUT_MS = 800;
    const CSS_ID = 'dsh-occlusion-throttle-style';

    // ---- 文案 -----------------------------------------------------------
    const zh = {
      settingsNav: '遮挡降频',
      kicker: 'PERFORMANCE',
      title: '遮挡降频',
      subtitle: '窗口被其他窗口完全遮挡时暂停动画渲染，重新可见立刻恢复。Chromium 自带的遮挡检测对独占全屏游戏无效，所以由插件自己判断。',
      statusTitle: '实时状态',
      statusDesc: '每 2 秒刷新。被遮挡时会暂停 requestAnimationFrame 与 CSS 动画。',
      stVisible: '可见（正常渲染）',
      stOccluded: '被遮挡（已暂停渲染）',
      stMinimized: '已最小化（Chromium 自己会停）',
      stHidden: '已隐藏',
      stNoWindow: '未找到 DSH 窗口',
      stUnknown: '未知（观察器未就绪）',
      stDisabled: '已停用',
      coverPrefix: '遮挡者：',
      watcher: '观察器',
      watcherExe: '编译版（约 0.12% 单核）',
      watcherPs: 'PowerShell 版（约 0.59% 单核）',
      watcherNone: '未找到',
      switchTitle: '启用遮挡降频',
      switchDesc: '关闭后插件完全不生效，窗口按 Chromium 默认行为常驻渲染。',
      intervalTitle: '轮询间隔',
      intervalDesc: '越短发现遮挡越快，观察器开销略高。默认 500 毫秒。',
      save: '保存',
      saving: '保存中…',
      saved: '已保存，观察器已按新配置重启。',
      unchanged: '没有变化。',
      failed: '保存失败：',
      refresh: '刷新',
      note: '只在窗口被其他窗口完全遮挡、且没有焦点时生效；最小化由 Chromium 自己处理，不依赖本插件。',
      intervalOption: '{n} 毫秒',
      recentTitle: '最近事件',
      recentDesc: '被遮挡时面板本身也看不见，所以把每次「暂停 / 恢复」记在这里。把窗口完全遮住几秒再放开，回来看这一栏。',
      recentEmpty: '还没有记录。把 DSH 窗口完全遮住 3~5 秒再放开试试。',
      evSleep: '暂停渲染（被遮挡）',
      evWake: '恢复渲染',
      totalPaused: '累计暂停',
      totalTimes: '次暂停',
      secondsShort: '秒',
    };
    const en = {
      settingsNav: 'Occlusion throttle',
      kicker: 'PERFORMANCE',
      title: 'Occlusion throttle',
      subtitle: 'Pause animation rendering while the window is fully occluded, and resume the moment it is visible again. Chromium cannot detect occlusion by an exclusive-fullscreen game, so this plugin measures it itself.',
      statusTitle: 'Live status',
      statusDesc: 'Refreshes every 2 s. While occluded, requestAnimationFrame and CSS animations are paused.',
      stVisible: 'Visible (rendering normally)',
      stOccluded: 'Occluded (rendering paused)',
      stMinimized: 'Minimized (Chromium already idles)',
      stHidden: 'Hidden',
      stNoWindow: 'DSH window not found',
      stUnknown: 'Unknown (watcher not ready)',
      stDisabled: 'Disabled',
      coverPrefix: 'Covered by: ',
      watcher: 'Watcher',
      watcherExe: 'Compiled (about 0.12% of one core)',
      watcherPs: 'PowerShell (about 0.59% of one core)',
      watcherNone: 'not found',
      switchTitle: 'Enable occlusion throttle',
      switchDesc: 'When off, the plugin does nothing and the window renders as Chromium would by default.',
      intervalTitle: 'Poll interval',
      intervalDesc: 'Shorter reacts faster; the watcher costs a little more. Default 500 ms.',
      save: 'Save',
      saving: 'Saving…',
      saved: 'Saved. The watcher restarted with the new settings.',
      unchanged: 'Nothing changed.',
      failed: 'Save failed: ',
      refresh: 'Refresh',
      note: 'Only applies when the window is fully covered by another window and unfocused. Minimizing is handled by Chromium itself.',
      intervalOption: '{n} ms',
      recentTitle: 'Recent events',
      recentDesc: 'While occluded you cannot see this panel — so every pause/resume is recorded here. Cover the window for a few seconds, uncover it, then come back.',
      recentEmpty: 'Nothing recorded yet. Fully cover the DSH window for 3-5 seconds, then uncover it.',
      evSleep: 'Rendering paused (occluded)',
      evWake: 'Rendering resumed',
      totalPaused: 'Paused for',
      totalTimes: 'pauses',
      secondsShort: 's',
    };

    const CSS = `
.dot-kicker{font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:var(--dsw-alias-label-tertiary,#8b93a7);margin:0 0 6px}
.dot-title{font-size:20px;font-weight:600;margin:0 0 6px;color:var(--dsw-alias-label-primary,#e6e8ee)}
.dot-sub{margin:0 0 18px;font-size:13px;line-height:1.6;color:var(--dsw-alias-label-secondary,#a8b0c2);max-width:62ch}
.dot-card{border:.5px solid var(--dsw-alias-border-l1,rgba(255,255,255,.12));border-radius:12px;padding:14px 16px;margin:0 0 12px;background:var(--dsw-alias-bg-layer-1,rgba(255,255,255,.03))}
.dot-cardTitle{margin:0 0 4px;font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary,#e6e8ee)}
.dot-cardDesc{margin:0;font-size:12px;line-height:1.55;color:var(--dsw-alias-label-secondary,#a8b0c2)}
.dot-row{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:12px}
.dot-pill{display:inline-flex;align-items:center;gap:7px;font-size:12px;padding:4px 10px;border-radius:999px;border:.5px solid var(--dsw-alias-border-l1,rgba(255,255,255,.12));color:var(--dsw-alias-label-secondary,#a8b0c2)}
.dot-dot{width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-state-success-primary,#3fb950)}
.dot-dot[data-state=occluded]{background:var(--dsw-alias-state-warning-primary,#d29922)}
.dot-dot[data-state=off]{background:var(--dsw-alias-label-tertiary,#8b93a7)}
.dot-meta{margin:10px 0 0;font-size:12px;line-height:1.9;color:var(--dsw-alias-label-secondary,#a8b0c2)}
.dot-meta code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;padding:1px 5px;border-radius:4px;background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.06))}
.dot-btn{appearance:none;border:.5px solid var(--dsw-alias-border-l1,rgba(255,255,255,.16));background:transparent;border-radius:8px;padding:6px 14px;font-size:12px;color:var(--dsw-alias-label-secondary,#a8b0c2);cursor:pointer;transition:background .12s,color .12s}
.dot-btn:hover:not(:disabled){color:var(--dsw-alias-label-primary,#e6e8ee);background:color-mix(in srgb,var(--dsw-alias-label-primary,#e6e8ee) 7%,transparent)}
.dot-btn:disabled{opacity:.5;cursor:default}
.dot-btnPrimary{border-color:transparent;background:var(--dsw-alias-brand-primary,#4c8dff);color:#fff}
.dot-btnPrimary:hover:not(:disabled){background:var(--dsw-alias-brand-primary,#4c8dff);filter:brightness(1.08);color:#fff}
.dot-select{appearance:none;border:.5px solid var(--dsw-alias-border-l1,rgba(255,255,255,.16));background:var(--dsw-alias-bg-layer-1,rgba(255,255,255,.03));color:var(--dsw-alias-label-primary,#e6e8ee);border-radius:8px;padding:6px 26px 6px 10px;font-size:12px;cursor:pointer}
.dot-switch{position:relative;display:inline-flex;align-items:center;width:38px;height:22px;border-radius:999px;border:.5px solid var(--dsw-alias-border-l1,rgba(255,255,255,.18));background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.06));cursor:pointer;transition:background .15s}
.dot-switch[data-on=true]{background:var(--dsw-alias-brand-primary,#4c8dff);border-color:transparent}
.dot-knob{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;transition:transform .15s}
.dot-switch[data-on=true] .dot-knob{transform:translateX(16px)}
.dot-msg{margin:10px 0 0;font-size:12px}
.dot-msg[data-kind=ok]{color:var(--dsw-alias-state-success-primary,#3fb950)}
.dot-msg[data-kind=error]{color:var(--dsw-alias-state-error-primary,#f85149)}
.dot-note{margin:16px 0 0;font-size:11.5px;line-height:1.7;color:var(--dsw-alias-label-tertiary,#8b93a7)}
.dot-list{list-style:none;margin:14px 0 0;padding:0;display:flex;flex-direction:column;gap:6px}
.dot-listItem{display:flex;align-items:center;gap:10px;font-size:12px;color:var(--dsw-alias-label-secondary,#a8b0c2);padding:6px 10px;border-radius:8px;background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.05))}
.dot-listItem[data-kind=sleep]{border-left:3px solid var(--dsw-alias-state-warning-primary,#d29922)}
.dot-listItem[data-kind=wake]{border-left:3px solid var(--dsw-alias-state-success-primary,#3fb950)}
.dot-time{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;color:var(--dsw-alias-label-tertiary,#8b93a7);min-width:62px}
html.dsh-occlusion-sleep *,
html.dsh-occlusion-sleep *::before,
html.dsh-occlusion-sleep *::after{animation-play-state:paused!important}
`;

    // ---- rAF 闸门 -------------------------------------------------------
    const rawRAF = window.requestAnimationFrame.bind(window);
    const rawCAF = window.cancelAnimationFrame.bind(window);
    let sleeping = false;
    let nextId = 1;
    const parked = new Map();

    function gatedRAF(callback) {
      if (!sleeping) return rawRAF(callback);
      const id = nextId++;
      parked.set(id, callback);
      return id;
    }

    function gatedCAF(id) {
      if (parked.delete(id)) return;
      try { rawCAF(id); } catch { /* ignore */ }
    }

    // 唤醒时最多补跑这么多帧回调：长时间遮挡后如果队列很大，
    // 一次性全部补跑会让主线程和合成器在同一帧里爆掉（DWM/GPU 尖峰的来源之一）。
    const MAX_FLUSH = 120;

    function flushParked() {
      if (parked.size === 0) return 0;
      let entries = Array.from(parked.values());
      parked.clear();
      let dropped = 0;
      if (entries.length > MAX_FLUSH) {
        dropped = entries.length - MAX_FLUSH;
        entries = entries.slice(-MAX_FLUSH); // 只保留最近的，旧的直接丢掉
      }
      const now = performance.now();
      for (const callback of entries) {
        try {
          rawRAF(() => { try { callback(now); } catch { /* 单帧回调失败不扩散 */ } });
        } catch { /* ignore */ }
      }
      if (dropped > 0) {
        try { console.info(`[occlusion-throttle] wake: replayed ${entries.length}, dropped ${dropped}`); } catch { /* ignore */ }
      }
      return entries.length;
    }

    window.requestAnimationFrame = gatedRAF;
    window.cancelAnimationFrame = gatedCAF;

    // ---- 样式 -----------------------------------------------------------
    function installStyle() {
      if (document.getElementById(CSS_ID)) return;
      const style = document.createElement('style');
      style.id = CSS_ID;
      style.dataset.plugin = 'dsh-occlusion-throttle';
      style.textContent = CSS;
      (document.head || document.documentElement).appendChild(style);
    }
    if (document.head) installStyle();
    else document.addEventListener('DOMContentLoaded', installStyle, { once: true });

    // ---- 状态 / 轮询 ----------------------------------------------------
    const stats = { sleeping: 0, wakes: 0, lastState: 'unknown', lastAt: 0 };
    // 被遮挡时看不见面板，所以把状态变化记下来，露出来后回看
    const recent = [];
    let sleepStartedAt = 0;
    let pausedTotalMs = 0;
    let isDesktopShell = /electron/i.test(String(navigator.userAgent || ''));
    let lastPayload = null;

    function pushEvent(sleepingNow, reason) {
      recent.unshift({ at: Date.now(), sleeping: sleepingNow, state: reason });
      if (recent.length > 12) recent.length = 12;
    }

    function setSleeping(next, reason) {
      if (next === sleeping) return;
      sleeping = next;
      stats.lastState = reason || (next ? 'sleep' : 'wake');
      stats.lastAt = Date.now();
      try { document.documentElement.classList.toggle('dsh-occlusion-sleep', next); } catch { /* ignore */ }
      if (next) {
        stats.sleeping += 1;
        sleepStartedAt = Date.now();
      } else {
        stats.wakes += 1;
        if (sleepStartedAt) {
          pausedTotalMs += Date.now() - sleepStartedAt;
          sleepStartedAt = 0;
        }
        flushParked();
      }
      pushEvent(next, stats.lastState);
      // 同时写进宿主日志：被遮挡时看不见面板，可以从终端 / 另一块屏回看
      try {
        void fetch(EVENT_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          cache: 'no-store',
          body: JSON.stringify({ kind: next ? 'sleep' : 'wake', state: stats.lastState }),
        }).catch(() => {});
      } catch { /* ignore */ }
      try { console.info(`[occlusion-throttle] ${next ? 'sleep' : 'wake'} (${stats.lastState})`); } catch { /* ignore */ }
    }

    let inflight = false;
    // 去抖：短暂遮挡（拖窗口掠过、通知弹窗、Alt+Tab 预览）不值得触发一整轮
    // 「暂停 → 恢复」——恢复时要做一次全窗口重绘，那才是 DWM/GPU 尖峰的来源。
    const MIN_SLEEP_MS = 800;
    let occludedSince = 0;

    async function poll() {
      if (inflight) return;
      inflight = true;
      let controller = null;
      let timer = null;
      try {
        controller = new AbortController();
        timer = setTimeout(() => { try { controller.abort(); } catch { /* ignore */ } }, FETCH_TIMEOUT_MS);
        const response = await fetch(STATE_URL, {
          cache: 'no-store',
          credentials: 'same-origin',
          signal: controller.signal,
        });
        if (!response.ok) {
          setSleeping(false, `http-${response.status}`);
          return;
        }
        const payload = await response.json();
        lastPayload = payload;
        // 桌面端判定：宿主报告（Electron 版本号）或 UA 任一命中即可。
        // 浏览器里打开同一份 GUI 时，宿主报的是「桌面窗口」的遮挡，
        // 不能拿它去冻结一个正被看着的浏览器标签页。
        if (payload?.desktop === true) isDesktopShell = true;
        const occluded = payload && payload.occluded === true;
        const eligible = isDesktopShell
          && payload?.enabled !== false
          && occluded
          && document.hasFocus() === false
          && document.visibilityState === 'visible';
        // 连续满足条件满 MIN_SLEEP_MS 才真的睡，避免拖窗口掠过就抖一次
        if (eligible) {
          if (!occludedSince) occludedSince = Date.now();
        } else {
          occludedSince = 0;
        }
        const shouldSleep = eligible && occludedSince > 0 && (Date.now() - occludedSince) >= MIN_SLEEP_MS;
        setSleeping(shouldSleep, payload?.state || 'unknown');
      } catch {
        setSleeping(false, 'fetch-error');
      } finally {
        if (timer) clearTimeout(timer);
        inflight = false;
      }
    }

    let pollTimer = null;
    function startPolling() {
      if (pollTimer) return;
      pollTimer = setInterval(() => { void poll(); }, POLL_MS);
      try { if (typeof pollTimer.unref === 'function') pollTimer.unref(); } catch { /* ignore */ }
      void poll();
    }

    function wakeNow(reason) {
      setSleeping(false, reason);
      void poll();
    }

    window.addEventListener('focus', () => wakeNow('window-focus'));
    window.addEventListener('blur', () => { void poll(); });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') setSleeping(false, 'doc-hidden');
      else void poll();
    });
    document.addEventListener('pointerdown', () => wakeNow('pointerdown'), true);

    // ---- 设置页 ---------------------------------------------------------
    const STATE_KEY = {
      visible: 'stVisible',
      occluded: 'stOccluded',
      minimized: 'stMinimized',
      hidden: 'stHidden',
      nowindow: 'stNoWindow',
      disabled: 'stDisabled',
    };

    function statusKey(state) {
      return STATE_KEY[state] || 'stUnknown';
    }

    function formatClock(ms) {
      const d = new Date(ms);
      const p = (n) => String(n).padStart(2, '0');
      return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
    }

    function SettingsPage(props) {
      const t = props.t;
      const [state, setState] = React.useState(null);
      const [config, setConfig] = React.useState(null);
      const [draft, setDraft] = React.useState(null);
      const [msg, setMsg] = React.useState(null);
      const [busy, setBusy] = React.useState(false);
      const [, tick] = React.useState(0);

      // 每秒刷新一次，让「最近事件」和累计暂停时长动起来
      React.useEffect(() => {
        const id = setInterval(() => { tick((n) => n + 1); }, 1000);
        return () => clearInterval(id);
      }, [tick]);

      const load = React.useCallback(async () => {
        try {
          const [stateRes, configRes] = await Promise.all([
            fetch(STATE_URL, { cache: 'no-store' }),
            fetch(CONFIG_URL, { cache: 'no-store' }),
          ]);
          const nextState = stateRes.ok ? await stateRes.json() : null;
          const nextConfig = configRes.ok ? await configRes.json() : null;
          setState(nextState);
          if (nextConfig) {
            setConfig(nextConfig);
            setDraft((prev) => prev ?? nextConfig);
          }
        } catch (error) {
          setMsg({ kind: 'error', text: t('failed') + String(error?.message ?? error) });
        }
      }, [t]);

      React.useEffect(() => {
        void load();
        const id = setInterval(() => { void load(); }, 2000);
        return () => clearInterval(id);
      }, [load]);

      const save = async () => {
        if (!draft) return;
        setBusy(true);
        setMsg(null);
        try {
          const response = await fetch(CONFIG_URL, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            cache: 'no-store',
            body: JSON.stringify(draft),
          });
          const result = await response.json();
          if (!response.ok) throw new Error(result?.error ?? `HTTP ${response.status}`);
          setConfig({ enabled: result.enabled, intervalMs: result.intervalMs });
          setMsg({ kind: 'ok', text: result.restarted ? t('saved') : t('unchanged') });
          void load();
        } catch (error) {
          setMsg({ kind: 'error', text: t('failed') + String(error?.message ?? error) });
        } finally {
          setBusy(false);
        }
      };

      const current = state?.state || 'unknown';
      const watcher = state?.watcher;
      const watcherLabel = watcher === 'exe' ? t('watcherExe')
        : watcher === 'powershell' ? t('watcherPs') : t('watcherNone');

      return h('section', { className: 'dot-root' },
        h('p', { className: 'dot-kicker' }, t('kicker')),
        h('h1', { className: 'dot-title' }, t('title')),
        h('p', { className: 'dot-sub' }, t('subtitle')),

        h('div', { className: 'dot-card' },
          h('h2', { className: 'dot-cardTitle' }, t('statusTitle')),
          h('p', { className: 'dot-cardDesc' }, t('statusDesc')),
          h('div', { className: 'dot-row' },
            h('span', { className: 'dot-pill' },
              h('span', { className: 'dot-dot', 'data-state': current === 'occluded' ? 'occluded' : (current === 'visible' ? 'ok' : 'off') }),
              t(statusKey(current))
            ),
            h('button', { type: 'button', className: 'dot-btn', onClick: () => { void load(); } }, t('refresh'))
          ),
          h('p', { className: 'dot-meta' },
            t('watcher') + '：' + watcherLabel,
            h('br'),
            state?.cover ? (t('coverPrefix') + state.cover) : '',
            state?.cover ? h('br') : null,
            h('code', null, `${state?.intervalMs ?? 500} ms`)
          )
        ),

        h('div', { className: 'dot-card' },
          h('div', { className: 'dot-row', style: { marginTop: 0 } },
            h('div', null,
              h('h2', { className: 'dot-cardTitle' }, t('switchTitle')),
              h('p', { className: 'dot-cardDesc' }, t('switchDesc'))
            ),
            h('button', {
              type: 'button',
              className: 'dot-switch',
              'data-on': draft?.enabled === true,
              'aria-pressed': draft?.enabled === true,
              onClick: () => setDraft((prev) => ({ ...(prev || config || {}), enabled: !(prev?.enabled ?? config?.enabled ?? true) })),
            }, h('span', { className: 'dot-knob' }))
          )
        ),

        h('div', { className: 'dot-card' },
          h('div', { className: 'dot-row', style: { marginTop: 0 } },
            h('div', null,
              h('h2', { className: 'dot-cardTitle' }, t('intervalTitle')),
              h('p', { className: 'dot-cardDesc' }, t('intervalDesc'))
            ),
            h('select', {
              className: 'dot-select',
              value: String(draft?.intervalMs ?? 500),
              onChange: (event) => setDraft((prev) => ({ ...(prev || config || {}), intervalMs: Number(event.target.value) })),
            },
              [300, 500, 800, 1000, 1500, 2000].map((ms) => h('option', { key: ms, value: String(ms) }, t('intervalOption').replace('{n}', String(ms))))
            )
          )
        ),

        h('div', { className: 'dot-card' },
          h('h2', { className: 'dot-cardTitle' }, t('recentTitle')),
          h('p', { className: 'dot-cardDesc' }, t('recentDesc')),
          recent.length === 0
            ? h('p', { className: 'dot-cardDesc', style: { marginTop: 10 } }, t('recentEmpty'))
            : h('ul', { className: 'dot-list' },
                recent.slice(0, 6).map((e, i) => h('li', {
                  key: `${e.at}-${i}`,
                  className: 'dot-listItem',
                  'data-kind': e.sleeping ? 'sleep' : 'wake',
                },
                  h('span', { className: 'dot-time' }, formatClock(e.at)),
                  h('span', null, e.sleeping ? t('evSleep') : t('evWake'))
                ))
              ),
          h('p', { className: 'dot-meta' },
            `${t('totalPaused')} ${Math.round((pausedTotalMs + (sleepStartedAt ? Date.now() - sleepStartedAt : 0)) / 1000)} ${t('secondsShort')} · ${stats.sleeping} ${t('totalTimes')}`
          )
        ),

        h('div', { className: 'dot-row' },
          h('button', { type: 'button', className: 'dot-btn dot-btnPrimary', disabled: busy || !draft, onClick: save },
            busy ? t('saving') : t('save')),
          msg ? h('span', { className: 'dot-msg', 'data-kind': msg.kind }, msg.text) : null
        ),

        h('p', { className: 'dot-note' }, t('note'))
      );
    }

    // ---- 挂载 -----------------------------------------------------------
    const inject = ['slots', 'locale'];

    function apply(ctx) {
      const slots = ctx?.get?.('slots');
      const locale = ctx?.get?.('locale');
      if (!slots || !locale) return;

      if (typeof ctx.effect === 'function') {
        ctx.effect(() => {
          const zhDispose = locale.register(NS, 'zh', zh);
          const enDispose = locale.register(NS, 'en', en);
          return () => { try { enDispose?.(); } catch { /* ignore */ } try { zhDispose?.(); } catch { /* ignore */ } };
        }, 'occlusion-throttle: dictionaries');
      } else {
        locale.register(NS, 'zh', zh);
        locale.register(NS, 'en', en);
      }

      const t = locale.bind(NS);

      if (typeof ctx.effect === 'function') {
        ctx.effect(() => () => {
          if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
          setSleeping(false, 'dispose');
        }, 'occlusion-throttle: polling');
      }

      slots.inject('settings.section', () => slots.register({
        name: 'settings.section',
        id: 'occlusion-throttle',
        order: 60,
        label: () => t('settingsNav'),
        locale: NS,
        inject: () => ({ t }),
      }, SettingsPage));
    }

    // 工厂阶段就开始轮询：即使将来客户端运行时的 apply 契约变了，核心功能仍然生效
    startPolling();

    try {
      window.__DSH_OCCLUSION_THROTTLE__ = { stats, poll, wakeNow, SettingsPage, get last() { return lastPayload; } };
    } catch { /* ignore */ }

    return { inject, apply };
  },
});
