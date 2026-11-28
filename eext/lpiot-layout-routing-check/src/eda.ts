/**
 * 嘉立创 EDA 专业版 ↔ 检查核心之间的适配：读板（mil → mm）、选中定位、写回修复（mm → mil，命令组可撤销）。
 */
import type { Board, FinishText, Net, Pad, Pt, Seg, Via } from './core';
import { textBBox } from './core';

export const MIL = 0.0254; // mm / mil
const mm = (v: number) => v * MIL;
const mil = (v: number) => Math.round((v / MIL) * 100) / 100; // 取到 0.01 mil

/** EDA 图层 ID → 检查用层序号（0 = 顶层，nL-1 = 底层，内层 1…） */
export function layerIndex(id: number, nL: number): number | null {
	if (id === 1)
		return 0;
	if (id === 2)
		return nL - 1;
	if (id >= 15 && id <= 44)
		return id - 14 < nL - 1 ? id - 14 : null;
	if (id === 12)
		return -1;
	return null;
}
export function layerId(idx: number, nL: number): number {
	if (idx === 0)
		return 1;
	if (idx === nL - 1)
		return 2;
	return 14 + idx;
}

function nums(src: unknown): number[] {
	return Array.isArray(src) ? (src.flat(3).filter(x => typeof x === 'number') as number[]) : [];
}

function padGeom(shape: any): { w: number | null; h: number | null; shape: string } {
	if (!Array.isArray(shape))
		return { w: null, h: null, shape: 'rect' };
	const t = shape[0];
	if (t === 'POLYGON') {
		const v = nums(shape[1]);
		const xs = v.filter((_, i) => i % 2 === 0);
		const ys = v.filter((_, i) => i % 2 === 1);
		if (!xs.length)
			return { w: null, h: null, shape: 'rect' };
		return { w: mm(Math.max(...xs) - Math.min(...xs)), h: mm(Math.max(...ys) - Math.min(...ys)), shape: 'rect' };
	}
	const w = mm(Number(shape[1]) || 0);
	const h = mm(Number(shape[2] ?? shape[1]) || 0);
	if (t === 'NGON' || (t === 'ELLIPSE' && Math.abs(w - h) < 1e-6))
		return { w, h: w, shape: 'circle' };
	return { w, h, shape: t === 'RECT' ? 'rect' : 'oval' };
}

/** 圆弧（两点 + 圆心角）离散成折线，标为圆弧 */
function arcPoints(x1: number, y1: number, x2: number, y2: number, angleDeg: number): Pt[] {
	const a = (angleDeg * Math.PI) / 180;
	const dx = x2 - x1;
	const dy = y2 - y1;
	const c = Math.hypot(dx, dy);
	if (Math.abs(a) < 1e-6 || c < 1e-9)
		return [[x1, y1], [x2, y2]];
	const r = c / 2 / Math.sin(Math.abs(a) / 2);
	const mx = (x1 + x2) / 2;
	const my = (y1 + y2) / 2;
	const h = Math.sqrt(Math.max(0, r * r - (c / 2) ** 2)) * (Math.abs(a) > Math.PI ? -1 : 1) * Math.sign(a);
	const cx = mx - (dy / c) * h;
	const cy = my + (dx / c) * h;
	const t0 = Math.atan2(y1 - cy, x1 - cx);
	const n = Math.max(4, Math.ceil(Math.abs(angleDeg) / 10));
	const pts: Pt[] = [];
	for (let i = 0; i <= n; i++) {
		const t = t0 + (a * i) / n;
		pts.push([cx + r * Math.cos(t), cy + r * Math.sin(t)]);
	}
	pts[pts.length - 1] = [x2, y2];
	return pts;
}

export interface ReadResult { board: Board; bbox: [number, number, number, number]; warnings: string[] }

