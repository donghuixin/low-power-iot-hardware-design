/**
 * 走线原则：就近（RTP）、差分（RTD）、优先级倒挂（RTO）、隔离（RTS-06）、裸露焊盘与地（RTV-08 / RTY-06）、推荐布线顺序。
 * 与 low-power-iot-hardware-design/scripts/route_principles.py 一致。
 */
import type { Pad, Pt, Seg } from './geom';
import type { Ctx } from './lint';
import type { Net } from './model';
import { angleBetween, dist, hypot, isOcti, median, octMst, ptInPad, ptSeg, round, segLen, segPad, segSeg } from './geom';
import { Graph } from './graph';

export const TIERS: [number, string, string[], string][] = [
	[1, '射频与天线', ['RF50'], '照抄参考设计，最短最直、0 过孔、不分叉，先占住最好的位置'],
	[2, '时钟源', ['XTAL'], '晶振线 ≤ 5 mm、0 过孔，负载电容贴着晶振，下方完整地'],
	[3, '开关回路与高压', ['SW', 'HV'], '热回路面积最小、开关节点铜最小；高压先定间距和爬电'],
	[4, '高速差分', ['USB90', 'DIFF100'], '成对、同层、等距、等长，过孔成对'],
	[5, '单端时钟', ['CLK'], '短、少过孔、远离模拟和射频，有完整参考平面'],
	[6, '模拟敏感', ['ANALOG'], '远离攻击网络，走在地的正上方，必要时包地'],
	[7, '电源', ['PWR_MAIN', 'PWR_LOW'], '先干线后支路，宽线或铺铜；去耦电容就近到引脚'],
	[8, '一般信号', ['SIG'], '总线成束等距，按层主方向走'],
	[9, '地', ['GND'], '铺铜和缝合过孔放在最后，补齐被切开的地'],
];
const TIER_OF: Record<string, number> = Object.fromEntries(TIERS.flatMap(([t, , cs]) => cs.map(c => [c, t])));
export const TIER_NAME: Record<number, string> = Object.fromEntries(TIERS.map(([t, n]) => [t, n]));
const AGGRESSOR = new Set(['SW', 'CLK', 'USB90', 'DIFF100', 'HV']);
const VICTIM = new Set(['ANALOG', 'XTAL', 'RF50']);
const POWER = new Set(['PWR_LOW', 'PWR_MAIN']);
const PAIR_SKEW: Record<string, [number, number]> = { USB90: [0.5, 1.25], DIFF100: [0.13, 0.5] };
const PAIR_DEFAULT_SKEW: [number, number] = [1, 2.5];

export function tierOf(cls: string): number {
	return TIER_OF[cls] ?? 8;
}
export function isIc(ref: string): boolean {
	return /^(U|IC)\d/.test(String(ref));
}

/** 电容值字符串 → 法拉 */
export function parseValue(v?: string | null): number | null {
	if (!v)
		return null;
	const s = String(v).replace(/[µμ]/g, 'u').trim();
	const m = /^(\d+(?:\.\d+)?)\s*([pnum])(\d*)/i.exec(s);
	if (!m)
		return null;
	const k = ({ p: 1e-12, n: 1e-9, u: 1e-6, m: 1e-3 } as Record<string, number>)[m[2].toLowerCase()];
	let x = Number.parseFloat(m[1]);
	if (m[3])
		x += Number.parseFloat(`0.${m[3]}`);
	return x * k;
}

/** 一个网络的跨层铜皮连通图，用来求焊盘之间的走线路径 */
export class NetPaths {
	adj = new Map<string, [string, number][]>();
	pos = new Map<string, Pt>();
	constructor(n: Net) {
		const layers = [...new Set(n.segs.map(s => s[0]))].sort((a, b) => a - b);
		for (const l of layers) {
			const g = new Graph(n.segs.filter(s => s[0] === l), n.pads, n.vias, l);
			for (const e of g.edges) {
				const a = `s|${l}|${e.ka}`;
				const b = `s|${l}|${e.kb}`;
				this.pos.set(a, e.a);
				this.pos.set(b, e.b);
				this.link(a, b, dist(e.a, e.b));
			}
			for (const [key, nd] of g.nodes) {
				const k = `s|${l}|${key}`;
				const [x, y] = nd.p;
				n.vias.forEach((v, i) => {
					if (hypot(x - v[0], y - v[1]) <= v[2] / 2 + 1e-3) {
						this.pos.set(`v|${i}`, [v[0], v[1]]);
						this.link(k, `v|${i}`, 0);
					}
				});
				n.pads.forEach((p, i) => {
					if ((p.l === -1 || p.l === l) && ptInPad(x, y, p)) {
						this.pos.set(`p|${i}`, [p.x, p.y]);
						this.link(k, `p|${i}`, 0);
					}
				});
			}
		}
		n.pads.forEach((p, i) => {
			if (!this.pos.has(`p|${i}`))
				this.pos.set(`p|${i}`, [p.x, p.y]);
			n.vias.forEach((v, j) => {
				if (ptInPad(v[0], v[1], p, v[2] / 2)) {
					if (!this.pos.has(`v|${j}`))
						this.pos.set(`v|${j}`, [v[0], v[1]]);
					this.link(`p|${i}`, `v|${j}`, 0);
				}
			});
		});
	}

