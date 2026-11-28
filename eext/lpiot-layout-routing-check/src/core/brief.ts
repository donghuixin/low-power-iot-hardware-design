/**
 * 设计确认闸门（与 scripts/design_gate.py 一致）：布局、布线之前必须由用户逐级确认的设计信息。
 * 确认码 = 闸门名 + 该闸门及之前所有闸门内容的 SHA-256 前 6 位；内容一改，后面的确认全部失效。
 */

export const KIND = 'lpiot-design-brief';
export const GATES = ['G0', 'G1', 'G2', 'G3', 'G4', 'G5'] as const;
export type Gate = typeof GATES[number];
export const SECTION: Record<Gate, string> = {
	G0: 'G0_requirements',
	G1: 'G1_mechanical',
	G2: 'G2_partition',
	G3: 'G3_layout_check',
	G4: 'G4_routing_plan',
	G5: 'G5_acceptance',
};
export const TITLE: Record<Gate, string> = {
	G0: '需求与工艺',
	G1: '板框、外壳与固定位置',
	G2: '功能分区与布局评审',
	G3: '布局检查',
	G4: '布线规划',
	G5: '交付验收',
};
export const STAGES: Record<'place' | 'route' | 'deliver', Gate[]> = {
	place: ['G0', 'G1'],
	route: ['G0', 'G1', 'G2', 'G3', 'G4'],
	deliver: [...GATES],
};
export const STAGE_NAME = { place: '开始摆放器件', route: '开始布线（含自动修复、写回 EDA）', deliver: '宣布完成 / 交付打样' };
export type GateState = 'missing' | 'blocked' | 'pending' | 'confirmed' | 'stale';
export const STATE_ZH: Record<GateState, string> = { missing: '缺信息', blocked: '等前一级', pending: '待用户确认', confirmed: '已确认', stale: '已失效' };

const PLACEHOLDER = /^(?:待填|待定|tbd|todo|\?+|？+|x{2,}|n\/?a|未知|不知道|随便|都行|你定|你看着办)$/i;

export function template(): any {
	return {
		kind: KIND,
		version: 1,
		project: { name: '待填', owner: '待填' },
		roles: {},
		G0_requirements: {
			function: '待填：这块板做什么、给谁用、在什么场景下用（不少于一句完整的话）',
			power: { source: '待填：如 CR2032 / 1S 锂电 500 mAh / USB 5 V', peak_ma: '待填', sleep_ua: '待填' },
			wireless: '待填：BLE / Wi-Fi / LoRa / 无',
			environment: '待填：温度、佩戴/固定方式、防水等',
			fab: { layers: '待填', thickness_mm: '待填', fab: '待填：如 JLC', tier: '待填：standard / 加价档' },
		},
		G1_mechanical: {
			outline: { shape: '待填：rect / round / dxf', w_mm: '待填', h_mm: '待填', file: '' },
			enclosure: { material: '待填：塑料 / 金属 / 无外壳', max_height_top_mm: '待填', max_height_bottom_mm: '待填' },
			holes: '待填：固定孔列表 [{x_mm,y_mm,d_mm}]，没有就写 无',
			fixed: '待填：位置被外壳决定的器件 [{ref, what, edge: left/right/top/bottom, along_mm, tol_mm, side, reason}]',
			keepouts: '待填：禁布区 [{rect_mm:[x0,y0,x1,y1] 或 rect_frac, reason}]，没有就写 无',
		},
		G2_partition: {
			blocks: '待填：功能块 [{name, parts:[位号…], region, why}]，region 可写 left/right/top/bottom/top-left… 或 [fx0,fy0,fx1,fy1]（板框比例，y 向上）',
			signal_flow: '待填：电源和信号从哪里进、经过哪些块、到哪里去，例如 USB(左) → 充电 → LDO → MCU(中) → 射频与天线(右)',
			layout_review: { screenshot: '待填：用户看过并认可的布局截图文件名', notes: '' },
		},
		G3_layout_check: {
			report: '待填：layout_lint.py 生成的 JSON 报告路径',
			accepted_exceptions: '待填：用户同意保留的 P1/P2 问题 [{rule, refs, why}]，没有就写 无',
		},
		G4_routing_plan: {
			stackup: '待填：每层用途 [{layer, use}]，例如 B.Cu 完整地平面',
			priorities: '待填：布线顺序 [{tier, class, nets:[…], method: 手工/工具辅助, rules}]，先射频、晶振、开关回路、高速差分',
			diff_pairs: '待填：差分对 [{p, n, impedance_ohm, skew_mm}]，没有就写 无',
			power_nets: '待填：电源网络 [{net, current_ma, width_mm}]',
			acceptance: { route_lint_min_score: 80, drc_zero: true, human_review: true },
		},
		G5_acceptance: {
			route_report: '待填：route_lint.py lint --json 的报告路径',
			drc_errors: '待填：EDA 原生 DRC 的错误数',
			screenshots: '待填：用户看过的布线截图 [文件名…]',
		},
		confirmations: {},
	};
}

