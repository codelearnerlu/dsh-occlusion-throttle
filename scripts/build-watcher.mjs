// 构建观察器：自动找系统的 csc.exe（.NET Framework 自带），不需要 PATH 里有 csc。
// 用法：node scripts/build-watcher.mjs
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const rc = process.env.WINDIR ?? 'C:\\Windows';
const candidates = [
  join(rc, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
  join(rc, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe'),
];

const csc = candidates.find((p) => existsSync(p));
if (!csc) {
  console.error('找不到 csc.exe。请安装 .NET Framework 4.x，或手动用任意 C# 编译器编译 watcher-exe.cs。');
  process.exit(1);
}

const out = join(root, 'occlusion-watcher.exe');
const src = join(root, 'watcher-exe.cs');

execFileSync(csc, ['-nologo', '-optimize+', `-out:${out}`, src], { stdio: 'inherit' });
console.log(`built -> ${out}`);