	private link(a: string, b: string, L: number): void {
		if (!this.adj.has(a))
			this.adj.set(a, []);
		if (!this.adj.has(b))
			this.adj.set(b, []);
		this.adj.get(a)!.push([b, L]);
		this.adj.get(b)!.push([a, L]);
	}

	pathKeys(i: number, j: number): [number | null, string[] | null] {
		const src = `p|${i}`;
		const dst = `p|${j}`;
		if (!this.adj.has(src) || !this.adj.has(dst))
			return [null, null];
		const d = new Map<string, number>([[src, 0]]);
		const prev = new Map<string, string>();
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
			if (u === null || u === dst)
				break;
			done.add(u);
			for (const [v, L] of this.adj.get(u) ?? []) {
				const nd = du + L;
				if (nd < (d.get(v) ?? Infinity) - 1e-12) {
					d.set(v, nd);
					prev.set(v, u);
				}
			}
		}
		if (!d.has(dst))
			return [null, null];
		const keys: string[] = [];
		let u = dst;
		for (;;) {
			keys.push(u);
			if (u === src)
				break;
			u = prev.get(u)!;
		}
		return [d.get(dst)!, keys.reverse()];
	}

	path(i: number, j: number): [number | null, Pt[] | null] {
		const [L, keys] = this.pathKeys(i, j);
		return keys ? [L, keys.map(k => this.pos.get(k)!)] : [null, null];
	}
}

function distAlong(pts: Pt[], x: number, y: number): [number, number] {
	let best = 1e18;
	let at = 0;
	let acc = 0;
	for (let i = 0; i < pts.length - 1; i++) {
		const [a, b] = [pts[i], pts[i + 1]];
		const L = dist(a, b);
		const d = ptSeg(x, y, a[0], a[1], b[0], b[1]);
		if (d < best) {
			const t = L < 1e-12 ? 0 : Math.max(0, Math.min(1, ((x - a[0]) * (b[0] - a[0]) + (y - a[1]) * (b[1] - a[1])) / (L * L)));
			best = d;
			at = acc + t * L;
		}
		acc += L;
	}
	return [best, at];
}

function padHalf(p: Pad): number {
	return Math.max(p.w || 0.5, p.h || 0.5) / 2;
}

function minBy<T>(xs: T[], f: (x: T) => number): T {
	let best = xs[0];
	let bv = f(best);
	for (const x of xs.slice(1)) {
		const v = f(x);
		if (v < bv) {
			best = x;
			bv = v;
		}
	}
	return best;
}

export function checkGround(ctx: Ctx, nets: Net[], classes: Record<string, string>, nL: number): void {
	const gnds = nets.filter(n => classes[n.name] === 'GND');
	for (const n of gnds) {
		for (const p of n.pads) {
			if (p.l === -1 || !p.w || !isIc(p.ref))
				continue;
			const area = p.w * (p.h ?? p.w);
			if (area < 4)
				continue;
			const need = Math.max(4, Math.round(area / 1.5));
			let got = 0;
			for (const g of gnds) {
				for (const v of g.vias) {
					if (ptInPad(v[0], v[1], p, 0))
						got++;
				}
			}
			if (got < need && nL >= 2)
				ctx.add('RTV-08', got ? 'P2' : 'P1', n.name, p.l, [p.x, p.y], `${p.ref} 的裸露焊盘（${p.w.toFixed(1)} × ${(p.h ?? p.w).toFixed(1)} mm）只有 ${got} 个地过孔，建议 ≥ ${need}（约每 1.5 mm² 一个，阵列排布、塞孔）：它是芯片所有地的汇集点和主散热路径`, got, 'VF-20');
		}
	}
	const names = gnds.filter(n => n.segs.length || n.vias.length || n.zone || n.pads.length > 1).map(n => n.name).sort();
	if (names.length > 1)
		ctx.add('RTY-06', 'P3', names.slice(0, 4).join('、'), null, null, `板上有 ${names.length} 个地网络（${names.slice(0, 4).join('、')}）：确认没有把地平面切开，只在转换器下方或功率星点一处相连；一般单一完整地加分区布局更好`, names.length);
}

