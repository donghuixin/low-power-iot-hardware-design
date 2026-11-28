/**
 * 实板布局检查（与 scripts/layout_lint.py 一致）：对照设计确认文件检查器件摆放。
 * LAY-01…10：板框、重叠、固定件、功能分区、天线、干扰源间距、禁布区；RTP-01…08：就近原则（未布线时按直线距离）。
 */
import type { Pt } from './geom';
import type { Board } from './model';
import { gateHash, missing } from './brief';
import { Ctx, upgradePairs } from './lint';
import { inferClass } from './model';
import { checkProximity } from './principles';

export type Rect = [number, number, number, number];
export interface LayoutIssue { rule: string; sev: 'P0' | 'P1' | 'P2' | 'P3'; refs: string[]; msg: string; fix?: string; at?: Pt; zone?: Rect; target?: Pt; kind?: string }
export interface LayoutPart { ref: string; rect: Rect; side: string; role: string; value?: string }
export interface LayoutBlock { name: string; zone: Rect | null; refs: string[]; color: number }
export interface LayoutReport {
	kind: 'lpiot-layout-lint';
	version: 1;
	p0: number;
	p1: number;
	p2: number;
	p3: number;
	pass: boolean;
	issues: LayoutIssue[];
	board_mm: [number, number];
	bbox: Rect;
	parts: LayoutPart[];
	blocks: LayoutBlock[];
	brief_hash?: string;
	brief_complete?: Record<string, boolean>;
	note?: string;
}

