/**
 * 出图前检查（与 scripts/finish_lint.py 一致）：丝印 SLK、位号编号 ANN、泪滴 TDR，对照设计确认 G5 里用户做出的决定。
 * 输入是“中间模型”：Python 从 KiCad 提取，扩展从嘉立创 EDA 读取（读不到泪滴和封装自带的丝印线）。
 */
import type { Pad, Pt } from './geom';
import type { Board } from './model';
import { finishRulesHash, finishUnresolved } from './brief';
import { padCorners, pointInPoly, ptSeg } from './geom';
import { roleOf } from './layout';

export type R4 = [number, number, number, number];
export interface FinishPad { pin: string; net: string; rect: R4; side: string }
export interface FinishPart { ref: string; value?: string | null; side: string; rect: R4; pads: FinishPad[] }
export interface FinishText { text: string; kind: 'ref' | 'value' | 'text'; owner: string; side: string; x: number; y: number; h: number; w: number; rot: number; mirror: boolean; hidden: boolean; bbox: R4; id?: string }
export interface FinishLine { side: string; x1: number; y1: number; x2: number; y2: number; w: number; owner: string }
export interface Junction { net: string; cls: string; kind: 'via' | 'pad' | 'tht'; x: number; y: number; size: number; trace_w: number; dir: Pt; teardrop: boolean | null; ref: string | null; pin: string | null; layer: number }
export interface FinishModel {
	kind: 'lpiot-finish-model';
	version: number;
	outline: Pt[] | null;
	parts: FinishPart[];
	texts: FinishText[];
	lines: FinishLine[];
	junctions: Junction[];
	teardrop_source: string;
	silk_graphics_source: string;
	ref_counts?: Record<string, number>;
}
export interface FinishIssue { rule: string; sev: 'P0' | 'P1' | 'P2' | 'P3'; refs: string[]; msg: string; fix?: string; at?: Pt; box?: R4 }
export interface FinishReport {
	kind: 'lpiot-finish-lint';
	version: number;
	p0: number;
	p1: number;
	p2: number;
	p3: number;
	pass: boolean;
	unresolved_p1: number;
	issues: FinishIssue[];
	teardrop_source: string;
	silk_graphics_source: string;
	rules_hash?: string;
	note?: string;
}

export const PROCESS: Record<string, [number, number]> = { 标准丝印: [0.153, 1.0], 高精度丝印: [0.1, 0.8], 镂空字: [0.2, 1.5] };
const TOL = 0.005;
const KEY_ROLES = new Set(['ic', 'soc_rf', 'rf_module', 'connector', 'crystal', 'button', 'diode', 'battery', 'inductor', 'antenna', 'dcdc', 'ldo', 'charger', 'imu', 'magnetometer', 'temp_humidity', 'barometer', 'microphone', 'testpoint']);
const POLARIZED = new Set(['diode', 'battery']);
const UNIT_OF_PREFIX: Record<string, string> = { R: 'Ω', C: 'F', L: 'H' };
const SENSITIVE = new Set(['RF50', 'USB90', 'DIFF100']);

