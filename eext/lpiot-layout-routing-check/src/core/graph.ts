import type { Pad, Pt, Seg, Via } from './geom';
import { dist, hypot, ptInPad, ptSeg, segLen } from './geom';

const WELD = 1e4;
export function wkey(x: number, y: number): string {
	return `${Math.round(x * WELD)},${Math.round(y * WELD)}`;
}

export interface Edge { a: Pt; b: Pt; w: number; arc: boolean; src: number; ka: string; kb: string }
export interface Node { p: Pt; e: number[]; pad: Pad | null; via: boolean; wchange: boolean; arc: boolean; anchor: boolean }
export interface Chain { keys: string[]; edges: number[]; pts: Pt[]; w: number; arc: boolean; len: number }

/** 一个网络在一层上的走线图：端点焊接，T 接点切开线段，锚点 = 焊盘 / 过孔 / 分支 / 线宽变化 / 圆弧 */
export class Graph {
	layer: number;
	pads: Pad[];
	edges: Edge[] = [];
	nodes = new Map<string, Node>();
	chains: Chain[];

	constructor(segs: Seg[], pads: Pad[], vias: Via[], layer: number) {
		this.layer = layer;
		this.pads = pads.filter(p => p.l === -1 || p.l === layer);
		const ends: Pt[] = [...segs.map(s => [s[1], s[2]] as Pt), ...segs.map(s => [s[3], s[4]] as Pt)];
		segs.forEach((s, i) => {
			let ts: number[] = [];
			if (!s[6]) {
				const L = segLen(s);
				for (const [x, y] of ends) {
					if (L > 1e-6 && ptSeg(x, y, s[1], s[2], s[3], s[4]) < 1e-4) {
						const t = ((x - s[1]) * (s[3] - s[1]) + (y - s[2]) * (s[4] - s[2])) / (L * L);
						if (t * L > 1e-4 && t * L < L - 1e-4)
							ts.push(t);
					}
				}
			}
			ts = [...new Set(ts.map(t => Math.round(t * 1e9) / 1e9))].sort((a, b) => a - b);
			const pts: Pt[] = [[s[1], s[2]], ...ts.map(t => [s[1] + t * (s[3] - s[1]), s[2] + t * (s[4] - s[2])] as Pt), [s[3], s[4]]];
			for (let k = 0; k < pts.length - 1; k++) this.edges.push({ a: pts[k], b: pts[k + 1], w: s[5], arc: s[6], src: i, ka: '', kb: '' });
		});
		this.edges.forEach((e, k) => {
			for (const end of ['a', 'b'] as const) {
				const p = e[end];
				const key = wkey(p[0], p[1]);
				let nd = this.nodes.get(key);
				if (!nd) {
					nd = { p, e: [], pad: null, via: false, wchange: false, arc: false, anchor: false };
					this.nodes.set(key, nd);
				}
				nd.e.push(k);
				if (end === 'a')
					e.ka = key;
				else e.kb = key;
			}
		});
		for (const nd of this.nodes.values()) {
			const [x, y] = nd.p;
			nd.pad = this.pads.find(p => ptInPad(x, y, p)) ?? null;
			nd.via = vias.some(v => hypot(x - v[0], y - v[1]) <= v[2] / 2 + 1e-3);
			nd.wchange = new Set(nd.e.map(k => Math.round(this.edges[k].w * 1e4))).size > 1;
			nd.arc = nd.e.some(k => this.edges[k].arc);
			nd.anchor = nd.e.length !== 2 || nd.pad !== null || nd.via || nd.wchange || nd.arc;
		}
		this.chains = this.buildChains();
	}

	other(k: number, key: string): string {
		const e = this.edges[k];
		return e.ka === key ? e.kb : e.ka;
	}

	vec(k: number, key: string): Pt {
		const e = this.edges[k];
		const [a, b] = e.ka === key ? [e.a, e.b] : [e.b, e.a];
		return [b[0] - a[0], b[1] - a[1]];
	}

	node(key: string): Node {
		return this.nodes.get(key)!;
	}

	private buildChains(): Chain[] {
		const seen = new Set<number>();
		const raw: { keys: string[]; edges: number[] }[] = [];
		const walk = (start: string, k0: number) => {
			const keys = [start];
			const ks: number[] = [];
			let cur = start;
			let k = k0;
			for (;;) {
				seen.add(k);
				ks.push(k);
				cur = this.other(k, cur);
				keys.push(cur);
				const nd = this.node(cur);
				if (nd.anchor || cur === start)
					break;
				const nxt = nd.e.filter(q => !seen.has(q));
				if (!nxt.length)
					break;
				k = nxt[0];
			}
			return { keys, edges: ks };
		};
		for (const [key, nd] of this.nodes) {
			if (nd.anchor) {
				for (const k of nd.e) {
					if (!seen.has(k))
						raw.push(walk(key, k));
				}
			}
		}
		for (let k = 0; k < this.edges.length; k++) {
			if (!seen.has(k)) {
				const key = this.edges[k].ka;
				this.node(key).anchor = true;
				raw.push(walk(key, k));
			}
		}
		return raw.map((c) => {
			const pts = c.keys.map(k => this.node(k).p);
			let len = 0;
			for (let i = 0; i < pts.length - 1; i++) len += dist(pts[i], pts[i + 1]);
			return { ...c, pts, w: this.edges[c.edges[0]].w, arc: c.edges.some(k => this.edges[k].arc), len };
		});
	}
}