// ------------------------------------------------------------------ 取值与校验
export function get(d: any, path: string): any {
	let cur = d;
	for (const k of path.split('.')) {
		if (!cur || typeof cur !== 'object' || Array.isArray(cur) || !(k in cur))
			return undefined;
		cur = cur[k];
	}
	return cur;
}

export function setPath(d: any, path: string, v: any): void {
	const ks = path.split('.');
	let cur = d;
	for (const k of ks.slice(0, -1)) {
		if (!cur[k] || typeof cur[k] !== 'object' || Array.isArray(cur[k]))
			cur[k] = {};
		cur = cur[k];
	}
	cur[ks[ks.length - 1]] = v;
}

function isBlank(v: any): boolean {
	return v === undefined || v === null || (typeof v === 'string' && (v.trim() === '' || PLACEHOLDER.test(v.trim()) || v.trim().startsWith('待填')));
}
function isNoneWord(v: any): boolean {
	return typeof v === 'string' && ['无', '没有', 'none', 'None', 'NONE'].includes(v.trim());
}
function num(v: any): number | null {
	if (typeof v === 'boolean')
		return null;
	if (typeof v === 'number')
		return Number.isFinite(v) ? v : null;
	if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v.trim())))
		return Number(v.trim());
	return null;
}

export interface Field { path: string; label: string; kind: 'text' | 'number' | 'list'; hint?: string }
type Check = (b: any) => string[];
interface Req { field?: Field; check: Check }

function reqText(path: string, label: string, minLen = 1): Req {
	return {
		field: { path, label, kind: 'text' },
		check: (b) => {
			const v = get(b, path);
			if (isBlank(v) || typeof v !== 'string' || v.trim().length < minLen)
				return [`${label}（${path}）${minLen > 1 ? `：至少 ${minLen} 个字，说清楚` : ''}`];
			return [];
		},
	};
}
function reqNum(path: string, label: string, lo?: number): Req {
	return {
		field: { path, label, kind: 'number' },
		check: (b) => {
			const v = num(get(b, path));
			if (v === null)
				return [`${label}（${path}）：要一个数字`];
			if (lo !== undefined && v < lo)
				return [`${label}（${path}）：不能小于 ${lo}`];
			return [];
		},
	};
}
function reqList(path: string, label: string, minItems = 1, itemKeys: string[] = [], allowNone = false, hint = ''): Req {
	return {
		field: { path, label, kind: 'list', hint },
		check: (b) => {
			const v = get(b, path);
			if (allowNone && (isNoneWord(v) || (Array.isArray(v) && v.length === 0)))
				return [];
			if (!Array.isArray(v) || v.length < minItems)
				return [`${label}（${path}）：至少 ${minItems} 项${allowNone ? '；确实没有就写 无' : ''}`];
			const out: string[] = [];
			v.forEach((it: any, i: number) => {
				if (itemKeys.length && (typeof it !== 'object' || it === null || Array.isArray(it))) {
					out.push(`${label} 第 ${i + 1} 项应写成对象，含 ${itemKeys.join('、')}`);
					return;
				}
				for (const k of itemKeys) {
					const x = it[k];
					if (Array.isArray(x) ? !x.length : isBlank(x))
						out.push(`${label} 第 ${i + 1} 项缺 ${k}`);
				}
			});
			return out;
		},
	};
}

