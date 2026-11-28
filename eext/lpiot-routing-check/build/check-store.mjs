// 上架前自检：按嘉立创 EDA 扩展开发指南（prodocs.lceda.cn/cn/api/guide/）检查 extension.json、图片、README 和打包产物。
// 用法：node build/check-store.mjs [build/dist/xxx.eext]   不通过时退出码 1。
import { Buffer } from 'node:buffer';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ext = JSON.parse(fs.readFileSync(path.join(root, 'extension.json'), 'utf8'));
const errors = [];
const warns = [];
const err = m => errors.push(m);
const warn = m => warns.push(m);

// ---- extension.json（extension-json.html、how-to-start.html、extensions-marketplace.html）
if (!/^[a-z0-9-]{5,30}$/.test(ext.name ?? ''))
	err('name 只能含 a-z、0-9、-，长度 5–30');
if (!/^[a-z0-9]{32}$/.test(ext.uuid ?? ''))
	err('uuid 必须是 32 位小写字母和数字');
for (const k of ['displayName', 'description', 'license']) {
	if (!ext[k])
		err(`缺少 ${k}`);
}
if (!/^\d+\.\d+\.\d+$/.test(ext.version ?? ''))
	err('version 必须是 major.minor.patch');
const CATS = ['Schematic', 'Symbol', 'PCB', 'Footprint', 'Panel', 'Library', 'Project', 'Other'];
const cats = [].concat(ext.categories ?? []);
if (!cats.length || cats.some(c => !CATS.includes(c)))
	err(`categories 只能取 ${CATS.join('/')}，至少一个`);
const REPO = ['extension-store', 'git', 'mercurial', 'svn', 'ftp', 'github', 'gitlab', 'gitlab-selfhosted', 'gitee', 'gitea', 'bitbucket', 'coding', 'gnu-savannah', 'gitbucket', 'gogs'];
if (ext.repository && !REPO.includes(ext.repository.type))
	err(`repository.type 不在允许列表内：${ext.repository.type}`);
try {
	if (ext.bugs)
		new URL(ext.bugs); // eslint-disable-line no-new
}
catch {
	err('bugs 必须是合法的 URI');
}
if (ext.entry !== './dist/index')
	warn('entry 不是 SDK 默认的 ./dist/index');

// ---- 菜单：id 唯一、menuItems 与 registerFn 不同级共存、最多两层子项、registerFn 已导出
const src = fs.readFileSync(path.join(root, 'src/index.ts'), 'utf8');
const ids = new Set();
function walk(items, depth, where) {
	for (const it of items ?? []) {
		if (ids.has(it.id))
			err(`菜单 id 重复：${it.id}`);
		ids.add(it.id);
		if (it.menuItems && it.registerFn)
			err(`菜单 ${it.id}：menuItems 与 registerFn 不能同级共存`);
		if (it.registerFn && !new RegExp(`export\\s+(async\\s+)?function\\s+${it.registerFn}\\b`).test(src))
			err(`菜单 ${it.id} 的 registerFn ${it.registerFn} 没有在 src/index.ts 里 export`);
		if (it.menuItems) {
			if (depth >= 2)
				err(`菜单 ${where}/${it.id} 嵌套超过两层子项`);
			walk(it.menuItems, depth + 1, `${where}/${it.id}`);
		}
	}
}
for (const [page, items] of Object.entries(ext.headerMenus ?? {})) {
	if (!['home', 'blank', 'sch', 'symbol', 'pcb', 'footprint', 'pcbView', 'panel', 'panelView'].includes(page))
		err(`headerMenus 不支持的页面：${page}`);
	walk(items, 0, page);
}