/** 读取当前 PCB */
export async function readBoard(): Promise<ReadResult> {
	const warnings: string[] = [];
	const nL = Math.max(2, (await eda.pcb_Layer.getTheNumberOfCopperLayers()) || 2);
	const layers = Array.from({ length: nL }, (_, i) => (i === 0 ? 'TOP' : i === nL - 1 ? 'BOTTOM' : `INNER_${i}`));
	const nets = new Map<string, Net>();
	const net = (name: string) => {
		if (!nets.has(name))
			nets.set(name, { name, segs: [], vias: [], pads: [] });
		return nets.get(name)!;
	};
	for (const l of await eda.pcb_PrimitiveLine.getAll()) {
		const li = layerIndex(Number(l.getState_Layer()), nL);
		const nm = l.getState_Net();
		if (li === null || li < 0 || !nm)
			continue;
		net(nm).segs.push([li, mm(l.getState_StartX()), mm(l.getState_StartY()), mm(l.getState_EndX()), mm(l.getState_EndY()), mm(l.getState_LineWidth()), false, l.getState_PrimitiveId()]);
	}
	for (const a of await eda.pcb_PrimitiveArc.getAll()) {
		const li = layerIndex(Number(a.getState_Layer()), nL);
		const nm = a.getState_Net();
		if (li === null || li < 0 || !nm)
			continue;
		const pts = arcPoints(a.getState_StartX(), a.getState_StartY(), a.getState_EndX(), a.getState_EndY(), a.getState_ArcAngle());
		for (let i = 0; i < pts.length - 1; i++) net(nm).segs.push([li, mm(pts[i][0]), mm(pts[i][1]), mm(pts[i + 1][0]), mm(pts[i + 1][1]), mm(a.getState_LineWidth()), true, a.getState_PrimitiveId()]);
	}
	for (const v of await eda.pcb_PrimitiveVia.getAll()) {
		const nm = v.getState_Net();
		if (nm)
			net(nm).vias.push([mm(v.getState_X()), mm(v.getState_Y()), mm(v.getState_Diameter()), v.getState_PrimitiveId()] as Via);
	}
	const comps = await eda.pcb_PrimitiveComponent.getAll();
	const parts: { ref: string; value?: string }[] = [];
	const seen = new Set<string>();
	const addPad = (p: any, ref: string) => {
		const id = p.getState_PrimitiveId();
		if (seen.has(id))
			return;
		seen.add(id);
		const nm = p.getState_Net();
		if (!nm)
			return;
		const lid = Number(p.getState_Layer());
		const g = padGeom(p.getState_Pad());
		const pad: Pad = { ref, pin: String(p.getState_PadNumber() ?? ''), l: lid === 12 ? -1 : (layerIndex(lid, nL) ?? 0), x: mm(p.getState_X()), y: mm(p.getState_Y()), w: g.w, h: g.h, rot: Number(p.getState_Rotation()) || 0, shape: g.shape, id };
		net(nm).pads.push(pad);
	};
	for (const c of comps) {
		const ref = c.getState_Designator() ?? '';
		const other = c.getState_OtherProperty() ?? {};
		const value = String(other.Value ?? other.value ?? other['值'] ?? c.getState_Name() ?? '');
		parts.push({ ref, value });
		try {
			for (const p of await c.getAllPins()) addPad(p, ref);
		}
		catch {
			warnings.push(`读取 ${ref} 的焊盘失败`);
		}
	}
	for (const p of await eda.pcb_PrimitivePad.getAll()) addPad(p, 'PAD');
	// 板框（只用包围盒）与铺铜
	const xs: number[] = [];
	const ys: number[] = [];
	for (const l of await eda.pcb_PrimitiveLine.getAll(undefined, 11 as any)) {
		xs.push(l.getState_StartX(), l.getState_EndX());
		ys.push(l.getState_StartY(), l.getState_EndY());
	}
	try {
		for (const pl of await eda.pcb_PrimitivePolyline.getAll(undefined, 11 as any)) {
			const v = nums(pl.getState_Polygon()?.getSource?.());
			v.forEach((x, i) => (i % 2 ? ys : xs).push(x));
		}
	}
	catch {}
	const all = [...nets.values()];
	const hasOutline = xs.length > 0;
	if (!xs.length) {
		for (const n of all) {
			for (const s of n.segs) {
				xs.push(s[1] / MIL, s[3] / MIL);
				ys.push(s[2] / MIL, s[4] / MIL);
			}
			for (const p of n.pads) {
				xs.push(p.x / MIL);
				ys.push(p.y / MIL);
			}
		}
		warnings.push('没有找到板框，按元素包围盒估计');
	}
	const bbox: [number, number, number, number] = xs.length ? [mm(Math.min(...xs)), mm(Math.min(...ys)), mm(Math.max(...xs)), mm(Math.max(...ys))] : [0, 0, 50, 50];
	const boardArea = Math.max(1e-6, (bbox[2] - bbox[0]) * (bbox[3] - bbox[1]));
	const planes: Board['planes'] = [];
	try {
		for (const po of await eda.pcb_PrimitivePour.getAll()) {
			const nm = po.getState_Net();
			const li = layerIndex(Number(po.getState_Layer()), nL);
			if (!nm || li === null || li < 0)
				continue;
			net(nm).zone = true;
			if (/GND|VSS/i.test(nm)) {
				const v = nums(po.getState_ComplexPolygon()?.getSource?.());
				const px = v.filter((_, i) => i % 2 === 0).map(mm);
				const py = v.filter((_, i) => i % 2 === 1).map(mm);
				const area = px.length ? (Math.max(...px) - Math.min(...px)) * (Math.max(...py) - Math.min(...py)) : 0;
				const prev = planes.find(p => p.layer === li);
				const frac = Math.min(1, area / boardArea);
				if (prev)
					prev.gnd_frac = Math.max(prev.gnd_frac, frac);
				else planes.push({ layer: li, gnd_frac: frac, frag: 0 });
			}
		}
	}
	catch {
		warnings.push('读取铺铜失败');
	}
	return {
		// 板框只取包围盒；没有板框时不给修复器板框约束
		board: { layers, nets: all, parts, planes, outline: hasOutline ? [[bbox[0], bbox[1]], [bbox[2], bbox[1]], [bbox[2], bbox[3]], [bbox[0], bbox[3]]] : undefined, units: 'mm' },
		bbox,
		warnings,
	};
}