const REGIONS: Record<string, Rect> = {
	'left': [0, 0, 0.5, 1],
	'right': [0.5, 0, 1, 1],
	'top': [0, 0.5, 1, 1],
	'bottom': [0, 0, 1, 0.5],
	'top-left': [0, 0.5, 0.5, 1],
	'top-right': [0.5, 0.5, 1, 1],
	'bottom-left': [0, 0, 0.5, 0.5],
	'bottom-right': [0.5, 0, 1, 0.5],
	'center': [0.25, 0.25, 0.75, 0.75],
	'left-third': [0, 0, 1 / 3, 1],
	'right-third': [2 / 3, 0, 1, 1],
	'middle-third': [1 / 3, 0, 2 / 3, 1],
	'top-third': [0, 2 / 3, 1, 1],
	'bottom-third': [0, 0, 1, 1 / 3],
	'any': [0, 0, 1, 1],
};
const REGION_ZH: Record<string, string> = { 'left': '左半', 'right': '右半', 'top': '上半', 'bottom': '下半', 'top-left': '左上', 'top-right': '右上', 'bottom-left': '左下', 'bottom-right': '右下', 'center': '中部', 'left-third': '左三分之一', 'right-third': '右三分之一', 'middle-third': '中间三分之一', 'top-third': '上三分之一', 'bottom-third': '下三分之一' };
const EDGE_ZH: Record<string, string> = { left: '左边', right: '右边', top: '上边', bottom: '下边', inner: '板内' };
const ROLE_RULES: [RegExp, string][] = [
	[/^(ANT|AE)\d*|^E\d/i, 'antenna'],
	[/^(BT|BAT)\d*/i, 'battery'],
	[/^(USB|CN|J|P)\d/i, 'connector'],
	[/^(Y|X|XTAL|OSC)\d/i, 'crystal'],
	[/^L\d/i, 'inductor'],
	[/^(SW|KEY|K|S)\d/i, 'button'],
	[/^(LED|D)\d/i, 'diode'],
	[/^U\d|^IC\d|^M\d/i, 'ic'],
	[/^C\d/i, 'cap'],
	[/^R\d/i, 'res'],
	[/^FB\d/i, 'ferrite'],
	[/^TP\d/i, 'testpoint'],
	[/^H\d|^MH\d/i, 'hole'],
];
// 按型号推断角色（位号推断之后再细分；设计确认里的 roles 优先），与 layout_lint.py 的 VALUE_ROLES 一致
const VALUE_ROLES: [RegExp, string][] = [
	[/1117|ME62|RT90|XC62|TLV7|AP21|LP59|HT7\d|MIC5|\bLDO\b/i, 'ldo'],
	[/TPS6|TLV62|SY8|MP15|MP23|RT8|LMR|XL15|\bbuck\b|\bboost\b|DCDC/i, 'dcdc'],
	[/TP40|BQ2[45]|MCP738|LTC40|ETA60|CN30/i, 'charger'],
	[/BMI\d|LSM6|MPU-?\d|ICM-?\d|LIS2|ADXL|BMA\d|KX\d{3}/i, 'imu'],
	[/MMC\d|QMC\d|LIS3MDL|BMM\d|AK09/i, 'magnetometer'],
	[/SHT\d|SHTC|HDC\d|AHT\d|Si70|HTU\d|TMP1\d/i, 'temp_humidity'],
	[/BMP\d|LPS\d|DPS\d|MS56/i, 'barometer'],
	[/SPH\d|ICS-4\d|MSM26|MEMS ?MIC/i, 'microphone'],
	[/nRF5|ESP32|STM32WB|CC26|EFR32|BL6\d|CH58|DA14/i, 'soc_rf'],
];
const HEAT = new Set(['dcdc', 'ldo', 'charger', 'pa']);
const MAJOR = new Set(['antenna', 'battery', 'connector', 'crystal', 'inductor', 'ic', 'button', 'rf_module', 'dcdc', 'mcu', 'soc_rf', 'ldo', 'charger', 'imu', 'magnetometer', 'temp_humidity', 'barometer', 'microphone']);
const MIN_DIST: [string, 'P1' | 'P2', Set<string>, Set<string>, number, string][] = [
	['LAY-07', 'P1', new Set(['antenna', 'rf_module']), new Set(['battery', 'connector']), 5, '天线离电池 / 连接器太近：金属会让天线失谐、效率下降'],
	['LAY-07', 'P1', new Set(['inductor']), new Set(['antenna', 'rf_module']), 8, '功率电感离天线太近：开关噪声会耦合进射频'],
	['LAY-07', 'P2', new Set(['inductor']), new Set(['crystal']), 4, '功率电感离晶振太近：磁场耦合会增加相噪、影响起振'],
	['LAY-07', 'P2', new Set(['crystal']), new Set(['antenna', 'rf_module']), 4, '晶振离天线太近：射频会注入振荡回路'],
	['LAY-11', 'P2', new Set(['imu']), new Set(['connector', 'button', 'hole']), 5, 'IMU 离连接器、按键或固定孔太近：插拔、按压和锁螺丝的应力会让零偏漂移'],
	['LAY-12', 'P2', new Set(['temp_humidity']), HEAT, 8, '温湿度传感器离发热器件太近：读数会偏高'],
	['LAY-12', 'P2', new Set(['imu']), HEAT, 5, 'IMU 离发热器件太近：温漂会进入零偏'],
	['LAY-12', 'P2', new Set(['crystal']), HEAT, 4, '晶振离发热器件太近：频率随温度漂移'],
	['LAY-12', 'P2', new Set(['battery']), HEAT, 5, '电池离发热器件太近：温度升高加速老化'],
	['LAY-13', 'P1', new Set(['magnetometer']), new Set(['inductor', 'battery', 'speaker', 'motor']), 10, '磁力计离电感、电池或磁性器件太近：硬铁干扰无法完全校准'],
	['LAY-14', 'P2', new Set(['inductor']), new Set(['imu', 'temp_humidity', 'microphone', 'barometer']), 4, '功率电感离敏感传感器太近：磁场和开关噪声会耦合进去'],
];

export function roleOf(ref: string, value: string | undefined, roles: Record<string, string>): string {
	if (roles[ref])
		return roles[ref];
	for (const [pat, r] of ROLE_RULES) {
		if (pat.test(ref)) {
			if (r === 'ic' && value && /module|模组|ESP32-[A-Z]|-WROOM|-MINI/i.test(value))
				return 'rf_module';
			if (r === 'inductor' && value && /\d\s*nH/i.test(value))
				return 'rf_match';
			if ((r === 'ic' || r === 'other') && value) {
				for (const [vp, vr] of VALUE_ROLES) {
					if (vp.test(value))
						return vr;
				}
			}
			return r;
		}
	}
	return 'other';
}

