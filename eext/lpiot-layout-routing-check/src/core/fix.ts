/**
 * 几何修复（route_fix.py 的扩展版子集）：合并重叠线段、删除悬空线头、把任意角度 / 锐角 / 抖动 / 斜出焊盘的走线
 * 在原锚点之间重建为直线、肘形或三段式八方向折线。每段提交前检查间距、板框、禁布区和连通关系，不满足就保留原样并标为需要人工处理。
 * 直线、肘形、三段式都不行时在局部窗口跑八方向 A*。不做拓扑修改（过孔、换层、连接关系）；修不了的交给人。
 */
import type { Pad, Pt, S4, Seg } from './geom';
import type { Graph as G } from './graph';
import type { Board, Constraints, Net } from './model';
import { angleBetween, dist, hypot, isOcti, padAxis, padExitDist, pointInPoly, ptInPad, ptSeg, segPad, segSeg, segsIntersect, SIN1, TURN_TOL } from './geom';
import { Graph } from './graph';
import { inferClass, mergeCons, PRIORITY } from './model';

export interface FixItem { net: string; layer: number; from?: Pt; to?: Pt; issues: string[]; how: string; before: Pt[]; after: Pt[] }
export interface FixPlan {
	fixed: FixItem[];
	manual: { net: string; layer?: number; at?: Pt; issues: string[]; reason: string }[];
	/** 每个改动网络：需要删除的原始线段 ID、需要新建的线段 */
	changes: { net: string; remove: string[]; add: Seg[] }[];
}

interface Item { net: string | null; kind: 'seg' | 'pad' | 'via'; layer: number; seg?: S4; pad?: Pad; xy?: Pt; r: number }

class Obstacles {
	items: Item[] = [];
	grid = new Map<string, number[]>();
	constructor(nets: Net[], public outline: Pt[] = [], public keepouts: Pt[][] = [], public cell = 1) {
		for (const n of nets) this.addNet(n);
	}

	private bbox(it: Item): [number, number, number, number] {
		if (it.kind === 'seg') {
			const s = it.seg!;
			return [Math.min(s[0], s[2]) - it.r, Math.min(s[1], s[3]) - it.r, Math.max(s[0], s[2]) + it.r, Math.max(s[1], s[3]) + it.r];
		}
		if (it.kind === 'pad') {
			const p = it.pad!;
			const h = Math.max(p.w ?? 0.6, p.h ?? 0.6) * 0.75;
			return [p.x - h, p.y - h, p.x + h, p.y + h];
		}
		return [it.xy![0] - it.r, it.xy![1] - it.r, it.xy![0] + it.r, it.xy![1] + it.r];
	}

	private cells(bb: [number, number, number, number], grow = 0): string[] {
		const c = this.cell;
		const out: string[] = [];
		for (let i = Math.floor((bb[0] - grow) / c); i <= Math.floor((bb[2] + grow) / c); i++) {
			for (let j = Math.floor((bb[1] - grow) / c); j <= Math.floor((bb[3] + grow) / c); j++) out.push(`${i},${j}`);
		}
		return out;
	}

	private put(it: Item): void {
		const k = this.items.length;
		this.items.push(it);
		for (const c of this.cells(this.bbox(it))) {
			if (!this.grid.has(c))
				this.grid.set(c, []);
			this.grid.get(c)!.push(k);
		}
	}

	addNet(n: Net): void {
		for (const s of n.segs) this.put({ net: n.name, kind: 'seg', layer: s[0], seg: [s[1], s[2], s[3], s[4]], r: s[5] / 2 });
		for (const p of n.pads) this.put({ net: n.name, kind: 'pad', layer: p.l, pad: p, r: 0 });
		for (const v of n.vias) this.put({ net: n.name, kind: 'via', layer: -1, xy: [v[0], v[1]], r: v[2] / 2 });
	}

	removeNet(name: string): void {
		for (const it of this.items) {
			if (it.net === name)
				it.net = null;
		}
	}