/** 选中图元并把视图移过去 */
export async function locate(ids: string[] | undefined, at?: [number, number], net?: string | null): Promise<void> {
	try {
		if (ids?.length)
			await eda.pcb_SelectControl.doSelectPrimitives(ids);
		else if (net)
			await eda.pcb_Net.selectNet(net);
		if (at) {
			const r = 80; // mil
			await eda.pcb_Document.navigateToRegion(mil(at[0]) - r, mil(at[0]) + r, mil(at[1]) + r, mil(at[1]) - r);
		}
	}
	catch (e) {
		console.warn('[lpiot] locate failed', e);
	}
}

/** 写回修复：删除旧线段、创建新线段；放在一个命令组里，可以一次撤销 */
export async function applyChanges(changes: { net: string; remove: string[]; add: Seg[] }[], nL: number): Promise<{ removed: number; added: number }> {
	let gid: string | undefined;
	try {
		gid = (await eda.pcb_Document.beginCommandGroup('布线修复'))?.groupId;
	}
	catch {}
	let removed = 0;
	let added = 0;
	try {
		for (const ch of changes) {
			if (ch.remove.length && (await eda.pcb_PrimitiveLine.delete(ch.remove)))
				removed += ch.remove.length;
			for (const s of ch.add) {
				const r = await eda.pcb_PrimitiveLine.create(ch.net, layerId(s[0], nL) as any, mil(s[1]), mil(s[2]), mil(s[3]), mil(s[4]), mil(s[5]));
				if (r)
					added++;
			}
		}
		if (gid)
			await eda.pcb_Document.commitCommandGroup(gid);
	}
	catch (e) {
		if (gid)
			await eda.pcb_Document.rollbackCommandGroup(gid);
		throw e;
	}
	return { removed, added };
}

