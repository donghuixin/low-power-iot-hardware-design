/**
 * 面板（iframe）：检查结论、板子动画（扫描入场、违规脉冲、电流 / 回流流动、去耦回路、布线顺序回放、修复前后形变）、AI 解读。
 * 在嘉立创 EDA 里通过 eda.sys_MessageBus 与扩展主线程通信；单独打开（没有 eda 对象）时进入演示模式，用内置示例板。
 */
import type { Board, FixPlan, Net, OrderRow, Pad, Pt, Report, Seg, Violation } from '../core';
import { analyze, dist, planFix, routingOrder, TIERS } from '../core';
import demo from './demo.json';

declare const eda: any;
const HAS_EDA = typeof eda !== 'undefined' && !!eda?.sys_MessageBus;
const $ = (id: string) => document.getElementById(id)!;
const SEVC: Record<string, string> = { P0: '#ff3b5c', P1: '#ff8a3d', P2: '#f5c542', P3: '#6fb7ff' };
const LAYERC = ['#e8683f', '#a07be8', '#c08be8', '#3f8fe8'];
const TIERC: Record<number, string> = { 1: '#ff5d8f', 2: '#ffb347', 3: '#ff6b3d', 4: '#39d0b0', 5: '#7fd4ff', 6: '#b98cff', 7: '#f5c542', 8: '#9fb3c8', 9: '#5b6778' };

// ------------------------------------------------------------------ 通信
const pending = new Map<string, { res: (v: any) => void; rej: (e: any) => void }>();
let seq = 0;
if (HAS_EDA) {
	const onRes = (m: any) => {
		const p = m && pending.get(m.id);
		if (!p)
			return;
		pending.delete(m.id);
		m.ok ? p.res(m.data) : p.rej(new Error(m.error));
	};
	try {
		eda.sys_MessageBus.subscribe('lpiot-res', onRes);
	}
	catch {}
	try {
		eda.sys_MessageBus.subscribePublic('lpiot-res', onRes);
	}
	catch {}
}
let demoKey: keyof typeof demo = 'principles-bad';
let demoBoard: Board = clone((demo as any)[demoKey]);
let demoPlan: FixPlan | null = null;
function clone<T>(x: T): T {
	return JSON.parse(JSON.stringify(x));
}
async function mock(cmd: string, _args: any): Promise<any> {
	const board = demoBoard;
	const bb = bboxOf(board);
	switch (cmd) {
		case 'check': {
			const report = analyze(board);
			return { board, bbox: bb, report, order: routingOrder(board.nets, report.classes), warnings: ['演示模式：内置示例板'] };
		}
		case 'fixPlan':
			demoPlan = planFix(board);
			return demoPlan;
		case 'fixApply': {
			for (const ch of demoPlan?.changes ?? []) {
				const n = board.nets.find(x => x.name === ch.net)!;
				let k = 0;
				n.segs = n.segs.filter(s => !ch.remove.includes(s[7]!)).concat(ch.add.map(s => [s[0], s[1], s[2], s[3], s[4], s[5], s[6], `${ch.net}#f${k++}`] as Seg));
			}
			return { removed: 0, added: 0 };
		}
		case 'aiGet':
			return { provider: 'anthropic', endpoint: 'https://api.anthropic.com/v1/messages', model: 'claude-sonnet-5-5', apiKey: '', hasKey: false };
		case 'aiReview':
		case 'aiAsk':
			return { text: '演示模式：在嘉立创 EDA 里打开本面板，并在“AI 设置”里配置模型后即可使用 AI 解读。' };
		default:
			return true;
	}
}
function rpc(cmd: string, args: any = {}): Promise<any> {
	if (!HAS_EDA)
		return mock(cmd, args);
	const id = `p${Date.now().toString(36)}${(seq++).toString(36)}`;
	return new Promise((res, rej) => {
		pending.set(id, { res, rej });
		const msg = { id, cmd, args };
		try {
			eda.sys_MessageBus.publish('lpiot-req', msg);
		}
		catch {}
		try {
			eda.sys_MessageBus.publishPublic('lpiot-req', msg);
		}
		catch {}
		setTimeout(() => {
			if (pending.has(id)) {
				pending.delete(id);
				rej(new Error('扩展没有响应，请关闭面板后从菜单重新打开'));
			}
		}, cmd.startsWith('ai') ? 180000 : 90000);
	});
}

// ------------------------------------------------------------------ 状态
interface Data { board: Board; bbox: [number, number, number, number]; report: Report; order: OrderRow[]; warnings?: string[] }
let D: Data | null = null;
let plan: FixPlan | null = null;
let selV: number | null = null;
let selNet: string | null = null;
let mode: 'idle' | 'order' | 'fix' = 'idle';
let modeT0 = 0;
let loadT0 = 0;
let flipY = true;
const layerOn = new Set<number>([0, 1, 2, 3, 4, 5, 6, 7]);
let sevOn = new Set(['P0', 'P1', 'P2', 'P3']);

function bboxOf(b: Board): [number, number, number, number] {
	const xs: number[] = [];
	const ys: number[] = [];
	for (const n of b.nets) {
		for (const s of n.segs) xs.push(s[1], s[3]), ys.push(s[2], s[4]);
		for (const p of n.pads) xs.push(p.x), ys.push(p.y);
	}
	if (b.outline?.length) {
		for (const [x, y] of b.outline) xs.push(x), ys.push(y);
	}
	if (!xs.length)
		return [0, 0, 10, 10];
	return [Math.min(...xs) - 1, Math.min(...ys) - 1, Math.max(...xs) + 1, Math.max(...ys) + 1];
}

