/**
 * 布线检查与评分（与 low-power-iot-hardware-design/scripts/route_lint.py 同一套规则）。
 * 规则：RTG（几何）、RTW（线宽）、RTL（线长）、RTV（过孔）、RTS（间距）、RTY（层）；评分 VF-16…30。
 */
import type { Pad, Pt, Seg } from './geom';
import type { Chain } from './graph';
import type { Board, ClassRule, Constraints, Net, Violation } from './model';
import { angleBetween, dist, hypot, isOcti, mean, octiDev, octMst, padAxis, pointInPoly, pstdev, ptInPad, ptSeg, round, segLen, SIN1, TURN_TOL } from './geom';
import { Graph } from './graph';
import { classRules, inferClass, mergeCons } from './model';
import { analyzePrinciples, pairNames } from './principles';

export const SEV_ORDER: Record<string, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };

export const WEIGHTS: Record<string, number> = { 'VF-16': 15, 'VF-17': 10, 'VF-18': 8, 'VF-19': 8, 'VF-20': 10, 'VF-21': 12, 'VF-22': 8, 'VF-23': 7, 'VF-24': 6, 'VF-25': 6, 'VF-26': 10, 'VF-28': 8, 'VF-29': 8, 'VF-30': 6 };
export const NAMES: Record<string, string> = { 'VF-16': '任意角度', 'VF-17': '锐角', 'VF-18': '短段、抖动与出线', 'VF-19': '多余拐弯', 'VF-20': '过孔', 'VF-21': '地平面完整性', 'VF-22': '绕行率', 'VF-23': '成束整齐度', 'VF-24': '层方向与层使用', 'VF-25': '走线密度均匀性', 'VF-26': '网络类约束', 'VF-28': '差分对', 'VF-29': '就近', 'VF-30': '优先级与隔离' };
const METRIC_OF: Record<string, string> = { 'RTG-01': 'VF-16', 'RTG-10': 'VF-16', 'RTG-02': 'VF-17', 'RTG-03': 'VF-17', 'RTG-05': 'VF-18', 'RTG-06': 'VF-18', 'RTG-07': 'VF-18', 'RTG-09': 'VF-18', 'RTG-12': 'VF-18', 'RTV-01': 'VF-20', 'RTV-05': 'VF-20', 'RTY-04': 'VF-21', 'RTY-05': 'VF-21', 'RTL-01': 'VF-22', 'RTL-02': 'VF-22', 'RTS-03': 'VF-23', 'RTY-02': 'VF-24', 'RTL-11': 'VF-24' };

export class Ctx {
	cons: Constraints;
	out: Violation[] = [];
	exempt: { rules: Set<string>; poly: Pt[] }[] = [];
	constructor(cons?: Partial<Constraints> | null) {
		this.cons = mergeCons(cons);
		for (const z of this.cons.exempt_zones ?? []) {
			if (z.poly?.length)
				this.exempt.push({ rules: new Set(z.rules ?? []), poly: z.poly });
		}
	}

	add(rule: string, sev: Violation['sev'], net: string | null, layer: number | null, at: Pt | null, msg: string, value?: unknown, metric?: string, ids?: string[]): void {
		if (at && this.exempt.some(z => z.rules.has(rule) && pointInPoly(at[0], at[1], z.poly)))
			return;
		const v: Violation = { rule, sev, net, layer, msg };
		if (at)
			v.at = [round(at[0], 3), round(at[1], 3)];
		if (value !== undefined && value !== null)
			v.value = value;
		if (metric)
			v.metric = metric;
		if (ids?.length)
			v.ids = ids.filter(Boolean);
		this.out.push(v);
	}
}

export interface Stats { angle: number; acute: number; short: number; jog: number; exit: number; wchange: number; stub: number; segs: number; bends: number; excess: number[] }

function f1(x: number, n = 1): string {
	return x.toFixed(n);
}

function idsOf(segs: Seg[], g: Graph, edges: number[]): string[] {
	return [...new Set(edges.map(k => segs[g.edges[k].src]?.[7]).filter(Boolean) as string[])];
}

function padAlignedExit(g: Graph, e: { ka: string; kb: string }, dx: number, dy: number): boolean {
	for (const key of [e.ka, e.kb]) {
		const p = g.node(key).pad;
		if (!p)
			continue;
		const [ux, uy] = padAxis(p);
		if (isOcti(ux, uy, 1e-6))
			continue;
		const L = hypot(dx, dy);
		if (L <= 1.5 && ([[ux, uy], [-uy, ux]] as Pt[]).some(([ax, ay]) => Math.abs(dx * ay - dy * ax) / L <= SIN1))
			return true;
	}
	return false;
}

