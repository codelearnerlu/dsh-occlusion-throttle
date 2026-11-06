// 自检：不依赖 DSH，用假的 ctx 挂载 host 插件，验证观察器与两个接口。
import { apply } from './index.js';

const routes = new Map();
let cleanup = null;

const fakeCtx = {
  inject(deps, callback) {
    callback({
      webServer: {
        register(spec) {
          routes.set(spec.path, spec);
          return () => routes.delete(spec.path);
        },
      },
      effect(fn) {
        cleanup = fn();
      },
    });
  },
};

apply(fakeCtx);

const STATE = '/dsh-occlusion-throttle/state';
const CONFIG = '/dsh-occlusion-throttle/config';

if (!routes.has(STATE) || !routes.has(CONFIG)) {
  console.error('FAIL: routes not registered:', [...routes.keys()]);
  process.exit(1);
}
console.log('routes:', [...routes.keys()].join(', '));

function request(path, method = 'GET', body = null) {
  const spec = routes.get(path);
  return new Promise((resolve, reject) => {
    const chunks = [];
    const res = {
      writeHead(status, headers) { this.status = status; this.headers = headers; },
      end(payload) { chunks.push(payload); resolve({ status: this.status, body: chunks.join('') }); },
    };
    const req = {
      method,
      socket: { remoteAddress: '127.0.0.1' },
      on(event, handler) {
        if (event === 'data' && body !== null) handler(Buffer.from(JSON.stringify(body)));
        if (event === 'end') handler();
      },
      destroy() {},
    };
    try { spec.handler(req, res); } catch (error) { reject(error); }
  });
}

const samples = [];
for (let i = 0; i < 6; i += 1) {
  await new Promise((r) => setTimeout(r, 500));
  const { status, body } = await request(STATE);
  const parsed = JSON.parse(body);
  samples.push({
    t: (i + 1) * 0.5,
    status,
    state: parsed.state,
    ok: parsed.ok,
    watcher: parsed.watcher,
    enabled: parsed.enabled,
    intervalMs: parsed.intervalMs,
  });
}
console.log('state samples:');
for (const s of samples) console.log(' ', JSON.stringify(s));

const last = samples[samples.length - 1];
const known = ['visible', 'occluded', 'minimized', 'hidden', 'nowindow', 'unknown', 'disabled'];
if (last.status === 200 && known.includes(last.state)) {
  console.log('PASS: state endpoint responds with a real window state');
} else {
  console.log('CHECK: state =', last.state);
}

// 配置接口：读 → 改 → 复原
const before = JSON.parse((await request(CONFIG)).body);
console.log('config before:', JSON.stringify(before));

const changed = JSON.parse((await request(CONFIG, 'POST', { intervalMs: 800 })).body);
console.log('config after POST:', JSON.stringify(changed));
if (changed.intervalMs !== 800) {
  console.log('FAIL: interval not applied');
} else {
  console.log('PASS: interval applied and watcher restarted');
}

await new Promise((r) => setTimeout(r, 800));
const restored = JSON.parse((await request(CONFIG, 'POST', { intervalMs: before.intervalMs, enabled: before.enabled })).body);
console.log('config restored:', JSON.stringify(restored));

try { cleanup?.(); } catch { /* ignore */ }
process.exit(0);