// ------------------------------------------------------------------ 视图
const cv = $('cv') as HTMLCanvasElement;
const ctx = cv.getContext('2d')!;
let W = 0;
let H = 0;
let DPR = 1;
const view = { s: 10, ox: 0, oy: 0 };
function resize(): void {
	DPR = window.devicePixelRatio || 1;
	const r = cv.getBoundingClientRect();
	W = r.width;
	H = r.height;
	cv.width = Math.round(W * DPR);
	cv.height = Math.round(H * DPR);
}
function fit(): void {
	if (!D)
		return;
	const [x0, y0, x1, y1] = D.bbox;
	const s = Math.min((W - 60) / Math.max(1, x1 - x0), (H - 70) / Math.max(1, y1 - y0));
	view.s = s;
	view.ox = W / 2 - ((x0 + x1) / 2) * s;
	view.oy = H / 2 + (flipY ? 1 : -1) * ((y0 + y1) / 2) * s;
}
const X = (x: number) => view.ox + x * view.s;
const Y = (y: number) => (flipY ? view.oy - y * view.s : view.oy + y * view.s);
const invX = (px: number) => (px - view.ox) / view.s;
const invY = (py: number) => (flipY ? (view.oy - py) / view.s : (py - view.oy) / view.s);
function zoomTo(at: Pt, scale?: number): void {
	const target = { s: scale ?? Math.max(view.s, 40), ox: 0, oy: 0 };
	target.ox = W / 2 - at[0] * target.s;
	target.oy = H / 2 + (flipY ? 1 : -1) * at[1] * target.s;
	tween = { from: { ...view }, to: target, t0: performance.now() };
}
let tween: { from: typeof view; to: typeof view; t0: number } | null = null;

// ------------------------------------------------------------------ 网络流向（BFS 距离）
interface Flow { segs: { a: Pt; b: Pt; d0: number; L: number; l: number; w: number }[]; max: number }
const flowCache = new Map<string, Flow>();
function wk(p: Pt): string {
	return `${Math.round(p[0] * 1000)},${Math.round(p[1] * 1000)}`;
}
function flowOf(n: Net): Flow {
	const hit = flowCache.get(n.name);
	if (hit)
		return hit;
	const adj = new Map<string, { to: string; L: number; s: Seg }[]>();
	const link = (a: string, b: string, L: number, s: Seg) => {
		if (!adj.has(a))
			adj.set(a, []);
		adj.get(a)!.push({ to: b, L, s });
	};
	for (const s of n.segs) {
		const a = wk([s[1], s[2]]);
		const b = wk([s[3], s[4]]);
		const L = dist([s[1], s[2]], [s[3], s[4]]);
		link(a, b, L, s);
		link(b, a, L, s);
	}
	// 过孔把各层同位置端点连起来（坐标相同时已天然相连）
	const ic = n.pads.find(p => /^(U|IC)\d/.test(p.ref)) ?? n.pads[0];
	let start: string | null = null;
	if (ic) {
		let best = 1e9;
		for (const s of n.segs) {
			for (const p of [[s[1], s[2]], [s[3], s[4]]] as Pt[]) {
				const d = dist(p, [ic.x, ic.y]);
				if (d < best) {
					best = d;
					start = wk(p);
				}
			}
		}
	}
	const d = new Map<string, number>();
	const queue: string[] = [];
	const starts = start ? [start] : [];
	for (const k of adj.keys()) {
		if (!starts.length)
			starts.push(k);
		break;
	}
	for (const s0 of starts) {
		d.set(s0, 0);
		queue.push(s0);
	}
	// Dijkstra（小图直接线性找最小）
	const done = new Set<string>();
	for (;;) {
		let u: string | null = null;
		let du = Infinity;
		for (const [k, v] of d) {
			if (!done.has(k) && v < du) {
				u = k;
				du = v;
			}
		}
		if (u === null) {
			const rest = [...adj.keys()].find(k => !d.has(k));
			if (!rest)
				break;
			d.set(rest, 0);
			continue;
		}
		done.add(u);
		for (const e of adj.get(u) ?? []) {
			if (du + e.L < (d.get(e.to) ?? Infinity))
				d.set(e.to, du + e.L);
		}
	}
	const segs = n.segs.map((s) => {
		const ka = wk([s[1], s[2]]);
		const kb = wk([s[3], s[4]]);
		const da = d.get(ka) ?? 0;
		const db = d.get(kb) ?? 0;
		const [a, b, d0] = da <= db ? [[s[1], s[2]] as Pt, [s[3], s[4]] as Pt, da] : [[s[3], s[4]] as Pt, [s[1], s[2]] as Pt, db];
		return { a, b, d0, L: dist(a, b), l: s[0], w: s[5] };
	});
	const f = { segs, max: Math.max(0, ...segs.map(s => s.d0 + s.L)) };
	flowCache.set(n.name, f);
	return f;
}

// ------------------------------------------------------------------ 绘制
function layerColor(l: number, nL: number): string {
	if (l === 0)
		return LAYERC[0];
	if (l === nL - 1)
		return LAYERC[3];
	return LAYERC[1 + ((l - 1) % 2)];
}
function drawPad(p: Pad, fill: string): void {
	const w = (p.w ?? 0.5) * view.s;
	const h = (p.h ?? p.w ?? 0.5) * view.s;
	ctx.save();
	ctx.translate(X(p.x), Y(p.y));
	ctx.rotate(((flipY ? -1 : 1) * (p.rot || 0) * Math.PI) / 180);
	ctx.fillStyle = fill;
	if (p.shape === 'circle') {
		ctx.beginPath();
		ctx.arc(0, 0, w / 2, 0, Math.PI * 2);
		ctx.fill();
	}
	else {
		ctx.fillRect(-w / 2, -h / 2, w, h);
	}
	ctx.restore();
}
function line(a: Pt, b: Pt, w: number, color: string, alpha = 1, dash?: number[]): void {
	ctx.globalAlpha = alpha;
	ctx.strokeStyle = color;
	ctx.lineWidth = Math.max(1, w * view.s);
	ctx.lineCap = 'round';
	ctx.setLineDash(dash ?? []);
	ctx.beginPath();
	ctx.moveTo(X(a[0]), Y(a[1]));
	ctx.lineTo(X(b[0]), Y(b[1]));
	ctx.stroke();
	ctx.setLineDash([]);
	ctx.globalAlpha = 1;
}
function poly(pts: Pt[], w: number, color: string, alpha = 1, dash?: number[], upto = Infinity): void {
	let acc = 0;
	for (let i = 0; i < pts.length - 1; i++) {
		const L = dist(pts[i], pts[i + 1]);
		if (acc >= upto)
			break;
		const t = Math.min(1, (upto - acc) / Math.max(L, 1e-9));
		const b: Pt = [pts[i][0] + (pts[i + 1][0] - pts[i][0]) * t, pts[i][1] + (pts[i + 1][1] - pts[i][1]) * t];
		line(pts[i], b, w, color, alpha, dash);
		acc += L;
	}
}
function caption(text: string | null): void {
	const el = $('caption');
	if (text) {
		el.textContent = text;
		el.classList.add('show');
	}
	else {
		el.classList.remove('show');
	}
}