/** 单个网络单层上的几何规则 */
export function checkGraph(ctx: Ctx, g: Graph, segs: Seg[], net: string, _cls: string, rules: ClassRule, stats: Stats): void {
	const geo = ctx.cons.geometry;
	const tol = (geo.angle_tol_um ?? 1) / 1000;
	const L = g.layer;
	for (const c of g.chains) {
		if (c.arc && !rules.allow_arc)
			ctx.add('RTG-10', 'P2', net, L, c.pts[Math.floor(c.pts.length / 2)], '圆弧走线没有声明豁免区（只限射频、柔性弯折区、高压区）', undefined, undefined, idsOf(segs, g, c.edges));
	}
	g.edges.forEach((e, k) => {
		if (e.arc)
			return;
		const dx = e.b[0] - e.a[0];
		const dy = e.b[1] - e.a[1];
		const [lat, deg] = octiDev(dx, dy);
		if (lat > tol) {
			if (padAlignedExit(g, e, dx, dy))
				return;
			ctx.add('RTG-01', 'P1', net, L, [(e.a[0] + e.b[0]) / 2, (e.a[1] + e.b[1]) / 2], `任意角度线段：偏离 45° 倍数 ${f1(deg)}°、长 ${f1(hypot(dx, dy), 2)} mm`, round(deg, 2), undefined, idsOf(segs, g, [k]));
			stats.angle++;
		}
	});
	for (const [key, nd] of g.nodes) {
		if (nd.e.length < 2 || nd.pad || nd.via || nd.arc)
			continue;
		const dirs = nd.e.map((k) => {
			const v = g.vec(k, key);
			return (((Math.atan2(v[1], v[0]) * 180) / Math.PI) % 360 + 360) % 360;
		}).sort((a, b) => a - b);
		let gaps = dirs.map((d, i) => (((dirs[(i + 1) % dirs.length] - d) % 360) + 360) % 360);
		if (dirs.length === 2)
			gaps = [Math.min(...gaps)];
		const m = Math.min(...gaps);
		if (m < 90 - TURN_TOL) {
			const w = Math.min(...nd.e.map(k => g.edges[k].w));
			const rule = dirs.length === 2 ? 'RTG-02' : 'RTG-03';
			ctx.add(rule, w <= 0.15 + 1e-9 ? 'P0' : 'P1', net, L, nd.p, `${rule === 'RTG-02' ? '锐角拐角' : '锐角 T 分支'}：夹角 ${m.toFixed(0)}°（线宽 ${w} mm）`, round(m, 1), undefined, idsOf(segs, g, nd.e));
			stats.acute++;
		}
	}
	const kw = geo.min_seg.k_w;
	const absmin = geo.min_seg.abs_mm;
	for (const c of g.chains) {
		if (c.arc)
			continue;
		const { pts, w } = c;
		stats.segs += pts.length - 1;
		for (let i = 0; i < pts.length - 1; i++) {
			const Ls = dist(pts[i], pts[i + 1]);
			const nearAnchor = (i === 0 && g.node(c.keys[0]).anchor) || (i === pts.length - 2 && g.node(c.keys[c.keys.length - 1]).anchor);
			const lim = nearAnchor ? (geo.fanout_k_w ?? 0.5) * w : Math.max(kw * w, absmin);
			if (Ls > 1e-6 && Ls < lim - 1e-9 && pts.length > 2) {
				ctx.add('RTG-05', 'P2', net, L, pts[i], `短线段 ${Ls.toFixed(3)} mm（下限 ${lim.toFixed(3)} mm）`, round(Ls, 3), undefined, idsOf(segs, g, [c.edges[i]]));
				stats.short++;
			}
		}
		const turns: [number, Pt][] = [];
		let cum = 0;
		let turnSum = 0;
		for (let i = 1; i < pts.length - 1; i++) {
			cum += dist(pts[i - 1], pts[i]);
			const t = angleBetween([pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]], [pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]]);
			if (t > 1) {
				turns.push([cum, pts[i]]);
				turnSum += Math.min(t, 180) / 90;
			}
		}
		stats.bends += turns.length;
		const A = pts[0];
		const B = pts[pts.length - 1];
		let need = isOcti(B[0] - A[0], B[1] - A[1]) ? 0 : 0.5;
		for (const key of [c.keys[0], c.keys[c.keys.length - 1]]) {
			const p = g.node(key).pad;
			if (p && p.w && p.shape !== 'circle' && dist(A, B) > 1e-6) {
				const d: Pt = key === c.keys[0] ? [B[0] - A[0], B[1] - A[1]] : [A[0] - B[0], A[1] - B[1]];
				const [ux, uy] = padAxis(p);
				if (!([[ux, uy], [-uy, ux]] as Pt[]).some(([ax, ay]) => Math.abs(d[0] * ay - d[1] * ax) / hypot(d[0], d[1]) <= SIN1))
					need += 0.5;
			}
		}
		stats.excess.push(Math.max(0, turnSum - need));
		const jogk = geo.jog_k_w ?? 2;
		let flagged = false;
		for (let i = 0; i < pts.length - 3; i++) {
			const [a0, a1, b0, b1] = [pts[i], pts[i + 1], pts[i + 2], pts[i + 3]];
			const u: Pt = [a1[0] - a0[0], a1[1] - a0[1]];
			const v: Pt = [b1[0] - b0[0], b1[1] - b0[1]];
			if (angleBetween(u, v) < 1 && hypot(u[0], u[1]) > 1e-6) {
				const off = ptSeg(b0[0], b0[1], a0[0] - 1e3 * u[0], a0[1] - 1e3 * u[1], a0[0] + 1e3 * u[0], a0[1] + 1e3 * u[1]);
				if (off > 1e-4 && off < jogk * w) {
					ctx.add('RTG-06', 'P2', net, L, a1, `Z 形微折：横向只错开 ${off.toFixed(3)} mm`, round(off, 3), undefined, idsOf(segs, g, c.edges.slice(i, i + 3)));
					stats.jog++;
					flagged = true;
					break;
				}
			}
		}
		const win = (geo.jitter_window_k_w ?? 5) * w;
		if (!flagged) {
			for (let i = 0; i < turns.length - 2; i++) {
				if (turns[i + 2][0] - turns[i][0] <= win) {
					ctx.add('RTG-06', 'P2', net, L, turns[i][1], `走线抖动：${win.toFixed(2)} mm 内拐了 3 次以上`, undefined, undefined, idsOf(segs, g, c.edges));
					stats.jog++;
					break;
				}
			}
		}
		for (const end of [0, -1]) {
			const nd = g.node(end === 0 ? c.keys[0] : c.keys[c.keys.length - 1]);
			const p = nd.pad;
			if (!p || !p.w || p.shape === 'circle' || pts.length < 2)
				continue;
			const [a, b] = end === 0 ? [pts[0], pts[1]] : [pts[pts.length - 1], pts[pts.length - 2]];
			const d: Pt = [b[0] - a[0], b[1] - a[1]];
			const Ld = hypot(d[0], d[1]);
			if (Ld < 1e-6)
				continue;
			const [ux, uy] = padAxis(p);
			let axes: Pt[] = [[ux, uy], [-uy, ux]];
			const ph = p.h ?? p.w;
			const big = Math.max(p.w, ph);
			const small = Math.min(p.w, ph);
			if (big / Math.max(small, 1e-6) >= 1.3)
				axes = p.w >= ph ? [[ux, uy]] : [[-uy, ux]];
			if (!axes.some(([ax, ay]) => Math.abs(d[0] * ay - d[1] * ax) / Ld <= SIN1)) {
				ctx.add('RTG-07', small <= 0.35 ? 'P1' : 'P2', net, L, a, `从焊盘 ${p.ref}.${p.pin} 斜着或沿短轴出线（应沿焊盘长轴直出）`, undefined, undefined, idsOf(segs, g, [end === 0 ? c.edges[0] : c.edges[c.edges.length - 1]]));
				stats.exit++;
			}
		}
	}
	if (!rules._zone) {
		for (const nd of g.nodes.values()) {
			if (nd.e.length === 1 && !nd.pad && !nd.via) {
				ctx.add('RTG-12', 'P2', net, L, nd.p, '悬空线头：走线一端没有接到焊盘、过孔或其他走线（天线式残桩）', undefined, undefined, idsOf(segs, g, nd.e));
				stats.stub++;
			}
		}
	}
	for (const [key, nd] of g.nodes) {
		if (nd.wchange && !nd.pad && !nd.via) {
			let neck = false;
			for (const k of nd.e) {
				const c = g.chains.find(cc => cc.edges.includes(k))!;
				const far = g.node(c.keys[0] === key ? c.keys[c.keys.length - 1] : c.keys[0]);
				if (far.pad && c.len <= 1 + 1e-9)
					neck = true;
			}
			if (!neck) {
				ctx.add('RTG-09', 'P2', net, L, nd.p, '线宽在走线中途变化（只应在焊盘颈缩或分支处变化）', undefined, undefined, idsOf(segs, g, nd.e));
				stats.wchange++;
			}
		}
	}
	if (rules.no_branch) {
		for (const nd of g.nodes.values()) {
			if (nd.e.length >= 3 && !nd.pad)
				ctx.add('RTL-06', 'P0', net, L, nd.p, '射频线分叉', undefined, 'VF-26');
		}
	}
}