export function checkProximity(ctx: Ctx, nets: Net[], classes: Record<string, string>, values: Record<string, string>, _nL: number, hasPlane: boolean): void {
	const by = new Map(nets.map(n => [n.name, n]));
	const paths = new Map<string, NetPaths>();
	const P = (name: string) => {
		if (!paths.has(name))
			paths.set(name, new NetPaths(by.get(name)!));
		return paths.get(name)!;
	};
	const comp = new Map<string, [string, number, Pad][]>();
	for (const n of nets) {
		n.pads.forEach((p, i) => {
			if (!comp.has(p.ref))
				comp.set(p.ref, []);
			comp.get(p.ref)!.push([n.name, i, p]);
		});
	}
	const gndVias: [number, number, number][] = [];
	for (const n of nets) {
		if (classes[n.name] !== 'GND')
			continue;
		for (const v of n.vias) gndVias.push([v[0], v[1], v[2]]);
	}
	for (const n of nets) {
		if (classes[n.name] !== 'GND')
			continue;
		for (const p of n.pads) {
			if (p.l === -1)
				gndVias.push([p.x, p.y, 0]);
		}
	}
	const routeLen = (net: string, i: number, j: number): [number, string] => {
		const n = by.get(net)!;
		const L = n.zone ? null : P(net).path(i, j)[0];
		const a = n.pads[i];
		const b = n.pads[j];
		return L !== null ? [L, '走线'] : [dist([a.x, a.y], [b.x, b.y]), '直线'];
	};
	for (const [ref, pads] of comp) {
		const netsOf = pads.map(([nm]) => classes[nm]);
		if (/^C\d/.test(ref) && pads.length === 2 && netsOf.includes('GND') && netsOf.some(c => POWER.has(c))) {
			const sorted = [...pads].sort((a, b) => Number(classes[a[0]] === 'GND') - Number(classes[b[0]] === 'GND'));
			const [[pn, pi, pp], [gn, , gp]] = sorted;
			if (!POWER.has(classes[pn]))
				continue;
			const cands = by.get(pn)!.pads.map((q, j) => [j, q] as [number, Pad]).filter(([, q]) => isIc(q.ref));
			if (cands.length) {
				const [j, q] = minBy(cands, ([, q2]) => dist([q2.x, q2.y], [pp.x, pp.y]));
				const [L, how] = routeLen(pn, pi, j);
				const cap = parseValue(values[ref]);
				const bulk = cap !== null && cap > 1.01e-6;
				if (!bulk) {
					if (pp.l !== -1 && q.l !== -1 && pp.l !== q.l) {
						ctx.add('RTP-08', 'P2', pn, pp.l, [pp.x, pp.y], `去耦电容 ${ref} 与 ${q.ref} 不在同一层：电流要经过过孔，回路电感变大`, undefined, 'VF-29');
					}
					else if (!by.get(pn)!.zone) {
						const [, keys] = P(pn).pathKeys(pi, j);
						const nv = (keys ?? []).slice(1, -1).filter(k => k.startsWith('v|')).length;
						if (nv)
							ctx.add('RTP-08', 'P2', pn, pp.l, [pp.x, pp.y], `去耦电容 ${ref} 到 ${q.ref}.${q.pin} 之间经过 ${nv} 个过孔（电容与芯片之间不打过孔，过孔打在电容焊盘外侧）`, nv, 'VF-29');
					}
				}
				if (bulk) {
					if (L > 10)
						ctx.add('RTP-02', 'P3', pn, pp.l, [pp.x, pp.y], `储能电容 ${ref}（${values[ref]}）到 ${q.ref}.${q.pin} ${how}距离 ${L.toFixed(1)} mm（建议 ≤ 10 mm）`, round(L, 2), 'VF-29');
				}
				else {
					let sev: 'P1' | 'P2' | null = L > 6 ? 'P1' : L > 3 ? 'P2' : null;
					if (sev && cap === null)
						sev = 'P2';
					if (sev)
						ctx.add('RTP-01', sev, pn, pp.l, [pp.x, pp.y], `去耦电容 ${ref}${values[ref] ? `（${values[ref]}）` : ''} 到 ${q.ref}.${q.pin} 的${how}距离 ${L.toFixed(1)} mm（焊盘中心之间，≤ 3 mm）`, round(L, 2), 'VF-29');
				}
			}
			if (hasPlane && gp.l !== -1) {
				const ds = gndVias.map(([x, y, r]) => Math.max(0, segPad([x, y, x, y], gp) - r));
				const d = ds.length ? Math.min(...ds) : null;
				if (d === null || d > 1.5)
					ctx.add('RTP-03', 'P2', gn, gp.l, [gp.x, gp.y], `电容 ${ref} 的地焊盘 ${d === null ? '附近没有地过孔' : `离最近的地过孔 ${d.toFixed(1)} mm`}（≤ 0.5 mm，回流要短）`, d ? round(d, 2) : undefined, 'VF-29');
				else if (d > 0.5)
					ctx.add('RTP-03', 'P3', gn, gp.l, [gp.x, gp.y], `电容 ${ref} 的地焊盘离最近的地过孔 ${d.toFixed(1)} mm（建议 ≤ 0.5 mm）`, round(d, 2), 'VF-29');
			}
		}
		if (/^C\d/.test(ref) && pads.length === 2 && netsOf.includes('GND') && netsOf.includes('XTAL')) {
			const [xn, xi, xp] = pads.find(t => classes[t[0]] === 'XTAL')!;
			const ys = by.get(xn)!.pads.map((q, j) => [j, q] as [number, Pad]).filter(([, q]) => /^(Y|X)\d/.test(String(q.ref)));
			if (ys.length) {
				const [j, q] = minBy(ys, ([, q2]) => dist([q2.x, q2.y], [xp.x, xp.y]));
				const [L, how] = routeLen(xn, xi, j);
				if (L > 3)
					ctx.add('RTP-04', L <= 6 ? 'P2' : 'P1', xn, xp.l, [xp.x, xp.y], `晶振负载电容 ${ref} 到 ${q.ref}.${q.pin} 的${how}距离 ${L.toFixed(1)} mm（≤ 3 mm，贴着晶振）`, round(L, 2), 'VF-29');
			}
		}
		if (/^(D|TVS|ESD|ZD)\d/.test(ref) && netsOf.includes('GND')) {
			for (const [sn, si, sp] of pads) {
				if (classes[sn] === 'GND')
					continue;
				const n = by.get(sn)!;
				const conns = n.pads.map((q, j) => [j, q] as [number, Pad]).filter(([, q]) => /^(J|CN|USB)\d/.test(String(q.ref)));
				const ics = n.pads.map((q, j) => [j, q] as [number, Pad]).filter(([, q]) => isIc(q.ref));
				if (!conns.length)
					continue;
				const [cj, cq] = minBy(conns, ([, q]) => dist([q.x, q.y], [sp.x, sp.y]));
				const [L, how] = routeLen(sn, si, cj);
				if (L > 5)
					ctx.add('RTP-05', L <= 10 ? 'P2' : 'P1', sn, sp.l, [sp.x, sp.y], `ESD 器件 ${ref} 离接口 ${cq.ref}.${cq.pin} ${how}距离 ${L.toFixed(1)} mm（≤ 5 mm，放在接口处）`, round(L, 2), 'VF-29');
				if (ics.length && !n.zone) {
					const [ij] = minBy(ics, ([, q]) => dist([q.x, q.y], [cq.x, cq.y]));
					const [Lci, pts] = P(sn).path(cj, ij);
					if (pts && Lci !== null) {
						const [d, s] = distAlong(pts, sp.x, sp.y);
						const stub = Math.max(0, d - padHalf(sp));
						if (stub > 1)
							ctx.add('RTP-06', 'P2', sn, sp.l, [sp.x, sp.y], `ESD 器件 ${ref} 不在接口到芯片的路径上，桩线约 ${stub.toFixed(1)} mm（应串在线上，桩线 ≤ 1 mm）`, round(stub, 2), 'VF-29');
						else if (s > 0.5 * Lci)
							ctx.add('RTP-06', 'P2', sn, sp.l, [sp.x, sp.y], `ESD 器件 ${ref} 在路径上更靠近芯片（离接口 ${s.toFixed(1)} mm、离芯片 ${(Lci - s).toFixed(1)} mm）：浪涌会先到芯片`, round(s, 2), 'VF-29');
					}
				}
			}
		}
		if (/^R\d/.test(ref) && pads.length === 2 && pads.every(([nm]) => !POWER.has(classes[nm]) && classes[nm] !== 'GND')) {
			const ends: [number, Pad][] = [];
			let ok = true;
			for (const [nm, i] of pads) {
				const others = by.get(nm)!.pads.map((q, j) => [j, q] as [number, Pad]).filter(([, q]) => q.ref !== ref);
				if (others.length !== 1 || !isIc(others[0][1].ref)) {
					ok = false;
					break;
				}
				ends.push([routeLen(nm, i, others[0][0])[0], others[0][1]]);
			}
			if (ok && ends.length === 2 && Math.min(ends[0][0], ends[1][0]) > 3) {
				const p0 = pads[0][2];
				ctx.add('RTP-07', 'P3', pads[0][0], p0.l, [p0.x, p0.y], `串联电阻 ${ref} 离两端芯片都远（${ends[0][1].ref} ${ends[0][0].toFixed(1)} mm、${ends[1][1].ref} ${ends[1][0].toFixed(1)} mm）：源端匹配电阻应贴着驱动端（≤ 3 mm）`, round(Math.min(ends[0][0], ends[1][0]), 2), 'VF-29');
			}
		}
	}
}

