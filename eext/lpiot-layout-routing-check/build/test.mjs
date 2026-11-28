// 运行单元测试：把 test/*.test.ts 打包到 test/.out 再用 node --test 跑
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'test/.out');
fs.mkdirSync(out, { recursive: true });
const files = fs.readdirSync(path.join(root, 'test')).filter(f => f.endsWith('.test.ts'));
for (const f of files)
	await esbuild.build({ entryPoints: [path.join(root, 'test', f)], bundle: true, platform: 'node', format: 'esm', external: ['ws'], outfile: path.join(out, f.replace(/\.ts$/, '.mjs')), logLevel: 'warning' });
execFileSync(process.execPath, ['--test', ...files.map(f => path.join(out, f.replace(/\.ts$/, '.mjs')))], { stdio: 'inherit' });
