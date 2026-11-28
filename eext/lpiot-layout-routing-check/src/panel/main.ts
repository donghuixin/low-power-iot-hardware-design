/**
 * 面板（iframe）：检查结论、板子动画（扫描入场、违规脉冲、电流 / 回流流动、去耦回路、布线顺序回放、修复前后形变）、AI 解读。
 * 在嘉立创 EDA 里通过 eda.sys_MessageBus 与扩展主线程通信；单独打开（没有 eda 对象）时进入演示模式，用内置示例板。
 */
import type { Board, FinishModel, FinishReport, FixPlan, Gate, LayoutIssue, LayoutReport, Net, OrderRow, Pad, Pt, Report, Seg, Violation } from '../core';
import { analyze, status as briefStatus, template as briefTemplate, confirm as confirmGate, confirmTier, dist, draftPriorities, fields, FINISH_QUESTIONS, finishAnswered, finishCheck, GATES, summary as gateSummary, layoutCheck, planFix, requireStage, routingOrder, TIERS, tierStates } from '../core';
import demoBrief from './demo-brief.json';
import demoFinish from './demo-finish.json';
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
const demoKey: keyof typeof demo = 'demo-node';
let demoBoard: Board = clone((demo as any)[demoKey]);
let demoPlan: FixPlan | null = null;
const demoBriefs: Record<string, any> = { 'demo-node': clone(demoBrief) };
const DEMO_OUTLINE: Record<string, Pt[]> = { 'demo-node': [[0, 0], [50, 0], [50, 32], [0, 32]] };
function demoView(): any {
	const b = demoBriefs[demoKey];
	return { brief: b, status: briefStatus(b), tiers: tierStates(b), summaries: Object.fromEntries(GATES.map(g => [g, gateSummary(b, g)])) };
}
function clone<T>(x: T): T {
	return JSON.parse(JSON.stringify(x));
}
async function mock(cmd: string, _args: any): Promise<any> {
	const board = demoBoard;
	board.outline = board.outline ?? DEMO_OUTLINE[demoKey];
	const bb = bboxOf(board);
	const args = _args ?? {};
	switch (cmd) {
		case 'check': {
			const report = analyze(board);
			const b = demoBriefs[demoKey];
			return { board, bbox: bb, report, order: routingOrder(board.nets, report.classes), warnings: ['演示模式：内置示例板'], gate: { route: requireStage(b, 'route'), deliver: requireStage(b, 'deliver') } };
		}
		case 'briefGet':
			return demoView();
		case 'briefUpdate': {
			const cur = demoBriefs[demoKey];
			if (args.brief)
				demoBriefs[demoKey] = { ...briefTemplate(), ...args.brief, confirmations: args.reset ? {} : cur.confirmations };
			for (const [path, v] of Object.entries(args.set ?? {})) {
				const ks = path.split('.');
				let o = demoBriefs[demoKey];
				for (const k of ks.slice(0, -1)) o = (o[k] && typeof o[k] === 'object' && !Array.isArray(o[k])) ? o[k] : (o[k] = {});
				o[ks[ks.length - 1]] = v;
			}
			return demoView();
		}
		case 'briefConfirm':
			confirmGate(demoBriefs[demoKey], args.gate, args.typed, 'panel');
			return demoView();
		case 'priorityDraft': {
			const b = demoBriefs[demoKey];
			const tiers = draftPriorities(board, b.roles ?? {});
			if (args.write) {
				b.G4_routing_plan = { ...(b.G4_routing_plan ?? {}), priorities: tiers };
				if (b.confirmations)
					delete b.confirmations.tiers;
			}
			return { tiers, note: args.ai ? '演示模式没有接入模型，按网络名、连接的器件和网络类推断' : '按网络名、连接的器件和网络类推断', brief: demoView() };
		}
		case 'tierConfirm': {
			const b = demoBriefs[demoKey];
			const st = tierStates(b).find(x => String(x.tier) === String(args.tier))!;
			confirmTier(b, args.tier, st.code, 'panel');
			return demoView();
		}
		case 'layoutCheck': {
			const b = demoBriefs[demoKey];
			const layout = layoutCheck(board, b, { yUp: args.yUp !== false });
			if (args.record)
				b.G3_layout_check = { ...(b.G3_layout_check ?? {}), report: '扩展布局检查', result: { kind: layout.kind, p0: layout.p0, p1: layout.p1, p2: layout.p2, brief_hash: layout.brief_hash } };
			return { board, bbox: bb, layout, brief: demoView() };
		}
		case 'finishCheck': {
			// 演示：用一块带丝印、位号和泪滴问题的示例板
			const b = demoBriefs[demoKey];
			const model = clone((demoFinish as any).model) as FinishModel;
			const report = finishCheck(model, b, null);
			if (args.record)
				b.G5_finish = { ...(b.G5_finish ?? {}), report: '扩展出图前检查', result: report };
			return { model, report, warnings: ['演示模式：内置丝印示例板（30 × 20 mm）'], brief: demoView() };
		}
		case 'routeRecord': {
			const report = analyze(board);
			demoBriefs[demoKey].G6_acceptance = { ...(demoBriefs[demoKey].G6_acceptance ?? {}), route_report: '扩展布线检查', route_result: { score: report.score, pass: report.pass, p0: report.violations.filter(v => v.sev === 'P0').length } };
			return demoView();
		}
		case 'fixPlan':
			demoPlan = planFix(board);
			return { ...demoPlan, gate: requireStage(demoBriefs[demoKey], 'route') };
		case 'fixApply': {
			const miss = requireStage(demoBriefs[demoKey], 'route');
			if (miss.length)
				throw new Error(`拒绝写回修复：设计确认闸门未放行。\n${miss.map(m => `· ${m}`).join('\n')}`);
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
interface Data { board: Board; bbox: [number, number, number, number]; report: Report; order: OrderRow[]; warnings?: string[]; gate?: { route: string[]; deliver: string[] } }
interface BriefView { brief: any; status: ReturnType<typeof briefStatus>; tiers: ReturnType<typeof tierStates>; summaries: Record<string, string> }
let tierFocus: { tier: number; nets: Set<string>; t0: number } | null = null;
let D: Data | null = null;
let BR: BriefView | null = null;
let L: LayoutReport | null = null;
let lmode = false;
let selL: number | null = null;
let layoutT0 = 0;
let openGate: Gate | null = null;
let F: { model: FinishModel; report: FinishReport; bbox: [number, number, number, number] } | null = null;
let fmode = false;
let selF: number | null = null;
let finishT0 = 0;
const BLOCKC = ['#39d0b0', '#ff8a3d', '#7fd4ff', '#b98cff', '#f5c542', '#ff5d8f', '#3ccf7a', '#e8683f'];
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
	if (!D && !(fmode && F))
		return;
	const [x0, y0, x1, y1] = fmode && F ? F.bbox : D!.bbox;
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
	if (fmode && F) {
		drawFinish(now);
		return;
	}
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
				if (tierFocus && !lmode) {
					const on = tierFocus.nets.has(n.name);
					if (on) {
						const pulse = 0.18 + 0.12 * Math.sin((now - tierFocus.t0) / 260);
						line(a, b, Math.max(s[5] * 3, 0.7), TIERC[tierFocus.tier], pulse);
					}
					line(a, b, on ? Math.max(s[5], 0.25) : s[5], on ? TIERC[tierFocus.tier] : col, on ? 0.95 : 0.1);
					continue;
				}
				line(a, b, s[5], c, lmode ? 0.16 : fixNets?.has(n.name) ? 0.1 : focus ? (l === 0 ? 0.9 : 0.6) : 0.18);
			}
		}
	}
	// 焊盘、过孔
	for (const n of D.board.nets) {
		const focus = selNet === null || n.name === selNet || pairOf(selNet) === n.name;
		for (const p of n.pads) {
			if (intro && p.x > scanX)
				continue;
			drawPad(p, lmode ? 'rgba(217,180,74,.35)' : focus ? 'rgba(217,180,74,.85)' : 'rgba(217,180,74,.25)');
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
	if (selNet && mode !== 'order' && !lmode) {
		drawFlow(selNet, now, '#7cf5dc');
		const mate = pairOf(selNet);
		if (mate)
			drawFlow(mate, now, '#ffd27c');
		drawReturn(selNet, now);
	}
	// 去耦回路
	if (selV !== null && mode !== 'order' && !lmode)
		drawLoop(D.report.violations[selV], now);
	// 修复形变
	if (mode === 'fix' && plan)
		drawFix(now);
	if (lmode && L)
		drawLayout(now);
	if (tierFocus && !lmode && mode !== 'order') {
		for (const nm of [...tierFocus.nets].slice(0, 10)) drawFlow(nm, now, '#ffffff');
	}
	// 违规标记
	if (mode !== 'order' && !lmode && !tierFocus) {
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

// ------------------------------------------------------------------ 布局检查动画
const clamp = (v: number, a: number, b: number): number => Math.max(a, Math.min(b, v));
function rectPx(r: number[]): [number, number, number, number] {
	const xa = X(r[0]);
	const xb = X(r[2]);
	const ya = Y(r[1]);
	const yb = Y(r[3]);
	return [Math.min(xa, xb), Math.min(ya, yb), Math.abs(xb - xa), Math.abs(yb - ya)];
}
function rc(r: number[]): Pt {
	return [(r[0] + r[2]) / 2, (r[1] + r[3]) / 2];
}
function hatch(r: number[], color: string, now: number, alpha = 0.55): void {
	const [x, y, w, h] = rectPx(r);
	ctx.save();
	ctx.beginPath();
	ctx.rect(x, y, w, h);
	ctx.clip();
	ctx.fillStyle = color;
	ctx.globalAlpha = 0.08;
	ctx.fillRect(x, y, w, h);
	ctx.globalAlpha = alpha;
	ctx.strokeStyle = color;
	ctx.lineWidth = 1.2;
	const off = (now / 40) % 12;
	ctx.beginPath();
	for (let k = -h - 12; k < w + h; k += 12) {
		ctx.moveTo(x + k + off, y + h);
		ctx.lineTo(x + k + off + h, y);
	}
	ctx.stroke();
	ctx.restore();
	ctx.strokeStyle = color;
	ctx.globalAlpha = 0.9;
	ctx.setLineDash([5, 4]);
	ctx.strokeRect(x, y, w, h);
	ctx.setLineDash([]);
	ctx.globalAlpha = 1;
}
function arrowPx(a: Pt, b: Pt, color: string, now: number): void {
	const ax = X(a[0]);
	const ay = Y(a[1]);
	const bx = X(b[0]);
	const by = Y(b[1]);
	const L = Math.hypot(bx - ax, by - ay);
	if (L < 4)
		return;
	const ux = (bx - ax) / L;
	const uy = (by - ay) / L;
	ctx.strokeStyle = color;
	ctx.lineWidth = 2;
	ctx.setLineDash([8, 6]);
	ctx.lineDashOffset = -(now / 30) % 14;
	ctx.beginPath();
	ctx.moveTo(ax, ay);
	ctx.lineTo(bx - ux * 8, by - uy * 8);
	ctx.stroke();
	ctx.setLineDash([]);
	ctx.lineDashOffset = 0;
	ctx.fillStyle = color;
	ctx.beginPath();
	ctx.moveTo(bx, by);
	ctx.lineTo(bx - ux * 12 - uy * 6, by - uy * 12 + ux * 6);
	ctx.lineTo(bx - ux * 12 + uy * 6, by - uy * 12 - ux * 6);
	ctx.closePath();
	ctx.fill();
	// 沿箭头移动的光点
	const ph = (now / 1200) % 1;
	ctx.globalAlpha = 1 - ph;
	ctx.beginPath();
	ctx.arc(ax + (bx - ax) * ph, ay + (by - ay) * ph, 4, 0, Math.PI * 2);
	ctx.fill();
	ctx.globalAlpha = 1;
}
function drawLayout(now: number): void {
	if (!L)
		return;
	const t = (now - layoutT0) / 1000;
	const [bx, by, bw, bh] = rectPx(L.bbox);
	ctx.strokeStyle = '#58708e';
	ctx.lineWidth = 1.5;
	ctx.strokeRect(bx, by, bw, bh);
	// 功能分区依次扫入（区域左上角重合时标签往下错开）
	const labelAt: [number, number][] = [];
	L.blocks.forEach((b, i) => {
		if (!b.zone)
			return;
		const k = clamp((t - i * 0.35) / 0.5, 0, 1);
		if (k <= 0)
			return;
		const [x, y, w, h] = rectPx(b.zone);
		const c = BLOCKC[b.color % BLOCKC.length];
		ctx.fillStyle = c;
		ctx.globalAlpha = 0.09 * k;
		ctx.fillRect(x, y, w * k, h);
		ctx.globalAlpha = 0.55 * k;
		ctx.strokeStyle = c;
		ctx.lineWidth = 1;
		ctx.setLineDash([6, 4]);
		ctx.strokeRect(x + 1, y + 1, w - 2, h - 2);
		ctx.setLineDash([]);
		ctx.globalAlpha = k;
		ctx.fillStyle = c;
		ctx.font = '600 12px system-ui';
		ctx.textAlign = 'left';
		let ly = y + 16;
		while (labelAt.some(([px, py]) => Math.abs(px - x) < 60 && Math.abs(py - ly) < 14)) ly += 15;
		labelAt.push([x, ly]);
		ctx.fillText(b.name, x + 6, ly);
		ctx.globalAlpha = 1;
	});
	// 器件按功能块着色，从上方落入
	const blockOf = new Map<string, number>();
	L.blocks.forEach(b => b.refs.forEach(r => blockOf.set(r, b.color)));
	const bad = new Set(L.issues.filter(v => v.sev === 'P0' || v.sev === 'P1').flatMap(v => v.refs));
	const base = 0.25 + L.blocks.filter(b => b.zone).length * 0.35;
	L.parts.forEach((p, i) => {
		const ap = clamp((t - base - i * 0.012) / 0.35, 0, 1);
		if (ap <= 0)
			return;
		const e = 1 - (1 - ap) ** 3;
		const [x, y0, w, h] = rectPx(p.rect);
		const y = y0 - (1 - e) * 24;
		const c = blockOf.has(p.ref) ? BLOCKC[blockOf.get(p.ref)! % BLOCKC.length] : '#6b7a8e';
		ctx.globalAlpha = 0.22 * e;
		ctx.fillStyle = c;
		ctx.fillRect(x, y, w, h);
		ctx.globalAlpha = 0.95 * e;
		ctx.strokeStyle = c;
		ctx.lineWidth = 1.2;
		ctx.strokeRect(x, y, w, h);
		if (bad.has(p.ref) && ap >= 1) {
			ctx.strokeStyle = '#ff3b5c';
			ctx.globalAlpha = 0.45 + 0.45 * Math.sin(now / 180);
			ctx.lineWidth = 2;
			ctx.strokeRect(x - 2, y - 2, w + 4, h + 4);
		}
		if (w > 16 && h > 9) {
			ctx.globalAlpha = e;
			ctx.fillStyle = '#e6edf3';
			ctx.font = `${Math.min(12, Math.max(9, h * 0.45))}px system-ui`;
			ctx.textAlign = 'center';
			ctx.fillText(p.ref, x + w / 2, y + h / 2 + 4);
		}
		ctx.globalAlpha = 1;
	});
	// 问题标记
	const ready = t > base + 0.4;
	L.issues.forEach((v, i) => {
		if (!v.at || !sevOn.has(v.sev) || !ready)
			return;
		const ph = ((now / 1000 + i * 0.37) % 1.6) / 1.6;
		const r0 = i === selL ? 9 : 5;
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
	});
	if (selL !== null && L.issues[selL])
		drawLayoutIssue(L.issues[selL], now);
}
function drawLayoutIssue(v: LayoutIssue, now: number): void {
	const part = v.refs[0] ? L!.parts.find(p => p.ref === v.refs[0]) : undefined;
	if (v.zone && v.kind !== 'block')
		hatch(v.zone, SEVC[v.sev], now);
	else if (v.zone)
		hatch(v.zone, '#3ccf7a', now, 0.25);
	if (v.kind === 'spacing' && v.refs.length >= 2) {
		const b = L!.parts.find(p => p.ref === v.refs[1]);
		if (part && b) {
			const cb = rc(b.rect);
			const ca = rc(part.rect);
			const pa: Pt = [clamp(cb[0], part.rect[0], part.rect[2]), clamp(cb[1], part.rect[1], part.rect[3])];
			const pb: Pt = [clamp(ca[0], b.rect[0], b.rect[2]), clamp(ca[1], b.rect[1], b.rect[3])];
			// 两个器件向外辐射的“场”，在中间相撞
			for (const [c, col] of [[ca, SEVC[v.sev]], [cb, '#7fd4ff']] as [Pt, string][]) {
				for (let k = 0; k < 3; k++) {
					const ph = ((now / 1400) + k / 3) % 1;
					ctx.strokeStyle = col;
					ctx.globalAlpha = (1 - ph) * 0.6;
					ctx.lineWidth = 1.2;
					ctx.beginPath();
					ctx.arc(X(c[0]), Y(c[1]), 6 + ph * 60, 0, Math.PI * 2);
					ctx.stroke();
				}
			}
			ctx.globalAlpha = 1;
			line(pa, pb, 0, SEVC[v.sev], 1, [4, 3]);
			const m = v.msg.match(/相距 ([\d.]+) mm（至少 ([\d.]+) mm）/);
			if (m) {
				ctx.fillStyle = SEVC[v.sev];
				ctx.font = '600 12px system-ui';
				ctx.textAlign = 'center';
				ctx.fillText(`${m[1]} mm / 需 ≥ ${m[2]} mm`, (X(pa[0]) + X(pb[0])) / 2, (Y(pa[1]) + Y(pb[1])) / 2 - 8);
			}
		}
		return;
	}
	if (v.target && part) {
		const c = rc(part.rect);
		const dx = v.target[0] - c[0];
		const dy = v.target[1] - c[1];
		const ghost = [part.rect[0] + dx, part.rect[1] + dy, part.rect[2] + dx, part.rect[3] + dy];
		const [gx, gy, gw, gh] = rectPx(ghost);
		ctx.strokeStyle = '#3ccf7a';
		ctx.lineWidth = 1.5;
		ctx.setLineDash([4, 3]);
		ctx.strokeRect(gx, gy, gw, gh);
		ctx.setLineDash([]);
		// 器件在原位和目标位之间来回滑动，示意怎么挪
		const ph = (1 - Math.cos((now / 1600) * Math.PI * 2)) / 2;
		const mv = [part.rect[0] + dx * ph, part.rect[1] + dy * ph, part.rect[2] + dx * ph, part.rect[3] + dy * ph];
		const [mx, my, mw, mh] = rectPx(mv);
		ctx.globalAlpha = 0.35;
		ctx.fillStyle = '#3ccf7a';
		ctx.fillRect(mx, my, mw, mh);
		ctx.globalAlpha = 1;
		arrowPx(c, v.target, '#3ccf7a', now);
		return;
	}
	if (v.kind === 'proximity') {
		const rv = D?.report.violations.find(x => x.rule === v.rule && x.msg === v.msg);
		if (rv?.at)
			drawLoop(rv, now);
		else if (part && v.at)
			arrowPx(rc(part.rect), v.at, SEVC[v.sev], now);
		return;
	}
	if (v.kind === 'antenna' && part && !v.zone) {
		const c = rc(part.rect);
		const bb = L!.bbox;
		const cand: Pt[] = [[bb[0], c[1]], [bb[2], c[1]], [c[0], bb[1]], [c[0], bb[3]]];
		const tgt = cand.sort((a, b) => dist(a, c) - dist(b, c))[0];
		arrowPx(c, tgt, '#3ccf7a', now);
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
	if (lmode && L) {
		let best = -1;
		let bd0 = 14;
		L.issues.forEach((v, i) => {
			if (!v.at || !sevOn.has(v.sev))
				return;
			const d = Math.hypot(X(v.at[0]) - px, Y(v.at[1]) - py);
			if (d < bd0) {
				bd0 = d;
				best = i;
			}
		});
		if (best >= 0)
			selectLayoutIssue(best);
		return;
	}
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
	if (D.gate?.route?.length)
		html += `<div class="warnbox">设计确认 G0–G4 未放行：只能查看和预览，不能写回修复。布线前请在“设计确认”页逐级确认。</div>`;
	html += '<div class="act" style="margin:0 0 10px"><button id="recG5">记录为 G6 依据</button></div>';
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
	const rec = document.getElementById('recG5');
	if (rec) {
		rec.onclick = async () => {
			BR = await rpc('routeRecord');
			renderBrief();
			updateGateChip();
			caption(`已记录布线得分 ${D?.report.score} 为 G6 依据；DRC 错误数和截图在“设计确认”页填写`);
			setTimeout(() => caption(null), 2600);
		};
	}
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
const ISSUE: Record<string, string> = { right: '直角拐角', angle: '任意角度', exit: '斜出焊盘', acute: '锐角', tee: '锐角分支', short: '短线段', jog: '抖动', stub: '悬空线头', overlap: '重叠线段', connectivity: '会改变连通', degenerate: '退化' };
const issueText = (xs: string[]) => xs.map(x => ISSUE[x] ?? x).join('、');
function renderFix(): void {
	const pane = $('p-fix');
	if (!plan) {
		pane.innerHTML = '<div class="empty">点“修复预览”计算修复方案。只修几何（任意角度、锐角、抖动、斜出焊盘、悬空线头、重叠线段），不改过孔和连接关系。</div>';
		return;
	}
	const nAdd = plan.changes.reduce((s, c) => s + c.add.length, 0);
	const nRm = plan.changes.reduce((s, c) => s + c.remove.length, 0);
	const gateMiss: string[] = (plan as any).gate ?? [];
	let html = gateMiss.length ? `<div class="warnbox">设计确认未放行，现在只能预览：${gateMiss.map(esc).join('；')}</div>` : '';
	html += `<div class="group"><h4><span>可自动修复 ${plan.fixed.length} 处（${plan.changes.length} 个网络，删 ${nRm} 段 / 建 ${nAdd} 段）</span></h4>`;
	html += plan.fixed.map(it => `<div class="item"><div class="row"><span class="sev P3">${esc(it.how === 'remove' ? '删除' : it.how === 'merge' ? '合并' : it.how === 'chamfer' ? '斜切' : '重建')}</span><span class="rule">${esc(it.net)} · L${it.layer + 1}</span></div><div class="msg">${esc(issueText(it.issues))}</div></div>`).join('');
	html += '</div>';
	if (plan.manual.length) {
		html += `<div class="group"><h4><span>需要人工处理 ${plan.manual.length} 处</span></h4>`;
		html += plan.manual.map(m => `<div class="item"><div class="row"><span class="sev P2">人工</span><span class="rule">${esc(m.net)}</span></div><div class="msg">${esc(issueText(m.issues))}：${esc(m.reason)}</div></div>`).join('');
		html += '</div>';
	}
	html += '<div class="note">画布上红色虚线是原走线，绿色是修复后的走线；黄框是修不了的位置。应用后请在嘉立创 EDA 里重新铺铜并跑一次 DRC。</div>';
	pane.innerHTML = html;
}
// ------------------------------------------------------------------ 设计确认与布局
function getPath(d: any, path: string): any {
	return path.split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), d);
}
const STATE_TXT: Record<string, string> = { missing: '缺信息', blocked: '等前一级', pending: '待确认', confirmed: '已确认', stale: '已失效' };
function updateGateChip(): void {
	if (!BR)
		return;
	const chip = $('gateChip');
	const n = BR.status.gates.filter(g => g.state === 'confirmed').length;
	const open = !BR.status.stages.route.length;
	chip.textContent = `设计确认 ${n}/${BR.status.gates.length}${open ? ' · 可布线' : ''}`;
	chip.className = `gatechip ${open ? 'open' : 'closed'}`;
	chip.title = open ? '设计确认 G0–G4 已放行，可以写回修复' : `写回修复前还需确认：\n${BR.status.stages.route.join('\n')}`;
	($('btnApply') as HTMLButtonElement).title = open ? '' : '设计确认 G0–G4 未放行，不能写回';
}
function renderBrief(): void {
	const pane = $('p-brief');
	if (!BR) {
		pane.innerHTML = '<div class="empty">读取设计确认…</div>';
		return;
	}
	const st = BR.status;
	const stg = (k: string, name: string): string => `<span class="${st.stages[k].length ? 'no' : 'ok'}">${st.stages[k].length ? '✗' : '✓'} ${name}</span>`;
	let html = '<div class="note" style="margin:0 0 8px">布局布线前必须由设计者逐级给出并确认这些信息：需求、外壳与固定件、功能分区（看过布局截图）、布局检查、布线规划。每一级核对无误后手动输入确认码；改了前面的内容，后面的确认自动失效。AI 助手只能帮你填写，不能替你确认。能力边界：检查图、改图，以及按你点名的网络逐批布线；不做完全自由的全局自动布线。</div>';
	html += `<div class="stages">${stg('place', '可以摆放器件（G0–G1）')}${stg('route', '可以布线、写回修复（G0–G4）')}${stg('finish', '可以导出 Gerber（G0–G5）')}${stg('deliver', '可以宣布完成（G0–G6）')}</div>`;
	for (const g of st.gates) {
		const open = openGate === g.gate;
		html += `<div class="gate${open ? ' open' : ''}" data-g="${g.gate}"><div class="gh"><span class="st ${g.state}">${STATE_TXT[g.state]}</span><b>${g.gate} ${esc(g.title)}</b><span class="rule">${open ? '收起' : '展开'}</span></div><div class="gb">`;
		if (g.state === 'missing')
			html += `<ul class="miss">${g.detail.map(m => `<li>${esc(m)}</li>`).join('')}</ul>`;
		if (g.state === 'blocked')
			html += `<div class="note">${esc(g.detail[0])}</div>`;
		if (g.gate === 'G3')
			html += '<div class="note">在“布局”页检查，没有 P0 时点“记录为 G3 依据”。</div>';
		if (g.gate === 'G5')
			html += '<div class="note">在“丝印”页逐项回答问题，检查后点“检查并记录为 G5 依据”。</div>';
		if (g.gate === 'G6')
			html += '<div class="note">在“结论”页点“记录为 G6 依据”，再填 DRC 错误数和截图。</div>';
		if (g.gate === 'G4')
			html += tierHtml();
		for (const f of fields(g.gate as Gate)) {
			if (f.path === 'G4_routing_plan.priorities')
				continue; // 布线优先级用上面的逐档卡片编辑
			const v = getPath(BR.brief, f.path);
			if (f.kind === 'list')
				html += `<label>${esc(f.label)}</label><textarea rows="4" data-f="${esc(f.path)}" data-k="list" placeholder="${esc(f.hint ?? '')}">${esc(Array.isArray(v) || (v && typeof v === 'object') ? JSON.stringify(v, null, 1) : (v ?? ''))}</textarea>`;
			else
				html += `<label>${esc(f.label)}</label><input data-f="${esc(f.path)}" data-k="${f.kind}" value="${esc(v ?? '')}" />`;
		}
		html += `<div class="act"><button data-save="${g.gate}">保存这一级</button></div>`;
		if (g.state === 'pending' || g.state === 'stale')
			html += `<div class="note">请逐项核对下面的摘要。全部正确时，手动输入确认码 <span class="code">${esc(g.code)}</span>：</div><pre>${esc(BR.summaries[g.gate])}</pre><div class="act"><input data-typed="${g.gate}" placeholder="输入 ${esc(g.code)}" autocomplete="off" /><button class="primary" data-confirm="${g.gate}">确认</button></div>`;
		if (g.state === 'confirmed') {
			const c = BR.brief.confirmations?.[g.gate] ?? {};
			html += `<div class="okbox">已确认 ${esc(c.code)} · ${esc(c.at ?? '')}</div>`;
		}
		html += '</div></div>';
	}
	html += `<details><summary>导入 / 导出 design-brief.json</summary><textarea id="briefJson" rows="8">${esc(JSON.stringify(BR.brief, null, 1))}</textarea><div class="act"><button id="briefImport">用上面的内容覆盖</button></div><div class="note">可以粘贴命令行 scripts/design_gate.py 生成的文件。导入后确认记录清空，每一级都要在这里重新确认。</div></details>`;
	pane.innerHTML = html;
	pane.querySelectorAll<HTMLElement>('.gh').forEach((el) => {
		el.onclick = () => {
			const g = el.parentElement!.dataset.g as Gate;
			openGate = openGate === g ? null : g;
			renderBrief();
		};
	});
	pane.querySelectorAll<HTMLElement>('[data-save]').forEach((b) => {
		b.onclick = async () => {
			const box = b.closest('.gate')!;
			const set: Record<string, any> = {};
			for (const el of Array.from(box.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('[data-f]'))) {
				const raw = el.value.trim();
				const k = el.dataset.k;
				if (k === 'number') {
					set[el.dataset.f!] = raw !== '' && Number.isFinite(Number(raw)) ? Number(raw) : raw;
				}
				else if (k === 'list') {
					if (raw === '' || raw === '无' || raw.startsWith('待填')) {
						set[el.dataset.f!] = raw;
						continue;
					}
					try {
						set[el.dataset.f!] = JSON.parse(raw);
					}
					catch {
						caption(`“${el.previousElementSibling?.textContent}”不是合法的 JSON 列表；确实没有就写 无`);
						return;
					}
				}
				else {
					set[el.dataset.f!] = raw;
				}
			}
			try {
				BR = await rpc('briefUpdate', { set });
				renderBrief();
				updateGateChip();
				caption('已保存；内容有变化的级别需要重新确认');
				setTimeout(() => caption(null), 1800);
			}
			catch (e: any) {
				caption(`保存失败：${e?.message ?? e}`);
			}
		};
	});
	pane.querySelectorAll<HTMLElement>('[data-confirm]').forEach((b) => {
		b.onclick = async () => {
			const g = b.dataset.confirm!;
			const typed = (pane.querySelector(`[data-typed="${g}"]`) as HTMLInputElement).value;
			try {
				const r = await rpc('briefConfirm', { gate: g, typed });
				BR = r.status ? r : BR;
				if (!r.cancelled)
					openGate = (GATES[GATES.indexOf(g as Gate) + 1] ?? null) as Gate | null;
				renderBrief();
				updateGateChip();
			}
			catch (e: any) {
				caption(`不能确认：${e?.message ?? e}`);
			}
		};
	});
	bindTiers(pane);
	const imp = document.getElementById('briefImport');
	if (imp) {
		imp.onclick = async () => {
			try {
				const obj = JSON.parse(($('briefJson') as HTMLTextAreaElement).value);
				BR = await rpc('briefUpdate', { brief: obj, reset: true });
				renderBrief();
				updateGateChip();
			}
			catch (e: any) {
				caption(`导入失败：${e?.message ?? e}`);
			}
		};
	}
}
const TSTATE: Record<string, string> = { confirmed: '已确认', pending: '待确认', blocked: '等前一档', stale: '已失效' };
function tierHtml(): string {
	const list: any[] = Array.isArray(BR?.brief?.G4_routing_plan?.priorities) ? BR!.brief.G4_routing_plan.priorities : [];
	let h = '<div class="tiers"><label>布线优先级：按板子的功能梳理，逐档确认</label><div class="act"><button data-pdraft="0">从板子梳理</button><button data-pdraft="1">让 AI 结合功能梳理</button></div>';
	if (!list.length)
		return `${h}<div class="note">还没有优先级。点“从板子梳理”，按网络名、连接的器件和网络类分成 1…9 档，每档写明理由和走法；再逐档核对、确认。</div></div>`;
	const sts = new Map((BR!.tiers ?? []).map(t => [String(t.tier), t]));
	for (const t of list) {
		const st = sts.get(String(t.tier));
		const state = st?.state ?? 'pending';
		const col = TIERC[t.tier] ?? '#9fb3c8';
		const on = tierFocus?.tier === t.tier;
		h += `<div class="tiercard${on ? ' on' : ''}" data-tier="${t.tier}" style="border-left-color:${col}"><div class="row"><b style="color:${col}">第 ${t.tier} 档 · ${esc(t.name ?? '')}</b><span class="st ${state === 'stale' ? 'stale' : state}">${TSTATE[state]}</span></div>`;
		h += `<div class="nets">${(t.nets ?? []).map((n: string) => `<span title="${esc(t.notes?.[n] ?? '')}">${esc(n)}</span>`).join('')}</div>`;
		h += `<div class="note">${esc(t.why ?? '')}</div>`;
		if (on && t.notes)
			h += `<ul class="tnotes">${Object.entries(t.notes).map(([n, w]) => `<li><b>${esc(n)}</b>：${esc(w)}</li>`).join('')}</ul>`;
		h += `<div class="row trow"><select data-tmethod="${t.tier}">${['手工', '工具辅助', '铺铜'].map(m => `<option${m === t.method ? ' selected' : ''}>${m}</option>`).join('')}</select><input data-trules="${t.tier}" value="${esc(t.rules ?? '')}" /></div>`;
		h += `<div class="act"><button data-tsave="${t.tier}">保存</button><button class="primary" data-tconfirm="${t.tier}"${state === 'pending' || state === 'stale' ? '' : ' disabled'}>确认第 ${t.tier} 档</button>${st?.state === 'confirmed' ? `<span class="code">${esc(st.code)}</span>` : ''}</div></div>`;
	}
	return `${h}<div class="note">点一档可以在板子上看这一档的网络。档位确认码由这一档和前面所有档的内容算出，挪动网络或改走法后，从这一档往后要重新确认。</div></div>`;
}
function focusTier(tier: number | null): void {
	const list: any[] = BR?.brief?.G4_routing_plan?.priorities ?? [];
	const t = list.find((x: any) => x.tier === tier);
	if (!t || !D) {
		tierFocus = null;
		caption(null);
		return;
	}
	lmode = false;
	selNet = null;
	selV = null;
	tierFocus = { tier: t.tier, nets: new Set(t.nets ?? []), t0: performance.now() };
	fit();
	setTimeout(() => document.querySelector(`.tiercard[data-tier="${t.tier}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }), 30);
	caption(`第 ${t.tier} 档 · ${t.name}：${(t.nets ?? []).join('、')} —— ${t.why ?? ''}`);
}
function bindTiers(pane: HTMLElement): void {
	pane.querySelectorAll<HTMLElement>('[data-pdraft]').forEach((b) => {
		b.onclick = async () => {
			b.innerHTML = '<span class="spinner"></span>梳理中';
			try {
				const r = await rpc('priorityDraft', { write: true, ai: b.dataset.pdraft === '1' });
				BR = r.brief;
				openGate = 'G4';
				renderBrief();
				updateGateChip();
				focusTier(r.tiers[0]?.tier ?? null);
				caption(`${r.note}：共 ${r.tiers.length} 档，请从第 ${r.tiers[0]?.tier} 档开始逐档核对`);
			}
			catch (e: any) {
				caption(`梳理失败：${e?.message ?? e}`);
				renderBrief();
			}
		};
	});
	pane.querySelectorAll<HTMLElement>('.tiercard').forEach((el) => {
		el.onclick = (e) => {
			const tag = (e.target as HTMLElement).tagName;
			if (['BUTTON', 'SELECT', 'INPUT', 'OPTION'].includes(tag))
				return;
			focusTier(Number(el.dataset.tier));
			renderBrief();
		};
	});
	pane.querySelectorAll<HTMLElement>('[data-tsave]').forEach((b) => {
		b.onclick = async () => {
			const tier = Number(b.dataset.tsave);
			const list = JSON.parse(JSON.stringify(BR!.brief.G4_routing_plan.priorities));
			const t = list.find((x: any) => x.tier === tier);
			t.method = (pane.querySelector(`[data-tmethod="${tier}"]`) as HTMLSelectElement).value;
			t.rules = (pane.querySelector(`[data-trules="${tier}"]`) as HTMLInputElement).value;
			BR = await rpc('briefUpdate', { set: { 'G4_routing_plan.priorities': list } });
			renderBrief();
			updateGateChip();
		};
	});
	pane.querySelectorAll<HTMLElement>('[data-tconfirm]').forEach((b) => {
		b.onclick = async () => {
			const tier = Number(b.dataset.tconfirm);
			try {
				BR = await rpc('tierConfirm', { tier });
				const list: any[] = BR!.brief.G4_routing_plan.priorities;
				const next = list[list.findIndex((x: any) => x.tier === tier) + 1];
				focusTier(next ? next.tier : null);
				if (!next)
					caption('所有档位都已确认，可以整体确认 G4');
				renderBrief();
				updateGateChip();
			}
			catch (e: any) {
				caption(`不能确认：${e?.message ?? e}`);
			}
		};
	});
}
function renderLayout(): void {
	const pane = $('p-layout');
	if (!L)
		return;
	let html = '';
	if (L.note)
		html += `<div class="warnbox">${esc(L.note)}</div>`;
	else if (L.brief_complete && Object.values(L.brief_complete).includes(false))
		html += `<div class="warnbox">设计确认 G0–G2 还没填完（${Object.entries(L.brief_complete).filter(([, v]) => !v).map(([g]) => g).join('、')}）：固定件、分区检查不完整。</div>`;
	html += `<div class="group"><h4><span>P0 ${L.p0} · P1 ${L.p1} · P2 ${L.p2} · P3 ${L.p3}</span><span>${L.pass ? '无 P0' : '有 P0，先改布局'}</span></h4>`;
	html += `<div>${L.blocks.map(b => `<span class="blk"><i style="background:${BLOCKC[b.color % BLOCKC.length]}"></i>${esc(b.name)}</span>`).join('')}</div>`;
	html += `<div class="act"><button id="lRecord"${L.p0 ? ' disabled title="有 P0 不能作为 G3 依据"' : ''}>记录为 G3 依据</button><button id="lReplay">重放动画</button></div></div>`;
	const bySev = ['P0', 'P1', 'P2', 'P3'];
	for (const sv of bySev) {
		const idx = L.issues.map((v, i) => [v, i] as [LayoutIssue, number]).filter(([v]) => v.sev === sv && sevOn.has(v.sev));
		if (!idx.length)
			continue;
		html += `<div class="group"><h4><span>${sv}</span><span>${idx.length}</span></h4>`;
		for (const [v, i] of idx)
			html += `<div class="item${i === selL ? ' sel' : ''}" data-l="${i}"><div class="row"><span class="sev ${v.sev}">${v.sev}</span><span class="rule">${esc(v.rule)}${v.refs.length ? ` · ${esc(v.refs.join('、'))}` : ''}</span></div><div class="msg">${esc(v.msg)}</div>${v.fix ? `<div class="note" style="margin-top:3px">${esc(v.fix)}</div>` : ''}</div>`;
		html += '</div>';
	}
	if (!L.issues.length)
		html += '<div class="empty">没有发现布局问题</div>';
	pane.innerHTML = html;
	pane.querySelectorAll<HTMLElement>('[data-l]').forEach((el) => {
		el.onclick = () => selectLayoutIssue(Number(el.dataset.l));
	});
	$('lReplay').onclick = () => {
		layoutT0 = performance.now();
		selL = null;
		fit();
	};
	$('lRecord').onclick = () => runLayout(true);
}
function selectLayoutIssue(i: number): void {
	if (!L)
		return;
	selL = i;
	const v = L.issues[i];
	lmode = true;
	if (v.at)
		zoomTo(v.target ? [(v.at[0] + v.target[0]) / 2, (v.at[1] + v.target[1]) / 2] : v.at, Math.max(view.s, 16));
	caption(`${v.rule}：${v.msg}${v.fix ? ` → ${v.fix}` : ''}`);
	renderLayout();
	document.querySelector(`[data-l="${i}"]`)?.scrollIntoView({ block: 'nearest' });
}

function tab(t: string): void {
	document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('on', (b as HTMLElement).dataset.t === t));
	document.querySelectorAll('.pane').forEach(p => p.classList.toggle('on', p.id === `p-${t}`));
	const wasF = fmode;
	fmode = t === 'finish' && !!F;
	if (wasF !== fmode)
		fit();
	if (t === 'finish' && !F)
		renderFinish();
	if (t === 'layout')
		lmode = !!L;
	else if (['issues', 'metrics', 'order', 'fix'].includes(t))
		lmode = false;
	if (t !== 'brief')
		tierFocus = null;
	if (t === 'brief')
		loadBrief();
}
document.querySelectorAll<HTMLElement>('#tabs button').forEach((b) => {
	b.onclick = () => tab(b.dataset.t!);
});

// ------------------------------------------------------------------ 出图前检查：丝印、位号编号、泪滴
const FGROUP: [string, string][] = [['silk', '丝印'], ['annotation', '位号编号'], ['teardrops', '泪滴']];
function finishBBox(m: FinishModel): [number, number, number, number] {
	const xs: number[] = [];
	const ys: number[] = [];
	for (const [x, y] of m.outline ?? []) xs.push(x), ys.push(y);
	for (const p of m.parts) xs.push(p.rect[0], p.rect[2]), ys.push(p.rect[1], p.rect[3]);
	for (const t of m.texts) xs.push(t.bbox[0], t.bbox[2]), ys.push(t.bbox[1], t.bbox[3]);
	return xs.length ? [Math.min(...xs) - 1, Math.min(...ys) - 1, Math.max(...xs) + 1, Math.max(...ys) + 1] : [0, 0, 10, 10];
}
function drawFinish(now: number): void {
	const m = F!.model;
	const t = (now - finishT0) / 1000;
	if (m.outline?.length)
		poly([...m.outline, m.outline[0]], 1.2 / view.s, '#2a3546');
	for (const p of m.parts) {
		const [a, b, c, d] = rectPx(p.rect);
		ctx.fillStyle = p.side === 'bottom' ? 'rgba(63,143,232,.08)' : 'rgba(160,123,232,.10)';
		ctx.fillRect(a, b, c, d);
		for (const q of p.pads) {
			const [x, y, w, h] = rectPx(q.rect);
			ctx.fillStyle = q.side === 'both' ? 'rgba(217,180,74,.75)' : 'rgba(217,180,74,.5)';
			ctx.fillRect(x, y, w, h);
		}
	}
	for (const j of m.junctions) {
		ctx.fillStyle = j.teardrop ? '#3ccf7a' : 'rgba(255,255,255,.25)';
		ctx.beginPath();
		ctx.arc(X(j.x), Y(j.y), 2.2, 0, Math.PI * 2);
		ctx.fill();
	}
	for (const l of m.lines) line([l.x1, l.y1], [l.x2, l.y2], Math.max(l.w, 0.1), l.side === 'bottom' ? '#7fb2ff' : '#e9eef5', 0.85);
	const reveal = Math.min(1, t / 0.8);
	m.texts.forEach((tx, i) => {
		if (i / Math.max(1, m.texts.length) > reveal)
			return;
		const [x, y, w, h] = rectPx(tx.bbox);
		ctx.globalAlpha = tx.hidden ? 0.25 : 1;
		ctx.strokeStyle = tx.side === 'bottom' ? 'rgba(127,178,255,.6)' : 'rgba(233,238,245,.35)';
		ctx.lineWidth = 1;
		ctx.setLineDash(tx.hidden ? [3, 3] : []);
		ctx.strokeRect(x, y, w, h);
		ctx.setLineDash([]);
		ctx.save();
		ctx.translate(X((tx.bbox[0] + tx.bbox[2]) / 2), Y((tx.bbox[1] + tx.bbox[3]) / 2));
		const deg = tx.rot % 180;
		ctx.rotate(-(deg * Math.PI) / 180 * (flipY ? 1 : -1));
		if (tx.mirror)
			ctx.scale(-1, 1);
		ctx.fillStyle = tx.side === 'bottom' ? '#7fb2ff' : '#e9eef5';
		ctx.font = `${Math.max(7, tx.h * view.s * 0.85)}px system-ui`;
		ctx.textAlign = 'center';
		ctx.textBaseline = 'middle';
		if (tx.rot % 360 >= 180)
			ctx.rotate(Math.PI);
		ctx.fillText(tx.text, 0, 0);
		ctx.restore();
		ctx.globalAlpha = 1;
	});
	if (t < 0.8)
		return;
	const pulse = 0.5 + 0.5 * Math.sin(now / 180);
	F!.report.issues.forEach((v, i) => {
		if (!sevOn.has(v.sev) || (selF !== null && selF !== i))
			return;
		const col = SEVC[v.sev];
		ctx.strokeStyle = col;
		ctx.lineWidth = i === selF ? 2.5 : 1.5;
		ctx.globalAlpha = i === selF ? 1 : 0.35 + 0.4 * pulse;
		if (v.box) {
			const [x, y, w, h] = rectPx(v.box);
			ctx.strokeRect(x - 3, y - 3, w + 6, h + 6);
		}
		else if (v.at) {
			ctx.beginPath();
			ctx.arc(X(v.at[0]), Y(v.at[1]), 6 + 4 * pulse, 0, Math.PI * 2);
			ctx.stroke();
		}
		ctx.globalAlpha = 1;
	});
}
function fqAnswer(path: string): any {
	return getPath(BR?.brief ?? {}, `G5_finish.${path}`);
}
function renderFinish(): void {
	const pane = $('p-finish');
	const b = BR?.brief ?? {};
	let html = '<div class="note">本 skill 的能力边界是检查图、改图：这里检查丝印、位号编号和泪滴，问题由你在 EDA 里改；不做自动布线。</div>';
	const todo = FINISH_QUESTIONS.filter(q => !finishAnswered(b, q)).length;
	html += `<div class="group"><h4><span>出图前要你决定的 ${FINISH_QUESTIONS.length} 件事</span><span>${todo ? `还差 ${todo} 项` : '都已回答'}</span></h4>`;
	for (const [g, zh] of FGROUP) {
		html += `<div class="note" style="margin-top:6px"><b>${zh}</b></div>`;
		for (const q of FINISH_QUESTIONS.filter(x => x.path.startsWith(`${g}.`))) {
			const v = fqAnswer(q.path);
			const ok = finishAnswered(b, q);
			const show = typeof v === 'object' ? JSON.stringify(v) : String(v ?? '');
			html += `<div class="fq" data-path="${q.path}"><div class="q">${ok ? '✓ ' : ''}${esc(q.q)}</div><div class="why">${esc(q.why)}</div>`;
			if (ok)
				html += `<div class="ans">${esc(show)}</div>`;
			if (q.opts.length && !['silk.labels', 'silk.warnings', 'silk.board_marking'].includes(q.path))
				html += `<div class="opts">${q.opts.map(o => `<button data-set="${esc(o)}" class="${v === o ? 'on' : ''}">${esc(o)}</button>`).join('')}</div>`;
			else
				html += `<div class="opts"><input data-in placeholder="${esc(q.rec)}" value="${ok ? esc(show) : ''}" /><button data-save>保存</button></div>`;
			html += `<div class="note">推荐：${esc(q.rec)}</div></div>`;
		}
	}
	html += '</div>';
	html += `<div class="group"><div class="act"><button id="fRun" class="primary">检查</button><button id="fRecord"${F && (F.report.p0 || F.report.unresolved_p1) ? ' disabled title="有 P0 或未处理的 P1，不能作为 G5 依据"' : ''}>检查并记录为 G5 依据</button></div></div>`;
	if (F) {
		const R = F.report;
		html += `<div class="group"><h4><span>P0 ${R.p0} · P1 ${R.p1}（未处理 ${R.unresolved_p1}）· P2 ${R.p2} · P3 ${R.p3}</span><span>${R.pass ? '通过' : '不通过'}</span></h4></div>`;
		if (R.teardrop_source !== 'kicad' || R.silk_graphics_source !== 'full')
			html += `<div class="warnbox">扩展读不到${R.teardrop_source !== 'kicad' ? '泪滴' : ''}${R.teardrop_source !== 'kicad' && R.silk_graphics_source !== 'full' ? '和' : ''}${R.silk_graphics_source !== 'full' ? '封装自带的丝印线（1 脚、极性标记）' : ''}：请在 EDA 里执行泪滴并重新铺铜，对照原理图逐个看极性标记，再回答上面对应的问题。</div>`;
		for (const sv of ['P0', 'P1', 'P2', 'P3']) {
			const idx = R.issues.map((v, i) => [v, i] as const).filter(([v]) => v.sev === sv);
			if (!idx.length)
				continue;
			html += `<div class="group"><h4><span>${sv}</span><span>${idx.length}</span></h4>`;
			for (const [v, i] of idx)
				html += `<div class="item${i === selF ? ' sel' : ''}" data-f="${i}"><div class="row"><span class="sev ${v.sev}">${v.sev}</span><span class="rule">${esc(v.rule)}${v.refs.length ? ` · ${esc(v.refs.join('、'))}` : ''}</span></div><div class="msg">${esc(v.msg)}</div>${v.fix ? `<div class="note" style="margin-top:3px">${esc(v.fix)}</div>` : ''}</div>`;
			html += '</div>';
		}
	}
	pane.innerHTML = html;
	pane.querySelectorAll<HTMLElement>('.fq').forEach((el) => {
		const path = el.dataset.path!;
		el.querySelectorAll<HTMLElement>('[data-set]').forEach((bt) => {
			bt.onclick = () => setFinish(path, bt.dataset.set);
		});
		const inp = el.querySelector<HTMLInputElement>('[data-in]');
		const save = el.querySelector<HTMLElement>('[data-save]');
		if (inp && save) {
			save.onclick = () => {
				const raw = inp.value.trim();
				let v: any = raw;
				if (/^[[{]/.test(raw)) {
					try {
						v = JSON.parse(raw);
					}
					catch {
						caption('格式不对：列表写成 [{"ref":"J1","text":"USB"}]，板名写成 {"name":"板名","version":"V1.0"}');
						return;
					}
				}
				else if (raw !== '' && Number.isFinite(Number(raw))) {
					v = Number(raw);
				}
				setFinish(path, v);
			};
		}
	});
	pane.querySelectorAll<HTMLElement>('[data-f]').forEach((el) => {
		el.onclick = () => selectFinishIssue(Number(el.dataset.f));
	});
	$('fRun').onclick = () => runFinish(false);
	$('fRecord').onclick = () => runFinish(true);
}
async function setFinish(path: string, v: any): Promise<void> {
	try {
		BR = await rpc('briefUpdate', { set: { [`G5_finish.${path}`]: v } });
		renderFinish();
		updateGateChip();
	}
	catch (e: any) {
		caption(`保存失败：${e?.message ?? e}`);
	}
}
function selectFinishIssue(i: number): void {
	if (!F)
		return;
	selF = selF === i ? null : i;
	const v = F.report.issues[i];
	if (selF !== null && (v.box || v.at))
		zoomTo(v.box ? [(v.box[0] + v.box[2]) / 2, (v.box[1] + v.box[3]) / 2] : v.at!, Math.max(view.s, 24));
	caption(`${v.rule}：${v.msg}${v.fix ? ` → ${v.fix}` : ''}`);
	renderFinish();
}
async function runFinish(record: boolean): Promise<void> {
	try {
		const r = await rpc('finishCheck', { record });
		F = { model: r.model, report: r.report, bbox: finishBBox(r.model) };
		BR = r.brief;
		selF = null;
		finishT0 = performance.now();
		tab('finish');
		fmode = true;
		fit();
		renderFinish();
		updateGateChip();
		caption(record ? '已记录为 G5 依据，去“确认”页确认 G5' : `出图前检查：P0 ${F.report.p0} · P1 ${F.report.p1} · P2 ${F.report.p2}`);
		setTimeout(() => caption(null), 2600);
	}
	catch (e: any) {
		caption(`出图前检查失败：${e?.message ?? e}`);
	}
}

// ------------------------------------------------------------------ 动作
async function loadBrief(): Promise<void> {
	try {
		BR = await rpc('briefGet');
		renderBrief();
		renderFinish();
		updateGateChip();
	}
	catch {}
}
async function runLayout(record = false): Promise<void> {
	const btn = $('btnLayout') as HTMLButtonElement;
	btn.disabled = true;
	btn.innerHTML = '<span class="spinner"></span>检查中';
	try {
		if (!D)
			await check();
		const r = await rpc('layoutCheck', { record, yUp: flipY });
		L = r.layout;
		BR = r.brief;
		if (D) {
			D.board = r.board;
			D.bbox = r.bbox;
		}
		selL = null;
		lmode = true;
		layoutT0 = performance.now();
		mode = 'idle';
		fit();
		tab('layout');
		renderLayout();
		renderBrief();
		updateGateChip();
		caption(record ? '已记录为 G3 依据，去“设计确认”页确认 G3' : `布局检查：P0 ${L!.p0} · P1 ${L!.p1} · P2 ${L!.p2}，点列表里的问题看动画`);
		setTimeout(() => caption(null), 2600);
	}
	catch (e: any) {
		caption(`布局检查失败：${e?.message ?? e}`);
	}
	finally {
		btn.disabled = false;
		btn.textContent = '布局检查';
	}
}
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
		if ((plan as any)?.gate?.length)
			caption('修复预览可以看，写回需要先完成设计确认 G0–G4');
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
	if (BR && BR.status.stages.route.length) {
		caption('设计确认 G0–G4 还没放行：先在“设计确认”页逐级确认，再写回修复');
		tab('brief');
		return;
	}
	btn.disabled = true;
	try {
		const r = await rpc('fixApply', { confirmed: false });
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
$('btnLayout').onclick = () => runLayout(false);
$('gateChip').onclick = () => tab('brief');
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
	tag.innerHTML = '演示 · <a href="#" id="swDemo" style="color:inherit">重置</a>';
	$('swDemo').onclick = (e) => {
		e.preventDefault();
		demoBoard = clone((demo as any)[demoKey]);
		demoBriefs[demoKey] = clone(demoBrief);
		L = null;
		lmode = false;
		check().then(loadBrief);
	};
}
window.addEventListener('resize', () => {
	resize();
	fit();
});
resize();
requestAnimationFrame(frame);
loadAi();
check().then(loadBrief);
(window as any).__lpiot = { runFinish, selectFinishIssue, setFinish, get finish() { return F; }, get layout() { return L; }, get brief() { return BR; }, runLayout, selectLayoutIssue, tab, get data() { return D; }, get plan() { return plan; }, selectNet, selectViolation, playOrder, fixPreview, check, rpc, get mode() { return mode; } };