function rectDist(a: Rect, b: Rect): number {
	const dx = Math.max(0, Math.max(a[0], b[0]) - Math.min(a[2], b[2]));
	const dy = Math.max(0, Math.max(a[1], b[1]) - Math.min(a[3], b[3]));
	return Math.hypot(dx, dy);
}
function overlap(a: Rect, b: Rect, shrink = 0.05): boolean {
	return Math.min(a[2], b[2]) - Math.max(a[0], b[0]) > shrink && Math.min(a[3], b[3]) - Math.max(a[1], b[1]) > shrink;
}
function overlapArea(a: Rect, b: Rect): number {
	return Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) * Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
}
function center(r: Rect): Pt {
	return [(r[0] + r[2]) / 2, (r[1] + r[3]) / 2];
}
function inPoly(x: number, y: number, poly: Pt[]): boolean {
	let inside = false;
	for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
		const [xi, yi] = poly[i];
		const [xj, yj] = poly[j];
		if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi + 1e-12) + xi)
			inside = !inside;
	}
	return inside;
}
const f1 = (x: number): string => x.toFixed(1);

/** 从焊盘（和器件中心）得到每个器件的包络矩形 */
export function partsOf(board: Board, roles: Record<string, string> = {}): LayoutPart[] {
	const nL = board.layers.length;
	const acc = new Map<string, { r: Rect; ls: Set<number> }>();
	for (const n of board.nets) {
		for (const p of n.pads) {
			if (!p.ref || p.ref === 'PAD')
				continue;
			const w = (p.w ?? 0.5) / 2;
			const h = (p.h ?? p.w ?? 0.5) / 2;
			const rot = Math.abs(((p.rot || 0) % 180 + 180) % 180 - 90) < 45;
			const [hw, hh] = rot ? [h, w] : [w, h];
			const a = acc.get(p.ref) ?? { r: [Infinity, Infinity, -Infinity, -Infinity] as Rect, ls: new Set<number>() };
			a.r = [Math.min(a.r[0], p.x - hw), Math.min(a.r[1], p.y - hh), Math.max(a.r[2], p.x + hw), Math.max(a.r[3], p.y + hh)];
			a.ls.add(p.l);
			acc.set(p.ref, a);
		}
	}
	const values = new Map((board.parts ?? []).map(p => [p.ref, p.value]));
	for (const p of (board.parts ?? []) as any[]) {
		if (!acc.has(p.ref) && Number.isFinite(p.x) && Number.isFinite(p.y))
			acc.set(p.ref, { r: [p.x - 0.5, p.y - 0.5, p.x + 0.5, p.y + 0.5], ls: new Set([p.layer === 'bottom' ? nL - 1 : 0]) });
	}
	return [...acc.entries()].map(([ref, a]) => {
		const side = a.ls.has(0) ? 'top' : a.ls.size && [...a.ls].every(l => l === nL - 1) ? 'bottom' : 'top';
		const value = values.get(ref) || undefined;
		return { ref, rect: a.r, side, role: roleOf(ref, value, roles), value };
	});
}

export interface LayoutOptions { yUp?: boolean }