function frame(now: number): void {
	requestAnimationFrame(frame);
	if (tween) {
		const k = Math.min(1, (now - tween.t0) / 450);
		const e = 1 - (1 - k) ** 3;
		view.s = tween.from.s + (tween.to.s - tween.from.s) * e;
		view.ox = tween.from.ox + (tween.to.ox - tween.from.ox) * e;
		view.oy = tween.from.oy + (tween.to.oy - tween.from.oy) * e;
		if (k >= 1)
			tween = null;
	}
	ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
	ctx.clearRect(0, 0, W, H);
	if (!D) {
		ctx.fillStyle = '#5b6778';
		ctx.font = '14px system-ui';
		ctx.textAlign = 'center';
		ctx.fillText('点右上角“检查”读取当前 PCB', W / 2, H / 2);
		return;
	}
	const t = (now - loadT0) / 1000;
	const nL = D.board.layers.length;
	const [x0, y0, x1, y1] = D.bbox;
	const scanX = x0 + (x1 - x0) * Math.min(1, t / 1.2);
	const intro = t < 1.2;
	// 板框
	ctx.strokeStyle = '#2a3546';
	ctx.lineWidth = 1;
	ctx.setLineDash([4, 4]);
	ctx.strokeRect(X(x0), Math.min(Y(y0), Y(y1)), (x1 - x0) * view.s, Math.abs(Y(y1) - Y(y0)));
	ctx.setLineDash([]);
	// 走线（底层先画）
	const orderMode = mode === 'order';
	const orderT = (now - modeT0) / 1000;
	const orderIdx = new Map<string, number>();
	if (orderMode)
		D.order.forEach((r, i) => orderIdx.set(r.net, i));
	const perNet = orderMode ? Math.max(0.08, Math.min(0.45, 7 / Math.max(1, D.order.length))) : 0;
	const fixNets = mode === 'fix' && plan ? new Set(plan.changes.map(c => c.net)) : null;
	const layersSorted = [...new Set(D.board.nets.flatMap(n => n.segs.map(s => s[0])))].sort((a, b) => b - a);
	for (const l of layersSorted) {
		if (!layerOn.has(l))
			continue;
		const col = layerColor(l, nL);
		for (const n of D.board.nets) {
			const focus = selNet === null || n.name === selNet || pairOf(selNet) === n.name;
			let reveal = Infinity;
			if (orderMode) {
				const i = orderIdx.get(n.name);
				const k = i === undefined ? 1 : (orderT - i * perNet) / perNet;
				const f = flowOf(n);
				reveal = k <= 0 ? -1 : k >= 1 ? Infinity : k * f.max;
			}
			if (reveal < 0)
				continue;
			const f = orderMode ? flowOf(n) : null;
			for (let si = 0; si < n.segs.length; si++) {
				const s = n.segs[si];
				if (s[0] !== l)
					continue;
				if (intro && Math.min(s[1], s[3]) > scanX)
					continue;
				let a: Pt = [s[1], s[2]];
				let b: Pt = [s[3], s[4]];
				if (f && reveal !== Infinity) {
					const fs = f.segs[si];
					if (fs.d0 >= reveal)
						continue;
					a = fs.a;
					const k = Math.min(1, (reveal - fs.d0) / Math.max(1e-9, fs.L));
					b = [fs.a[0] + (fs.b[0] - fs.a[0]) * k, fs.a[1] + (fs.b[1] - fs.a[1]) * k];
				}
				const c = orderMode ? TIERC[tierOfNet(n.name)] : col;
				line(a, b, s[5], c, fixNets?.has(n.name) ? 0.1 : focus ? (l === 0 ? 0.9 : 0.6) : 0.18);
			}
		}
	}
	// 焊盘、过孔
	for (const n of D.board.nets) {
		const focus = selNet === null || n.name === selNet || pairOf(selNet) === n.name;
		for (const p of n.pads) {
			if (intro && p.x > scanX)
				continue;
			drawPad(p, focus ? 'rgba(217,180,74,.85)' : 'rgba(217,180,74,.25)');
		}
		for (const v of n.vias) {
			if (intro && v[0] > scanX)
				continue;
			ctx.globalAlpha = focus ? 0.95 : 0.3;
			ctx.fillStyle = '#c9ced6';
			ctx.beginPath();
			ctx.arc(X(v[0]), Y(v[1]), Math.max(1.5, (v[2] / 2) * view.s), 0, Math.PI * 2);
			ctx.fill();
			ctx.fillStyle = '#0b0f15';
			ctx.beginPath();
			ctx.arc(X(v[0]), Y(v[1]), Math.max(0.8, (v[2] / 4) * view.s), 0, Math.PI * 2);
			ctx.fill();
			ctx.globalAlpha = 1;
		}
	}
	if (intro) {
		const sx = X(scanX);
		const g = ctx.createLinearGradient(sx - 60, 0, sx, 0);
		g.addColorStop(0, 'rgba(57,208,176,0)');
		g.addColorStop(1, 'rgba(57,208,176,.35)');
		ctx.fillStyle = g;
		ctx.fillRect(sx - 60, 0, 60, H);
		ctx.fillStyle = '#39d0b0';
		ctx.fillRect(sx - 1, 0, 2, H);
	}
	// 电流 / 信号流
	if (selNet && mode !== 'order') {
		drawFlow(selNet, now, '#7cf5dc');
		const mate = pairOf(selNet);
		if (mate)
			drawFlow(mate, now, '#ffd27c');
		drawReturn(selNet, now);
	}
	// 去耦回路
	if (selV !== null && mode !== 'order')
		drawLoop(D.report.violations[selV], now);
	// 修复形变
	if (mode === 'fix' && plan)
		drawFix(now);
	// 违规标记
	if (mode !== 'order') {
		D.report.violations.forEach((v, i) => {
			if (!v.at || !sevOn.has(v.sev))
				return;
			if (intro && v.at[0] > scanX)
				return;
			const appear = intro ? Math.max(0, Math.min(1, (scanX - v.at[0]) / ((x1 - x0) * 0.08))) : 1;
			const ph = ((now / 1000 + i * 0.37) % 1.6) / 1.6;
			const r0 = (i === selV ? 9 : 5) * appear;
			ctx.strokeStyle = SEVC[v.sev];
			ctx.globalAlpha = (1 - ph) * 0.8;
			ctx.lineWidth = 1.5;
			ctx.beginPath();
			ctx.arc(X(v.at[0]), Y(v.at[1]), r0 + ph * 14, 0, Math.PI * 2);
			ctx.stroke();
			ctx.globalAlpha = 1;
			ctx.fillStyle = SEVC[v.sev];
			ctx.beginPath();
			ctx.arc(X(v.at[0]), Y(v.at[1]), r0 * 0.55 + 1.5, 0, Math.PI * 2);
			ctx.fill();
			if (i === selV) {
				ctx.strokeStyle = 'rgba(255,255,255,.5)';
				ctx.lineWidth = 1;
				ctx.setLineDash([3, 3]);
				ctx.beginPath();
				ctx.moveTo(X(v.at[0]) - 28, Y(v.at[1]));
				ctx.lineTo(X(v.at[0]) + 28, Y(v.at[1]));
				ctx.moveTo(X(v.at[0]), Y(v.at[1]) - 28);
				ctx.lineTo(X(v.at[0]), Y(v.at[1]) + 28);
				ctx.stroke();
				ctx.setLineDash([]);
			}
		});
	}
	if (orderMode) {
		const i = Math.min(D.order.length - 1, Math.floor(orderT / perNet));
		const r = D.order[Math.max(0, i)];
		if (r)
			caption(`第 ${r.tier} 档 · ${r.tier_name}：${r.net} —— ${r.why}`);
		if (orderT > perNet * (D.order.length + 2)) {
			mode = 'idle';
			caption('回放完成：关键网络先布、先占最好的位置，一般信号最后让路');
			setTimeout(() => caption(null), 2600);
		}
	}
}