/** 按命名找差分对 */
export function pairNames(names: string[]): [string, string][] {
	const out: [string, string][] = [];
	const used = new Set<string>();
	const pats: [string, string][] = [['_P', '_N'], ['+', '-'], ['_DP', '_DM'], ['_DP', '_DN'], ['DP', 'DM'], ['DP', 'DN'], ['_H', '_L'], ['P', 'N']];
	const S = new Set(names);
	for (const nm of [...names].sort()) {
		if (used.has(nm))
			continue;
		for (const [a, b] of pats) {
			if (nm.toUpperCase().endsWith(a) && nm.length > a.length + 1) {
				const m = nm.slice(0, nm.length - a.length) + (nm.endsWith(a) ? b : b.toLowerCase());
				if (S.has(m) && !used.has(m)) {
					if (a === 'P' && !/(TX|RX|CK|CLK|D\d|LVDS|DAT\d*|IN|OUT)P$/.test(nm.toUpperCase()))
						continue;
					out.push([nm, m]);
					used.add(nm);
					used.add(m);
					break;
				}
			}
		}
	}
	return out;
}

class SegIndex {
	grid = new Map<string, number[]>();
	constructor(public items: [string, Seg][], public cell = 1) {
		items.forEach(([, s], k) => {
			for (let i = Math.floor(Math.min(s[1], s[3]) / cell); i <= Math.floor(Math.max(s[1], s[3]) / cell); i++) {
				for (let j = Math.floor(Math.min(s[2], s[4]) / cell); j <= Math.floor(Math.max(s[2], s[4]) / cell); j++) {
					const key = `${s[0]},${i},${j}`;
					if (!this.grid.has(key))
						this.grid.set(key, []);
					this.grid.get(key)!.push(k);
				}
			}
		});
	}

