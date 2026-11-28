/** 网络类、推导规则、约束默认值（与 route_lint.py 一致） */
import type { Pad, Pt, Seg, Via } from './geom';

export interface ClassRule {
	width: number | null;
	min_width: number | null;
	via_budget: number | null;
	tau_max: number | null;
	critical?: boolean;
	max_len_mm?: number;
	allow_arc?: boolean;
	no_branch?: boolean;
	skew_mm?: number;
	skew_max_mm?: number;
	clearance?: number;
	_zone?: boolean;
}

export const CLASSES: Record<string, ClassRule> = {
	SIG: { width: 0.2, min_width: 0.127, via_budget: 2, tau_max: 1.3 },
	CLK: { width: 0.2, min_width: 0.127, via_budget: 1, tau_max: 1.15, critical: true },
	ANALOG: { width: 0.2, min_width: 0.15, via_budget: 2, tau_max: 1.15, critical: true },
	XTAL: { width: 0.2, min_width: 0.127, via_budget: 0, tau_max: 1.15, max_len_mm: 5, critical: true },
	RF50: { width: null, min_width: 0.15, via_budget: 0, tau_max: 1.15, critical: true, allow_arc: true, no_branch: true },
	USB90: { width: 0.2, min_width: 0.127, via_budget: 2, tau_max: 1.15, critical: true, skew_mm: 0.5, skew_max_mm: 1.25 },
	DIFF100: { width: 0.15, min_width: 0.1, via_budget: 2, tau_max: 1.15, critical: true, skew_mm: 0.13, skew_max_mm: 0.5 },
	PWR_LOW: { width: 0.3, min_width: 0.25, via_budget: null, tau_max: null },
	PWR_MAIN: { width: 0.6, min_width: 0.5, via_budget: null, tau_max: null },
	SW: { width: null, min_width: 0.3, via_budget: null, tau_max: null },
	HV: { width: 0.3, min_width: 0.3, via_budget: 2, tau_max: 1.3 },
	GND: { width: null, min_width: null, via_budget: null, tau_max: null },
};

export const PRIORITY = ['RF50', 'XTAL', 'SW', 'HV', 'USB90', 'DIFF100', 'CLK', 'ANALOG', 'PWR_MAIN', 'PWR_LOW', 'SIG', 'GND'];

const NAME_RULES: [RegExp, string, number][] = [
	[/^([ADPSC])?GND|^VSS|^EARTH|^0V$/i, 'GND', 0.95],
	[/^(SW|LX|PH)\d*$|_(SW|LX)\d*$/i, 'SW', 0.9],
	[/USB.*D[PN+\-]$|^D[+\-]$|USB_?D?[PN]$|_D[PN]$/i, 'USB90', 0.9],
	[/LVDS|MIPI|HDMI|SERDES|(^|_)(TX|RX|CK|CLK|D\d)_?[PN]$/i, 'DIFF100', 0.85],
	[/XTAL|^XIN|^XOUT|^XC\d|^XL\d|OSC_?(IN|OUT)|32K/i, 'XTAL', 0.85],
	[/(^|_)(ANT|RF)(_|$|\d)|RFIO|LNA|^RF/i, 'RF50', 0.85],
	[/^HV|PULSE|VPP|VNN/i, 'HV', 0.85],
	[/VBAT|VBUS|VIN|VSYS|BAT\+|^\+?BATT?$/i, 'PWR_MAIN', 0.85],
	[/^\+|VCC|VDD|VOUT|PWR|\dV\d|^\d+V\d*$|VREG|VIO/i, 'PWR_LOW', 0.85],
	[/CLK|SCK|MCLK|BCLK|LRCK/i, 'CLK', 0.85],
	[/ADC|AIN|SENS|ANA|VREF|MIC|ECG|PPG/i, 'ANALOG', 0.8],
	[/SCL|SDA|TXD?|RXD?|MOSI|MISO|CS|EN|INT|RST|GPIO|^P\d/i, 'SIG', 0.85],
];
const CTRL = /EN|CTRL|SEL|_SW_?C|GPIO/i;