	margin(s: S4, w: number, net: string, layer: number, clear: number): number {
		const bb: [number, number, number, number] = [Math.min(s[0], s[2]), Math.min(s[1], s[3]), Math.max(s[0], s[2]), Math.max(s[1], s[3])];
		const seen = new Set<number>();
		let best = 1e9;
		for (const c of this.cells(bb, w / 2 + clear + 2)) {
			for (const k of this.grid.get(c) ?? []) {
				if (seen.has(k))
					continue;
				seen.add(k);
				const it = this.items[k];
				if (it.net === null || it.net === net || (it.layer !== -1 && it.layer !== layer))
					continue;
				let d: number;
				if (it.kind === 'seg')
					d = segSeg(s, it.seg!) - it.r;
				else if (it.kind === 'pad')
					d = it.pad!.w ? segPad(s, it.pad!) : ptSeg(it.pad!.x, it.pad!.y, s[0], s[1], s[2], s[3]) - 0.3;
				else d = ptSeg(it.xy![0], it.xy![1], s[0], s[1], s[2], s[3]) - it.r;
				best = Math.min(best, d - w / 2 - clear);
			}
		}
		if (this.outline.length > 2) {
			const o = this.outline;
			for (let i = 0; i < o.length; i++) {
				const [a, b] = [o[i], o[(i + 1) % o.length]];
				best = Math.min(best, segSeg(s, [a[0], a[1], b[0], b[1]]) - w / 2 - 0.2);
			}
			if (!(pointInPoly(s[0], s[1], o) && pointInPoly(s[2], s[3], o)))
				best = Math.min(best, -1);
		}
		for (const poly of this.keepouts) {
			if (pointInPoly(s[0], s[1], poly) || pointInPoly(s[2], s[3], poly) || poly.some((a, i) => segsIntersect(s, [a[0], a[1], poly[(i + 1) % poly.length][0], poly[(i + 1) % poly.length][1]])))
				best = Math.min(best, -1);
		}
		return best;
	}
}

/** 网络里焊盘、过孔的连通分组签名 */
export function components(n: Net): string {
	const { segs, pads, vias } = n;
	const items: [string, number][] = [...segs.map((_, i) => ['s', i] as [string, number]), ...pads.map((_, i) => ['p', i] as [string, number]), ...vias.map((_, i) => ['v', i] as [string, number])];
	const parent = items.map((_, i) => i);
	const f = (a: number): number => {
		while (parent[a] !== a) {
			parent[a] = parent[parent[a]];
			a = parent[a];
		}
		return a;
	};
	const touch = (x: [string, number], y: [string, number]): boolean => {
		let [ka, ia] = x;
		let [kb, ib] = y;
		if (ka > kb)
			[ka, ia, kb, ib] = [kb, ib, ka, ia];
		if (ka === 'p' && kb === 's') {
			const p = pads[ia];
			const s = segs[ib];
			return (p.l === -1 || p.l === s[0]) && (p.w ? segPad([s[1], s[2], s[3], s[4]], p) : ptSeg(p.x, p.y, s[1], s[2], s[3], s[4]) - 0.25) < s[5] / 2;
		}
		if (ka === 'p' && kb === 'v') {
			const p = pads[ia];
			const v = vias[ib];
			return (p.w ? segPad([v[0], v[1], v[0], v[1]], p) : hypot(p.x - v[0], p.y - v[1]) - 0.25) < v[2] / 2;
		}
		if (ka === 's' && kb === 's') {
			const s = segs[ia];
			const t = segs[ib];
			return s[0] === t[0] && segSeg([s[1], s[2], s[3], s[4]], [t[1], t[2], t[3], t[4]]) < (s[5] + t[5]) / 2 - 1e-6;
		}
		if (ka === 's' && kb === 'v') {
			const s = segs[ia];
			const v = vias[ib];
			return ptSeg(v[0], v[1], s[1], s[2], s[3], s[4]) < (s[5] + v[2]) / 2;
		}
		if (ka === 'p' && kb === 'p') {
			const p = pads[ia];
			const q = pads[ib];
			return (p.l === q.l || p.l === -1 || q.l === -1) && ptInPad(q.x, q.y, p, 0);
		}
		if (ka === 'v' && kb === 'v') {
			const u = vias[ia];
			const v = vias[ib];
			return hypot(u[0] - v[0], u[1] - v[1]) < (u[2] + v[2]) / 2;
		}
		return false;
	};
	for (let i = 0; i < items.length; i++) {
		for (let j = i + 1; j < items.length; j++) {
			if (touch(items[i], items[j]))
				parent[f(i)] = f(j);
		}
	}
	const groups = new Map<number, string[]>();
	items.forEach((it, i) => {
		if (it[0] !== 's') {
			const r = f(i);
			if (!groups.has(r))
				groups.set(r, []);
			groups.get(r)!.push(`${it[0]}${it[1]}`);
		}
	});
	return [...groups.values()].map(g => g.sort().join(',')).sort().join('|');
}