function reportCheck(b: any, pathKey: string, resKey: string, reports: Record<string, any>): [any, string[]] {
	const emb = get(b, resKey);
	if (emb && typeof emb === 'object' && !Array.isArray(emb))
		return [emb, []];
	const p = get(b, pathKey);
	if (isBlank(p) || typeof p !== 'string')
		return [null, []];
	if (reports[p])
		return [reports[p], []];
	return [null, [`报告 ${p} 在扩展里读不到：在“布局”页重新检查并记录`]];
}

export function makeRequire(reports: Record<string, any> = {}): Record<Gate, Req[]> {
	return {
		G0: [
			reqText('project.name', '项目名'),
			reqText('G0_requirements.function', '产品功能与使用场景', 10),
			reqText('G0_requirements.power.source', '供电方式'),
			reqNum('G0_requirements.power.peak_ma', '峰值电流 mA', 0),
			reqText('G0_requirements.wireless', '无线方式（没有写 无）'),
			reqText('G0_requirements.environment', '使用环境'),
			reqNum('G0_requirements.fab.layers', '层数', 1),
			reqNum('G0_requirements.fab.thickness_mm', '板厚 mm', 0.2),
			reqText('G0_requirements.fab.fab', '板厂'),
		],
		G1: [
			{ field: { path: 'G1_mechanical.outline.w_mm', label: '板框宽 mm', kind: 'number' }, check: () => [] },
			{ field: { path: 'G1_mechanical.outline.h_mm', label: '板框高 mm', kind: 'number' }, check: () => [] },
			{ field: { path: 'G1_mechanical.outline.file', label: '或：外壳导出的 DXF 文件名', kind: 'text' }, check: (b) => {
				const o = get(b, 'G1_mechanical.outline') ?? {};
				if (typeof o.file === 'string' && o.file.trim() && !isBlank(o.file))
					return [];
				if (num(o.w_mm) && num(o.h_mm))
					return [];
				return ['板框（G1_mechanical.outline）：给出外形尺寸 w_mm × h_mm，或外壳图纸导出的 DXF 文件'];
			} },
			reqText('G1_mechanical.enclosure.material', '外壳材料（没有外壳写 无外壳）'),
			reqNum('G1_mechanical.enclosure.max_height_top_mm', '顶面限高 mm', 0),
			reqList('G1_mechanical.holes', '固定孔', 1, [], true, '[{"x_mm":3,"y_mm":3,"d_mm":2.2}] 或 无'),
			reqList('G1_mechanical.fixed', '固定位置的器件（接口、按键、灯、天线、电池、传感器开窗）', 1, ['ref', 'edge', 'reason'], false, '[{"ref":"J1","what":"USB-C","edge":"bottom","along_mm":19,"tol_mm":1,"reason":"外壳开孔"}]'),
			{ check: (b) => {
				const v = get(b, 'G1_mechanical.fixed');
				const out: string[] = [];
				if (Array.isArray(v)) {
					v.forEach((it: any, i: number) => {
						if (it && typeof it === 'object' && it.edge !== undefined && !['left', 'right', 'top', 'bottom', 'inner'].includes(it.edge))
							out.push(`固定件第 ${i + 1} 项 edge 只能是 left/right/top/bottom/inner`);
					});
				}
				return out;
			} },
			reqList('G1_mechanical.keepouts', '禁布区', 1, [], true, '[{"rect_frac":[0,0.8,1,1],"reason":"天线净空"}] 或 无'),
		],
		G2: [
			reqList('G2_partition.blocks', '功能块', 2, ['name', 'parts', 'region'], false, '[{"name":"射频","parts":["U1","ANT1"],"region":"top","why":"天线朝上"}]'),
			reqText('G2_partition.signal_flow', '信号与电源流向', 10),
			reqText('G2_partition.layout_review.screenshot', '用户看过的布局截图'),
		],
		G3: [
			{ check: (b) => {
				const [rep, err] = reportCheck(b, 'G3_layout_check.report', 'G3_layout_check.result', reports);
				if (err.length)
					return err;
				if (!rep)
					return ['布局检查报告：在“布局”页检查后点“记录为 G3 依据”'];
				const out: string[] = [];
				if (rep.kind !== 'lpiot-layout-lint')
					out.push('布局检查报告不是 layout_lint.py / 扩展生成的');
				if ((rep.p0 ?? 1) > 0)
					out.push(`布局检查还有 ${rep.p0} 个 P0：改完布局重新检查`);
				if (rep.brief_hash !== gateHash(b, 'G2'))
					out.push('布局检查报告是按旧的 G0–G2 内容生成的：重新检查并记录');
				return out;
			} },
			reqList('G3_layout_check.accepted_exceptions', '保留的问题', 1, [], true, '[{"rule":"LAY-07","refs":["L1","Y1"],"why":"空间受限，已加屏蔽"}] 或 无'),
		],
		G4: [
			reqList('G4_routing_plan.stackup', '叠层用途', 1, ['layer', 'use'], false, '[{"layer":"TOP","use":"器件与信号"},{"layer":"BOTTOM","use":"完整地平面"}]'),
			{ check: (b) => {
				const st = get(b, 'G4_routing_plan.stackup');
				const n = num(get(b, 'G0_requirements.fab.layers'));
				if (Array.isArray(st) && n && st.length < Math.trunc(n))
					return [`叠层（G4_routing_plan.stackup）只写了 ${st.length} 层，但工艺是 ${Math.trunc(n)} 层板，每层都要写用途`];
				return [];
			} },
			reqList('G4_routing_plan.priorities', '布线优先级（可以在下面“从板子梳理”）', 1, ['tier', 'nets', 'method'], false, '[{"tier":1,"name":"射频与天线","nets":["RF_ANT"],"method":"手工","rules":"50Ω"}]'),
			{ check: (b) => {
				const sts = tierStates(b);
				const left = sts.filter(x => x.state !== 'confirmed').map(x => `第 ${x.tier} 档${x.name ? `（${x.name}）` : ''}`);
				return sts.length && left.length ? [`布线优先级还要逐档确认：${left.slice(0, 4).join('、')}${left.length > 4 ? ' 等' : ''}`] : [];
			} },
			reqList('G4_routing_plan.diff_pairs', '差分对', 1, [], true, '[{"p":"USB_DP","n":"USB_DM","impedance_ohm":90,"skew_mm":0.5}] 或 无'),
			reqList('G4_routing_plan.power_nets', '电源网络与电流', 1, ['net', 'current_ma'], false, '[{"net":"VBAT","current_ma":300,"width_mm":0.5}]'),
			{ field: { path: 'G4_routing_plan.acceptance.route_lint_min_score', label: '验收分数（≥ 75）', kind: 'number' }, check: (b) => {
				const v = num(get(b, 'G4_routing_plan.acceptance.route_lint_min_score'));
				return v === null || v < 75 ? ['验收分数（G4_routing_plan.acceptance.route_lint_min_score）：不低于 75'] : [];
			} },
		],
		G5: [
			{ check: (b) => {
				const [rep, err] = reportCheck(b, 'G5_acceptance.route_report', 'G5_acceptance.route_result', reports);
				if (err.length)
					return err;
				if (!rep)
					return ['布线检查结果：在“结论”页检查后点“记录为 G5 依据”'];
				const need = num(get(b, 'G4_routing_plan.acceptance.route_lint_min_score')) ?? 80;
				const out: string[] = [];
				if ((rep.p0 ?? 0) > 0 || rep.pass === false)
					out.push('布线检查有 P0：不能交付');
				if (rep.score === undefined || rep.score === null || rep.score < need)
					out.push(`布线得分 ${rep.score} 低于验收线 ${need}`);
				return out;
			} },
			{ field: { path: 'G5_acceptance.drc_errors', label: 'EDA 原生 DRC 错误数', kind: 'number' }, check: (b) => {
				const v = num(get(b, 'G5_acceptance.drc_errors'));
				if (v === null)
					return ['DRC 错误数（G5_acceptance.drc_errors）：在 EDA 里跑一次 DRC 填数字'];
				if (v > 0 && get(b, 'G4_routing_plan.acceptance.drc_zero') !== false)
					return [`DRC 还有 ${Math.trunc(v)} 个错误`];
				return [];
			} },
			reqList('G5_acceptance.screenshots', '用户看过的布线截图', 1, [], false, '["route-top.png"]'),
		],
	};
}