export function inferClass(name: string, pads: Pad[] = []): [string, number, string] {
	let cls = 'SIG';
	let conf = 0.6;
	let why = '默认';
	if (!name || name.startsWith('Net-(') || name.startsWith('unconnected-') || /^\$/.test(name)) {
		cls = 'SIG';
		conf = 0.5;
		why = '未命名网络';
	}
	else {
		for (const [pat, c, p] of NAME_RULES) {
			if (pat.test(name)) {
				cls = c;
				conf = p;
				why = `网络名匹配 ${pat.source}`;
				break;
			}
		}
		if (cls === 'RF50' && CTRL.test(name)) {
			cls = 'SIG';
			conf = 0.6;
			why = '名字含 RF 但像控制线';
		}
	}
	if (cls === 'SIG' && conf < 0.9) {
		const refs = pads.map(p => [String(p.ref ?? ''), String(p.pin ?? '')]);
		if (refs.some(([r]) => /^(Y|X)\d/.test(r)))
			return ['XTAL', 0.9, '连到晶振'];
		if (refs.some(([r, q]) => /^(J|USB|CN)/.test(r) && ['A6', 'A7', 'B6', 'B7', 'D+', 'D-', 'DP', 'DM'].includes(q.toUpperCase())))
			return ['USB90', 0.85, '连到 USB 连接器的 D+/D- 脚'];
		if (refs.some(([r, q]) => /^(ANT|AE|E)\d/.test(r) || ['ANT', 'FEED', 'RF'].includes(q.toUpperCase())))
			return ['RF50', 0.85, '连到天线或 ANT/RF 脚'];
		if (refs.some(([r]) => /^L\d/.test(r)) && refs.some(([r]) => /^U\d/.test(r)) && !name.startsWith('Net-(L'))
			return ['SW', 0.7, '电感与芯片之间（可能是开关节点）'];
	}
	return [cls, conf, why];
}

export interface Constraints {
	geometry: { angle_tol_um: number; min_seg: { k_w: number; abs_mm: number }; fanout_k_w: number; jog_k_w: number; jitter_window_k_w: number; forbid_right_angle?: boolean };
	netclasses: Record<string, Partial<ClassRule>>;
	nets: Record<string, { class?: string }>;
	layers: { name?: string; role?: string; preferred_dir?: 'H' | 'V' | null }[];
	bundles: { id: string; nets: string[]; pitch_mm?: number }[];
	exempt_zones: { poly: Pt[]; rules: string[]; reason?: string }[];
	keepouts: { poly: Pt[] }[];
	locks: { net: string }[];
	pairs: { p: string; n: string }[];
	board: { fab_min_track?: number };
}

export function mergeCons(c?: Partial<Constraints> | null): Constraints {
	const base: Constraints = {
		geometry: { angle_tol_um: 1, min_seg: { k_w: 1, abs_mm: 0.15 }, fanout_k_w: 0.5, jog_k_w: 2, jitter_window_k_w: 5, forbid_right_angle: true },
		netclasses: {},
		nets: {},
		layers: [],
		bundles: [],
		exempt_zones: [],
		keepouts: [],
		locks: [],
		pairs: [],
		board: {},
	};
	if (c) {
		for (const [k, v] of Object.entries(c)) {
			const cur = (base as any)[k];
			(base as any)[k] = v && typeof v === 'object' && !Array.isArray(v) && cur && typeof cur === 'object' && !Array.isArray(cur) ? { ...cur, ...v } : v;
		}
	}
	return base;
}

export function classRules(cls: string, cons?: Constraints): ClassRule {
	return { ...(CLASSES[cls] ?? CLASSES.SIG), ...((cons?.netclasses ?? {})[cls] ?? {}) };
}

/** 一个网络 */
export interface Net {
	name: string;
	segs: Seg[];
	vias: Via[];
	pads: Pad[];
	zone?: boolean;
}

/** 整块板（数据包） */
export interface Board {
	layers: string[];
	nets: Net[];
	parts?: { ref: string; value?: string }[];
	planes?: { layer: number; gnd_frac: number; frag: number; pieces?: number }[];
	outline?: Pt[];
	units?: string;
}

export interface Violation {
	rule: string;
	sev: 'P0' | 'P1' | 'P2' | 'P3';
	net: string | null;
	layer: number | null;
	msg: string;
	at?: [number, number];
	value?: unknown;
	metric?: string;
	ids?: string[];
}