// ------------------------------------------------------------------ 丝印（出图前检查用）
const SILK_LAYERS: Record<number, 'top' | 'bottom'> = { 3: 'top', 4: 'bottom' };

/** 对齐方式 1…9 → 锚点比例（列：左 / 中 / 右，行：上 / 中 / 下；y 向上）。读不到时按居中。 */
function anchorOf(mode: any): [number, number] {
	const m = Number(mode);
	if (!Number.isInteger(m) || m < 1 || m > 9)
		return [0.5, 0.5];
	return [Math.floor((m - 1) / 3) * 0.5, 1 - ((m - 1) % 3) * 0.5];
}

export interface SilkRead { texts: FinishText[]; refCounts: Record<string, number>; warnings: string[] }

/**
 * 读取顶层 / 底层丝印的文字和位号属性。嘉立创扩展 API 读不到封装自带的丝印线和泪滴，
 * 所以模型里 silk_graphics_source = 'text'、teardrop_source = 'none'，这两项由用户在 G5 里人工确认。
 */
export async function readSilk(): Promise<SilkRead> {
	const texts: FinishText[] = [];
	const warnings: string[] = [];
	const refCounts: Record<string, number> = {};
	const owner = new Map<string, string>();
	try {
		for (const c of await eda.pcb_PrimitiveComponent.getAll()) {
			const ref = c.getState_Designator() ?? '';
			if (ref)
				refCounts[ref] = (refCounts[ref] ?? 0) + 1;
			try {
				owner.set(c.getState_PrimitiveId(), ref);
			}
			catch {}
		}
	}
	catch {
		warnings.push('读取器件列表失败');
	}
	const push = (s: string, kind: FinishText['kind'], own: string, side: string, xMil: number, yMil: number, hMil: number, wMil: number, rot: number, mirror: boolean, hidden: boolean, align: any, id?: string) => {
		const h = mm(hMil || 40);
		const [ax, ay] = anchorOf(align);
		const x = mm(xMil);
		const y = mm(yMil);
		texts.push({ text: s, kind, owner: own, side, x, y, h, w: mm(wMil || 6), rot: ((Number(rot) || 0) % 360 + 360) % 360, mirror: !!mirror, hidden, bbox: textBBox(x, y, Math.max(1, s.length) * h * 0.9, h, Number(rot) || 0, mirror ? 1 - ax : ax, ay), id });
	};
	try {
		for (const t of await (eda as any).pcb_PrimitiveString.getAll()) {
			const side = SILK_LAYERS[Number(t.getState_Layer())];
			if (!side)
				continue;
			push(String(t.getState_Text() ?? ''), 'text', '', side, t.getState_X(), t.getState_Y(), t.getState_FontSize(), t.getState_LineWidth(), t.getState_Rotation(), t.getState_Mirror(), false, t.getState_AlignMode(), t.getState_PrimitiveId?.());
		}
	}
	catch {
		warnings.push('读取丝印文字失败');
	}
	try {
		for (const a of await (eda as any).pcb_PrimitiveAttribute.getAll()) {
			const side = SILK_LAYERS[Number(a.getState_Layer())];
			const key = String(a.getState_Key() ?? '');
			if (!side || !/^designator$/i.test(key))
				continue;
			const x = a.getState_X();
			const y = a.getState_Y();
			const own = owner.get(a.getState_ParentPrimitiveId?.()) ?? String(a.getState_Value() ?? '');
			if (x === null || x === undefined || y === null || y === undefined) {
				warnings.push(`${own} 的位号位置读不到，按隐藏处理`);
				continue;
			}
			push(String(a.getState_Value() ?? own), 'ref', own, side, x, y, a.getState_FontSize(), a.getState_LineWidth(), a.getState_Rotation(), a.getState_Mirror(), a.getState_ValueVisible() === false, a.getState_AlignMode(), a.getState_PrimitiveId?.());
		}
	}
	catch {
		warnings.push('读取位号属性失败');
	}
	return { texts, refCounts, warnings };
}