function tierOfNet(name: string): number {
	return D?.order.find(r => r.net === name)?.tier ?? 8;
}
function pairOf(name: string | null): string | null {
	if (!name || !D)
		return null;
	const p = D.report.pairs.find(q => q.p === name || q.n === name);
	return p ? (p.p === name ? p.n : p.p) : null;
}
function drawFlow(name: string, now: number, color: string): void {
	const n = D!.board.nets.find(x => x.name === name);
	if (!n)
		return;
	const cls = D!.report.classes[name] ?? 'SIG';
	const speed = cls.startsWith('PWR') || cls === 'GND' ? 4 : cls === 'CLK' || cls === 'XTAL' ? 14 : 8; // mm/s
	const sp = 1.2;
	const f = flowOf(n);
	const t = now / 1000;
	ctx.fillStyle = color;
	for (const s of f.segs) {
		if (!layerOn.has(s.l))
			continue;
		let first = (((speed * t - s.d0) % sp) + sp) % sp;
		for (let x = first; x < s.L; x += sp) {
			const k = x / Math.max(s.L, 1e-9);
			const px = s.a[0] + (s.b[0] - s.a[0]) * k;
			const py = s.a[1] + (s.b[1] - s.a[1]) * k;
			ctx.globalAlpha = 0.9;
			ctx.beginPath();
			ctx.arc(X(px), Y(py), Math.max(1.6, s.w * view.s * 0.6), 0, Math.PI * 2);
			ctx.fill();
		}
		first = 0;
	}
	ctx.globalAlpha = 1;
}
/** 回流：信号过孔到最近地过孔的回流路径（虚线反向流动），超过 2 mm 标橙色 */
function drawReturn(name: string, now: number): void {
	const cls = D!.report.classes[name];
	if (!cls || cls === 'GND' || cls.startsWith('PWR'))
		return;
	const n = D!.board.nets.find(x => x.name === name)!;
	const gv: Pt[] = [];
	for (const g of D!.board.nets) {
		if (D!.report.classes[g.name] === 'GND') {
			for (const v of g.vias) gv.push([v[0], v[1]]);
		}
	}
	if (!gv.length)
		return;
	const off = -((now / 60) % 12);
	for (const v of n.vias) {
		let best: Pt | null = null;
		let bd = 1e9;
		for (const q of gv) {
			const d = dist(q, [v[0], v[1]]);
			if (d < bd) {
				bd = d;
				best = q;
			}
		}
		if (!best)
			continue;
		const col = bd > 2 ? '#ff8a3d' : '#3ccf7a';
		ctx.strokeStyle = col;
		ctx.lineWidth = 2;
		ctx.setLineDash([6, 6]);
		ctx.lineDashOffset = off;
		ctx.beginPath();
		ctx.moveTo(X(v[0]), Y(v[1]));
		ctx.lineTo(X(best[0]), Y(best[1]));
		ctx.stroke();
		ctx.setLineDash([]);
		ctx.lineDashOffset = 0;
		ctx.fillStyle = col;
		ctx.font = '11px system-ui';
		ctx.textAlign = 'left';
		ctx.fillText(`回流 ${bd.toFixed(1)} mm`, X((v[0] + best[0]) / 2) + 6, Y((v[1] + best[1]) / 2) - 6);
	}
}
/** 去耦与 ESD：芯片引脚 → 电容 → 地过孔 的电流回路，面积越大越红 */
function drawLoop(v: Violation | undefined, now: number): void {
	if (!v || !v.at || !['RTP-01', 'RTP-03', 'RTP-08'].includes(v.rule) || !D)
		return;
	const nets = D.board.nets;
	const own = nets.find(n => n.name === v.net);
	if (!own)
		return;
	const cap = own.pads.find(p => Math.abs(p.x - v.at![0]) < 1e-3 && Math.abs(p.y - v.at![1]) < 1e-3);
	if (!cap)
		return;
	const other = nets.flatMap(n => n.pads.map(p => [n.name, p] as [string, Pad])).find(([, p]) => p.ref === cap.ref && p !== cap);
	const isGndSide = D.report.classes[own.name] === 'GND';
	const pwrPad = isGndSide ? other?.[1] : cap;
	const gndPad = isGndSide ? cap : other?.[1];
	const pwrNet = isGndSide ? nets.find(n => n.name === other?.[0]) : own;
	if (!pwrPad || !gndPad || !pwrNet)
		return;
	const ic = pwrNet.pads.filter(p => /^(U|IC)\d/.test(p.ref)).sort((a, b) => dist([a.x, a.y], [pwrPad.x, pwrPad.y]) - dist([b.x, b.y], [pwrPad.x, pwrPad.y]))[0];
	const gvs = nets.filter(n => D!.report.classes[n.name] === 'GND').flatMap(n => n.vias.map(q => [q[0], q[1]] as Pt));
	const gv = gvs.sort((a, b) => dist(a, [gndPad.x, gndPad.y]) - dist(b, [gndPad.x, gndPad.y]))[0];
	if (!ic)
		return;
	const loop: Pt[] = [[ic.x, ic.y], [pwrPad.x, pwrPad.y], [gndPad.x, gndPad.y], ...(gv ? [gv] : [])];
	let area = 0;
	for (let i = 0; i < loop.length; i++) {
		const [a, b] = [loop[i], loop[(i + 1) % loop.length]];
		area += a[0] * b[1] - b[0] * a[1];
	}
	area = Math.abs(area) / 2;
	const hot = Math.min(1, area / 20);
	ctx.fillStyle = `rgba(255,${Math.round(180 - 140 * hot)},${Math.round(90 - 60 * hot)},${0.12 + 0.18 * hot})`;
	ctx.beginPath();
	loop.forEach((p, i) => (i ? ctx.lineTo(X(p[0]), Y(p[1])) : ctx.moveTo(X(p[0]), Y(p[1]))));
	ctx.closePath();
	ctx.fill();
	ctx.strokeStyle = '#ffb36b';
	ctx.lineWidth = 1.5;
	ctx.setLineDash([5, 5]);
	ctx.lineDashOffset = -((now / 40) % 10);
	ctx.stroke();
	ctx.setLineDash([]);
	ctx.lineDashOffset = 0;
	const per = loop.reduce((s, p, i) => s + dist(p, loop[(i + 1) % loop.length]), 0);
	const t = ((now / 1000) * 6) % per;
	let acc = 0;
	for (let i = 0; i < loop.length; i++) {
		const [a, b] = [loop[i], loop[(i + 1) % loop.length]];
		const L = dist(a, b);
		if (t <= acc + L) {
			const k = (t - acc) / Math.max(L, 1e-9);
			ctx.fillStyle = '#fff1d6';
			ctx.beginPath();
			ctx.arc(X(a[0] + (b[0] - a[0]) * k), Y(a[1] + (b[1] - a[1]) * k), 4, 0, Math.PI * 2);
			ctx.fill();
			break;
		}
		acc += L;
	}
	ctx.fillStyle = '#ffd3a1';
	ctx.font = '12px system-ui';
	ctx.fillText(`去耦回路面积 ≈ ${area.toFixed(1)} mm²`, X(pwrPad.x) + 10, Y(pwrPad.y) - 10);
}
function drawFix(now: number): void {
	const t = ((now - modeT0) / 1000) % 3.6;
	for (const it of plan!.fixed) {
		if (it.before.length > 1)
			poly(it.before, 0.2, '#ff3b5c', Math.max(0.15, 1 - t / 1.4), [4, 4]);
		if (it.after.length > 1) {
			const total = it.after.reduce((s, p, i) => (i ? s + dist(it.after[i - 1], p) : 0), 0);
			const k = Math.max(0, Math.min(1, (t - 0.6) / 1.6));
			poly(it.after, 0.22, '#3ccf7a', 0.95, undefined, k * total);
		}
	}
	for (const m of plan!.manual) {
		if (!m.at)
			continue;
		ctx.strokeStyle = '#f5c542';
		ctx.lineWidth = 1.5;
		ctx.strokeRect(X(m.at[0]) - 7, Y(m.at[1]) - 7, 14, 14);
	}
}