// ------------------------------------------------------------------ 几何
function r3(x: number): number {
	return Math.round(x * 1000) / 1000;
}
function r4(x: number): number {
	return Math.round(x * 10000) / 10000;
}
/** 与 Python 的 {x:g} 一致（常见数值） */
export function fmtG(x: number): string {
	return String(Number(x.toPrecision(6)));
}
export function rectDist(a: R4, b: R4): number {
	const dx = Math.max(0, Math.max(a[0], b[0]) - Math.min(a[2], b[2]));
	const dy = Math.max(0, Math.max(a[1], b[1]) - Math.min(a[3], b[3]));
	return Math.hypot(dx, dy);
}
function segCross(p1: Pt, p2: Pt, p3: Pt, p4: Pt): boolean {
	const o = (a: Pt, b: Pt, c: Pt) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
	const d1 = o(p3, p4, p1);
	const d2 = o(p3, p4, p2);
	const d3 = o(p1, p2, p3);
	const d4 = o(p1, p2, p4);
	return d1 * d2 < 0 && d3 * d4 < 0;
}
function segRectDist(x1: number, y1: number, x2: number, y2: number, r: R4): number {
	if ((r[0] <= x1 && x1 <= r[2] && r[1] <= y1 && y1 <= r[3]) || (r[0] <= x2 && x2 <= r[2] && r[1] <= y2 && y2 <= r[3]))
		return 0;
	const cs: Pt[] = [[r[0], r[1]], [r[2], r[1]], [r[2], r[3]], [r[0], r[3]]];
	const edges: [Pt, Pt][] = [[cs[0], cs[1]], [cs[1], cs[2]], [cs[2], cs[3]], [cs[3], cs[0]]];
	let best = Math.min(...edges.map(([a, b]) => ptSeg(x1, y1, a[0], a[1], b[0], b[1])));
	best = Math.min(best, ...cs.map(c => ptSeg(c[0], c[1], x1, y1, x2, y2)));
	for (const [a, b] of edges) {
		if (segCross([x1, y1], [x2, y2], a, b))
			return 0;
	}
	return best;
}
function overlap(a: R4, b: R4, shrink = 0): boolean {
	return Math.min(a[2], b[2]) - Math.max(a[0], b[0]) > shrink && Math.min(a[3], b[3]) - Math.max(a[1], b[1]) > shrink;
}
export function padRect(p: Pad): R4 {
	const q = { ...p, w: p.w || 0.5, h: p.h || p.w || 0.5, rot: p.rot || 0 } as Pad;
	const cs = padCorners(q);
	const xs = cs.map(c => c[0]);
	const ys = cs.map(c => c[1]);
	return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}
/** 文字框：锚点在 (ax, ay) 比例处，按 deg 逆时针旋转后的外接矩形（y 向上） */
export function textBBox(x: number, y: number, wBox: number, hBox: number, deg: number, ax = 0.5, ay = 0.5): R4 {
	const a = (deg * Math.PI) / 180;
	const pts = [[0, 0], [1, 0], [1, 1], [0, 1]].map(([fx, fy]) => {
		const dx = (fx - ax) * wBox;
		const dy = (fy - ay) * hBox;
		return [x + dx * Math.cos(a) - dy * Math.sin(a), y + dx * Math.sin(a) + dy * Math.cos(a)];
	});
	const xs = pts.map(p => p[0]);
	const ys = pts.map(p => p[1]);
	return [r4(Math.min(...xs)), r4(Math.min(...ys)), r4(Math.max(...xs)), r4(Math.max(...ys))];
}
const center = (r: R4): Pt => [(r[0] + r[2]) / 2, (r[1] + r[3]) / 2];

// ------------------------------------------------------------------ 从板子 + 丝印建中间模型（扩展用）
export function buildFinishModel(board: Board, parts: { ref: string; value?: string; side: string; rect: R4 }[], texts: FinishText[], lines: FinishLine[], classes: Record<string, string>, opts: { teardropSource?: string; silkSource?: string; refCounts?: Record<string, number> } = {}): FinishModel {
	const nL = board.layers.length;
	const pm = new Map<string, FinishPart>(parts.map(p => [p.ref, { ref: p.ref, value: p.value ?? null, side: p.side, rect: p.rect, pads: [] }]));
	for (const n of board.nets) {
		for (const p of n.pads) {
			const part = pm.get(p.ref);
			if (!part)
				continue;
			const side = p.l === -1 ? 'both' : (nL - 1 > 0 && p.l === nL - 1 ? 'bottom' : 'top');
			part.pads.push({ pin: String(p.pin ?? ''), net: n.name, rect: padRect(p).map(r4) as R4, side });
		}
	}
	const junctions: Junction[] = [];
	for (const n of board.nets) {
		for (const s of n.segs) {
			const [l, x1, y1, x2, y2, w] = s;
			for (const [[px, py], [qx, qy]] of [[[x1, y1], [x2, y2]], [[x2, y2], [x1, y1]]] as [Pt, Pt][]) {
				const L = Math.hypot(qx - px, qy - py) || 1;
				const d: Pt = [(qx - px) / L, (qy - py) / L];
				let hit: [Junction['kind'], number, string | null, string | null] | null = null;
				let skip = false;
				for (const v of n.vias) {
					if (Math.hypot(v[0] - px, v[1] - py) <= v[2] / 2 + 1e-6) {
						// 另一端也在过孔里：是过孔里的残段，不是连接点
						if (Math.hypot(v[0] - qx, v[1] - qy) <= v[2] / 2 + 1e-6)
							skip = true;
						else hit = ['via', v[2], null, null];
						break;
					}
				}
				if (!hit && !skip) {
					for (const p of n.pads) {
						if (p.l !== -1 && p.l !== l)
							continue;
						const r = padRect(p);
						if (r[0] - 1e-6 <= px && px <= r[2] + 1e-6 && r[1] - 1e-6 <= py && py <= r[3] + 1e-6) {
							if (!(r[0] - 1e-6 <= qx && qx <= r[2] + 1e-6 && r[1] - 1e-6 <= qy && qy <= r[3] + 1e-6)) // 整段都在焊盘里是残段
								hit = [p.l === -1 ? 'tht' : 'pad', Math.min(r[2] - r[0], r[3] - r[1]), p.ref ?? null, String(p.pin ?? '')];
							break;
						}
					}
				}
				if (!hit)
					continue;
				junctions.push({ net: n.name, cls: classes[n.name] ?? 'SIG', kind: hit[0], x: r4(px), y: r4(py), size: r4(hit[1]), trace_w: w, dir: [r4(d[0]), r4(d[1])], teardrop: null, ref: hit[2], pin: hit[3], layer: l });
			}
		}
	}
	return { kind: 'lpiot-finish-model', version: 1, outline: board.outline?.length ? board.outline : null, parts: [...pm.values()], texts, lines, junctions, teardrop_source: opts.teardropSource ?? 'none', silk_graphics_source: opts.silkSource ?? 'text', ref_counts: opts.refCounts };
}