// ---- 图片：logo 1:1 PNG/JPEG ≥ 500 px、≤ 5 MiB、不是 SDK 默认图标；banner 64:27 JPEG
function imageSize(file) {
	const b = fs.readFileSync(file);
	if (b.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])))
		return { type: 'png', w: b.readUInt32BE(16), h: b.readUInt32BE(20), bytes: b.length };
	if (b[0] === 0xFF && b[1] === 0xD8) {
		let i = 2;
		while (i < b.length) {
			if (b[i] !== 0xFF) {
				i++;
				continue;
			}
			const m = b[i + 1];
			const len = b.readUInt16BE(i + 2);
			if (m >= 0xC0 && m <= 0xCF && ![0xC4, 0xC8, 0xCC].includes(m))
				return { type: 'jpeg', h: b.readUInt16BE(i + 5), w: b.readUInt16BE(i + 7), bytes: b.length };
			i += 2 + len;
		}
	}
	return { type: 'unknown', w: 0, h: 0, bytes: b.length };
}
const logoPath = path.join(root, ext.images?.logo ?? '');
if (!fs.existsSync(logoPath)) {
	err('缺少 logo');
}
else {
	const s = imageSize(logoPath);
	if (!['png', 'jpeg'].includes(s.type))
		err('logo 必须是 PNG 或 JPEG');
	if (s.w !== s.h)
		err(`logo 必须是 1:1（现在 ${s.w}×${s.h}）`);
	if (s.w < 500)
		warn(`logo 建议不小于 500×500（现在 ${s.w}）`);
	if (s.bytes > 5 * 1024 * 1024)
		err('logo 不能超过 5 MiB');
	// easyeda-api-sdk 默认图标的 SHA-256
	if (createHash('sha256').update(fs.readFileSync(logoPath)).digest('hex') === 'ef1a173637a9260d5e2171bc3cf98ea0a3a6649022e3111b063e54a418c9ce22')
		err('logo 不能用 SDK 默认图标');
}
if (ext.images?.banner) {
	const bp = path.join(root, ext.images.banner);
	if (!fs.existsSync(bp)) {
		err('extension.json 写了 banner 但文件不存在');
	}
	else {
		const s = imageSize(bp);
		if (s.type !== 'jpeg')
			err('banner 必须是 JPEG');
		if (Math.abs(s.w / s.h - 64 / 27) > 0.005)
			err(`banner 必须是 64:27（现在 ${s.w}×${s.h}）`);
	}
}

// ---- 多语言：extension.json 里的菜单标题都有英文翻译；两种以上语言时要有 zh-Hans 或 en
const enJson = JSON.parse(fs.readFileSync(path.join(root, 'locales/extensionJson/en.json'), 'utf8'));
const titles = [];
function collect(items) {
	return (items ?? []).forEach((it) => {
		titles.push(it.title);
		collect(it.menuItems);
	});
}
Object.values(ext.headerMenus ?? {}).forEach(collect);
for (const t of [...titles, ext.description]) {
	if (!enJson[t])
		warn(`locales/extensionJson/en.json 缺少翻译：${t.slice(0, 30)}`);
}

// ---- README / CHANGELOG
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
if (readme.length < 500 || !/使用|用法|Usage/.test(readme))
	err('README 需要写清功能和使用方法');

// ---- 打包产物：入口存在、不含个人隐私信息（邮箱、手机号）、不含测试和桥接代码
const eext = process.argv[2] ?? path.join(root, 'build/dist', `${ext.name}_v${ext.version}.eext`);
if (!fs.existsSync(eext)) {
	err(`找不到打包产物 ${eext}，先 npm run build`);
}
else {
	const list = execFileSync('unzip', ['-Z1', eext], { encoding: 'utf8' }).split('\n').filter(Boolean);
	if (!list.includes('dist/index.js'))
		err('包里没有入口 dist/index.js');
	for (const bad of ['test/', 'bridge/', 'src/', 'node_modules/']) {
		if (list.some(f => f.startsWith(bad)))
			err(`包里不应包含 ${bad}`);
	}
	const text = list.filter(f => /\.(?:js|json|md|html|txt)$|^LICENSE$|^NOTICE$/.test(f)).map(f => execFileSync('unzip', ['-p', eext, f], { encoding: 'utf8', maxBuffer: 64 << 20 })).join('\n');
	const emails = [...new Set(text.match(/[\w.+-]+@[\w-]+\.[\w.]+/g) ?? [])].filter(e => !/noreply|example|anthropic\.com$|@jlceda|@antfu|@types|@\d/.test(e));
	if (emails.length)
		err(`包里含有邮箱地址（个人隐私信息禁止上传）：${emails.slice(0, 5).join(', ')}`);
	if (/(?<!\d)1[3-9]\d{9}(?!\d)/.test(text))
		err('包里含有疑似手机号');
	if (/sk-ant-|sk-[A-Za-z0-9]{20,}/.test(text))
		err('包里含有疑似 API Key');
}

for (const w of warns) console.log(`提醒：${w}`);
if (errors.length) {
	for (const e of errors) console.log(`✗ ${e}`);
	process.exit(1);
}
console.log(`✓ ${ext.name} v${ext.version} 符合扩展广场上架要求（extension.json、图标、横幅、菜单、多语言、README、打包内容、隐私信息）`);
