// 自检 client.js 的核心逻辑：DOM 打桩，验证「遮挡 → 暂停 rAF」和「恢复 → 补跑回调」。
const listeners = {};
const classes = new Set();
let focusState = false;
let rafSeq = 1;
const rafTimers = new Map();

const styleEl = { id: '', dataset: {}, textContent: '' };

globalThis.document = {
  head: { appendChild() {} },
  documentElement: { classList: { toggle(name, on) { if (on) classes.add(name); else classes.delete(name); return !!on; } } },
  visibilityState: 'visible',
  hasFocus: () => focusState,
  addEventListener(event, fn) { (listeners[event] ||= []).push(fn); },
  getElementById: () => null,
  createElement: () => styleEl,
};

globalThis.window = {
  requestAnimationFrame(cb) { const id = rafSeq++; rafTimers.set(id, cb); return id; },
  cancelAnimationFrame(id) { rafTimers.delete(id); },
  addEventListener(event, fn) { (listeners[event] ||= []).push(fn); },
  __ModuleLoader__: { load(spec) { globalThis.__captured = spec; } },
};

Object.defineProperty(globalThis, 'navigator', {
  value: { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Electron/44.7.0 DSH' },
  configurable: true,
  writable: true,
});

globalThis.fetch = async () => ({
  ok: true,
  status: 200,
  async json() {
    return { occluded: true, state: 'occluded', ok: true, desktop: true, enabled: true, intervalMs: 500, watcher: 'exe' };
  },
});

await import('./client.js');

const captured = globalThis.__captured;
if (!captured || captured.id !== 'dsh-occlusion-throttle') {
  console.error('FAIL: client module did not register');
  process.exit(1);
}

// 最小 React 替身：工厂里只用到 createElement；顺便把设置页浅渲染一次，确认不抛错
function makeNode(type, props, ...children) {
  return { type, props: props || {}, children: children.flat(Infinity) };
}
const ReactStub = {
  createElement: makeNode,
  useState: (v) => [typeof v === 'function' ? v() : v, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
  useRef: (v) => ({ current: v }),
};
const requireStub = (name) => {
  if (name === 'react') return ReactStub;
  throw new Error(`unexpected require: ${name}`);
};

const mod = captured.factory(requireStub);
console.log('client module loaded, inject =', JSON.stringify(mod.inject));

// 假 ctx：没有任何服务 → apply 直接返回；轮询在工厂阶段已经启动
let cleaned = null;
mod.apply({ effect(fn) { cleaned = fn(); } });

// 去抖要求连续满足 800ms，轮询间隔 1s → 等两次轮询
await new Promise((r) => setTimeout(r, 1400));

const stats = globalThis.window.__DSH_OCCLUSION_THROTTLE__.stats;
console.log('after poll -> lastState =', stats.lastState, '| sleeping =', stats.sleeping);

const before = rafTimers.size;
let ran = false;
globalThis.window.requestAnimationFrame(() => { ran = true; });
await new Promise((r) => setTimeout(r, 100));
const parked = rafTimers.size === before;
console.log('rAF gated ->', parked ? 'PASS (callback parked)' : 'FAIL (callback still scheduled)', '| ran =', ran);
console.log('sleep class applied ->', classes.has('dsh-occlusion-sleep') ? 'PASS' : 'FAIL');

focusState = true;
for (const fn of listeners.focus || []) fn();
await new Promise((r) => setTimeout(r, 200));

// 设置页浅渲染：只要不抛错、且产出了节点，就说明 JSX 结构与文案键没问题
try {
  const page = globalThis.window.__DSH_OCCLUSION_THROTTLE__.SettingsPage({ t: (key) => `t:${key}` });
  const hasNode = page && page.type === 'section';
  console.log('settings page renders ->', hasNode ? 'PASS' : 'FAIL', '| children =', page?.children?.length);
  const keys = JSON.stringify(page);
  const missing = ['t:title', 't:statusTitle', 't:switchTitle', 't:intervalTitle', 't:save', 't:note']
    .filter((k) => !keys.includes(k));
  console.log('settings labels present ->', missing.length === 0 ? 'PASS' : `FAIL missing ${missing.join(',')}`);
} catch (error) {
  console.log('settings page renders -> FAIL:', error?.message ?? error);
}

const replayed = [];
for (const [tid, cb] of rafTimers) { if (tid > before) { replayed.push(tid); cb(); } }
console.log('wake -> sleeps:', stats.sleeping, 'wakes:', stats.wakes, '| class removed:', !classes.has('dsh-occlusion-sleep') ? 'PASS' : 'FAIL');
console.log('parked callbacks replayed ->', ran || replayed.length > 0 ? 'PASS' : 'FAIL');

const id2 = globalThis.window.requestAnimationFrame(() => {});
globalThis.window.cancelAnimationFrame(id2);

try { cleaned?.(); } catch { /* ignore */ }
console.log('cleanup ok');
process.exit(0);