export function ramp(v: number | null | undefined, good: number, bad: number): number {
	if (v === null || v === undefined || v <= good)
		return 0;
	if (v >= bad)
		return 1;
	return (v - good) / (bad - good);
}

export interface Metric { name: string; value: unknown; weight: number; deduct: number; level: string; note: string }
export interface NetSummary { net: string; class: string; len: number; vias: number; bends: number }
export interface Report {
	kind: 'routing-report';
	version: 1;
	score: number;
	grade: string;
	pass: boolean;
	metrics: Record<string, Metric>;
	violations: Violation[];
	pairs: { p: string; n: string; class: string }[];
	classes: Record<string, string>;
	confirm: { net: string; class: string; confidence: number; why: string }[];
	nets: NetSummary[];
	stats: Record<string, number>;
}

/** 按命名成对、但被推成 SIG / CLK 的网络改成 DIFF100 */
export function upgradePairs(classes: Record<string, string>, nets: { name: string }[], cons: Constraints | null, conf?: Report['confirm']): void {
	const given = new Set(Object.keys(cons?.nets ?? {}));
	for (const [a, b] of pairNames(nets.map(n => n.name))) {
		for (const x of [a, b]) {
			if (!given.has(x) && ['SIG', 'CLK'].includes(classes[x])) {
				classes[x] = 'DIFF100';
				if (conf) {
					const i = conf.findIndex(c => c.net === x);
					if (i >= 0)
						conf.splice(i, 1);
					conf.push({ net: x, class: 'DIFF100', confidence: 0.75, why: `与 ${x === a ? b : a} 命名成对` });
				}
			}
		}
	}
}

