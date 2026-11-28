/**
 * 几何工具（与 low-power-iot-hardware-design/scripts/route_lint.py 一致）。单位 mm。
 */
export type Pt = [number, number];
export type S4 = [number, number, number, number];

export const ANG_TOL = 0.001; // mm：横向偏差容差 1 µm
export const TURN_TOL = 0.5; // 度
export const SIN1 = Math.sin((1 * Math.PI) / 180);
const DEG = 180 / Math.PI;

export interface Pad {
	ref: string;
	pin: string;
	l: number; // 层序号，-1 = 所有层（通孔）
	x: number;
	y: number;
	w: number | null;
	h: number | null;
	rot: number; // 焊盘局部 x 轴的方向角（度）
	shape: string; // rect | circle | oval | polygon
	id?: string;
}

/** 线段：[层, x1, y1, x2, y2, 线宽, 是否圆弧, 图元 ID?] */
export type Seg = [number, number, number, number, number, number, boolean, string?];
/** 过孔：[x, y, 直径, 图元 ID?] */
export type Via = [number, number, number, string?];

export function hypot(x: number, y: number): number {
	return Math.sqrt(x * x + y * y);
}
export function dist(a: Pt, b: Pt): number {
	return hypot(a[0] - b[0], a[1] - b[1]);
}
export function segLen(s: Seg): number {
	return hypot(s[3] - s[1], s[4] - s[2]);
}
function pymod(a: number, m: number): number {
	return ((a % m) + m) % m;
}
/** 相对最近 45° 倍数方向的横向偏差（mm）与角度偏差（度） */
export function octiDev(dx: number, dy: number): [number, number] {
	const L = hypot(dx, dy);
	if (L < 1e-9)
		return [0, 0];
	const a = pymod(Math.atan2(dy, dx) * DEG, 45);
	const d = Math.min(a, 45 - a);
	return [L * Math.sin(d / DEG), d];
}
export function isOcti(dx: number, dy: number, tol = ANG_TOL): boolean {
	return octiDev(dx, dy)[0] <= tol;
}
export function dOct(dx: number, dy: number): number {
	const ax = Math.abs(dx);
	const ay = Math.abs(dy);
	return Math.max(ax, ay) + (Math.SQRT2 - 1) * Math.min(ax, ay);
}
export function angleBetween(u: Pt, v: Pt): number {
	const lu = hypot(u[0], u[1]);
	const lv = hypot(v[0], v[1]);
	if (lu < 1e-12 || lv < 1e-12)
		return 180;
	const c = Math.max(-1, Math.min(1, (u[0] * v[0] + u[1] * v[1]) / (lu * lv)));
	return Math.acos(c) * DEG;
}
export function ptSeg(px: number, py: number, x1: number, y1: number, x2: number, y2: number): number {
	const dx = x2 - x1;
	const dy = y2 - y1;
	const L2 = dx * dx + dy * dy;
	const t = L2 < 1e-18 ? 0 : Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / L2));
	return hypot(px - x1 - t * dx, py - y1 - t * dy);
}
function cross(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number {
	return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
}
export function segsIntersect(a: S4, b: S4): boolean {
	const [x1, y1, x2, y2] = a;
	const [x3, y3, x4, y4] = b;
	const d1 = cross(x3, y3, x4, y4, x1, y1);
	const d2 = cross(x3, y3, x4, y4, x2, y2);
	const d3 = cross(x1, y1, x2, y2, x3, y3);
	const d4 = cross(x1, y1, x2, y2, x4, y4);
	return d1 * d2 < 0 && d3 * d4 < 0;
}
export function segSeg(a: S4, b: S4): number {
	if (segsIntersect(a, b))
		return 0;
	return Math.min(ptSeg(a[0], a[1], b[0], b[1], b[2], b[3]), ptSeg(a[2], a[3], b[0], b[1], b[2], b[3]), ptSeg(b[0], b[1], a[0], a[1], a[2], a[3]), ptSeg(b[2], b[3], a[0], a[1], a[2], a[3]));
}
export function padAxis(p: Pad): Pt {
	const r = ((p.rot || 0) * Math.PI) / 180;
	return [Math.cos(r), Math.sin(r)];
}
export function padCorners(p: Pad, grow = 0): Pt[] {
	const [ux, uy] = padAxis(p);
	const hw = (p.w ?? 0.5) / 2 + grow;
	const hh = (p.h ?? 0.5) / 2 + grow;
	return ([[-1, -1], [1, -1], [1, 1], [-1, 1]] as Pt[]).map(([sx, sy]) => [p.x + sx * hw * ux - sy * hh * uy, p.y + sx * hw * uy + sy * hh * ux] as Pt);
}
export function ptInPad(x: number, y: number, p: Pad, tol = 1e-3): boolean {
	if (p.shape === 'circle' || !p.w)
		return hypot(x - p.x, y - p.y) <= Math.max(p.w || 0.5, p.h || 0.5) / 2 + tol;
	const [ux, uy] = padAxis(p);
	const dx = x - p.x;
	const dy = y - p.y;
	const lx = dx * ux + dy * uy;
	const ly = -dx * uy + dy * ux;
	return Math.abs(lx) <= p.w / 2 + tol && Math.abs(ly) <= (p.h ?? p.w) / 2 + tol;
}
export function segPad(s: S4, p: Pad): number {
	if (p.shape === 'circle')
		return Math.max(0, ptSeg(p.x, p.y, s[0], s[1], s[2], s[3]) - Math.max(p.w ?? 0.5, p.h ?? 0.5) / 2);
	if (ptInPad(s[0], s[1], p, 0) || ptInPad(s[2], s[3], p, 0))
		return 0;
	const c = padCorners(p);
	const edges = c.map((a, i) => [a, c[(i + 1) % 4]] as [Pt, Pt]);
	if (edges.some(([a, b]) => segsIntersect(s, [a[0], a[1], b[0], b[1]])))
		return 0;
	let m = Infinity;
	for (const [a, b] of edges) {
		m = Math.min(m, ptSeg(s[0], s[1], a[0], a[1], b[0], b[1]), ptSeg(s[2], s[3], a[0], a[1], b[0], b[1]));
	}
	for (const q of c) m = Math.min(m, ptSeg(q[0], q[1], s[0], s[1], s[2], s[3]));
	return m;
}
export function padExitDist(x: number, y: number, e: Pt, p: Pad): number {
	const [ux, uy] = padAxis(p);
	const dx = x - p.x;
	const dy = y - p.y;
	const lx = dx * ux + dy * uy;
	const ly = -dx * uy + dy * ux;
	const ex = e[0] * ux + e[1] * uy;
	const ey = -e[0] * uy + e[1] * ux;
	const ts: number[] = [];
	for (const [pos, d, half] of [[lx, ex, (p.w ?? 0.5) / 2], [ly, ey, (p.h ?? 0.5) / 2]]) {
		if (Math.abs(d) > 1e-12)
			ts.push(((d > 0 ? half : -half) - pos) / d);
	}
	const ok = ts.filter(t => t >= 0);
	return ok.length ? Math.min(...ok) : 0;
}
export function pointInPoly(x: number, y: number, poly: Pt[]): boolean {
	let inside = false;
	const n = poly.length;
	for (let i = 0; i < n; i++) {
		const [x1, y1] = poly[i];
		const [x2, y2] = poly[(i + 1) % n];
		if ((y1 > y) !== (y2 > y) && x < ((x2 - x1) * (y - y1)) / (y2 - y1 + 1e-300) + x1)
			inside = !inside;
	}
	return inside;
}
export function octMst(points: Pt[]): number {
	const seen = new Set<string>();
	const pts: Pt[] = [];
	for (const [x, y] of points) {
		const k = `${x.toFixed(3)},${y.toFixed(3)}`;
		if (!seen.has(k)) {
			seen.add(k);
			pts.push([Number(x.toFixed(3)), Number(y.toFixed(3))]);
		}
	}
	if (pts.length < 2)
		return 0;
	const inside = new Set<number>([0]);
	let total = 0;
	const d = pts.map(q => dOct(pts[0][0] - q[0], pts[0][1] - q[1]));
	while (inside.size < pts.length) {
		let k = -1;
		for (let i = 0; i < pts.length; i++) {
			if (!inside.has(i) && (k < 0 || d[i] < d[k]))
				k = i;
		}
		total += d[k];
		inside.add(k);
		for (let i = 0; i < pts.length; i++) {
			if (!inside.has(i))
				d[i] = Math.min(d[i], dOct(pts[k][0] - pts[i][0], pts[k][1] - pts[i][1]));
		}
	}
	return total;
}
export function median(xs: number[]): number {
	const a = [...xs].sort((p, q) => p - q);
	const n = a.length;
	return n % 2 ? a[(n - 1) / 2] : (a[n / 2 - 1] + a[n / 2]) / 2;
}
export function mean(xs: number[]): number {
	return xs.reduce((s, x) => s + x, 0) / xs.length;
}
export function pstdev(xs: number[]): number {
	const m = mean(xs);
	return Math.sqrt(mean(xs.map(x => (x - m) * (x - m))));
}
export function round(x: number, n: number): number {
	const k = 10 ** n;
	return Math.round(x * k) / k;
}