// ------------------------------------------------------------------ 交互
let drag: { x: number; y: number; ox: number; oy: number; moved: boolean } | null = null;
cv.addEventListener('wheel', (e) => {
	e.preventDefault();
	const k = Math.exp(-e.deltaY * 0.0015);
	const mx = e.offsetX;
	const my = e.offsetY;
	const wx = invX(mx);
	const wy = invY(my);
	view.s *= k;
	view.ox = mx - wx * view.s;
	view.oy = flipY ? my + wy * view.s : my - wy * view.s;
}, { passive: false });
cv.addEventListener('mousedown', (e) => {
	drag = { x: e.clientX, y: e.clientY, ox: view.ox, oy: view.oy, moved: false };
});
window.addEventListener('mousemove', (e) => {
	if (!drag)
		return;
	const dx = e.clientX - drag.x;
	const dy = e.clientY - drag.y;
	if (Math.abs(dx) + Math.abs(dy) > 3)
		drag.moved = true;
	view.ox = drag.ox + dx;
	view.oy = drag.oy + dy;
});
window.addEventListener('mouseup', (e) => {
	if (drag && !drag.moved)
		pick(e.offsetX ?? 0, e.offsetY ?? 0, e);
	drag = null;
});
cv.addEventListener('dblclick', () => {
	selNet = null;
	selV = null;
	fit();
	renderIssues();
});
function pick(_px: number, _py: number, e: MouseEvent): void {
	if (!D || e.target !== cv)
		return;
	const px = e.offsetX;
	const py = e.offsetY;
	// 先找违规标记
	let bestV = -1;
	let bd = 12;
	D.report.violations.forEach((v, i) => {
		if (!v.at || !sevOn.has(v.sev))
			return;
		const d = Math.hypot(X(v.at[0]) - px, Y(v.at[1]) - py);
		if (d < bd) {
			bd = d;
			bestV = i;
		}
	});
	if (bestV >= 0) {
		selectViolation(bestV, false);
		return;
	}
	// 再找走线
	let bestN: string | null = null;
	let bs = 8;
	const wx = invX(px);
	const wy = invY(py);
	for (const n of D.board.nets) {
		for (const s of n.segs) {
			if (!layerOn.has(s[0]))
				continue;
			const dx = s[3] - s[1];
			const dy = s[4] - s[2];
			const L2 = dx * dx + dy * dy;
			const tt = L2 < 1e-12 ? 0 : Math.max(0, Math.min(1, ((wx - s[1]) * dx + (wy - s[2]) * dy) / L2));
			const d = Math.hypot(wx - s[1] - tt * dx, wy - s[2] - tt * dy) * view.s;
			if (d < bs) {
				bs = d;
				bestN = n.name;
			}
		}
	}
	selectNet(bestN);
}
function selectNet(name: string | null): void {
	selNet = name;
	selV = null;
	renderIssues();
	if (name && D) {
		const cls = D.report.classes[name];
		const ns = D.report.nets.find(n => n.net === name);
		const mate = pairOf(name);
		caption(`${name}（${cls}）走线 ${ns?.len ?? '—'} mm · 过孔 ${ns?.vias ?? 0} 个${mate ? ` · 与 ${mate} 成对（黄色）` : ''}${cls && !cls.startsWith('PWR') && cls !== 'GND' && ns?.vias ? ' · 虚线为回流到最近地过孔的路径' : ''}`);
		rpc('highlightNet', { net: name }).catch(() => {});
	}
	else {
		caption(null);
		rpc('highlightNet', { net: null }).catch(() => {});
	}
}
function selectViolation(i: number, zoom = true): void {
	if (!D)
		return;
	const v = D.report.violations[i];
	selV = i;
	selNet = v.net && D.board.nets.some(n => n.name === v.net) ? v.net : null;
	if (v.at && zoom)
		zoomTo(v.at);
	renderIssues();
	const el = document.querySelector(`[data-v="${i}"]`);
	el?.scrollIntoView({ block: 'nearest' });
	caption(`${v.rule}：${v.msg}`);
	rpc('locate', { ids: v.ids, at: v.at, net: v.net }).catch(() => {});
}