export function fields(gate: Gate): Field[] {
	return makeRequire()[gate].map(r => r.field).filter(Boolean) as Field[];
}

export function missing(b: any, gate: Gate, reports: Record<string, any> = {}): string[] {
	return makeRequire(reports)[gate].flatMap(r => r.check(b));
}

// ------------------------------------------------------------------ 哈希
function norm(v: any): any {
	if (Array.isArray(v))
		return v.map(norm);
	if (v && typeof v === 'object') {
		const o: any = {};
		for (const k of Object.keys(v)) o[k] = norm(v[k]);
		return o;
	}
	return v;
}

/** 与 Python json.dumps(sort_keys=True, separators=(',',':'), ensure_ascii=False) 一致（整数值的浮点在 JS 里本来就输出为整数） */
export function canonical(v: any): string {
	const x = norm(v);
	if (x === null || x === undefined)
		return 'null';
	if (Array.isArray(x))
		return `[${x.map(canonical).join(',')}]`;
	if (typeof x === 'object')
		return `{${Object.keys(x).sort().map(k => `${JSON.stringify(k)}:${canonical(x[k])}`).join(',')}}`;
	if (typeof x === 'number')
		return Number.isFinite(x) ? String(x) : 'null';
	return JSON.stringify(x);
}

const K = new Uint32Array([0x428A2F98, 0x71374491, 0xB5C0FBCF, 0xE9B5DBA5, 0x3956C25B, 0x59F111F1, 0x923F82A4, 0xAB1C5ED5, 0xD807AA98, 0x12835B01, 0x243185BE, 0x550C7DC3, 0x72BE5D74, 0x80DEB1FE, 0x9BDC06A7, 0xC19BF174, 0xE49B69C1, 0xEFBE4786, 0x0FC19DC6, 0x240CA1CC, 0x2DE92C6F, 0x4A7484AA, 0x5CB0A9DC, 0x76F988DA, 0x983E5152, 0xA831C66D, 0xB00327C8, 0xBF597FC7, 0xC6E00BF3, 0xD5A79147, 0x06CA6351, 0x14292967, 0x27B70A85, 0x2E1B2138, 0x4D2C6DFC, 0x53380D13, 0x650A7354, 0x766A0ABB, 0x81C2C92E, 0x92722C85, 0xA2BFE8A1, 0xA81A664B, 0xC24B8B70, 0xC76C51A3, 0xD192E819, 0xD6990624, 0xF40E3585, 0x106AA070, 0x19A4C116, 0x1E376C08, 0x2748774C, 0x34B0BCB5, 0x391C0CB3, 0x4ED8AA4A, 0x5B9CCA4F, 0x682E6FF3, 0x748F82EE, 0x78A5636F, 0x84C87814, 0x8CC70208, 0x90BEFFFA, 0xA4506CEB, 0xBEF9A3F7, 0xC67178F2]);