// ------------------------------------------------------------------ 规则
function num(v: any, d: number | null = null): number | null {
	if (typeof v === 'number')
		return Number.isFinite(v) ? v : d;
	if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)))
		return Number(v);
	return d;
}

export function parseValueUnit(v: any): string | null {
	if (!v)
		return null;
	const s = String(v).trim().split(/[,，;/\s]+/)[0]; // 只看第一段：“10uF, >4V” → 10uF；料号（GRM033R61A105…）认不出就不判
	if (/^\d+(?:\.\d+)?\s*[pnuμm]?F$/i.test(s) || /^\d+[pnuμ]\d+$/i.test(s))
		return 'F';
	if (/^\d+(?:\.\d+)?\s*[pnuμm]?H$/i.test(s))
		return 'H';
	if (/^\d+(?:\.\d+)?\s*(?:[ΩRkKM]|ohm)?$/.test(s) || /^\d+[RkKM]\d+$/.test(s))
		return 'Ω';
	return null;
}

type Part = FinishPart & { role: string };

/** G5 的决定；还没回答的“待填”当作没给，按默认值检查。 */
function cleanDecisions(v: any): any {
	if (!v || typeof v !== 'object' || Array.isArray(v))
		return v;
	const out: any = {};
	for (const [k, x] of Object.entries(v)) {
		if (typeof x === 'string' && x.trim().startsWith('待填'))
			continue;
		out[k] = cleanDecisions(x);
	}
	return out;
}

class Finish {
	issues: FinishIssue[] = [];
	d: any;
	silk: any;
	minW: number;
	minH: number;
	clear: number;
	counts: Record<string, number>;
	allParts: Map<string, Part>;
	parts: Map<string, Part>;

	constructor(public m: FinishModel, public b: any = {}, public bom: string[] | null = null) {
		this.d = cleanDecisions((b ?? {}).G5_finish ?? {});
		this.silk = this.d.silk ?? {};
		const proc = PROCESS[this.silk.process] ?? PROCESS.标准丝印;
		this.minW = this.silk.line_width_mm ? Math.max(proc[0], num(this.silk.line_width_mm, 0) || 0) : proc[0];
		this.minH = this.silk.text_height_mm ? Math.max(proc[1], num(this.silk.text_height_mm, 0) || 0) : proc[1];
		this.clear = Math.max(0.15, num(this.silk.pad_clearance_mm, 0.15) || 0.15);
		const roles = (b ?? {}).roles ?? {};
		this.counts = { ...(m.ref_counts ?? {}) };
		for (const p of m.parts) this.counts[p.ref] = this.counts[p.ref] ?? 1;
		this.allParts = new Map(m.parts.map(p => [p.ref, { ...p, role: roleOf(p.ref, p.value ?? undefined, roles) }]));
		this.parts = new Map([...this.allParts].filter(([r]) => (this.counts[r] ?? 1) === 1));
	}