export function simplify(pts: Pt[]): Pt[] {
	const out: Pt[] = [pts[0]];
	for (const p of pts.slice(1)) {
		if (dist(p, out[out.length - 1]) > 1e-7)
			out.push(p);
	}
	let i = 1;
	while (i < out.length - 1) {
		const [a, b, c] = [out[i - 1], out[i], out[i + 1]];
		const u: Pt = [b[0] - a[0], b[1] - a[1]];
		const v: Pt = [c[0] - b[0], c[1] - b[1]];
		if (Math.abs(u[0] * v[1] - u[1] * v[0]) < 1e-9 * Math.max(1e-9, hypot(u[0], u[1]) * hypot(v[0], v[1])) && u[0] * v[0] + u[1] * v[1] > 0)
			out.splice(i, 1);
		else i++;
	}
	return out;
}

export function octiPaths(P: Pt, Q: Pt): Pt[][] {
	const dx = Q[0] - P[0];
	const dy = Q[1] - P[1];
	if (isOcti(dx, dy, 1e-7))
		return [[P, Q]];
	const ax = Math.abs(dx);
	const ay = Math.abs(dy);
	const sx = Math.sign(dx) || 1;
	const sy = Math.sign(dy) || 1;
	const d = Math.min(ax, ay);
	const r = Math.max(ax, ay) - d;
	const diag: Pt = [sx * d, sy * d];
	const st: Pt = ax > ay ? [sx * r, 0] : [0, sy * r];
	const add = (p: Pt, v: Pt, k = 1): Pt => [p[0] + k * v[0], p[1] + k * v[1]];
	const m1 = add(P, st, 0.5);
	const m2 = add(P, diag, 0.5);
	return [[P, add(P, diag), Q], [P, add(P, st), Q], [P, m1, add(m1, diag), Q], [P, m2, add(m2, st), Q]];
}

function polyCost(pts: Pt[], minseg: number): number {
	let c = 0;
	for (let i = 0; i < pts.length - 1; i++) {
		const [a, b] = [pts[i], pts[i + 1]];
		const L = dist(a, b);
		c += L * (Math.abs(Math.abs(b[0] - a[0]) - Math.abs(b[1] - a[1])) < 1e-6 && L > 0 ? 1.1 : 1);
		if (L < minseg)
			c += 2;
	}
	for (let i = 0; i < pts.length - 2; i++) {
		const [a, b, d] = [pts[i], pts[i + 1], pts[i + 2]];
		const turn = 180 - angleBetween([a[0] - b[0], a[1] - b[1]], [d[0] - b[0], d[1] - b[1]]);
		c += turn < 46 ? 1 : turn < 91 ? 3 : 100;
	}
	return c;
}

export function exitAxes(p: Pad | null): Pt[] | null {
	if (!p || !p.w || p.shape === 'circle')
		return null;
	const [ux, uy] = padAxis(p);
	const h = p.h ?? p.w;
	if (Math.max(p.w, h) / Math.max(Math.min(p.w, h), 1e-6) >= 1.3)
		return p.w >= h ? [[ux, uy]] : [[-uy, ux]];
	return [[ux, uy], [-uy, ux]];
}

function along(d: Pt, ax: Pt[]): boolean {
	const L = hypot(d[0], d[1]);
	return L > 1e-9 && ax.some(q => Math.abs(d[0] * q[1] - d[1] * q[0]) / L <= SIN1);
}

export function polyProblems(pts: Pt[], w: number, padA: Pad | null, padB: Pad | null, oA: Pt[], oB: Pt[], minseg: number, fanout: number): [string[], string[]] {
	const hard: string[] = [];
	const soft: string[] = [];
	if (pts.length < 2)
		return [['degenerate'], soft];
	for (let i = 0; i < pts.length - 1; i++) {
		const [a, b] = [pts[i], pts[i + 1]];
		const dx = b[0] - a[0];
		const dy = b[1] - a[1];
		if (!isOcti(dx, dy)) {
			const pad = i === 0 ? padA : i === pts.length - 2 ? padB : null;
			const ax = exitAxes(pad);
			if (!(pad && ax && !isOcti(ax[0][0], ax[0][1], 1e-6) && along([dx, dy], ax)))
				hard.push('angle');
		}
		const L = hypot(dx, dy);
		const lim = i === 0 || i === pts.length - 2 ? fanout * w : minseg;
		if (pts.length > 2 && L < lim - 1e-9)
			soft.push('short');
	}
	for (let i = 0; i < pts.length - 2; i++) {
		const [a, b, c] = [pts[i], pts[i + 1], pts[i + 2]];
		if (angleBetween([a[0] - b[0], a[1] - b[1]], [c[0] - b[0], c[1] - b[1]]) < 90 - TURN_TOL)
			hard.push('acute');
	}
	for (const [end, pad, others] of [[0, padA, oA], [-1, padB, oB]] as [number, Pad | null, Pt[]][]) {
		const [a, b] = end === 0 ? [pts[0], pts[1]] : [pts[pts.length - 1], pts[pts.length - 2]];
		const d: Pt = [b[0] - a[0], b[1] - a[1]];
		for (const o of others) {
			if (angleBetween(d, o) < 90 - TURN_TOL)
				hard.push('tee');
		}
		const ax = exitAxes(pad);
		if (ax && pad) {
			const seq = end === 0 ? pts : [...pts].reverse();
			for (let i = 0; i < seq.length - 1; i++) {
				if (i > 0 && !ptInPad(seq[i][0], seq[i][1], pad))
					break;
				const dd: Pt = [seq[i + 1][0] - seq[i][0], seq[i + 1][1] - seq[i][1]];
				if (hypot(dd[0], dd[1]) > 1e-9 && !along(dd, ax)) {
					hard.push('exit');
					break;
				}
			}
		}
	}
	return [hard, soft];
}

