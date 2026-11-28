// 把面板脚本（src/panel/main.ts，含检查核心）打包并内联进 iframe/index.html。
// 扩展的 iframe 不会递归加载外部资源，所以样式和脚本都内联在一个 HTML 文件里。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const r = await esbuild.build({ entryPoints: [path.join(root, 'src/panel/main.ts')], bundle: true, minify: true, format: 'iife', platform: 'browser', target: 'es2020', write: false, legalComments: 'none' });
const js = r.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const tpl = fs.readFileSync(path.join(root, 'src/panel/template.html'), 'utf8');
fs.mkdirSync(path.join(root, 'iframe'), { recursive: true });
fs.writeFileSync(path.join(root, 'iframe/index.html'), tpl.replace('/*__PANEL_JS__*/', () => js));
console.log(`iframe/index.html ${(fs.statSync(path.join(root, 'iframe/index.html')).size / 1024).toFixed(0)} KB`);