	add(rule: string, sev: FinishIssue['sev'], refs: string[], msg: string, fix = '', at?: Pt | null, box?: R4 | null): void {
		const v: FinishIssue = { rule, sev, refs: [...refs], msg };
		if (fix)
			v.fix = fix;
		if (at)
			v.at = [r3(at[0]), r3(at[1])];
		if (box)
			v.box = box.map(r3) as R4;
		this.issues.push(v);
	}

	visible(): FinishText[] {
		return this.m.texts.filter(t => !t.hidden);
	}

	checkSilk(): void {
		const pads: [string, FinishPad][] = [];
		for (const p of this.parts.values()) {
			for (const q of p.pads) pads.push([p.ref, q]);
		}
		const same = (side: string, q: FinishPad) => [side, 'both'].includes(q.side ?? 'top');
		const thin = new Map<string, { rule: string; val: number; sev: FinishIssue['sev']; need: number; names: string[]; at: Pt; box: R4 | null; what: string }>();
		const small = (rule: string, sev: FinishIssue['sev'], val: number, need: number, name: string, c: Pt, box: R4 | null, what: string) => {
			const k = `${rule}|${val}`;
			if (!thin.has(k))
				thin.set(k, { rule, val, sev, need, names: [], at: c, box, what });
			const g = thin.get(k)!;
			if (!g.names.includes(name))
				g.names.push(name);
		};
		const poly = this.m.outline ?? [];
		const allowed = this.silk.orientation === '全部 0°' ? [0] : [0, 90];
		const vt = this.visible();
		for (const t of vt) {
			const name = t.text;
			const c = center(t.bbox);
			const hit = pads.filter(([, q]) => same(t.side, q) && rectDist(t.bbox, q.rect) < this.clear - 1e-6);
			if (hit.length) {
				const [r, q] = hit[0];
				this.add('SLK-01', 'P1', [t.owner || name, ...(r !== t.owner ? [r] : [])], `丝印“${name}”离 ${r}.${q.pin} 焊盘不到 ${fmtG(this.clear)} mm：板厂会把压到焊盘的部分裁掉，字会残缺`, '把文字挪开，或缩小到不压焊盘', c, t.bbox);
			}
			if (t.w < this.minW - TOL)
				small('SLK-02', 'P1', t.w, this.minW, t.owner || name, c, t.bbox, '文字线宽');
			if (t.h < this.minH - TOL)
				small('SLK-03', 'P1', t.h, this.minH, t.owner || name, c, t.bbox, '字高');
			else if (t.h > 0 && t.w / t.h < 1 / 8)
				this.add('SLK-03', 'P3', [t.owner || name], `丝印“${name}”笔画太细（线宽 / 字高 = 1:${(t.h / t.w).toFixed(0)}，建议约 1:6）`, '加粗笔画', c, t.bbox);
			const b = t.bbox;
			if (poly.length && ![[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]]].every(([x, y]) => pointInPoly(x, y, poly)))
				this.add('SLK-04', 'P1', [t.owner || name], `丝印“${name}”超出板框：超出的部分不会印出来`, '挪回板内', c, t.bbox);
			const r0 = (Math.floor((((t.rot % 360) + 360) % 360) * 10 + 0.5) / 10) % 360;
			if (!allowed.includes(r0)) {
				const way = Math.abs(r0 - 180) < 1 || Math.abs(r0 - 270) < 1 ? '倒着' : '斜着';
				this.add('SLK-09', 'P2', [t.owner || name], `丝印“${name}”旋转 ${fmtG(r0)}°，${way}读：全板文字只用 ${allowed.map(a => `${a}°`).join('、')}，装配和维修时不用转板`, '旋转到 0° 或 90°', c, t.bbox);
			}
			if (t.side === 'bottom' && !t.mirror)
				this.add('SLK-10', 'P1', [t.owner || name], `底面丝印“${name}”没有镜像：从底面看是反字`, '设为镜像', c, t.bbox);
			const under = [...this.parts.values()].filter(p => p.side === t.side && p.rect[0] < c[0] && c[0] < p.rect[2] && p.rect[1] < c[1] && c[1] < p.rect[3]);
			if (under.length)
				this.add('SLK-08', 'P2', [t.owner || name, ...(under[0].ref !== t.owner ? [under[0].ref] : [])], `丝印“${name}”在 ${under[0].ref} 下面：贴片后被器件盖住，装配和维修时看不到`, '挪到器件旁边', c, t.bbox);
		}
		const seenLine = new Set<string>();
		for (const ln of this.m.lines) {
			const mid: Pt = [(ln.x1 + ln.x2) / 2, (ln.y1 + ln.y2) / 2];
			// 封装自己的丝印框：只在压到自己的焊盘时报；离别的器件焊盘按设定距离；同一封装对同一焊盘只报一次
			const hit = pads.filter(([r, q]) => same(ln.side, q) && segRectDist(ln.x1, ln.y1, ln.x2, ln.y2, q.rect) - ln.w / 2 < (r === ln.owner ? 0 : this.clear) - 1e-6);
			if (hit.length && !seenLine.has(`${ln.owner}|${hit[0][0]}|${hit[0][1].pin}`)) {
				const [r, q] = hit[0];
				seenLine.add(`${ln.owner}|${r}|${q.pin}`);
				this.add('SLK-01', 'P1', [ln.owner || r], `丝印线离 ${r}.${q.pin} 焊盘不到 ${fmtG(this.clear)} mm：会被裁掉，或者印到焊盘上影响焊接`, '修改封装丝印或挪开线条', mid);
			}
			if (ln.w < this.minW - TOL)
				small('SLK-02', 'P1', ln.w, this.minW, `${ln.owner || '板上'} 的丝印线`, mid, null, '丝印线宽');
			if (poly.length && !(pointInPoly(ln.x1, ln.y1, poly) && pointInPoly(ln.x2, ln.y2, poly)) && !seenLine.has(`out|${ln.owner}`)) {
				seenLine.add(`out|${ln.owner}`);
				this.add('SLK-04', 'P1', [ln.owner || '丝印线'], '丝印线超出板框', '挪回板内', mid);
			}
		}
		const groups = [...thin.values()].sort((a, b) => (a.rule < b.rule ? -1 : a.rule > b.rule ? 1 : a.val - b.val));
		for (const g of groups) {
			const more = g.names.length > 6 ? ` 等 ${g.names.length} 处` : '';
			const bad = g.rule === 'SLK-02' ? '印出来会断笔或看不清' : '印出来认不出';
			this.add(g.rule, g.sev, g.names.map(n => n.split(' ')[0]), `${g.what} ${fmtG(g.val)} mm，小于 ${fmtG(g.need)} mm：${g.names.slice(0, 6).join('、')}${more}（${bad}）`, `${g.what}改到 ≥ ${fmtG(g.need)} mm`, g.at, g.box);
		}
		for (let i = 0; i < vt.length; i++) {
			for (let j = i + 1; j < vt.length; j++) {
				const a = vt[i];
				const b = vt[j];
				if (a.side === b.side && overlap(a.bbox, b.bbox, 0.05))
					this.add('SLK-05', 'P2', [a.owner || a.text, b.owner || b.text], `丝印“${a.text}”和“${b.text}”重叠`, '错开摆放', center(a.bbox), a.bbox);
			}
		}
		this.checkDesignators(vt);
		this.checkPolarity();
		this.checkMarkings(vt);
	}

	checkDesignators(vt: FinishText[]): void {
		const pol: string = this.silk.designators || '全部显示';
		if (pol.startsWith('不印'))
			return;
		const shown = new Map<string, FinishText>();
		for (const t of vt) {
			if (t.kind === 'ref' && t.owner && !shown.has(t.owner))
				shown.set(t.owner, t);
		}
		for (const [ref, p] of this.parts) {
			if (p.role === 'hole')
				continue;
			const need = pol === '全部显示' || KEY_ROLES.has(p.role);
			const t = shown.get(ref);
			if (!t) {
				if (need)
					this.add('SLK-06', 'P1', [ref], `${ref} 没有可见的位号丝印（策略：${pol}）`, '显示位号并摆到器件旁边', center(p.rect));
				continue;
			}
			const own = rectDist(t.bbox, p.rect);
			let near: [number, string] = [1e9, ''];
			for (const q of this.parts.values()) {
				if (q.ref === ref || q.side !== t.side)
					continue;
				const d = rectDist(t.bbox, q.rect);
				if (d < near[0] || (d === near[0] && q.ref < near[1]))
					near = [d, q.ref];
			}
			const closer = near[0] + 0.2 < own;
			if (own > 3.0 || closer) {
				const why = `离 ${ref} ${own.toFixed(1)} mm${closer ? `，反而离 ${near[1]} 更近` : ''}`;
				this.add('SLK-07', 'P2', [ref, ...(closer ? [near[1]] : [])], `位号 ${ref} 指认不清：${why}`, '把位号挪到自己器件旁边（≤ 3 mm），不要放在两个器件之间', center(t.bbox), t.bbox);
			}
		}
	}

	checkPolarity(): void {
		if (this.m.silk_graphics_source !== 'full')
			return;
		const L = this.m.lines;
		const marks: Pt[] = [...L.map(l => [l.x1, l.y1] as Pt), ...L.map(l => [l.x2, l.y2] as Pt), ...L.map(l => [(l.x1 + l.x2) / 2, (l.y1 + l.y2) / 2] as Pt), ...this.visible().filter(t => ['1', '+', '•', '●'].includes(t.text.trim())).map(t => center(t.bbox))];
		const ICS = ['ic', 'soc_rf', 'dcdc', 'ldo', 'charger', 'imu', 'magnetometer', 'temp_humidity', 'barometer', 'microphone'];
		for (const [ref, p] of this.parts) {
			const n = p.pads.length;
			const pol = POLARIZED.has(p.role) || (ICS.includes(p.role) && n >= 4) || (p.role === 'connector' && n >= 3) || (p.role === 'cap' && /钽|电解|tant|elec/i.test(String(p.value ?? '')));
			if (!pol)
				continue;
			const p1 = p.pads.find(q => ['1', 'A1', 'K'].includes(q.pin));
			if (!p1)
				continue;
			const others = p.pads.filter(q => q !== p1);
			const ok = marks.some(([mx, my]) => {
				const d1 = rectDist([mx, my, mx, my], p1.rect);
				return d1 <= 1.2 && others.every(q => d1 + 0.1 < rectDist([mx, my, mx, my], q.rect));
			});
			if (!ok) {
				const kind = POLARIZED.has(p.role) || p.role === 'cap' ? '阴极 / 正极' : '1 脚';
				this.add('SLK-11', 'P1', [ref], `${ref} 没有检测到${kind}标记：贴反了没有参照`, `在 ${ref}.1 旁加${kind}标记（圆点、横杠或 +）`, center(p1.rect));
			}
		}
	}

	checkMarkings(vt: FinishText[]): void {
		const norm = (s: any) => String(s).replace(/\s+/g, '').toLowerCase();
		const all = vt.map(t => norm(t.text));
		const bm = this.silk.board_marking || {};
		for (const [key, zh] of [['name', '板名'], ['version', '版本']]) {
			const v = bm[key];
			if (typeof v === 'string' && v.trim() && v.trim() !== '无' && !all.some(s => s.includes(norm(v))))
				this.add('SLK-12', 'P1', [], `板上没有找到${zh}丝印“${v}”`, `加上${zh}，改版时才分得清`);
		}
		const labels = this.silk.labels;
		for (const it of Array.isArray(labels) ? labels : []) {
			if (!it || typeof it !== 'object' || !it.text)
				continue;
			const p = this.parts.get(it.ref);
			const near = vt.filter(t => norm(t.text).includes(norm(it.text)) && (!p || rectDist(t.bbox, p.rect) <= 6.0));
			if (!near.length)
				this.add('SLK-12', 'P1', [it.ref ?? ''], `${it.ref ?? ''} 旁边没有找到说明丝印“${it.text}”`, '在接口 / 按键 / 指示灯旁加上说明', p ? center(p.rect) : null);
		}
		const warns = this.silk.warnings;
		for (const w of Array.isArray(warns) ? warns : []) {
			const s = w && typeof w === 'object' ? w.text : w;
			if (typeof s === 'string' && s.trim() && !all.some(t => t.includes(norm(s))))
				this.add('SLK-12', 'P1', [], `板上没有找到警示丝印“${s}”`, '加上警示标注');
		}
		const jlc = this.silk.jlc_order_no || '板厂默认位置';
		if (jlc === '指定位置' && !all.some(s => s.includes('jlcjlcjlcjlc')))
			this.add('SLK-13', 'P1', [], '选了“指定位置”放板厂订单号，但板上没有“JLCJLCJLCJLC”占位文字', '在想放订单号的空白处加一行 JLCJLCJLCJLC（字高 ≥ 1 mm）');
		else if (jlc === '板厂默认位置')
			this.add('SLK-13', 'P3', [], '板厂会在空白处自动加订单号，可能落在你不想要的地方（比如外壳开窗或导光柱下）', '介意的话改成“指定位置”并放 JLCJLCJLCJLC 占位');
	}

	checkAnnotation(): void {
		const ann = this.d.annotation ?? {};
		const refs = this.m.parts.map(p => p.ref);
		const seen = new Map<string, number>();
		for (const r of refs) seen.set(r, this.counts[r] ?? 1);
		for (const [r, n] of seen) {
			const p = this.allParts.get(r)!;
			const at = center(p.rect);
			if (!/^[A-Z_]+\d+[A-Z]?$/i.test(r))
				this.add('ANN-01', 'P0', [r], `位号“${r}”没有编号（或格式不对）：BOM、贴片坐标和维修都会对不上`, '在原理图里重新编号，再更新到 PCB', at);
			if (n > 1)
				this.add('ANN-02', 'P0', [r], `位号 ${r} 重复了 ${n} 次：贴片坐标和 BOM 会张冠李戴`, '在原理图里重新编号，再更新到 PCB', at);
			const m = /^([A-Z]+)/i.exec(r);
			const want = m ? UNIT_OF_PREFIX[m[1].toUpperCase()] : undefined;
			const got = parseValueUnit(p.value);
			if (want && got && want !== got)
				this.add('ANN-03', 'P1', [r], `${r} 的前缀是 ${m![1]}（${({ Ω: '电阻', F: '电容', H: '电感' } as any)[want]}），但值是“${p.value}”`, '核对是位号错了还是值错了', at);
		}
		const groups = new Map<string, [number, string][]>();
		for (const r of refs) {
			const m = /^([A-Z]+)(\d+)$/i.exec(r);
			if (m) {
				const k = m[1].toUpperCase();
				if (!groups.has(k))
					groups.set(k, []);
				groups.get(k)!.push([Number(m[2]), r]);
			}
		}
		for (const [pre, items] of groups) {
			const nums = items.map(x => x[0]).sort((a, b) => a - b);
			const have = new Set(nums);
			const missing: number[] = [];
			for (let i = 1; i <= nums[nums.length - 1]; i++) {
				if (!have.has(i))
					missing.push(i);
			}
			if (missing.length && missing.length <= 20)
				this.add('ANN-04', 'P3', [], `${pre} 系列跳号：缺 ${missing.slice(0, 8).map(x => `${pre}${x}`).join(', ')}${missing.length > 8 ? ' 等' : ''}`, '需要的话在原理图里重新编号');
		}
		if (String(ann.scheme ?? '').startsWith('按位置')) {
			for (const [pre, items] of groups) {
				const pts = [...items].sort((a, b) => a[0] - b[0] || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
				const rows = pts.map(([n, r]) => {
					const c = center(this.allParts.get(r)!.rect);
					return { n, r, x: c[0], y: c[1] };
				});
				const order = [...rows].sort((a, b) => (-Math.floor(a.y / 5 + 0.5)) - (-Math.floor(b.y / 5 + 0.5)) || a.x - b.x);
				const bad: [string, string][] = [];
				for (let i = 0; i + 1 < order.length; i++) {
					if (order[i].n > order[i + 1].n)
						bad.push([order[i].r, order[i + 1].r]);
				}
				if (bad.length)
					this.add('ANN-04', 'P2', [bad[0][0], bad[0][1]], `${pre} 系列没有按位置编号（${bad[0][0]} 在 ${bad[0][1]} 前面）：维修时按位号找器件要来回找`, '用 EDA 的“按位置重新编号”，再反标回原理图');
			}
		}
		if (this.bom) {
			const board = new Set(refs);
			const bom = new Set(this.bom);
			for (const r of [...bom].filter(x => !board.has(x)).sort().slice(0, 20))
				this.add('ANN-05', 'P1', [r], `BOM 里有 ${r}，板上没有`, '原理图更新到 PCB，或从 BOM 删掉');
			for (const r of [...board].filter(x => !bom.has(x)).sort().slice(0, 20))
				this.add('ANN-05', 'P1', [r], `板上有 ${r}，BOM 里没有`, '核对 BOM 是否过期', center(this.allParts.get(r)!.rect));
		}
	}

	checkTeardrops(): void {
		const td = this.d.teardrops ?? {};
		const policy: string = td.policy || '仅过孔和插件孔';
		if (policy === '不加')
			return;
		const excl = !['保留', false].includes(td.exclude_rf_diff);
		const unknown = [undefined, null, 'none'].includes(this.m.teardrop_source);
		const need: Junction[] = [];
		for (const j of this.m.junctions) {
			if (excl && SENSITIVE.has(j.cls)) {
				if (j.teardrop)
					this.add('TDR-02', 'P2', [j.net], `${j.net}（${j.cls}）在 ${j.kind} 连接处加了泪滴：会改变阻抗，射频和差分线一般不加`, '去掉这个泪滴', [j.x, j.y]);
				continue;
			}
			if (policy.startsWith('仅过孔') && j.kind === 'pad')
				continue;
			if (j.trace_w >= 0.8 * j.size)
				continue;
			need.push(j);
		}
		if (unknown) {
			if (need.length)
				this.add('TDR-00', 'P2', [], `读不到泪滴（嘉立创扩展里没有泪滴的接口）：按“${policy}”策略有 ${need.length} 处连接点需要泪滴，请在嘉立创里执行 工具 → 泪滴，并在 G5 里确认已执行`, '执行泪滴后重新铺铜，再逐处看一遍', [need[0].x, need[0].y]);
			return;
		}
		const seen = new Set<string>();
		for (const j of need) {
			const key = `${j.net}|${j.x}|${j.y}`;
			if (j.teardrop || seen.has(key))
				continue;
			seen.add(key);
			const where = j.ref ? `${j.ref}.${j.pin}` : '过孔';
			this.add('TDR-01', 'P2', [j.ref || j.net], `${j.net} 在 ${where} 的连接处没有泪滴（线宽 ${fmtG(j.trace_w)} mm，${j.kind === 'via' ? '过孔' : '焊盘'} ${fmtG(j.size)} mm）`, '执行泪滴，钻孔偏位时线不会被切断', [j.x, j.y]);
		}
	}

	run(): FinishIssue[] {
		this.checkSilk();
		this.checkAnnotation();
		this.checkTeardrops();
		const order: Record<string, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };
		const k0 = (v: FinishIssue) => v.refs[0];
		this.issues.sort((a, b) => {
			if (order[a.sev] !== order[b.sev])
				return order[a.sev] - order[b.sev];
			if (a.rule !== b.rule)
				return a.rule < b.rule ? -1 : 1;
			const x = k0(a);
			const y = k0(b);
			if (x === y)
				return 0;
			if (x === undefined)
				return -1;
			if (y === undefined)
				return 1;
			return x < y ? -1 : 1;
		});
		return this.issues;
	}
}

export function finishCheck(model: FinishModel, brief: any = null, bom: string[] | null = null): FinishReport {
	const issues = new Finish(model, brief ?? {}, bom).run();
	const cnt = (s: string) => issues.filter(v => v.sev === s).length;
	const unres = finishUnresolved({ issues }, brief ?? {});
	const rep: FinishReport = {
		kind: 'lpiot-finish-lint',
		version: 1,
		p0: cnt('P0'),
		p1: cnt('P1'),
		p2: cnt('P2'),
		p3: cnt('P3'),
		pass: cnt('P0') === 0 && !unres.length,
		unresolved_p1: unres.length,
		issues,
		teardrop_source: model.teardrop_source,
		silk_graphics_source: model.silk_graphics_source,
	};
	if (brief)
		rep.rules_hash = finishRulesHash(brief);
	else
		rep.note = '没有设计确认文件：按嘉立创标准丝印默认值检查；板名、版本、接口说明、订单号位置、泪滴策略需要 G5 的决定。';
	return rep;
}