export function mergeOverlaps(segs0: Seg[]): Seg[] {
	const segs = segs0.map(s => [...s] as Seg);
	let changed = true;
	while (changed) {
		changed = false;
		outer: for (let i = 0; i < segs.length; i++) {
			const a = segs[i];
			if (a[6])
				continue;
			let ux = a[3] - a[1];
			let uy = a[4] - a[2];
			const La = hypot(ux, uy);
			if (La < 1e-9)
				continue;
			ux /= La;
			uy /= La;
			for (let j = i + 1; j < segs.length; j++) {
				const b = segs[j];
				if (b[6] || b[0] !== a[0] || Math.abs(b[5] - a[5]) > 1e-6)
					continue;
				if ([[b[1], b[2]], [b[3], b[4]]].some(([x, y]) => Math.abs((x - a[1]) * uy - (y - a[2]) * ux) > 1e-5))
					continue;
				const pb = [(b[1] - a[1]) * ux + (b[2] - a[2]) * uy, (b[3] - a[1]) * ux + (b[4] - a[2]) * uy].sort((p, q) => p - q);
				if (Math.min(La, pb[1]) - Math.max(0, pb[0]) <= 1e-6)
					continue;
				const lo = Math.min(0, pb[0]);
				const hi = Math.max(La, pb[1]);
				segs[i] = [a[0], a[1] + lo * ux, a[2] + lo * uy, a[1] + hi * ux, a[2] + hi * uy, a[5], false];
				segs.splice(j, 1);
				changed = true;
				break outer;
			}
		}
	}
	return segs;
}

function others(g: G, c: G['chains'][number], end: 0 | -1): Pt[] {
	const key = end === 0 ? c.keys[0] : c.keys[c.keys.length - 1];
	const nd = g.node(key);
	if (nd.pad || nd.via)
		return [];
	const mine = end === 0 ? c.edges[0] : c.edges[c.edges.length - 1];
	return nd.e.filter(k => k !== mine).map(k => g.vec(k, key));
}

const DIRS: Pt[] = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];

class Heap {
	a: [number, number, number, number, number][] = [];
	push(x: [number, number, number, number, number]): void {
		const a = this.a;
		a.push(x);
		let i = a.length - 1;
		while (i > 0) {
			const p = (i - 1) >> 1;
			if (a[p][0] <= a[i][0])
				break;
			[a[p], a[i]] = [a[i], a[p]];
			i = p;
		}
	}

	pop(): [number, number, number, number, number] | undefined {
		const a = this.a;
		if (!a.length)
			return undefined;
		const top = a[0];
		const last = a.pop()!;
		if (a.length) {
			a[0] = last;
			let i = 0;
			for (;;) {
				const l = 2 * i + 1;
				const r = l + 1;
				let m = i;
				if (l < a.length && a[l][0] < a[m][0])
					m = l;
				if (r < a.length && a[r][0] < a[m][0])
					m = r;
				if (m === i)
					break;
				[a[m], a[i]] = [a[i], a[m]];
				i = m;
			}
		}
		return top;
	}

	get size(): number {
		return this.a.length;
	}
}