export function layoutCheck(board: Board, brief: any = null, opt: LayoutOptions = {}): LayoutReport {
	const yUp = opt.yUp !== false;
	const roles: Record<string, string> = brief?.roles ?? {};
	const parts = partsOf(board, roles);
	const byRef = new Map(parts.map(p => [p.ref, p]));
	let poly: Pt[] = board.outline?.length ? board.outline : [];
	const noOutline = !poly.length;
	if (noOutline) {
		const xs = parts.flatMap(p => [p.rect[0], p.rect[2]]);
		const ys = parts.flatMap(p => [p.rect[1], p.rect[3]]);
		poly = xs.length ? [[Math.min(...xs), Math.min(...ys)], [Math.max(...xs), Math.min(...ys)], [Math.max(...xs), Math.max(...ys)], [Math.min(...xs), Math.max(...ys)]] : [[0, 0], [1, 0], [1, 1], [0, 1]];
	}
	const xs = poly.map(p => p[0]);
	const ys = poly.map(p => p[1]);
	const bb: Rect = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
	const W = bb[2] - bb[0];
	const H = bb[3] - bb[1];
	const issues: LayoutIssue[] = [];
	const add = (v: LayoutIssue): void => {
		issues.push(v);
	};
	// “上”在屏幕上方：y 向上的坐标里是 y 大的一侧
	const fracRect = (f: number[]): Rect => {
		const [fx0, fy0, fx1, fy1] = f;
		if (yUp)
			return [bb[0] + fx0 * W, bb[1] + fy0 * H, bb[0] + fx1 * W, bb[1] + fy1 * H];
		return [bb[0] + fx0 * W, bb[3] - fy1 * H, bb[0] + fx1 * W, bb[3] - fy0 * H];
	};
	const regionRect = (reg: any): Rect | null => {
		if (typeof reg === 'string') {
			const k = reg.trim().toLowerCase().replace(/[_\s]/g, '-');
			return REGIONS[k] ? fracRect(REGIONS[k]) : null;
		}
		if (Array.isArray(reg) && reg.length === 4 && reg.every(v => typeof v === 'number' && v >= 0 && v <= 1))
			return fracRect(reg);
		if (reg && typeof reg === 'object') {
			if (Array.isArray(reg.rect_frac))
				return fracRect(reg.rect_frac);
			if (Array.isArray(reg.rect_mm)) {
				const [x0, y0, x1, y1] = reg.rect_mm;
				return [Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)];
			}
		}
		return null;
	};
	const edgeDist = (r: Rect, edge: string): number => {
		const top = yUp ? bb[3] - r[3] : r[1] - bb[1];
		const bottom = yUp ? r[1] - bb[1] : bb[3] - r[3];
		return ({ left: r[0] - bb[0], right: bb[2] - r[2], top, bottom } as Record<string, number>)[edge];
	};

	// ---- 机械
	if (noOutline)
		add({ rule: 'LAY-01', sev: 'P1', refs: [], msg: '没有找到板框（板框层上没有图元）：下面按器件包络估计板子范围，板边与分区检查不准', fix: '先按外壳图纸画出板框（G1）' });
	for (const p of noOutline ? [] : parts) {
		const r = p.rect;
		const corners: Pt[] = [[r[0], r[1]], [r[2], r[1]], [r[2], r[3]], [r[0], r[3]]];
		if (!corners.every(c => inPoly(c[0], c[1], poly)) && !['connector', 'antenna'].includes(p.role))
			add({ rule: 'LAY-01', sev: 'P0', refs: [p.ref], msg: `${p.ref} 超出板框`, fix: '移回板框内，或确认板框是否画错', at: center(r), kind: 'part' });
	}
	for (let i = 0; i < parts.length; i++) {
		for (let j = i + 1; j < parts.length; j++) {
			const a = parts[i];
			const b = parts[j];
			if (a.side === b.side && overlap(a.rect, b.rect))
				add({ rule: 'LAY-02', sev: 'P0', refs: [a.ref, b.ref], msg: `${a.ref} 与 ${b.ref} 焊盘区域重叠`, fix: '拉开至少一个器件本体的间距', at: center(a.rect), kind: 'part' });
		}
	}
	const mech = brief?.G1_mechanical ?? {};
	for (const k of Array.isArray(mech.keepouts) ? mech.keepouts : []) {
		const z = regionRect(k && typeof k === 'object' && !Array.isArray(k) ? k : { rect_frac: k });
		if (!z)
			continue;
		for (const p of parts) {
			if (overlap(p.rect, z, 0))
				add({ rule: 'LAY-08', sev: 'P0', refs: [p.ref], msg: `${p.ref} 进入禁布区（${k?.reason ?? '禁布区'}）`, fix: '移出禁布区', at: center(p.rect), zone: z, kind: 'keepout' });
		}
	}
	for (const f of Array.isArray(mech.fixed) ? mech.fixed : []) {
		if (!f || typeof f !== 'object' || !f.ref)
			continue;
		const p = byRef.get(f.ref);
		if (!p) {
			add({ rule: 'LAY-10', sev: 'P1', refs: [f.ref], msg: `设计确认里的固定件 ${f.ref} 在板上找不到`, fix: '核对位号，或在确认文件里更正' });
			continue;
		}
		const r = p.rect;
		const c = center(r);
		const tol = Number(f.tol_mm) || 1;
		const edge = f.edge;
		if (!['left', 'right', 'top', 'bottom'].includes(edge))
			continue;
		const d = edgeDist(r, edge);
		const hw = (r[2] - r[0]) / 2;
		const hh = (r[3] - r[1]) / 2;
		const topY = yUp ? bb[3] - hh : bb[1] + hh;
		const botY = yUp ? bb[1] + hh : bb[3] - hh;
		let target: Pt = ({ left: [bb[0] + hw, c[1]], right: [bb[2] - hw, c[1]], top: [c[0], topY], bottom: [c[0], botY] } as Record<string, Pt>)[edge];
		if (d > tol + 1e-6)
			add({ rule: 'LAY-03', sev: 'P0', refs: [p.ref], msg: `${p.ref}（${f.what ?? ''}）应贴${EDGE_ZH[edge]}，现在离板边 ${f1(d)} mm`, fix: `移到${EDGE_ZH[edge]}，原因：${f.reason ?? '外壳开孔'}`, at: c, target, kind: 'fixed' });
		if (typeof f.along_mm === 'number') {
			const horiz = edge === 'top' || edge === 'bottom';
			const cur = horiz ? c[0] - bb[0] : (yUp ? c[1] - bb[1] : bb[3] - c[1]);
			if (Math.abs(cur - f.along_mm) > tol + 1e-6) {
				target = horiz ? [bb[0] + f.along_mm, target[1]] : [target[0], yUp ? bb[1] + f.along_mm : bb[3] - f.along_mm];
				add({ rule: 'LAY-03', sev: 'P1', refs: [p.ref], msg: `${p.ref} 沿${EDGE_ZH[edge]}的位置是 ${f1(cur)} mm，外壳要求 ${f.along_mm} ± ${tol} mm`, fix: '按外壳开孔位置移动', at: c, target, kind: 'fixed' });
			}
		}
	}

	// ---- 分区
	const blocks: LayoutBlock[] = [];
	const rawBlocks = brief?.G2_partition?.blocks;
	if (Array.isArray(rawBlocks)) {
		const assigned = new Set<string>();
		const boxes: [string, Rect][] = [];
		rawBlocks.forEach((b: any, bi: number) => {
			if (!b || typeof b !== 'object')
				return;
			const name = String(b.name ?? '?');
			const refs: string[] = (Array.isArray(b.parts) ? b.parts : []).filter((r: any) => typeof r === 'string');
			refs.forEach(r => assigned.add(r));
			const z = regionRect(b.region);
			blocks.push({ name, zone: z, refs, color: bi });
			const present: LayoutPart[] = [];
			for (const ref of refs) {
				const p = byRef.get(ref);
				if (!p) {
					add({ rule: 'LAY-10', sev: 'P1', refs: [ref], msg: `功能块“${name}”里的 ${ref} 在板上找不到`, fix: '核对位号' });
					continue;
				}
				present.push(p);
				if (z) {
					const c = center(p.rect);
					const mx = 0.05 * W;
					const my = 0.05 * H;
					if (!(z[0] - mx <= c[0] && c[0] <= z[2] + mx && z[1] - my <= c[1] && c[1] <= z[3] + my)) {
						const reg = typeof b.region === 'string' ? (REGION_ZH[b.region] ?? b.region) : '指定区域';
						add({ rule: 'LAY-04', sev: 'P1', refs: [ref], msg: `${ref} 属于“${name}”，应在${reg}，现在在区域外`, fix: '移回该功能块的区域，或和用户确认后修改分区', at: c, zone: z, target: [Math.min(Math.max(c[0], z[0] + 0.5), z[2] - 0.5), Math.min(Math.max(c[1], z[1] + 0.5), z[3] - 0.5)], kind: 'block' });
					}
				}
			}
			const major = present.filter(p => MAJOR.has(p.role));
			const use = major.length ? major : present;
			if (use.length)
				boxes.push([name, [Math.min(...use.map(p => p.rect[0])), Math.min(...use.map(p => p.rect[1])), Math.max(...use.map(p => p.rect[2])), Math.max(...use.map(p => p.rect[3]))]]);
		});
		for (let i = 0; i < boxes.length; i++) {
			for (let j = i + 1; j < boxes.length; j++) {
				const [na, a] = boxes[i];
				const [nb, b] = boxes[j];
				const small = Math.min((a[2] - a[0]) * (a[3] - a[1]), (b[2] - b[0]) * (b[3] - b[1]));
				if (small > 1 && overlapArea(a, b) > 0.3 * small)
					add({ rule: 'LAY-05', sev: 'P2', refs: [], msg: `功能块“${na}”与“${nb}”的主器件区域交叠超过 30%：分区不清，走线会互相穿插`, fix: '把两个块的主器件分开摆，各自形成紧凑的一团', at: center(a), zone: [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])], kind: 'block' });
			}
		}
		for (const p of parts) {
			if (MAJOR.has(p.role) && !assigned.has(p.ref))
				add({ rule: 'LAY-09', sev: 'P2', refs: [p.ref], msg: `${p.ref} 没有分到任何功能块`, fix: '在设计确认 G2 里把它归到一个功能块', at: center(p.rect), kind: 'part' });
		}
	}

	// ---- 射频与间距
	const ants = parts.filter(p => p.role === 'antenna' || p.role === 'rf_module');
	const rfMates = new Set<string>();
	for (const b of Array.isArray(rawBlocks) ? rawBlocks : []) {
		if (b && Array.isArray(b.parts) && ants.some(a => b.parts.includes(a.ref))) {
			for (const r of b.parts) {
				if (['cap', 'res', 'inductor', 'other'].includes(byRef.get(r)?.role ?? ''))
					rfMates.add(r);
			}
		}
	}
	for (const a of ants) {
		const r = a.rect;
		const d = Math.min(r[0] - bb[0], bb[2] - r[2], r[1] - bb[1], bb[3] - r[3]);
		if (d > 0.5)
			add({ rule: 'LAY-06', sev: 'P1', refs: [a.ref], msg: `天线 ${a.ref} 不在板边（离最近板边 ${f1(d)} mm）：净空区被板内铜皮和器件包围`, fix: '把天线移到板边，馈点朝板内', at: center(r), kind: 'antenna' });
		if (a.role === 'antenna') {
			const z: Rect = [r[0] - 3, r[1] - 3, r[2] + 3, r[3] + 3];
			for (const q of parts) {
				if (q.ref === a.ref || rfMates.has(q.ref) || q.role === 'hole')
					continue;
				if (overlap(q.rect, z, 0) && rectDist(q.rect, r) < 3 - 1e-6)
					add({ rule: 'LAY-06', sev: 'P1', refs: [a.ref, q.ref], msg: `${q.ref} 在天线 ${a.ref} 的 3 mm 净空区内`, fix: '移出净空区（匹配网络器件请在 G2 里和天线放进同一功能块）', at: center(q.rect), zone: z, kind: 'antenna' });
			}
		}
	}
	for (const p of parts) {
		if (p.role !== 'imu')
			continue;
		const r = p.rect;
		const d = Math.min(r[0] - bb[0], bb[2] - r[2], r[1] - bb[1], bb[3] - r[3]);
		if (d < 3 - 1e-6)
			add({ rule: 'LAY-11', sev: 'P2', refs: [p.ref], msg: `IMU ${p.ref} 离板边 ${f1(d)} mm（建议 ≥ 3 mm）：板边受力最大，分板和装配应力会影响零偏`, fix: '往板内挪', at: center(r), kind: 'part' });
	}
	const pickRole = (roles: string[]): LayoutPart | undefined => parts.find(p => roles.includes(p.role));
	const chg = pickRole(['charger']);
	const reg = pickRole(['dcdc', 'ldo']);
	const main = pickRole(['soc_rf', 'mcu', 'rf_module']);
	if (chg && reg && main && rectDist(reg.rect, main.rect) > rectDist(chg.rect, main.rect) + 1)
		add({ rule: 'LAY-15', sev: 'P3', refs: [chg.ref, reg.ref, main.ref], msg: `电源流向绕路：稳压器 ${reg.ref} 离主控比充电芯片 ${chg.ref} 还远，电源要先绕到远处再回来`, fix: '按 输入 → 充电 → 稳压 → 主控 的顺序排成一条线', at: center(reg.rect), kind: 'part' });
	const seen = new Set<string>();
	for (const [rule, sev, A, B, dmin, why] of MIN_DIST) {
		for (const a of parts) {
			if (!A.has(a.role))
				continue;
			for (const b of parts) {
				if (b.ref === a.ref || !B.has(b.role))
					continue;
				const key = `${rule}|${[a.ref, b.ref].sort().join('|')}`;
				if (seen.has(key))
					continue;
				const d = rectDist(a.rect, b.rect);
				if (d < dmin - 1e-6) {
					seen.add(key);
					add({ rule, sev, refs: [a.ref, b.ref], msg: `${a.ref} 与 ${b.ref} 相距 ${f1(d)} mm（至少 ${dmin} mm）：${why}`, fix: `再拉开 ${f1(dmin - d)} mm`, at: center(a.rect), target: center(b.rect), kind: 'spacing' });
				}
			}
		}
	}

	// ---- 就近原则（与布线检查同一套 RTP 规则）
	const ctx = new Ctx(null);
	const classes: Record<string, string> = {};
	for (const n of board.nets) classes[n.name] = inferClass(n.name, n.pads)[0];
	upgradePairs(classes, board.nets, ctx.cons, []);
	const values: Record<string, string> = {};
	for (const p of board.parts ?? []) values[p.ref] = p.value ?? '';
	checkProximity(ctx, board.nets, classes, values, board.layers.length, board.nets.some(n => n.zone));
	for (const v of ctx.out) {
		const refs = [...new Set(v.msg.match(/(?<![.\w])[A-Z]{1,3}\d+\b/g) ?? [])].slice(0, 3);
		add({ rule: v.rule, sev: v.sev, refs, msg: v.msg, at: v.at, kind: 'proximity' });
	}

	const order: Record<string, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };
	issues.sort((a, b) => order[a.sev] - order[b.sev] || a.rule.localeCompare(b.rule));
	const cnt = (s: string): number => issues.filter(v => v.sev === s).length;
	const rep: LayoutReport = { kind: 'lpiot-layout-lint', version: 1, p0: cnt('P0'), p1: cnt('P1'), p2: cnt('P2'), p3: cnt('P3'), pass: cnt('P0') === 0, issues, board_mm: [Math.round(W * 100) / 100, Math.round(H * 100) / 100], bbox: bb, parts, blocks };
	if (brief) {
		rep.brief_hash = gateHash(brief, 'G2');
		rep.brief_complete = Object.fromEntries((['G0', 'G1', 'G2'] as const).map(g => [g, !missing(brief, g).length]));
	}
	else {
		rep.note = '没有设计确认内容：只做了通用检查。固定件位置、功能分区和禁布区需要先在“设计确认”页填写。';
	}
	return rep;
}