	near(layer: number, x: number, y: number, r: number): [string, Seg][] {
		const c = this.cell;
		const seen = new Set<number>();
		const out: [string, Seg][] = [];
		for (let i = Math.floor((x - r) / c); i <= Math.floor((x + r) / c); i++) {
			for (let j = Math.floor((y - r) / c); j <= Math.floor((y + r) / c); j++) {
				for (const k of this.grid.get(`${layer},${i},${j}`) ?? []) {
					if (!seen.has(k)) {
						seen.add(k);
						out.push(this.items[k]);
					}
				}
			}
		}
		return out;
	}
}

function* samples(segs: Seg[], step = 0.2): Generator<[Seg, number, number, number]> {
	for (const s of segs) {
		if (s[6])
			continue;
		const L = segLen(s);
		const k = Math.max(1, Math.floor(L / step));
		for (let i = 0; i < k; i++) {
			const t = (i + 0.5) / k;
			yield [s, s[1] + t * (s[3] - s[1]), s[2] + t * (s[4] - s[2]), L / k];
		}
	}
}

function proj(x: number, y: number, s: Seg): Pt {
	const dx = s[3] - s[1];
	const dy = s[4] - s[2];
	const L2 = dx * dx + dy * dy;
	const t = L2 < 1e-18 ? 0 : Math.max(0, Math.min(1, ((x - s[1]) * dx + (y - s[2]) * dy) / L2));
	return [s[1] + t * dx, s[2] + t * dy];
}