// ------------------------------------------------------------------ 右侧面板
const METRIC_OF_RULE = (v: Violation) => v.metric ?? 'VF-26';
function esc(s: unknown): string {
	return String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}
function renderHeader(): void {
	if (!D)
		return;
	const r = D.report;
	$('score').textContent = String(Math.round(r.score));
	const arc = $('ringArc');
	const col = !r.pass ? '#ff3b5c' : r.score >= 90 ? '#3ccf7a' : r.score >= 75 ? '#39d0b0' : r.score >= 60 ? '#f5c542' : '#ff8a3d';
	arc.setAttribute('stroke', col);
	arc.setAttribute('stroke-dashoffset', String(113.1 * (1 - r.score / 100)));
	$('grade').textContent = `${r.grade} · 违规 ${r.violations.length} 条 · ${D.board.layers.length} 层 ${D.board.nets.length} 网络${D.warnings?.length ? ` · ${D.warnings.join('；')}` : ''}`;
	const hud = $('hud');
	const nL = D.board.layers.length;
	hud.innerHTML = '';
	const layers = [...new Set(D.board.nets.flatMap(n => n.segs.map(s => s[0])))].sort((a, b) => a - b);
	for (const l of layers) {
		const c = document.createElement('span');
		c.className = `chip${layerOn.has(l) ? ' on' : ''}`;
		c.innerHTML = `<i style="background:${layerColor(l, nL)}"></i>${esc(D.board.layers[l] ?? `L${l + 1}`)}`;
		c.onclick = () => {
			layerOn.has(l) ? layerOn.delete(l) : layerOn.add(l);
			renderHeader();
		};
		hud.appendChild(c);
	}
	for (const s of ['P0', 'P1', 'P2', 'P3']) {
		const c = document.createElement('span');
		const k = r.violations.filter(v => v.sev === s).length;
		c.className = `chip${sevOn.has(s) ? ' on' : ''}`;
		c.innerHTML = `<i style="background:${SEVC[s]};border-radius:50%"></i>${s} ${k}`;
		c.onclick = () => {
			sevOn.has(s) ? sevOn.delete(s) : sevOn.add(s);
			sevOn = new Set(sevOn);
			renderHeader();
			renderIssues();
		};
		hud.appendChild(c);
	}
	const f = document.createElement('span');
	f.className = 'chip';
	f.textContent = '上下翻转';
	f.onclick = () => {
		flipY = !flipY;
		try {
			localStorage.setItem('lpiot-flip', flipY ? '1' : '0');
		}
		catch {}
		fit();
	};
	hud.appendChild(f);
}
function renderIssues(): void {
	const pane = $('p-issues');
	if (!D) {
		pane.innerHTML = '<div class="empty">还没有检查结果</div>';
		return;
	}
	const r = D.report;
	if (!r.violations.length) {
		pane.innerHTML = '<div class="empty">没有发现问题 🎉</div>';
		return;
	}
	const groups = new Map<string, number[]>();
	r.violations.forEach((v, i) => {
		if (!sevOn.has(v.sev))
			return;
		const k = METRIC_OF_RULE(v);
		if (!groups.has(k))
			groups.set(k, []);
		groups.get(k)!.push(i);
	});
	let html = '';
	if (r.confirm.length)
		html += `<div class="note" style="margin:0 0 10px">网络类需要确认：${r.confirm.slice(0, 8).map(c => `${esc(c.net)}→${esc(c.class)}`).join('、')}${r.confirm.length > 8 ? ' 等' : ''}</div>`;
	for (const [k, idx] of [...groups].sort((a, b) => a[0].localeCompare(b[0]))) {
		html += `<div class="group"><h4><span>${esc(k)} ${esc(r.metrics[k]?.name ?? '')}</span><span>${idx.length}</span></h4>`;
		for (const i of idx) {
			const v = r.violations[i];
			html += `<div class="item${i === selV ? ' sel' : ''}" data-v="${i}"><div class="row"><span class="sev ${v.sev}">${v.sev}</span><span class="rule">${esc(v.rule)}${v.net ? ` · ${esc(v.net)}` : ''}${v.layer !== null && v.layer !== undefined ? ` · L${v.layer + 1}` : ''}</span></div><div class="msg">${esc(v.msg)}</div><div class="act"><button data-ask="${i}">问 AI</button>${v.net && D.board.nets.some(n => n.name === v.net) ? `<button data-net="${esc(v.net)}">看电流</button>` : ''}</div></div>`;
		}
		html += '</div>';
	}
	pane.innerHTML = html;
	pane.querySelectorAll<HTMLElement>('.item').forEach((el) => {
		el.onclick = (e) => {
			if ((e.target as HTMLElement).tagName === 'BUTTON')
				return;
			selectViolation(Number(el.dataset.v));
		};
	});
	pane.querySelectorAll<HTMLElement>('[data-ask]').forEach((b) => {
		b.onclick = () => askAi(Number(b.dataset.ask));
	});
	pane.querySelectorAll<HTMLElement>('[data-net]').forEach((b) => {
		b.onclick = () => selectNet(b.dataset.net!);
	});
}
function renderMetrics(): void {
	if (!D)
		return;
	let html = '';
	for (const [k, e] of Object.entries(D.report.metrics)) {
		const ok = e.weight - e.deduct;
		const val = e.value === null || e.value === undefined ? '—' : typeof e.value === 'object' ? Object.entries(e.value as object).map(([a, b]) => `${a}=${b ?? '—'}`).join(' ') : String(e.value);
		html += `<div class="metric"><div class="row"><span>${esc(k)} ${esc(e.name)}</span><span>${(ok).toFixed(1)} / ${e.weight}</span></div><div class="bar"><i style="width:${(100 * ok) / e.weight}%;background:${e.deduct === 0 ? '#3ccf7a' : e.level === '警告' ? '#f5c542' : '#ff6b5c'}"></i></div><div class="note" style="margin-top:2px">${esc(val)}${e.note ? ` · ${esc(e.note)}` : ''}</div></div>`;
	}
	html += '<div class="note">总分按全部权重归一化到 100；任一 P0 即不通过。规则见 low-power-iot-hardware-design 的 references/16–18。</div>';
	$('p-metrics').innerHTML = html;
}
function renderOrder(): void {
	if (!D)
		return;
	let html = '<div class="act" style="margin-bottom:10px"><button id="playOrder" class="primary">回放布线顺序</button></div>';
	for (const [t, name, , why] of TIERS) {
		const rows = D.order.filter(r => r.tier === t);
		if (!rows.length)
			continue;
		html += `<div class="tier" style="border-left-color:${TIERC[t]}"><b>${t}. ${esc(name)}</b><small>${esc(why)}</small><div class="nets">${rows.map(r => `<span data-on="${esc(r.net)}">${esc(r.net)}</span>`).join('')}</div></div>`;
	}
	$('p-order').innerHTML = html;
	$('playOrder').onclick = playOrder;
	$('p-order').querySelectorAll<HTMLElement>('[data-on]').forEach((el) => {
		el.onclick = () => selectNet(el.dataset.on!);
	});
}
const ISSUE: Record<string, string> = { angle: '任意角度', exit: '斜出焊盘', acute: '锐角', tee: '锐角分支', short: '短线段', jog: '抖动', stub: '悬空线头', overlap: '重叠线段', connectivity: '会改变连通', degenerate: '退化' };
const issueText = (xs: string[]) => xs.map(x => ISSUE[x] ?? x).join('、');
function renderFix(): void {
	const pane = $('p-fix');
	if (!plan) {
		pane.innerHTML = '<div class="empty">点“修复预览”计算修复方案。只修几何（任意角度、锐角、抖动、斜出焊盘、悬空线头、重叠线段），不改过孔和连接关系。</div>';
		return;
	}
	const nAdd = plan.changes.reduce((s, c) => s + c.add.length, 0);
	const nRm = plan.changes.reduce((s, c) => s + c.remove.length, 0);
	let html = `<div class="group"><h4><span>可自动修复 ${plan.fixed.length} 处（${plan.changes.length} 个网络，删 ${nRm} 段 / 建 ${nAdd} 段）</span></h4>`;
	html += plan.fixed.map(it => `<div class="item"><div class="row"><span class="sev P3">${esc(it.how === 'remove' ? '删除' : it.how === 'merge' ? '合并' : '重建')}</span><span class="rule">${esc(it.net)} · L${it.layer + 1}</span></div><div class="msg">${esc(issueText(it.issues))}</div></div>`).join('');
	html += '</div>';
	if (plan.manual.length) {
		html += `<div class="group"><h4><span>需要人工处理 ${plan.manual.length} 处</span></h4>`;
		html += plan.manual.map(m => `<div class="item"><div class="row"><span class="sev P2">人工</span><span class="rule">${esc(m.net)}</span></div><div class="msg">${esc(issueText(m.issues))}：${esc(m.reason)}</div></div>`).join('');
		html += '</div>';
	}
	html += '<div class="note">画布上红色虚线是原走线，绿色是修复后的走线；黄框是修不了的位置。应用后请在嘉立创 EDA 里重新铺铜并跑一次 DRC。</div>';
	pane.innerHTML = html;
}
function tab(t: string): void {
	document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('on', (b as HTMLElement).dataset.t === t));
	document.querySelectorAll('.pane').forEach(p => p.classList.toggle('on', p.id === `p-${t}`));
}
document.querySelectorAll<HTMLElement>('#tabs button').forEach((b) => {
	b.onclick = () => tab(b.dataset.t!);
});