function bundleCheck(ctx: Ctx, nets: Net[]): number | null {
	const bundles = ctx.cons.bundles ?? [];
	if (!bundles.length)
		return null;
	const by = new Map(nets.map(n => [n.name, n]));
	const sds: number[] = [];
	for (const bd of bundles) {
		const segs: [string, Seg][] = [];
		for (const nm of bd.nets ?? []) {
			for (const s of by.get(nm)?.segs ?? []) {
				if (!s[6])
					segs.push([nm, s]);
			}
		}
		const pitches: number[] = [];
		for (const [na, a] of segs) {
			let best: number | null = null;
			for (const [nb, b] of segs) {
				if (nb === na || b[0] !== a[0])
					continue;
				const u: Pt = [a[3] - a[1], a[4] - a[2]];
				const ang = angleBetween(u, [b[3] - b[1], b[4] - b[2]]);
				if (Math.min(ang, 180 - ang) > 1)
					continue;
				const La = hypot(u[0], u[1]);
				if (La < 1)
					continue;
				const ux = u[0] / La;
				const uy = u[1] / La;
				const t1 = (b[1] - a[1]) * ux + (b[2] - a[2]) * uy;
				const t2 = (b[3] - a[1]) * ux + (b[4] - a[2]) * uy;
				const ov = Math.min(La, Math.max(t1, t2)) - Math.max(0, Math.min(t1, t2));
				if (ov < 1)
					continue;
				const d = Math.abs((b[1] - a[1]) * uy - (b[2] - a[2]) * ux);
				best = best === null ? d : Math.min(best, d);
			}
			if (best !== null)
				pitches.push(best);
		}
		if (pitches.length >= 2) {
			let sd = pstdev(pitches);
			if (bd.pitch_mm)
				sd = Math.max(sd, Math.abs(mean(pitches) - bd.pitch_mm));
			sds.push(sd);
			if (sd > 0.05)
				ctx.add('RTS-03', 'P2', bd.id, null, null, `束 ${bd.id} 间距不一致（标准差或偏差 ${sd.toFixed(3)} mm）`, round(sd, 3));
		}
	}
	return sds.length ? Math.max(...sds) : null;
}

function density(nets: Net[], tile = 2.5): [number | null, number] {
	const occ = new Map<string, number>();
	for (const n of nets) {
		for (const s of n.segs) {
			const L = segLen(s);
			const k = Math.max(1, Math.floor(L / 0.5));
			for (let i = 0; i < k; i++) {
				const t = (i + 0.5) / k;
				const x = s[1] + t * (s[3] - s[1]);
				const y = s[2] + t * (s[4] - s[2]);
				const key = `${s[0]},${Math.floor(x / tile)},${Math.floor(y / tile)}`;
				occ.set(key, (occ.get(key) ?? 0) + ((L / k) * s[5]) / (tile * tile));
			}
		}
	}
	const vals = [...occ.values()];
	if (vals.length < 4)
		return [null, 0];
	const mu = mean(vals);
	return [mu > 0 ? pstdev(vals) / mu : null, vals.filter(x => x > 0.6).length];
}