export function checkDiffPairs(ctx: Ctx, nets: Net[], classes: Record<string, string>, routedLen: Record<string, number>): { p: string; n: string; class: string }[] {
	const by = new Map(nets.map(n => [n.name, n]));
	const consPairs = (ctx.cons.pairs ?? []).filter(p => by.has(p.p) && by.has(p.n)).map(p => [p.p, p.n] as [string, string]);
	const pairs = consPairs.length ? consPairs : pairNames(nets.filter(n => n.segs.length).map(n => n.name));
	const others: [string, Seg][] = [];
	for (const n of nets) {
		if (classes[n.name] === 'GND')
			continue;
		for (const s of n.segs) {
			if (!s[6])
				others.push([n.name, s]);
		}
	}
	const idx = new SegIndex(others);
	const found: { p: string; n: string; class: string }[] = [];
	for (const [a, b] of pairs) {
		const A = by.get(a);
		const B = by.get(b);
		if (!A || !B || !A.segs.length || !B.segs.length)
			continue;
		const cls = PAIR_SKEW[classes[a]] ? classes[a] : PAIR_SKEW[classes[b]] ? classes[b] : classes[a];
		const imped = !!PAIR_SKEW[cls];
		found.push({ p: a, n: b, class: cls });
		const nm = `${a}/${b}`;
		const ids = [...A.segs, ...B.segs].map(s => s[7]).filter(Boolean) as string[];
		const la = [...new Set(A.segs.map(s => s[0]))].sort((x, y) => x - y);
		const lb = [...new Set(B.segs.map(s => s[0]))].sort((x, y) => x - y);
		if (la.join() !== lb.join())
			ctx.add('RTD-01', imped ? 'P1' : 'P2', nm, null, null, `差分对 ${nm} 两根线用的层不同（[${la.map(x => x + 1).join(', ')}] 对 [${lb.map(x => x + 1).join(', ')}]）：应同层同时换层`, undefined, 'VF-28', ids);
		const pitch: [number, number, number, number, Seg, Seg][] = [];
		let coupled = 0;
		let total = 0;
		const intr = new Map<string, [number, number, number]>();
		const tight = new Map<string, [number, [number, number, number], number]>();
		const w = median(A.segs.map(s => s[5]));
		for (const [s, x, y, dl] of samples(A.segs)) {
			total += dl;
			const same = B.segs.filter(t => t[0] === s[0] && !t[6]);
			if (!same.length)
				continue;
			let best: [number, Seg] | null = null;
			for (const t of same) {
				const d = ptSeg(x, y, t[1], t[2], t[3], t[4]);
				if (!best || d < best[0])
					best = [d, t];
			}
			const [d, t] = best!;
			const ang = angleBetween([s[3] - s[1], s[4] - s[2]], [t[3] - t[1], t[4] - t[2]]);
			if (Math.min(ang, 180 - ang) <= 2 && d <= Math.max(1.2, 6 * w))
				pitch.push([d, x, y, dl, s, t]);
		}
		if (pitch.length) {
			const med = median(pitch.map(p => p[0]));
			const lim = Math.max(med * 1.3, med + 0.05);
			const cp = pitch.filter(p => p[0] <= lim);
			coupled = cp.reduce((s, p) => s + p[3], 0);
			const ds = cp.map(p => p[0]);
			const dev = ds.length ? Math.max(...ds.map(x => Math.abs(x - med))) : 0;
			if (ds.length >= 3 && dev > Math.max(0.1 * med, 0.03)) {
				let p = cp[0];
				for (const q of cp) {
					if (Math.abs(q[0] - med) > Math.abs(p[0] - med))
						p = q;
				}
				ctx.add('RTD-03', imped ? 'P2' : 'P3', nm, p[4][0], [p[1], p[2]], `差分对 ${nm} 间距不一致：中心距中位数 ${med.toFixed(2)} mm，最大偏差 ${dev.toFixed(2)} mm（≤ 10%）`, round(dev, 3), 'VF-28', ids);
			}
			for (const [d, x, y, dl, s, t] of cp) {
				const [qx, qy] = proj(x, y, t);
				for (const [on, o] of idx.near(s[0], (x + qx) / 2, (y + qy) / 2, d / 2 + 1)) {
					if (on === a || on === b)
						continue;
					if (segSeg([x, y, qx, qy], [o[1], o[2], o[3], o[4]]) < o[5] / 2 - 1e-6 && !intr.has(on))
						intr.set(on, [x, y, s[0]]);
				}
				for (const [on, o] of idx.near(s[0], x, y, 3 * w + 1)) {
					if (on === a || on === b)
						continue;
					const e = ptSeg(x, y, o[1], o[2], o[3], o[4]) - (o[5] + s[5]) / 2;
					if (e < Math.max(2 * (d - s[5]), 3 * s[5]) - 1e-6) {
						const r = tight.get(on) ?? [0, [x, y, s[0]], e];
						r[0] += dl;
						r[2] = Math.min(r[2], e);
						tight.set(on, r);
					}
				}
			}
		}
		const un = total - coupled;
		if (total > 0 && un > Math.max(4, 0.15 * total))
			ctx.add('RTD-02', imped ? 'P2' : 'P3', nm, null, null, `差分对 ${nm} 只有 ${Math.round((coupled / total) * 100)}% 的长度是并行耦合的（未耦合 ${un.toFixed(1)} mm；出焊盘的分开段合计 ≤ 4 mm）`, round(coupled / total, 2), 'VF-28', ids);
		for (const [on, [x, y, l]] of intr) ctx.add('RTD-06', 'P1', nm, l, [x, y], `差分对 ${nm} 中间穿过了 ${on}`, undefined, 'VF-28', ids);
		for (const [on, [L, [x, y, l], e]] of tight) {
			if (L >= 2)
				ctx.add('RTD-07', 'P3', nm, l, [x, y], `差分对 ${nm} 与 ${on} 并行 ${L.toFixed(1)} mm、边距 ${e.toFixed(2)} mm（建议 ≥ 2 倍对内线距且 ≥ 3 倍线宽）`, round(e, 3), 'VF-28', ids);
		}
		const [lo, hi] = PAIR_SKEW[cls] ?? PAIR_DEFAULT_SKEW;
		const skew = Math.abs((routedLen[a] ?? 0) - (routedLen[b] ?? 0));
		if (skew > hi)
			ctx.add('RTD-04', imped ? 'P1' : 'P2', nm, null, null, `差分对 ${nm} 长度差 ${skew.toFixed(2)} mm（${cls} 上限 ${hi}）`, round(skew, 2), 'VF-28', ids);
		else if (skew > lo)
			ctx.add('RTD-04', imped ? 'P2' : 'P3', nm, null, null, `差分对 ${nm} 长度差 ${skew.toFixed(2)} mm（${cls} 建议 ≤ ${lo}）`, round(skew, 2), 'VF-28', ids);
		const va = A.vias;
		const vb = B.vias;
		if (va.length !== vb.length) {
			const v0 = (va.length ? va : vb)[0];
			ctx.add('RTD-05', imped ? 'P1' : 'P2', nm, null, [v0[0], v0[1]], `差分对 ${nm} 过孔不成对（${va.length} 对 ${vb.length}）`, undefined, 'VF-28', [...va, ...vb].map(v => v[3] ?? '').filter(Boolean));
		}
		else {
			for (const v of va) {
				const d = vb.length ? Math.min(...vb.map(u => hypot(v[0] - u[0], v[1] - u[1]))) : 1e9;
				if (d > 1.5) {
					ctx.add('RTD-05', 'P2', nm, null, [v[0], v[1]], `差分对 ${nm} 的过孔没有并排放（最近的对侧过孔 ${d.toFixed(1)} mm，≤ 1.5 mm）`, round(d, 2), 'VF-28');
					break;
				}
			}
		}
	}
	return found;
}

