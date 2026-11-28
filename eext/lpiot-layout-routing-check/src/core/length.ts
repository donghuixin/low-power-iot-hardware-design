/**
 * 等长组（与 scripts/route_lint.py RTL-07、scripts/route_fix.py --length 一致）：
 * 用户在 G4 里确认“哪几根线要等长、容差多少”，检查器报出偏短的网络，修复器只在偏短网络的一段直线上加局部蛇形线补齐。
 *
 * 蛇形线全部是八方向、拐角 135°（没有直角）：每个凸起 = 45° 斜上 → 竖直 → 45° → 平顶 → 45° → 竖直 → 45° 回到基线。
 * 每个凸起增加的长度 = 2A − 4c(2 − √2)，A 是凸起高度，c 是斜切长度（取线宽）；差得很少时用 45° 梯形小凸起，增加 2A(√2 − 1)。
 */
import type { FixPlan } from './fix';
import type { Pt, Seg } from './geom';
import type { Board, Net } from './model';
import { padCorners, pointInPoly, ptSeg, segSeg } from './geom';

export interface LengthGroup { name: string; nets: string[]; tol_mm: number }
export interface LengthRow { group: string; net: string; len: number; target: number; deficit: number }

export function netLength(n: Net): number {
	return n.segs.reduce((s, q) => s + Math.hypot(q[3] - q[1], q[4] - q[2]), 0);
}

/** 每组：以最长的网络为目标，比目标短超过容差的网络就是要补的 */
export function lengthRows(board: Board, groups: LengthGroup[]): LengthRow[] {
	const by = new Map(board.nets.map(n => [n.name, n]));
	const out: LengthRow[] = [];
	for (const g of groups ?? []) {
		const ls = g.nets.filter(x => by.has(x)).map(x => [x, netLength(by.get(x)!)] as [string, number]);
		if (ls.length < 2)
			continue;
		const target = Math.max(...ls.map(x => x[1]));
		for (const [net, len] of ls) out.push({ group: g.name, net, len: r4(len), target: r4(target), deficit: r4(Math.max(0, target - len - (g.tol_mm ?? 0))) });
	}
	return out;
}

function r4(x: number): number {
	return Math.round(x * 10000) / 10000;
}

/** 一段直线 A→B 上的蛇形：在 [s0, s0 + span] 范围内放 N 个凸起，side = ±1 选左右 */
export function meander(A: Pt, B: Pt, w: number, amp: number, n: number, s0: number, side: number): Pt[] {
	const L = Math.hypot(B[0] - A[0], B[1] - A[1]);
	const u: Pt = [(B[0] - A[0]) / L, (B[1] - A[1]) / L];
	const nv: Pt = [-u[1] * side, u[0] * side];
	const c = w;
	const t = w;
	const at = (s: number, h: number): Pt => [r4(A[0] + u[0] * s + nv[0] * h), r4(A[1] + u[1] * s + nv[1] * h)];
	const pts: Pt[] = [A];
	let s = s0;
	for (let k = 0; k < n; k++) {
		if (amp >= 2 * c) // 带竖直段的凸起
			pts.push(at(s, 0), at(s + c, c), at(s + c, amp - c), at(s + 2 * c, amp), at(s + 2 * c + t, amp), at(s + 3 * c + t, amp - c), at(s + 3 * c + t, c), at(s + 4 * c + t, 0));
		else // 差得很少：45° 梯形小凸起（高 amp）
			pts.push(at(s, 0), at(s + amp, amp), at(s + amp + t, amp), at(s + 2 * amp + t, 0));
		s += bumpPitch(w, amp);
	}
	pts.push(B);
	// 去掉重合点
	return pts.filter((p, i) => i === 0 || Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]) > 1e-6);
}

export const bumpAdd = (amp: number, w: number) => (amp >= 2 * w ? 2 * amp - 4 * w * (2 - Math.SQRT2) : 2 * amp * (Math.SQRT2 - 1));
/** 每个凸起要补 add mm 时的高度（与 bumpAdd 互逆） */
export const bumpAmp = (add: number, w: number) => (add >= bumpAdd(2 * w, w) ? (add + 4 * w * (2 - Math.SQRT2)) / 2 : add / (2 * (Math.SQRT2 - 1)));
export const bumpPitch = (w: number, amp = 2 * w) => (amp >= 2 * w ? 6 * w : 2 * amp + 2 * w);
const AMPS = [12, 8, 6, 4, 3, 2, 1.5, 1, 0.6, 0.3];