/** 全部布线检查并打分 */
export function analyze(board: Board, consIn?: Partial<Constraints> | null): Report {
	const ctx = new Ctx(consIn);
	const layers = board.layers ?? [];
	const nL = layers.length;
	const nets = board.nets;
	const stats: Stats = { angle: 0, acute: 0, short: 0, jog: 0, exit: 0, wchange: 0, stub: 0, segs: 0, bends: 0, excess: [] };
	const classes: Record<string, string> = {};
	const conf: Report['confirm'] = [];
	for (const n of nets) {
		const given = ctx.cons.nets?.[n.name]?.class;
		if (given) {
			classes[n.name] = given;
		}
		else {
			const [c, p, why] = inferClass(n.name, n.pads);
			classes[n.name] = c;
			if (p < 0.8)
				conf.push({ net: n.name, class: c, confidence: p, why });
		}
	}
	upgradePairs(classes, nets, ctx.cons, conf);
	const gndVias: Pt[] = [];
	for (const n of nets) {
		if (classes[n.name] !== 'GND')
			continue;
		for (const v of n.vias) gndVias.push([v[0], v[1]]);
		for (const p of n.pads) {
			if (p.l === -1)
				gndVias.push([p.x, p.y]);
		}
	}
	const fabMin = ctx.cons.board?.fab_min_track ?? (nL <= 2 ? 0.127 : 0.09);
	const perNet: NetSummary[] = [];
	const critTau: number[] = [];
	const normTau: number[] = [];
	let overBudget = 0;
	const lenByLayer = Array.from<number>({ length: Math.max(nL, 1) }).fill(0);
	const against = new Map<number, [number, number]>();
	const layerDir = new Map<number, 'H' | 'V'>();
	(ctx.cons.layers ?? []).forEach((Ld, i) => {
		const idx = Ld.name && layers.includes(Ld.name) ? layers.indexOf(Ld.name) : (i < nL ? i : null);
		if (idx !== null && (Ld.preferred_dir === 'H' || Ld.preferred_dir === 'V'))
			layerDir.set(idx, Ld.preferred_dir);
	});
	const bottomChains: [string, Chain, string[]][] = [];
	for (const n of nets) {
		const name = n.name;
		const cls = classes[name];
		const rules = classRules(cls, ctx.cons);
		rules._zone = !!n.zone || cls === 'GND';
		const bends0 = stats.bends;
		let routed = 0;
		for (const l of [...new Set(n.segs.map(s => s[0]))].sort((a, b) => a - b)) {
			const segs = n.segs.filter(s => s[0] === l);
			const g = new Graph(segs, n.pads, n.vias, l);
			checkGraph(ctx, g, segs, name, cls, rules, stats);
			for (const c of g.chains) {
				routed += c.len;
				if (l >= 0 && l < lenByLayer.length)
					lenByLayer[l] += c.len;
				if (nL === 2 && l === nL - 1 && !['GND', 'PWR_LOW', 'PWR_MAIN', 'SW'].includes(cls))
					bottomChains.push([name, c, idsOf(segs, g, c.edges)]);
			}
			if (layerDir.has(l) && cls !== 'GND') {
				for (const s of segs) {
					if (s[6])
						continue;
					const dx = Math.abs(s[3] - s[1]);
					const dy = Math.abs(s[4] - s[2]);
					const Ls = hypot(dx, dy);
					const a = against.get(l) ?? [0, 0];
					a[1] += Ls;
					if ((layerDir.get(l) === 'H' && dy > 10 * dx) || (layerDir.get(l) === 'V' && dx > 10 * dy))
						a[0] += Ls;
					against.set(l, a);
				}
			}
		}
		const bends = stats.bends - bends0;
		const mw = rules.min_width;
		if (mw && n.segs.length) {
			let worst: Seg | null = null;
			for (const s of n.segs) {
				if (s[5] < mw - 1e-6) {
					const nearPad = segLen(s) <= 1 && n.pads.some(p => (p.l === -1 || p.l === s[0]) && (ptInPad(s[1], s[2], p) || ptInPad(s[3], s[4], p)));
					if (nearPad && s[5] >= fabMin - 1e-6)
						continue;
					if (!worst || s[5] < worst[5])
						worst = s;
				}
			}
			if (worst) {
				const p0 = worst[5] < fabMin - 1e-6;
				ctx.add(p0 ? 'RTW-09' : 'RTW-01', p0 ? 'P0' : 'P1', name, worst[0], [(worst[1] + worst[3]) / 2, (worst[2] + worst[4]) / 2], `${cls} 线宽 ${round(worst[5], 3)} mm 低于${p0 ? `板厂下限 ${fabMin}` : `网络类下限 ${mw}`} mm`, worst[5], 'VF-26', worst[7] ? [worst[7]] : undefined);
			}
		}
		const vb = rules.via_budget;
		const nv = n.vias.length;
		if (vb !== null && vb !== undefined && nv > vb && n.segs.length) {
			ctx.add('RTV-01', vb === 0 ? 'P0' : 'P2', name, null, [n.vias[0][0], n.vias[0][1]], `${cls} 网络有 ${nv} 个过孔，预算 ${vb}`, nv, undefined, n.vias.map(v => v[3] ?? '').filter(Boolean));
			overBudget++;
		}
		const tauMax = rules.tau_max;
		const direct = octMst(n.pads.map(p => [p.x, p.y] as Pt));
		if (tauMax && direct >= 1 && routed >= 0.5 * direct && !n.zone) {
			const tau = routed / direct;
			(rules.critical ? critTau : normTau).push(tau);
			const lim = direct < 5 && !rules.critical ? 1.6 : tauMax;
			if (tau > lim) {
				const s0 = n.segs.reduce<Seg | null>((m, s) => (!m || segLen(s) > segLen(m) ? s : m), null);
				ctx.add(rules.critical ? 'RTL-02' : 'RTL-01', rules.critical ? 'P1' : 'P2', name, null, s0 ? [(s0[1] + s0[3]) / 2, (s0[2] + s0[4]) / 2] : null, `绕行率 ${tau.toFixed(2)}（走线 ${routed.toFixed(1)} mm，八方向最短 ${direct.toFixed(1)} mm，上限 ${lim}）`, round(tau, 2));
			}
		}
		if (cls === 'XTAL' && n.segs.length) {
			const mx = rules.max_len_mm ?? 5;
			if (routed > mx)
				ctx.add('RTL-03', 'P1', name, null, null, `晶振走线 ${routed.toFixed(1)} mm，超过 ${mx} mm`, round(routed, 2), 'VF-26');
		}
		perNet.push({ net: name, class: cls, len: round(routed, 2), vias: nv, bends });
	}
	const smd: [string, Pad][] = [];
	for (const n of nets) {
		for (const p of n.pads) {
			if (p.l !== -1 && p.w)
				smd.push([n.name, p]);
		}
	}
	for (const n of nets) {
		const cls = classes[n.name];
		for (const v of n.vias) {
			for (const [owner, p] of smd) {
				if (ptInPad(v[0], v[1], p, 0)) {
					if (owner !== n.name)
						ctx.add('RTV-05', 'P0', n.name, p.l, [v[0], v[1]], `过孔压在其他网络 ${owner} 的焊盘 ${p.ref}.${p.pin} 上`, undefined, undefined, v[3] ? [v[3]] : undefined);
					else if ((p.w ?? 0) * (p.h ?? 0) < 2 && !['EP', 'PAD', '0', 'GND', 'THERMAL'].includes(String(p.pin).toUpperCase()))
						ctx.add('RTV-05', 'P1', n.name, p.l, [v[0], v[1]], `盘中孔：过孔在焊盘 ${p.ref}.${p.pin} 内（标准工艺不塞孔会漏锡）`, undefined, undefined, v[3] ? [v[3]] : undefined);
				}
			}
			if (nL >= 4 && !['GND', 'PWR_LOW', 'PWR_MAIN', 'SW'].includes(cls) && n.segs.length) {
				const d = gndVias.length ? Math.min(...gndVias.map(([x, y]) => hypot(v[0] - x, v[1] - y))) : null;
				if (d === null || d > 5.08)
					ctx.add('RTV-02', 'P1', n.name, null, [v[0], v[1]], d !== null ? '换层过孔附近 5.08 mm 内没有地过孔' : '换层过孔附近没有地过孔', d !== null ? round(d, 2) : undefined, 'VF-26', v[3] ? [v[3]] : undefined);
				else if (d > 2)
					ctx.add('RTV-02', 'P2', n.name, null, [v[0], v[1]], `最近的地过孔在 ${d.toFixed(1)} mm 外（建议 2 mm 内）`, round(d, 2), 'VF-26', v[3] ? [v[3]] : undefined);
			}
		}
	}
	if (nL === 2) {
		for (const [name, c, ids] of bottomChains) {
			if (c.len > 10)
				ctx.add('RTL-11', 'P2', name, 1, c.pts[Math.floor(c.pts.length / 2)], `底层信号跳线长 ${c.len.toFixed(1)} mm（2 层板底层应是地平面，单根 ≤ 10 mm）`, round(c.len, 1), undefined, ids);
		}
		const bot = bottomChains.reduce((s, [, c]) => s + c.len, 0);
		const top = lenByLayer[0] ?? 0;
		if (top > 0 && bot > 0.1 * top)
			ctx.add('RTL-11', 'P2', null, 1, null, `底层信号总长 ${bot.toFixed(0)} mm，是顶层的 ${Math.round((bot / top) * 100)}%（上限 10%）`, round(bot / top, 2));
	}
	for (const [l, [a, t]] of against) {
		if (t > 0 && a / t > 0.25)
			ctx.add('RTY-02', 'P2', null, l, null, `L${l + 1}（主方向 ${layerDir.get(l)}）逆向走线占 ${Math.round((a / t) * 100)}%`, round(a / t, 2));
	}
	const planes = board.planes ?? [];
	const roles = new Map<number, string | undefined>();
	(ctx.cons.layers ?? []).forEach((Ld, i) => roles.set(Ld.name && layers.includes(Ld.name) ? layers.indexOf(Ld.name) : i, Ld.role));
	const planeLayer = (l: number) => (roles.size ? roles.get(l) === 'gnd_plane' : (nL === 2 && l === 1) || (nL >= 4 && l > 0 && l < nL - 1));
	const gndLayers = planes.filter(p => planeLayer(p.layer) && (p.gnd_frac ?? 0) >= 0.5);
	const noPlane = nL >= 2 && !gndLayers.length && board.planes !== undefined;
	for (const p of gndLayers) {
		if ((p.frag ?? 0) > 0.1)
			ctx.add('RTY-05', 'P1', null, p.layer, null, `L${p.layer + 1} 地平面破碎度 ${p.frag.toFixed(2)}（被走线切成 ${p.pieces ?? '?'} 块，上限 0.10）`, p.frag);
		if (nL >= 4 && p.layer > 0 && p.layer < nL - 1) {
			const tr = nets.filter(n => classes[n.name] !== 'GND' && n.segs.some(s => s[0] === p.layer)).map(n => n.name);
			if (tr.length)
				ctx.add('RTY-04', 'P0', tr.slice(0, 4).join(', '), p.layer, null, `内层地平面 L${p.layer + 1} 上有其他网络的走线：${tr.slice(0, 4).join(', ')}`);
		}
	}
	const bundleSd = bundleCheck(ctx, nets);
	const values: Record<string, string> = {};
	for (const p of board.parts ?? []) {
		if (p.value)
			values[p.ref] = p.value;
	}
	const pairs = analyzePrinciples(ctx, nets, classes, values, nL, gndLayers.length > 0, Object.fromEntries(perNet.map(p => [p.net, p.len])));
	const [cv, overload] = density(nets);

	// ---------------- 评分
	const v = ctx.out;
	const cnt = (rs: string[]) => v.filter(x => rs.includes(x.rule)).length;
	const m: Record<string, Metric> = {};
	const put = (id: string, value: unknown, frac0: number, note = '') => {
		const w = WEIGHTS[id];
		const frac = Math.max(0, Math.min(1, frac0));
		m[id] = { name: NAMES[id], value, weight: w, deduct: round(w * frac, 1), level: frac === 0 ? '良好' : frac < 0.75 ? '警告' : '不合格', note };
	};
	const n16 = cnt(['RTG-01', 'RTG-10']);
	const n17 = cnt(['RTG-02', 'RTG-03']);
	put('VF-16', n16, n16 === 0 ? 0 : 0.4 + 0.12 * (n16 - 1));
	put('VF-17', n17, n17 === 0 ? 0 : 0.4 + 0.2 * (n17 - 1));
	const per100 = (100 * (stats.short + stats.jog + stats.exit + stats.wchange + stats.stub)) / Math.max(1, stats.segs);
	put('VF-18', round(per100, 2), ramp(per100, 1, 4), '每 100 段的短段、抖动、斜出焊盘、线宽突变与悬空线头数');
	const ex = stats.excess.length ? mean(stats.excess) : null;
	put('VF-19', ex !== null ? round(ex, 2) : null, ex !== null ? ramp(ex, 0.5, 2) : 0, '每段连接的多余转角（45° 记 0.5、90° 记 1，扣除必需转角）的平均值');
	const n20 = overBudget + cnt(['RTV-05', 'RTV-08']);
	put('VF-20', n20, n20 === 0 ? 0 : n20 <= 2 ? 0.5 : 1, '超预算的网络 + 盘中孔 + 裸露焊盘过孔不足');
	if (gndLayers.length) {
		const F = Math.max(...gndLayers.map(p => p.frag ?? 0));
		put('VF-21', round(F, 3), cnt(['RTY-04']) ? 1 : ramp(F, 0.05, 0.15), '最大破碎度 = 1 − 最大连通地铜 / 该层地铜');
	}
	else if (noPlane) {
		put('VF-21', null, 0.5, '该当地平面的层（2 层板底层 / 4 层板内层）地铜覆盖不到一半');
	}
	else {
		put('VF-21', null, 0, '未计算');
	}
	const sortedNorm = [...normTau].sort((a, b) => a - b);
	const p90 = sortedNorm.length ? sortedNorm[Math.floor(0.9 * (sortedNorm.length - 1))] : null;
	const cmax = critTau.length ? Math.max(...critTau) : null;
	put('VF-22', { p90: p90 ? round(p90, 2) : null, critical_max: cmax ? round(cmax, 2) : null }, Math.max(p90 ? ramp(p90, 1.2, 1.4) : 0, cmax ? ramp(cmax, 1.1, 1.2) : 0));
	if (bundleSd !== null)
		put('VF-23', round(bundleSd, 3), ramp(bundleSd, 0.02, 0.08), '束内间距标准差（mm）');
	else put('VF-23', null, 0, '约束里没有定义成束网络');
	const dirs = [...against.values()].filter(([, t]) => t > 0).map(([a, t]) => a / t);
	const worstDir = dirs.length ? Math.max(...dirs) : null;
	const n24 = cnt(['RTL-11']);
	put('VF-24', { against_max: worstDir !== null ? round(worstDir, 2) : null, rtl11: n24 }, Math.max(worstDir !== null ? ramp(worstDir, 0.15, 0.35) : 0, n24 === 0 ? 0 : n24 <= 2 ? 0.5 : 1));
	put('VF-25', { cv: cv !== null ? round(cv, 2) : null, overloaded_tiles: overload }, Math.max(cv !== null ? ramp(cv, 0.8, 1.6) : 0, overload ? 0.5 : 0), '2.5 mm 瓦片走线占用率');
	const crit = v.filter(x => x.metric === 'VF-26' || ['RTL-03', 'RTL-06', 'RTV-02', 'RTW-01', 'RTW-09'].includes(x.rule));
	const p0 = crit.some(x => x.sev === 'P0');
	const p1 = crit.filter(x => x.sev === 'P1').length;
	const p2 = crit.filter(x => x.sev === 'P2').length;
	put('VF-26', { P0: p0 ? 1 : 0, P1: p1, P2: p2 }, p0 || p1 > 2 ? 1 : p1 ? 0.6 : p2 ? 0.3 : 0);
	const sevFrac = (prefix: string, extra: string[] = []): [Record<string, number>, number] => {
		const xs = v.filter(x => x.rule.startsWith(prefix) || extra.includes(x.rule));
		const c: Record<string, number> = { P0: 0, P1: 0, P2: 0, P3: 0 };
		for (const x of xs) c[x.sev]++;
		return [c, c.P0 ? 1 : Math.min(1, 0.5 * c.P1 + 0.2 * c.P2 + 0.05 * c.P3)];
	};
	const [c28, f28] = sevFrac('RTD-');
	put('VF-28', { ...c28, pairs: pairs.length }, f28, pairs.length ? '' : '没有识别到差分对');
	const [c29, f29] = sevFrac('RTP-');
	put('VF-29', c29, f29);
	const [c30, f30] = sevFrac('RTO-', ['RTS-06']);
	put('VF-30', c30, f30);
	for (const x of v) {
		if (!x.metric)
			x.metric = METRIC_OF[x.rule] ?? (crit.includes(x) ? 'VF-26' : undefined);
	}
	const totalW = Object.values(WEIGHTS).reduce((s, w) => s + w, 0);
	const score = round(100 - (100 * Object.values(m).reduce((s, e) => s + e.deduct, 0)) / totalW, 1);
	const hasP0 = v.some(x => x.sev === 'P0');
	const grade = hasP0 ? '不通过（有 P0）' : score >= 90 ? '优秀' : score >= 75 ? '合格' : score >= 60 ? '需返工' : '不合格';
	v.sort((a, b) => SEV_ORDER[a.sev] - SEV_ORDER[b.sev] || a.rule.localeCompare(b.rule) || String(a.net).localeCompare(String(b.net)));
	return {
		kind: 'routing-report',
		version: 1,
		score,
		grade,
		pass: !hasP0,
		metrics: m,
		violations: v,
		pairs,
		classes,
		confirm: conf,
		nets: perNet,
		stats: { angle: stats.angle, acute: stats.acute, short: stats.short, jog: stats.jog, exit: stats.exit, wchange: stats.wchange, stub: stats.stub, segs: stats.segs, bends: stats.bends, excess: stats.excess.length ? round(mean(stats.excess), 3) : 0 },
	};
}

/** 写入前闸门：只看任意角度、锐角、锐角分支 */
export function gate(board: Board, cons?: Partial<Constraints> | null): { pass: boolean; blocks: Violation[] } {
	const rep = analyze(board, cons);
	const blocks = rep.violations.filter(x => ['RTG-01', 'RTG-02', 'RTG-03'].includes(x.rule));
	return { pass: !blocks.length, blocks };
}