export function elbows(P: Pt, Q: Pt): Pt[][] {
	const dx = Q[0] - P[0];
	const dy = Q[1] - P[1];
	if (isOcti(dx, dy, 1e-6))
		return [[P, Q]];
	const ax = Math.abs(dx);
	const ay = Math.abs(dy);
	const sx = Math.sign(dx) || 1;
	const sy = Math.sign(dy) || 1;
	const d = Math.min(ax, ay);
	const r = Math.max(ax, ay) - d;
	const m1: Pt = [P[0] + sx * d, P[1] + sy * d];
	const m2: Pt = ax > ay ? [P[0] + sx * r, P[1]] : [P[0], P[1] + sy * r];
	return [[P, m1, Q], [P, m2, Q]];
}

export function checkPriority(ctx: Ctx, nets: Net[], classes: Record<string, string>, clear = 0.15): void {
	const by = new Map(nets.map(n => [n.name, n]));
	const troubled = new Map<string, string>();
	for (const v of ctx.out) {
		if (['RTV-01', 'RTL-02', 'RTL-01', 'RTL-03'].includes(v.rule) && v.net && by.has(v.net) && !troubled.has(v.net))
			troubled.set(v.net, v.rule);
	}
	const segs: [string, Seg][] = [];
	for (const n of nets) {
		for (const s of n.segs) {
			if (!s[6])
				segs.push([n.name, s]);
		}
	}
	const idx = new SegIndex(segs, 1);
	const padsAll: [string, Pad][] = nets.flatMap(n => n.pads.map(p => [n.name, p] as [string, Pad]));
	for (const [name, why] of troubled) {
		const n = by.get(name)!;
		const t0 = tierOf(classes[name]);
		if (t0 > 6)
			continue;
		const w = n.segs.length ? median(n.segs.map(s => s[5])) : 0.2;
		const pts = n.pads;
		let done = false;
		for (let i = 0; i < pts.length; i++) {
			for (let j = i + 1; j < pts.length; j++) {
				if (done || pts[i].ref === pts[j].ref)
					continue;
				const P: Pt = [pts[i].x, pts[i].y];
				const Q: Pt = [pts[j].x, pts[j].y];
				if (dist(P, Q) > 25)
					continue;
				const layer = pts[i].l !== -1 ? pts[i].l : 0;
				const lower = new Set<string>();
				let placement = false;
				let ok = false;
				for (const c of elbows(P, Q)) {
					const blk = new Set<string>();
					for (let k = 0; k < c.length - 1; k++) {
						const [a, b] = [c[k], c[k + 1]];
						for (const [on, s] of idx.near(layer, (a[0] + b[0]) / 2, (a[1] + b[1]) / 2, dist(a, b) / 2 + 1)) {
							if (on !== name && segSeg([a[0], a[1], b[0], b[1]], [s[1], s[2], s[3], s[4]]) < (s[5] + w) / 2 + clear)
								blk.add(on);
						}
					}
					const pb = padsAll.some(([on, q]) => on !== name && (q.l === -1 || q.l === layer) && !!q.w && q.ref !== pts[i].ref && q.ref !== pts[j].ref
						&& c.slice(0, -1).some((a, k) => segPad([a[0], a[1], c[k + 1][0], c[k + 1][1]], q) < w / 2 + clear));
					if (!blk.size && !pb) {
						ok = true;
						break;
					}
					placement = placement || pb;
					for (const x of blk) lower.add(x);
				}
				if (ok || !lower.size || placement)
					continue;
				if ([...lower].every(on => tierOf(classes[on] ?? 'SIG') > t0)) {
					const names = [...lower].sort().slice(0, 3).join('、');
					ctx.add('RTO-01', 'P2', name, layer, [(P[0] + Q[0]) / 2, (P[1] + Q[1]) / 2], `优先级倒挂：${TIER_NAME[t0]}网络 ${name}（${why}）的直连通道被低优先级网络 ${names} 占了，应先布 ${name}，再让 ${names} 绕开`, undefined, 'VF-30');
					done = true;
				}
			}
		}
	}
}