/** 局部八方向 A*（状态含方向，锐角和回折不展开） */
function astar(obs: Obstacles, S: Pt, T: Pt, w: number, net: string, layer: number, clear: number, margin = 2, maxNodes = 40000): Pt[] | null {
	const span = Math.max(Math.abs(T[0] - S[0]), Math.abs(T[1] - S[1])) + 2 * margin;
	const p = Math.max(0.05, span / 300);
	const x0 = Math.min(S[0], T[0]) - margin;
	const x1 = Math.max(S[0], T[0]) + margin;
	const y0 = Math.min(S[1], T[1]) - margin;
	const y1 = Math.max(S[1], T[1]) + margin;
	const cache = new Map<string, boolean>();
	const free = (i: number, j: number): boolean => {
		const k = `${i},${j}`;
		let v = cache.get(k);
		if (v === undefined) {
			const x = S[0] + i * p;
			const y = S[1] + j * p;
			v = x >= x0 && x <= x1 && y >= y0 && y <= y1 && obs.margin([x, y, x, y], w, net, layer, clear) >= 0;
			cache.set(k, v);
		}
		return v;
	};
	const finish = (i: number, j: number, d: number): Pt[] | null => {
		const P: Pt = [S[0] + i * p, S[1] + j * p];
		for (const tail of octiPaths(P, T).slice(0, 2)) {
			let ok = true;
			let prev: Pt | null = d >= 0 ? DIRS[d] : null;
			for (let k = 0; k < tail.length - 1; k++) {
				const v: Pt = [tail[k + 1][0] - tail[k][0], tail[k + 1][1] - tail[k][1]];
				if (hypot(v[0], v[1]) < 1e-9)
					continue;
				if (prev && angleBetween([-prev[0], -prev[1]], v) < 90 - TURN_TOL) {
					ok = false;
					break;
				}
				if (obs.margin([tail[k][0], tail[k][1], tail[k + 1][0], tail[k + 1][1]], w, net, layer, clear) < -1e-6) {
					ok = false;
					break;
				}
				prev = v;
			}
			if (ok)
				return tail;
		}
		return null;
	};
	const h = (i: number, j: number) => {
		const dx = Math.abs(T[0] - S[0] - i * p);
		const dy = Math.abs(T[1] - S[1] - j * p);
		return Math.max(dx, dy) + (Math.SQRT2 - 1) * Math.min(dx, dy);
	};
	const g = new Map<string, number>([['0,0,-1', 0]]);
	const came = new Map<string, [number, number, number]>();
	const pq = new Heap();
	pq.push([h(0, 0), 0, 0, 0, -1]);
	let n = 0;
	while (pq.size && n < maxNodes) {
		const [, gc, i, j, d] = pq.pop()!;
		if (gc > (g.get(`${i},${j},${d}`) ?? 1e18) + 1e-9)
			continue;
		n++;
		if (n % 16 === 1 || h(i, j) < 3 * p) {
			const tail = finish(i, j, d);
			if (tail) {
				const pts: Pt[] = [tail[0]];
				let st: [number, number, number] = [i, j, d];
				for (;;) {
					const c = came.get(st.join(','));
					if (!c)
						break;
					st = c;
					pts.push([S[0] + st[0] * p, S[1] + st[1] * p]);
				}
				pts.reverse();
				return simplify([...pts, ...tail.slice(1)]);
			}
		}
		DIRS.forEach(([dx, dy], nd) => {
			let tc = 0;
			if (d >= 0) {
				const turn = Math.min(((nd - d) % 8 + 8) % 8, ((d - nd) % 8 + 8) % 8);
				if (turn > 2)
					return;
				tc = [0, 1, 3][turn];
			}
			const ni = i + dx;
			const nj = j + dy;
			if (!free(ni, nj))
				return;
			const ng = gc + p * (dx && dy ? Math.SQRT2 * 1.1 : 1) + tc;
			const key = `${ni},${nj},${nd}`;
			if (ng < (g.get(key) ?? 1e18) - 1e-9) {
				g.set(key, ng);
				came.set(key, [i, j, d]);
				pq.push([ng + h(ni, nj), ng, ni, nj, nd]);
			}
		});
	}
	return null;
}

export interface FixOptions { clearance?: number; outline?: Pt[]; cons?: Partial<Constraints> | null; nets?: string[] }