/** 在线段 sg 上放 nb 个高 amp 的凸起：可选的起点（中间优先，再向两端各挪几步），放不下返回 null */
function fit(sg: Seg, amp: number, nb: number): number[] | null {
	const w = sg[5];
	const L = Math.hypot(sg[3] - sg[1], sg[4] - sg[2]);
	const margin = Math.max(0.3, 2 * w); // 离线段两端（焊盘、过孔、拐角）留一点直线
	const span = nb * bumpPitch(w, amp) - w;
	if (span > L - 2 * margin)
		return null;
	const mid = (L - span) / 2;
	const room = mid - margin;
	const out = [mid];
	for (let k = 1; k <= 5; k++) out.push(mid - (room * k) / 5, mid + (room * k) / 5);
	return out;
}

type Pick = [Seg, number, number, Pt[]];
type OkFn = (pts: Pt[], w: number, layer: number, net: string, skip: Seg) => boolean;

function tryPlace(sg: Seg, w: number, amp: number, nb: number, s0s: number[], ok: OkFn, net: string): Pick | null {
	for (const s0 of s0s) {
		for (const side of [1, -1]) {
			const pts = meander([sg[1], sg[2]], [sg[3], sg[4]], w, r4(amp), nb, s0, side);
			if (ok(pts, w, sg[0], net, sg))
				return [sg, nb, amp, pts];
		}
	}
	return null;
}

/** 把 need mm 分到网络的几段直线上：先试一段补齐，补不齐就每段放能放下的最大凸起，最后一段按剩下的量精确算高度 */
function place(n: Net, need: number, ok: OkFn): Pick[] | null {
	const cands = n.segs.filter(s => !s[6]).sort((a, b) => Math.hypot(b[3] - b[1], b[4] - b[2]) - Math.hypot(a[3] - a[1], a[4] - a[2]));
	const picks: Pick[] = [];
	let left = need;
	for (const sg of cands) {
		if (left <= 1e-4)
			break;
		const w = sg[5];
		let got: Pick | null = null;
		for (let nb = 1; nb < 40; nb++) {
			const amp = bumpAmp(left / nb, w);
			if (amp > 12 * w)
				continue;
			if (amp < 0.3 * w)
				break;
			const s0s = fit(sg, amp, nb);
			if (!s0s)
				break;
			got = tryPlace(sg, w, amp, nb, s0s, ok, n.name);
			if (got)
				break;
		}
		if (got) {
			picks.push(got);
			left = 0;
			break;
		}
		for (const k of AMPS) {
			const amp = k * w;
			let nb = 1;
			while (fit(sg, amp, nb + 1) && nb * bumpAdd(amp, w) < left) nb++;
			const s0s = fit(sg, amp, nb);
			if (!s0s || nb * bumpAdd(amp, w) >= left)
				continue;
			got = tryPlace(sg, w, amp, nb, s0s, ok, n.name);
			if (got)
				break;
		}
		if (got) {
			picks.push(got);
			left -= got[1] * bumpAdd(got[2], w);
		}
	}
	return left <= 1e-4 ? picks : null;
}

interface Ob { a: Pt; b: Pt; r: number; layer: number; net: string }