export function checkIsolation(ctx: Ctx, nets: Net[], classes: Record<string, string>): void {
	const agg: [string, Seg][] = [];
	const vic: [string, Seg][] = [];
	for (const n of nets) {
		for (const s of n.segs) {
			if (s[6])
				continue;
			if (AGGRESSOR.has(classes[n.name]))
				agg.push([n.name, s]);
			if (VICTIM.has(classes[n.name]))
				vic.push([n.name, s]);
		}
	}
	const acc = new Map<string, [number, number, Pt, number, string, string]>();
	for (const [an, a] of agg) {
		for (const [vn, v] of vic) {
			if (a[0] !== v[0])
				continue;
			const u: Pt = [a[3] - a[1], a[4] - a[2]];
			const ang = angleBetween(u, [v[3] - v[1], v[4] - v[2]]);
			if (Math.min(ang, 180 - ang) > 2)
				continue;
			const La = hypot(u[0], u[1]);
			if (La < 1e-6)
				continue;
			const ux = u[0] / La;
			const uy = u[1] / La;
			const t1 = (v[1] - a[1]) * ux + (v[2] - a[2]) * uy;
			const t2 = (v[3] - a[1]) * ux + (v[4] - a[2]) * uy;
			const ov = Math.min(La, Math.max(t1, t2)) - Math.max(0, Math.min(t1, t2));
			if (ov <= 0)
				continue;
			const gap = Math.abs((v[1] - a[1]) * uy - (v[2] - a[2]) * ux) - (a[5] + v[5]) / 2;
			if (gap < Math.max(0.5, 3 * v[5])) {
				const key = `${an}\u0000${vn}`;
				const t = Math.max(0, Math.min(t1, t2));
				const r = acc.get(key) ?? [0, gap, [a[1] + ux * t, a[2] + uy * t], a[0], an, vn];
				r[0] += ov;
				r[1] = Math.min(r[1], gap);
				acc.set(key, r);
			}
		}
	}
	for (const [L, gap, at, l, an, vn] of acc.values()) {
		if (L > 5)
			ctx.add('RTS-06', L <= 10 ? 'P2' : 'P1', `${an}/${vn}`, l, at, `攻击网络 ${an}（${classes[an]}）与敏感网络 ${vn}（${classes[vn]}）同层并行 ${L.toFixed(1)} mm、边距 ${gap.toFixed(2)} mm（≤ 5 mm 或拉开到 ≥ 3h，中间加地）`, round(L, 1), 'VF-30');
	}
}

export interface OrderRow { tier: number; tier_name: string; net: string; class: string; pads: number; len: number; why: string }

export function routingOrder(nets: Net[], classes: Record<string, string>): OrderRow[] {
	const pins = new Map<string, number>();
	for (const n of nets) {
		for (const p of n.pads) pins.set(p.ref, (pins.get(p.ref) ?? 0) + 1);
	}
	const rows: [number, number, number, string, string, number][] = [];
	for (const n of nets) {
		if (!n.pads.length)
			continue;
		const c = classes[n.name];
		const dense = Math.max(0, ...n.pads.filter(p => isIc(p.ref)).map(p => pins.get(p.ref) ?? 0));
		rows.push([tierOf(c), -dense, octMst(n.pads.map(p => [p.x, p.y] as Pt)), n.name, c, n.pads.length]);
	}
	rows.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2] || (a[3] < b[3] ? -1 : a[3] > b[3] ? 1 : 0));
	const why = Object.fromEntries(TIERS.map(([t, , , r]) => [t, r]));
	return rows.map(([t, , L, nm, c, k]) => ({ tier: t, tier_name: TIER_NAME[t], net: nm, class: c, pads: k, len: round(L, 1), why: why[t] }));
}

export function analyzePrinciples(ctx: Ctx, nets: Net[], classes: Record<string, string>, values: Record<string, string>, nL: number, hasPlane: boolean, routedLen: Record<string, number>): { p: string; n: string; class: string }[] {
	checkGround(ctx, nets, classes, nL);
	checkProximity(ctx, nets, classes, values, nL, hasPlane);
	const pairs = checkDiffPairs(ctx, nets, classes, routedLen);
	checkIsolation(ctx, nets, classes);
	checkPriority(ctx, nets, classes);
	return pairs;
}