/** 只计算修复方案，不改板子 */
export function planFix(board: Board, opt: FixOptions = {}): FixPlan {
	const cons = mergeCons(opt.cons);
	const clear0 = opt.clearance ?? 0.15;
	const nets: Net[] = board.nets.map(n => ({ ...n, segs: n.segs.map(s => [...s] as Seg) }));
	const obs = new Obstacles(nets, opt.outline ?? board.outline ?? [], (cons.keepouts ?? []).map(k => k.poly).filter(Boolean));
	const kw = cons.geometry.min_seg.k_w;
	const absmin = cons.geometry.min_seg.abs_mm;
	const fanout = cons.geometry.fanout_k_w ?? 0.5;
	const locked = new Set((cons.locks ?? []).map(l => l.net));
	const plan: FixPlan = { fixed: [], manual: [], changes: [] };
	const stubOptions = (A: Pt, pad: Pad | null, target: Pt, w: number): (Pt | null)[] => {
		const opts: (Pt | null)[] = [null];
		for (const q of exitAxes(pad) ?? []) {
			for (const s of [1, -1]) {
				const e: Pt = [q[0] * s, q[1] * s];
				if ((target[0] - A[0]) * e[0] + (target[1] - A[1]) * e[1] < -1e-9)
					continue;
				const t = padExitDist(A[0], A[1], e, pad!) + Math.max(0.2, w);
				opts.push([A[0] + e[0] * t, A[1] + e[1] * t]);
			}
		}
		return opts;
	};
	const clsOf = (n: Net) => cons.nets?.[n.name]?.class ?? inferClass(n.name, n.pads)[0];
	const rank = (n: Net) => {
		const i = PRIORITY.indexOf(clsOf(n));
		return i < 0 ? 99 : i;
	};
	const order = [...nets].sort((a, b) => rank(a) - rank(b));
	const originals = new Map(nets.map(n => [n.name, n.segs.map(s => [...s] as Seg)]));
	const touched = new Set<string>();
	for (let pass = 0; pass < 3; pass++) {
		let any = false;
		plan.manual = [];
		for (const n of order) {
			const cls = clsOf(n);
			if (cls === 'GND' || !n.segs.length || locked.has(n.name) || (opt.nets && !opt.nets.includes(n.name)))
				continue;
			const clear = cons.netclasses?.[cls]?.clearance ?? clear0;
			const before = components(n);
			let newSegs: Seg[] = [];
			let changed = false;
			const items: FixItem[] = [];
			for (const l of [...new Set(n.segs.map(s => s[0]))].sort((a, b) => a - b)) {
				let segs = n.segs.filter(s => s[0] === l);
				const merged = mergeOverlaps(segs);
				if (merged.length !== segs.length) {
					items.push({ net: n.name, layer: l, issues: ['overlap'], how: 'merge', before: [], after: [] });
					segs = merged;
					changed = true;
				}
				let g = new Graph(segs, n.pads, n.vias, l);
				if (!n.zone) {
					for (let it = 0; it < 5; it++) {
						const dead = g.chains.filter(c => !c.arc && [c.keys[0], c.keys[c.keys.length - 1]].some((k) => {
							const nd = g.node(k);
							return nd.e.length === 1 && !nd.pad && !nd.via;
						}));
						if (!dead.length)
							break;
						const drop = new Set(dead.flatMap(c => c.edges));
						for (const c of dead) items.push({ net: n.name, layer: l, from: c.pts[0], to: c.pts[c.pts.length - 1], issues: ['stub'], how: 'remove', before: c.pts, after: [] });
						segs = mergeOverlaps(g.edges.filter((_, k) => !drop.has(k)).map(e => [l, e.a[0], e.a[1], e.b[0], e.b[1], e.w, e.arc] as Seg));
						changed = true;
						g = new Graph(segs, n.pads, n.vias, l);
					}
				}
				const replaced = new Set<number>();
				const added: Seg[] = [];
				for (const c of g.chains) {
					if (c.arc)
						continue;
					const w = c.w;
					const minseg = Math.max(kw * w, absmin);
					const nA = g.node(c.keys[0]);
					const nB = g.node(c.keys[c.keys.length - 1]);
					const oA = others(g, c, 0);
					const oB = others(g, c, -1);
					const [hard, soft] = polyProblems(c.pts, w, nA.pad, nB.pad, oA, oB, minseg, fanout);
					let jog = false;
					const pts0 = c.pts;
					for (let i = 0; i < pts0.length - 3; i++) {
						const u: Pt = [pts0[i + 1][0] - pts0[i][0], pts0[i + 1][1] - pts0[i][1]];
						const v: Pt = [pts0[i + 3][0] - pts0[i + 2][0], pts0[i + 3][1] - pts0[i + 2][1]];
						if (angleBetween(u, v) < 1 && hypot(u[0], u[1]) > 1e-6) {
							const off = ptSeg(pts0[i + 2][0], pts0[i + 2][1], pts0[i][0] - 1e3 * u[0], pts0[i][1] - 1e3 * u[1], pts0[i][0] + 1e3 * u[0], pts0[i][1] + 1e3 * u[1]);
							if (off > 1e-4 && off < 2 * w)
								jog = true;
						}
					}
					const issues = [...new Set([...hard, ...soft, ...(jog ? ['jog'] : [])])].sort();
					if (!issues.length)
						continue;
					const A = c.pts[0];
					const B = c.pts[c.pts.length - 1];
					if (dist(A, B) < 1e-6)
						continue;
					const cands: [number, Pt[]][] = [];
					for (const sa of stubOptions(A, nA.pad, B, w)) {
						for (const sb of stubOptions(B, nB.pad, A, w)) {
							for (const mid of octiPaths(sa ?? A, sb ?? B)) {
								const pts = simplify([...(sa ? [A] : []), ...mid, ...(sb ? [B] : [])]);
								cands.push([polyCost(pts, minseg), pts]);
							}
						}
					}
					cands.sort((p, q) => p[0] - q[0]);
					let pick: Pt[] | null = null;
					let softOk: Pt[] | null = null;
					for (const [, pts] of cands) {
						const [h, s] = polyProblems(pts, w, nA.pad, nB.pad, oA, oB, minseg, fanout);
						if (h.length)
							continue;
						let okc = true;
						for (let i = 0; i < pts.length - 1; i++) {
							if (obs.margin([pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]], w, n.name, l, clear) < -1e-6) {
								okc = false;
								break;
							}
						}
						if (!okc)
							continue;
						if (!s.length) {
							pick = pts;
							break;
						}
						if (!softOk)
							softOk = pts;
					}
					if (!pick) {
						let best: [number, Pt[]] | null = null;
						for (const sa of stubOptions(A, nA.pad, B, w)) {
							for (const sb of stubOptions(B, nB.pad, A, w)) {
								const r = astar(obs, sa ?? A, sb ?? B, w, n.name, l, clear);
								if (!r)
									continue;
								const pts = simplify([...(sa ? [A] : []), ...r, ...(sb ? [B] : [])]);
								const [h] = polyProblems(pts, w, nA.pad, nB.pad, oA, oB, minseg, fanout);
								if (h.length || pts.slice(0, -1).some((q, i) => obs.margin([q[0], q[1], pts[i + 1][0], pts[i + 1][1]], w, n.name, l, clear) < -1e-6))
									continue;
								const cst = polyCost(pts, minseg);
								if (!best || cst < best[0])
									best = [cst, pts];
							}
							if (best)
								break;
						}
						if (best)
							pick = best[1];
					}
					pick = pick ?? softOk;
					const same = pick && JSON.stringify(pick) === JSON.stringify(simplify(c.pts));
					if (!pick || same) {
						if (!pick)
							plan.manual.push({ net: n.name, layer: l, at: A, issues, reason: '没有找到合法的八方向走法（空间不够或被挡住），需要局部重布或回到布局' });
						continue;
					}
					for (const k of c.edges) replaced.add(k);
					for (let i = 0; i < pick.length - 1; i++) added.push([l, pick[i][0], pick[i][1], pick[i + 1][0], pick[i + 1][1], w, false]);
					items.push({ net: n.name, layer: l, from: A, to: B, issues, how: 'elbow', before: c.pts, after: pick });
				}
				const hitSrc = new Set([...replaced].map(k => g.edges[k].src));
				segs.forEach((s, i) => {
					if (!hitSrc.has(i))
						newSegs.push(s);
				});
				g.edges.forEach((e, k) => {
					if (hitSrc.has(e.src) && !replaced.has(k))
						newSegs.push([l, e.a[0], e.a[1], e.b[0], e.b[1], e.w, e.arc]);
				});
				newSegs = newSegs.concat(added);
				if (replaced.size)
					changed = true;
			}
			if (!changed)
				continue;
			const trial: Net = { ...n, segs: newSegs };
			if (components(trial) !== before) {
				plan.manual.push({ net: n.name, issues: ['connectivity'], reason: '修复后连通关系会改变，已放弃' });
				continue;
			}
			obs.removeNet(n.name);
			n.segs = newSegs;
			obs.addNet(n);
			plan.fixed.push(...items);
			touched.add(n.name);
			any = true;
		}
		if (!any)
			break;
	}
	// 最后一遍：所有网络（含地线、电源、射频）上剩下的直角拐角斜切成两个 135° 拐角；切不了的列为人工处理
	const SQ2 = Math.SQRT2;
	for (const n of order) {
		if (!n.segs.length || locked.has(n.name) || (opt.nets && !opt.nets.includes(n.name)))
			continue;
		const clear = cons.netclasses?.[clsOf(n)]?.clearance ?? clear0;
		const before = components(n);
		let out: Seg[] = [];
		const items: FixItem[] = [];
		for (const l of [...new Set(n.segs.map(s => s[0]))].sort((x, y) => x - y)) {
			const segs = n.segs.filter(s => s[0] === l);
			const g = new Graph(segs, n.pads, n.vias, l);
			const doneSrc = new Set<number>();
			const modEdges = new Set<number>();
			const add: Seg[] = [];
			for (const c of g.chains) {
				if (c.arc || c.pts.length < 3)
					continue;
				const pts: Pt[] = c.pts.map(q => [q[0], q[1]] as Pt);
				const w = c.w;
				const minseg = Math.max(kw * w, absmin);
				const cuts = [Math.max(2 * w, 0.2) / SQ2, Math.max(w, 0.15) / SQ2, (0.6 * w) / SQ2];
				let k = 1;
				let mod = false;
				while (k < pts.length - 1) {
					const a = pts[k - 1];
					const bb = pts[k];
					const d = pts[k + 1];
					const u: Pt = [a[0] - bb[0], a[1] - bb[1]];
					const v: Pt = [d[0] - bb[0], d[1] - bb[1]];
					let done = false;
					if (Math.abs(angleBetween(u, v) - 90) < 0.5) {
						const lu = hypot(u[0], u[1]);
						const lv = hypot(v[0], v[1]);
						for (const cut of cuts) {
							if (lu < cut + minseg || lv < cut + minseg)
								continue;
							const p1: Pt = [bb[0] + (u[0] / lu) * cut, bb[1] + (u[1] / lu) * cut];
							const p2: Pt = [bb[0] + (v[0] / lv) * cut, bb[1] + (v[1] / lv) * cut];
							const inPad = n.pads.some(pd => (pd.l === -1 || pd.l === l) && !!pd.w && [p1, p2].some(q => ptInPad(q[0], q[1], pd, w / 2)));
							if (!inPad && obs.margin([p1[0], p1[1], p2[0], p2[1]], w, n.name, l, clear) >= 0) {
								pts.splice(k, 1, p1, p2);
								k += 2;
								mod = done = true;
								break;
							}
						}
					}
					if (!done)
						k++;
				}
				if (mod) {
					for (const e of c.edges) {
						doneSrc.add(g.edges[e].src);
						modEdges.add(e);
					}
					for (let i = 0; i < pts.length - 1; i++) add.push([l, pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1], w, false]);
					items.push({ net: n.name, layer: l, from: c.pts[0], to: c.pts[c.pts.length - 1], issues: ['right'], how: 'chamfer', before: c.pts, after: pts });
				}
			}
			segs.forEach((s, i) => {
				if (!doneSrc.has(i))
					out.push(s);
			});
			g.edges.forEach((e, k) => {
				if (doneSrc.has(e.src) && !modEdges.has(k))
					out.push([l, e.a[0], e.a[1], e.b[0], e.b[1], e.w, e.arc]);
			});
			out = out.concat(add);
		}
		if (items.length) {
			const trial: Net = { ...n, segs: out };
			if (components(trial) === before) {
				obs.removeNet(n.name);
				n.segs = out;
				obs.addNet(n);
				plan.fixed.push(...items);
				touched.add(n.name);
			}
		}
		for (const l of [...new Set(n.segs.map(s => s[0]))]) {
			const g = new Graph(n.segs.filter(s => s[0] === l), n.pads, n.vias, l);
			for (const [key, nd] of g.nodes) {
				if (nd.e.length !== 2 || nd.pad || nd.via || nd.arc)
					continue;
				if (Math.abs(angleBetween(g.vec(nd.e[0], key), g.vec(nd.e[1], key)) - 90) < 0.5)
					plan.manual.push({ net: n.name, layer: l, at: nd.p, issues: ['right'], reason: '直角拐角无法自动斜切（两侧线段太短或旁边没有空间），请拆线按 135° 拐角重布或挪开相邻走线' });
			}
		}
	}
	for (const n of nets) {
		if (!touched.has(n.name))
			continue;
		const original = originals.get(n.name)!;
		const newSegs = n.segs;
		// 与原始线段比对：没保留的删掉，新增的创建
		const key = (s: Seg) => {
			const a = `${s[1].toFixed(4)},${s[2].toFixed(4)}`;
			const b = `${s[3].toFixed(4)},${s[4].toFixed(4)}`;
			return `${s[0]}|${s[5].toFixed(4)}|${[a, b].sort().join('|')}`;
		};
		const keep = new Map<string, number>();
		for (const s of newSegs) keep.set(key(s), (keep.get(key(s)) ?? 0) + 1);
		const remove: string[] = [];
		for (const s of original) {
			const k = key(s);
			if ((keep.get(k) ?? 0) > 0)
				keep.set(k, keep.get(k)! - 1);
			else if (s[7] && !s[6])
				remove.push(s[7]);
		}
		const orig = new Map<string, number>();
		for (const s of original) orig.set(key(s), (orig.get(key(s)) ?? 0) + 1);
		const add: Seg[] = [];
		for (const s of newSegs) {
			const k = key(s);
			if ((orig.get(k) ?? 0) > 0)
				orig.set(k, orig.get(k)! - 1);
			else add.push(s);
		}
		plan.changes.push({ net: n.name, remove, add });
	}
	return plan;
}