/** 给偏短的网络加蛇形线的方案（和几何修复同一种 FixPlan，可以预览、写回、撤销） */
export function planLengthMatch(board: Board, groups: LengthGroup[], opt: { clearance?: number; nets?: string[] } = {}): FixPlan & { rows: LengthRow[] } {
	const clear = opt.clearance ?? 0.15;
	const rows = lengthRows(board, groups);
	const plan: FixPlan & { rows: LengthRow[] } = { fixed: [], manual: [], changes: [], rows };
	const obs: Ob[] = [];
	for (const n of board.nets) {
		for (const s of n.segs) obs.push({ a: [s[1], s[2]], b: [s[3], s[4]], r: s[5] / 2, layer: s[0], net: n.name });
		for (const v of n.vias) obs.push({ a: [v[0], v[1]], b: [v[0], v[1]], r: v[2] / 2, layer: -1, net: n.name });
	}
	const padsAll = board.nets.flatMap(n => n.pads.map(p => ({ p, net: n.name })));
	const outline = board.outline ?? [];
	const ok = (pts: Pt[], w: number, layer: number, net: string, skip: Seg): boolean => {
		for (let i = 0; i + 1 < pts.length; i++) {
			const s: [number, number, number, number] = [pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]];
			if (outline.length > 2 && !(pointInPoly(s[0], s[1], outline) && pointInPoly(s[2], s[3], outline)))
				return false;
			for (const o of obs) {
				if (o.layer !== -1 && o.layer !== layer)
					continue;
				if (o.net === net) {
					// 同一网络：只和不相邻的线段比，保持 2 倍线宽，避免蛇形贴上自己的其他走线
					if (o.layer === layer && o.a[0] === skip[1] && o.a[1] === skip[2] && o.b[0] === skip[3] && o.b[1] === skip[4])
						continue;
					const d = segSeg(s, [o.a[0], o.a[1], o.b[0], o.b[1]]);
					if (d > 1e-6 && d < w + 2 * w && !touches(pts, o))
						return false;
					continue;
				}
				if (segSeg(s, [o.a[0], o.a[1], o.b[0], o.b[1]]) - o.r - w / 2 < clear)
					return false;
			}
			for (const { p, net: pn } of padsAll) {
				if (pn === net || (p.l !== -1 && p.l !== layer))
					continue;
				const cs = padCorners({ ...p, w: p.w ?? 0.5, h: p.h ?? p.w ?? 0.5 });
				const d = Math.min(...cs.map((c, k) => segSeg(s, [c[0], c[1], cs[(k + 1) % 4][0], cs[(k + 1) % 4][1]])), pointInPoly(s[0], s[1], cs) ? 0 : 1e9);
				if (d - w / 2 < clear)
					return false;
			}
		}
		return true;
	};
	const touches = (pts: Pt[], o: Ob) => [pts[0], pts[pts.length - 1]].some(e => Math.hypot(e[0] - o.a[0], e[1] - o.a[1]) < 1e-6 || Math.hypot(e[0] - o.b[0], e[1] - o.b[1]) < 1e-6);
	const by = new Map(board.nets.map(n => [n.name, n]));
	for (const row of rows) {
		if (row.deficit <= 0 || (opt.nets && !opt.nets.includes(row.net)))
			continue;
		const n = by.get(row.net)!;
		const need = row.target - row.len; // 补到和最长的一样长
		const picks = place(n, need, ok);
		if (!picks) {
			plan.manual.push({ net: n.name, issues: ['length'], reason: `差 ${need.toFixed(2)} mm，找不到够长、够空的直线段加蛇形线，需要人工绕线` });
			continue;
		}
		for (const [sg, nb, amp, pts] of picks) {
			const add: Seg[] = [];
			for (let i = 0; i + 1 < pts.length; i++) add.push([sg[0], pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1], sg[5], false]);
			plan.changes.push({ net: n.name, remove: sg[7] ? [sg[7]] : [], add });
			plan.fixed.push({ net: n.name, layer: sg[0], from: [sg[1], sg[2]], to: [sg[3], sg[4]], issues: ['length'], how: `serpentine ×${nb}，A=${amp.toFixed(2)} mm，+${(nb * bumpAdd(amp, sg[5])).toFixed(2)} mm`, before: [[sg[1], sg[2]], [sg[3], sg[4]]], after: pts });
		}
	}
	return plan;
}

/** RTL-07 违规（给检查报告用） */
export function lengthViolations(board: Board, groups: LengthGroup[]): { rule: string; sev: 'P1'; net: string; layer: null; msg: string; value: number; metric: string }[] {
	return lengthRows(board, groups).filter(r => r.deficit > 0).map(r => ({
		rule: 'RTL-07',
		sev: 'P1' as const,
		net: r.net,
		layer: null,
		msg: `等长组“${r.group}”：${r.net} 长 ${r.len.toFixed(2)} mm，比最长的 ${r.target.toFixed(2)} mm 短 ${(r.target - r.len).toFixed(2)} mm（容差内还差 ${r.deficit.toFixed(2)} mm）`,
		value: r.deficit,
		metric: 'VF-26',
	}));
}

/** 线段上一点到折线的最近距离（测试用） */
export function distToPolyline(p: Pt, pts: Pt[]): number {
	let d = Infinity;
	for (let i = 0; i + 1 < pts.length; i++) d = Math.min(d, ptSeg(p[0], p[1], pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]));
	return d;
}