// ------------------------------------------------------------------ 动作
async function check(): Promise<void> {
	const btn = $('btnCheck') as HTMLButtonElement;
	btn.disabled = true;
	btn.innerHTML = '<span class="spinner"></span>检查中';
	try {
		D = await rpc('check');
		flowCache.clear();
		plan = null;
		selV = null;
		selNet = null;
		mode = 'idle';
		fit();
		loadT0 = performance.now();
		renderHeader();
		renderIssues();
		renderMetrics();
		renderOrder();
		renderFix();
		($('btnApply') as HTMLButtonElement).disabled = true;
	}
	catch (e: any) {
		$('grade').textContent = `检查失败：${e?.message ?? e}`;
	}
	finally {
		btn.disabled = false;
		btn.textContent = '检查';
	}
}
function playOrder(): void {
	if (!D)
		return;
	selNet = null;
	selV = null;
	mode = 'order';
	modeT0 = performance.now();
	fit();
}
async function fixPreview(): Promise<void> {
	if (!D)
		await check();
	const btn = $('btnFix') as HTMLButtonElement;
	btn.disabled = true;
	btn.innerHTML = '<span class="spinner"></span>计算中';
	try {
		plan = await rpc('fixPlan');
		mode = 'fix';
		modeT0 = performance.now();
		renderFix();
		tab('fix');
		($('btnApply') as HTMLButtonElement).disabled = !plan?.changes.length;
		caption(plan?.changes.length ? `可自动修复 ${plan.fixed.length} 处：红色虚线 → 绿色八方向走线` : '没有可以自动修复的几何问题');
	}
	catch (e: any) {
		caption(`修复计算失败：${e?.message ?? e}`);
	}
	finally {
		btn.disabled = false;
		btn.textContent = '修复预览';
	}
}
async function fixApply(): Promise<void> {
	const btn = $('btnApply') as HTMLButtonElement;
	btn.disabled = true;
	try {
		const r = await rpc('fixApply');
		if (r?.cancelled) {
			btn.disabled = false;
			return;
		}
		await check();
		caption('已应用修复并重新检查');
	}
	catch (e: any) {
		caption(`应用失败：${e?.message ?? e}`);
		btn.disabled = false;
	}
}
async function aiReview(): Promise<void> {
	tab('ai');
	const out = $('aiOut');
	out.innerHTML = '<span class="spinner"></span>AI 正在阅读检查报告…';
	try {
		if (!D)
			await check();
		const r = await rpc('aiReview', { note: ($('aiNote') as HTMLTextAreaElement).value });
		out.textContent = r.text || '（模型没有返回内容）';
	}
	catch (e: any) {
		out.textContent = `AI 调用失败：${e?.message ?? e}`;
	}
}
async function askAi(i: number): Promise<void> {
	tab('ai');
	selectViolation(i);
	const out = $('aiOut');
	out.innerHTML = `<span class="spinner"></span>正在问 AI：${esc(D!.report.violations[i].msg)}`;
	try {
		const r = await rpc('aiAsk', { index: i, question: ($('aiNote') as HTMLTextAreaElement).value });
		out.textContent = r.text || '（模型没有返回内容）';
	}
	catch (e: any) {
		out.textContent = `AI 调用失败：${e?.message ?? e}`;
	}
}
async function loadAi(): Promise<void> {
	try {
		const c = await rpc('aiGet');
		($('aiProvider') as HTMLSelectElement).value = c.provider;
		($('aiEndpoint') as HTMLInputElement).value = c.endpoint;
		($('aiModel') as HTMLInputElement).value = c.model;
		($('aiKey') as HTMLInputElement).placeholder = c.hasKey ? `已保存（${c.apiKey}），留空则不修改` : '粘贴你的 API Key';
	}
	catch {}
}
$('aiProvider').addEventListener('change', () => {
	const p = ($('aiProvider') as HTMLSelectElement).value;
	const ep = $('aiEndpoint') as HTMLInputElement;
	const md = $('aiModel') as HTMLInputElement;
	if (p === 'anthropic') {
		ep.value = 'https://api.anthropic.com/v1/messages';
		md.value = 'claude-sonnet-5-5';
	}
	else if (/anthropic/.test(ep.value)) {
		ep.value = 'https://api.deepseek.com/v1/chat/completions';
		md.value = 'deepseek-chat';
	}
});
$('aiSave').onclick = async () => {
	await rpc('aiSet', { provider: ($('aiProvider') as HTMLSelectElement).value, endpoint: ($('aiEndpoint') as HTMLInputElement).value.trim(), model: ($('aiModel') as HTMLInputElement).value.trim(), apiKey: ($('aiKey') as HTMLInputElement).value.trim() });
	($('aiKey') as HTMLInputElement).value = '';
	await loadAi();
	caption('AI 设置已保存');
	setTimeout(() => caption(null), 1500);
};
$('btnCheck').onclick = check;
$('btnOrder').onclick = () => {
	if (D) {
		playOrder();
		tab('order');
	}
};
$('btnFix').onclick = fixPreview;
$('btnApply').onclick = fixApply;
$('btnAi').onclick = aiReview;
$('aiGo').onclick = aiReview;

// ------------------------------------------------------------------ 启动
try {
	flipY = localStorage.getItem('lpiot-flip') !== '0';
}
catch {}
if (!HAS_EDA) {
	const tag = $('demoTag');
	tag.innerHTML = '演示模式 · <a href="#" id="swDemo" style="color:inherit">换一块示例板</a>';
	$('swDemo').onclick = (e) => {
		e.preventDefault();
		demoKey = demoKey === 'principles-bad' ? 'route-bad' : 'principles-bad';
		demoBoard = clone((demo as any)[demoKey]);
		check();
	};
}
window.addEventListener('resize', () => {
	resize();
	fit();
});
resize();
requestAnimationFrame(frame);
loadAi();
check();
(window as any).__lpiot = { get data() { return D; }, get plan() { return plan; }, selectNet, selectViolation, playOrder, fixPreview, check, rpc, get mode() { return mode; } };
