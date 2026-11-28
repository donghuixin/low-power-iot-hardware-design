/**
 * 用假的 eda 对象（按 @jlceda/pro-api-types 的接口签名实现）跑打包后的扩展 dist/index.js：
 * 读板（mil → mm）、经消息总线检查、修复预览、确认后写回（mm → mil），验证适配层和通信协议。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test as it } from 'node:test';
import vm from 'node:vm';
import demo from '../src/panel/demo.json';

const MIL = 0.0254;
function fakeEda(boardName: 'route-bad' | 'principles-bad') {
	const b = (demo as any)[boardName];
	const nL = b.layers.length;
	const lid = (l: number) => (l === 0 ? 1 : l === nL - 1 ? 2 : 14 + l);
	let nid = 0;
	const lines = new Map<string, any>();
	const mkLine = (net: string, layer: number, x1: number, y1: number, x2: number, y2: number, w: number) => {
		const id = `line${nid++}`;
		const o = { id, net, layer, x1, y1, x2, y2, w };
		lines.set(id, o);
		return { getState_PrimitiveId: () => id, getState_Net: () => o.net, getState_Layer: () => o.layer, getState_StartX: () => o.x1, getState_StartY: () => o.y1, getState_EndX: () => o.x2, getState_EndY: () => o.y2, getState_LineWidth: () => o.w };
	};
	for (const n of b.nets) {
		for (const s of n.segs) mkLine(n.name, lid(s[0]), s[1] / MIL, s[2] / MIL, s[3] / MIL, s[4] / MIL, s[5] / MIL);
	}
	const vias = b.nets.flatMap((n: any) => n.vias.map((v: any, i: number) => ({ getState_PrimitiveId: () => `via-${n.name}-${i}`, getState_Net: () => n.name, getState_X: () => v[0] / MIL, getState_Y: () => v[1] / MIL, getState_Diameter: () => v[2] / MIL })));
	const byRef = new Map<string, any[]>();
	for (const n of b.nets) {
		for (const p of n.pads) {
			if (!byRef.has(p.ref))
				byRef.set(p.ref, []);
			byRef.get(p.ref)!.push({ ...p, net: n.name });
		}
	}
	let pid = 0;
	const padObj = (p: any) => {
		const id = `pad${pid++}`;
		const shape = p.shape === 'circle' ? ['ELLIPSE', p.w / MIL, p.w / MIL] : ['RECT', p.w / MIL, p.h / MIL, 0];
		return { getState_PrimitiveId: () => id, getState_Net: () => p.net, getState_Layer: () => (p.l === -1 ? 12 : lid(p.l)), getState_Pad: () => shape, getState_PadNumber: () => p.pin, getState_X: () => p.x / MIL, getState_Y: () => p.y / MIL, getState_Rotation: () => p.rot };
	};
	const parts = (b.parts ?? []).reduce((m: any, p: any) => ((m[p.ref] = p.value), m), {});
	const comps = [...byRef].map(([ref, ps]) => {
		const pins = ps.map(padObj);
		return { getState_Designator: () => ref, getState_OtherProperty: () => (parts[ref] ? { Value: parts[ref] } : {}), getState_Name: () => '', getAllPins: async () => pins };
	});
	const subs = new Map<string, ((m: any) => void)[]>();
	const pub = (t: string, m: any) => (subs.get(t) ?? []).forEach(f => setTimeout(() => f(m), 0));
	const sub = (t: string, f: (m: any) => void) => {
		if (!subs.has(t))
			subs.set(t, []);
		subs.get(t)!.push(f);
		return { cancel() {} };
	};
	const log: string[] = [];
	const eda = {
		pcb_Layer: { getTheNumberOfCopperLayers: async () => nL },
		pcb_PrimitiveLine: {
			getAll: async (_n?: string, layer?: number) => (layer === 11 ? [] : [...lines.values()].map(o => ({ getState_PrimitiveId: () => o.id, getState_Net: () => o.net, getState_Layer: () => o.layer, getState_StartX: () => o.x1, getState_StartY: () => o.y1, getState_EndX: () => o.x2, getState_EndY: () => o.y2, getState_LineWidth: () => o.w }))),
			delete: async (ids: string[]) => {
				ids.forEach(i => lines.delete(i));
				log.push(`delete ${ids.length}`);
				return true;
			},
			create: async (net: string, layer: number, x1: number, y1: number, x2: number, y2: number, w: number) => mkLine(net, layer, x1, y1, x2, y2, w),
		},
		pcb_PrimitiveArc: { getAll: async () => [] },
		pcb_PrimitiveVia: { getAll: async () => vias },
		pcb_PrimitiveComponent: { getAll: async () => comps },
		pcb_PrimitivePad: { getAll: async () => [] },
		pcb_PrimitivePolyline: { getAll: async () => [] },
		// 两块示例板的底层都整层铺了 GND
		pcb_PrimitivePour: { getAll: async () => [{ getState_Net: () => 'GND', getState_Layer: () => 2, getState_ComplexPolygon: () => ({ getSource: () => [-200, -200, 'L', 3000, -200, 3000, 3000, -200, 3000] }) }] },
		pcb_SelectControl: { doSelectPrimitives: async (ids: string[]) => log.push(`select ${ids.length}`) },
		pcb_Net: { selectNet: async () => true, highlightNet: async () => true, unhighlightAllNets: async () => true },
		pcb_Document: { navigateToRegion: async () => log.push('navigate'), beginCommandGroup: async () => ({ groupId: 'g1' }), commitCommandGroup: async () => log.push('commit'), rollbackCommandGroup: async () => log.push('rollback') },
		sys_MessageBus: { publish: pub, publishPublic: pub, subscribe: sub, subscribePublic: sub },
		sys_Storage: { getExtensionUserConfig: () => undefined, setExtensionUserConfig: async () => true },
		sys_Dialog: { showConfirmationMessage: (_c: string, _t: string, _a: string, _b: string, cb: (ok: boolean) => void) => cb(true), showInformationMessage: (c: string) => log.push(`info ${c.split('\n')[0]}`) },
		sys_ToastMessage: { showMessage: (m: string) => log.push(`toast ${m}`) },
		sys_IFrame: { openIFrame: async () => true },
	};
	return { eda, lines, log, sub, pub };
}

function loadExt(eda: any): any {
	const code = fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'dist/index.js'), 'utf8');
	const ctx: any = { eda, console, setTimeout, Date, Math, JSON, Promise };
	vm.createContext(ctx);
	vm.runInContext(`${code}\nthis.__ext = edaEsbuildExportName;`, ctx);
	return ctx.__ext;
}

function rpc(f: ReturnType<typeof fakeEda>, cmd: string, args: any = {}): Promise<any> {
	const id = `t${Math.random()}`;
	return new Promise((res, rej) => {
		f.sub('lpiot-res', (m: any) => {
			if (m.id === id)
				m.ok ? res(m.data) : rej(new Error(m.error));
		});
		f.pub('lpiot-req', { id, cmd, args });
	});
}

it('扩展经消息总线读板、检查，结果与核心一致（单位换算正确）', async () => {
	const f = fakeEda('principles-bad');
	const ext = loadExt(f.eda);
	ext.activate();
	const r = await rpc(f, 'check');
	assert.equal(r.report.score, 67.3);
	assert.ok(r.report.violations.some((v: any) => v.rule === 'RTP-01' && /C1/.test(v.msg)));
	const order = await rpc(f, 'order');
	assert.equal(order[0].class, 'XTAL');
	await rpc(f, 'locate', { ids: ['line1'], at: [10, 10] });
	assert.ok(f.log.includes('navigate'));
});

it('修复预览 → 确认 → 写回，得分提高，放在一个命令组里', async () => {
	const f = fakeEda('route-bad');
	const ext = loadExt(f.eda);
	ext.activate();
	const before = await rpc(f, 'check');
	const plan = await rpc(f, 'fixPlan');
	assert.ok(plan.changes.length >= 5);
	const r = await rpc(f, 'fixApply');
	assert.ok(r.added > 0 && r.removed > 0);
	assert.ok(f.log.includes('commit'));
	assert.ok(r.report.score > before.report.score + 25, `${before.report.score} -> ${r.report.score}`);
	assert.equal(r.report.violations.filter((v: any) => ['RTG-01', 'RTG-02', 'RTG-03'].includes(v.rule)).length, 0);
});

it('快速检查弹出得分', async () => {
	const f = fakeEda('principles-bad');
	const ext = loadExt(f.eda);
	await ext.quickCheck();
	assert.ok(f.log.some(l => l.startsWith('info 布线质量 67.3')));
});