function utf8(s: string): number[] {
	const out: number[] = [];
	for (const ch of s) {
		const c = ch.codePointAt(0)!;
		if (c < 0x80) {
			out.push(c);
		}
		else if (c < 0x800) {
			out.push(0xC0 | (c >> 6), 0x80 | (c & 63));
		}
		else if (c < 0x10000) {
			out.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
		}
		else {
			out.push(0xF0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
		}
	}
	return out;
}

export function sha256(s: string): string {
	const bytes = utf8(s);
	const l = bytes.length * 8;
	bytes.push(0x80);
	while (bytes.length % 64 !== 56) bytes.push(0);
	const hi = Math.floor(l / 0x100000000);
	for (const v of [hi, l >>> 0]) bytes.push((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255);
	const H = new Uint32Array([0x6A09E667, 0xBB67AE85, 0x3C6EF372, 0xA54FF53A, 0x510E527F, 0x9B05688C, 0x1F83D9AB, 0x5BE0CD19]);
	const W = new Uint32Array(64);
	const rotr = (x: number, n: number): number => (x >>> n) | (x << (32 - n));
	for (let i = 0; i < bytes.length; i += 64) {
		for (let t = 0; t < 16; t++) W[t] = (bytes[i + 4 * t] << 24) | (bytes[i + 4 * t + 1] << 16) | (bytes[i + 4 * t + 2] << 8) | bytes[i + 4 * t + 3];
		for (let t = 16; t < 64; t++) {
			const s0 = rotr(W[t - 15], 7) ^ rotr(W[t - 15], 18) ^ (W[t - 15] >>> 3);
			const s1 = rotr(W[t - 2], 17) ^ rotr(W[t - 2], 19) ^ (W[t - 2] >>> 10);
			W[t] = (W[t - 16] + s0 + W[t - 7] + s1) >>> 0;
		}
		let [a, b, c, d, e, f, g, h] = H;
		for (let t = 0; t < 64; t++) {
			const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
			const ch = (e & f) ^ (~e & g);
			const t1 = (h + S1 + ch + K[t] + W[t]) >>> 0;
			const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
			const mj = (a & b) ^ (a & c) ^ (b & c);
			const t2 = (S0 + mj) >>> 0;
			h = g;
			g = f;
			f = e;
			e = (d + t1) >>> 0;
			d = c;
			c = b;
			b = a;
			a = (t1 + t2) >>> 0;
		}
		H[0] += a;
		H[1] += b;
		H[2] += c;
		H[3] += d;
		H[4] += e;
		H[5] += f;
		H[6] += g;
		H[7] += h;
	}
	return [...H].map(x => x.toString(16).padStart(8, '0')).join('');
}

export function gateHash(b: any, gate: Gate): string {
	const i = GATES.indexOf(gate);
	const payload: any = { project: b.project ?? null, roles: b.roles ?? {} };
	for (const g of GATES.slice(0, i + 1)) payload[SECTION[g]] = b[SECTION[g]] ?? null;
	return sha256(canonical(payload));
}

export function codeOf(b: any, gate: Gate): string {
	return `${gate}-${gateHash(b, gate).slice(0, 6)}`;
}

export function gateState(b: any, gate: Gate, reports: Record<string, any> = {}): [GateState, string[]] {
	const miss = missing(b, gate, reports);
	if (miss.length)
		return ['missing', miss];
	const i = GATES.indexOf(gate);
	for (const g of GATES.slice(0, i)) {
		if (gateState(b, g, reports)[0] !== 'confirmed')
			return ['blocked', [`先确认 ${g}`]];
	}
	const c = b.confirmations?.[gate];
	if (!c)
		return ['pending', [codeOf(b, gate)]];
	if (c.hash !== gateHash(b, gate))
		return ['stale', [`确认之后内容被改过，需要重新确认：${codeOf(b, gate)}`]];
	return ['confirmed', [c.code ?? '']];
}

/** 记录确认。typed 是用户手动输入的内容，必须包含当前确认码。 */
export function confirm(b: any, gate: Gate, typed: string, by = 'user'): string {
	const [st, det] = gateState(b, gate);
	if (st === 'missing')
		throw new Error(`不能确认，缺：${det.join('；')}`);
	if (st === 'blocked')
		throw new Error(`不能确认：${det[0]}`);
	const code = codeOf(b, gate);
	if (!typed || !typed.replace(/\s+/g, '').toLowerCase().includes(code.toLowerCase()))
		throw new Error(`输入的内容里没有确认码 ${code}`);
	b.confirmations = b.confirmations ?? {};
	b.confirmations[gate] = { code, hash: gateHash(b, gate), quote: typed.trim().slice(0, 500), by, at: new Date().toISOString().replace(/\.\d+Z$/, '+00:00') };
	for (const g of GATES.slice(GATES.indexOf(gate) + 1)) {
		const c = b.confirmations[g];
		if (c && c.hash !== gateHash(b, g))
			delete b.confirmations[g];
	}
	return code;
}

export function requireStage(b: any, stage: keyof typeof STAGES, reports: Record<string, any> = {}): string[] {
	const out: string[] = [];
	for (const g of STAGES[stage]) {
		const [st, det] = gateState(b, g, reports);
		if (st !== 'confirmed')
			out.push(`${g} ${TITLE[g]}：${STATE_ZH[st]}${det.length && st !== 'pending' ? `（${det[0]}）` : ''}`);
	}
	return out;
}

export function status(b: any, reports: Record<string, any> = {}): { gates: { gate: Gate; title: string; state: GateState; detail: string[]; code: string }[]; stages: Record<string, string[]> } {
	return {
		gates: GATES.map((g) => {
			const [state, detail] = gateState(b, g, reports);
			return { gate: g, title: TITLE[g], state, detail, code: codeOf(b, g) };
		}),
		stages: Object.fromEntries((Object.keys(STAGES) as (keyof typeof STAGES)[]).map(s => [s, requireStage(b, s, reports)])),
	};
}

/** 给用户核对的摘要文本 */
export function summary(b: any, gate: Gate): string {
	const sec = b[SECTION[gate]];
	const body = JSON.stringify(gate === 'G0' ? { project: b.project, ...sec } : sec, null, 2);
	return `【${gate} ${TITLE[gate]}】\n${body}\n\n全部正确请输入：确认 ${codeOf(b, gate)}`;
}

// ------------------------------------------------------------------ 布线优先级逐档确认（与 design_gate.py 一致）
export function tierList(b: any): any[] {
	const v = get(b, 'G4_routing_plan.priorities');
	return Array.isArray(v) ? v.filter(t => t && typeof t === 'object' && !Array.isArray(t)) : [];
}

export function tierHash(b: any, idx: number): string {
	const tiers = tierList(b).slice(0, idx + 1).map((t) => {
		const { confirmed: _c, ...rest } = t;
		return rest;
	});
	return sha256(canonical({ base: gateHash(b, 'G3'), tiers }));
}

export function tierCode(b: any, idx: number): string {
	const t = tierList(b)[idx];
	return `T${t?.tier ?? idx + 1}-${tierHash(b, idx).slice(0, 6)}`;
}

export interface TierState { tier: number; name: string; state: 'confirmed' | 'pending' | 'blocked' | 'stale'; code: string; index: number }

export function tierStates(b: any): TierState[] {
	const conf = b.confirmations?.tiers ?? {};
	const out: TierState[] = [];
	let prevOk = true;
	tierList(b).forEach((t, i) => {
		const key = String(t.tier ?? i + 1);
		const c = conf[key];
		const code = tierCode(b, i);
		let state: TierState['state'];
		if (c && c.hash === tierHash(b, i))
			state = 'confirmed';
		else if (!prevOk)
			state = 'blocked';
		else
			state = c ? 'stale' : 'pending';
		out.push({ tier: t.tier ?? i + 1, name: t.name ?? '', state, code, index: i });
		prevOk = state === 'confirmed';
	});
	return out;
}

export function confirmTier(b: any, tier: number | string, typed: string, by = 'user'): string {
	const tiers = tierList(b);
	const idx = tiers.findIndex((t, i) => String(t.tier ?? i + 1) === String(tier));
	if (idx < 0)
		throw new Error(`没有第 ${tier} 档`);
	for (const s of tierStates(b).slice(0, idx)) {
		if (s.state !== 'confirmed')
			throw new Error(`先确认第 ${s.tier} 档（${s.name}）`);
	}
	const code = tierCode(b, idx);
	if (!typed || !typed.replace(/\s+/g, '').toLowerCase().includes(code.toLowerCase()))
		throw new Error(`没有确认码 ${code}`);
	b.confirmations = b.confirmations ?? {};
	b.confirmations.tiers = b.confirmations.tiers ?? {};
	b.confirmations.tiers[String(tier)] = { code, hash: tierHash(b, idx), quote: typed.trim().slice(0, 500), by, at: new Date().toISOString().replace(/\.\d+Z$/, '+00:00') };
	return code;
}
