/**
 * 用假的 eda 对象（按 @jlceda/pro-api-types 的接口签名实现）跑打包后的扩展 dist/index.js：
 * 读板（mil → mm）、经消息总线检查、修复预览、确认后写回（mm → mil），验证适配层和通信协议。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test as it } from 'node:test';
import vm from 'node:vm';

const MIL = 0.0254;
const FIXDIR = path.join(import.meta.dirname, '..', 'fixtures');
const demoBrief = JSON.parse(fs.readFileSync(path.join(FIXDIR, 'brief-principles.json.txt'), 'utf8'));
function fakeEda(boardName: 'route-bad' | 'principles-bad' | 'demo-node') {
	const b = JSON.parse(fs.readFileSync(path.join(FIXDIR, `${boardName}.json`), 'utf8')).board;
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
		return { getState_PrimitiveId: () => `comp-${ref}`, getState_Designator: () => ref, getState_OtherProperty: () => (parts[ref] ? { Value: parts[ref] } : {}), getState_Name: () => '', getAllPins: async () => pins };
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
	const store = new Map<string, any>();
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
		// 丝印：一段字太小的说明文字；U1 的位号放在 U1 上方，第二个器件的位号隐藏
		pcb_PrimitiveString: { getAll: async () => [{ getState_Layer: () => 3, getState_Text: () => 'tiny', getState_X: () => 200, getState_Y: () => 200, getState_FontSize: () => 20, getState_LineWidth: () => 3, getState_Rotation: () => 0, getState_Mirror: () => false, getState_AlignMode: () => 5 }] },
		pcb_PrimitiveAttribute: { getAll: async () => comps.map(c => ({ getState_Layer: () => 3, getState_Key: () => 'Designator', getState_Value: () => c.getState_Designator(), getState_ParentPrimitiveId: () => c.getState_PrimitiveId(), getState_X: () => -3000, getState_Y: () => -3000, getState_FontSize: () => 40, getState_LineWidth: () => 6, getState_Rotation: () => 0, getState_Mirror: () => false, getState_ValueVisible: () => c !== comps[1], getState_AlignMode: () => 5 })) },
		pcb_PrimitivePolyline: { getAll: async () => [] },
		// 两块示例板的底层都整层铺了 GND
		pcb_PrimitivePour: { getAll: async () => [{ getState_Net: () => 'GND', getState_Layer: () => 2, getState_ComplexPolygon: () => ({ getSource: () => [-200, -200, 'L', 3000, -200, 3000, 3000, -200, 3000] }) }] },
		pcb_SelectControl: { doSelectPrimitives: async (ids: string[]) => log.push(`select ${ids.length}`) },
		pcb_Net: { selectNet: async () => true, highlightNet: async () => true, unhighlightAllNets: async () => true },
		pcb_Document: { navigateToRegion: async () => log.push('navigate'), beginCommandGroup: async () => ({ groupId: 'g1' }), commitCommandGroup: async () => log.push('commit'), rollbackCommandGroup: async () => log.push('rollback') },
		sys_MessageBus: { publish: pub, publishPublic: pub, subscribe: sub, subscribePublic: sub },
		sys_Storage: { getExtensionUserConfig: (k: string) => store.get(k), setExtensionUserConfig: async (k: string, v: any) => (store.set(k, JSON.parse(JSON.stringify(v))), true) },
		dmt_Project: { getCurrentProjectInfo: async () => ({ uuid: 'proj-1' }) },
		sys_Dialog: { showConfirmationMessage: (_c: string, _t: string, _a: string, _b: string, cb: (ok: boolean) => void) => cb(true), showInformationMessage: (c: string) => log.push(`info ${c.split('\n')[0]}`) },
		sys_Message: { showToastMessage: (m: string) => log.push(`toast ${m}`) },
		sys_IFrame: { openIFrame: async () => true },
	};
	return { eda, lines, log, sub, pub, store };
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
	assert.equal(r.report.score, 59.1); // 与 Python 版 principles-bad 一致（含 RTG-04 直角）
	assert.ok(r.report.violations.some((v: any) => v.rule === 'RTP-01' && /C1/.test(v.msg)));
	const order = await rpc(f, 'order');
	assert.equal(order[0].class, 'XTAL');
	await rpc(f, 'locate', { ids: ['line1'], at: [10, 10] });
	assert.ok(f.log.includes('navigate'));
});

function routeBrief(): any {
	const b = JSON.parse(JSON.stringify(demoBrief));
	b.roles = {};
	b.G1_mechanical.fixed = [{ ref: 'J1', what: '排针', edge: 'right', tol_mm: 6, reason: '外壳右侧开口' }];
	b.G2_partition.blocks = [{ name: '主控', parts: ['U1', 'Y1', 'U2'], region: 'any', why: '测试' }, { name: '接口', parts: ['J1', 'R1', 'R2', 'R3'], region: 'any', why: '测试' }];
	return b;
}

it('设计确认未放行时拒绝写回；面板逐级确认后才能写回，得分提高，放在一个命令组里', async () => {
	const f = fakeEda('route-bad');
	const ext = loadExt(f.eda);
	ext.activate();
	const before = await rpc(f, 'check');
	assert.ok(before.gate.route.length >= 5);
	const plan = await rpc(f, 'fixPlan');
	assert.ok(plan.changes.length >= 5 && plan.gate.length >= 5);
	await assert.rejects(rpc(f, 'fixApply'), /设计确认闸门未放行/);
	assert.ok(!f.log.includes('commit'));
	// 填写内容不能顺带写入确认记录
	await assert.rejects(rpc(f, 'briefUpdate', { set: { 'confirmations.G0': { code: 'x' } } }), /不能直接修改确认记录/);
	let v = await rpc(f, 'briefUpdate', { brief: { ...routeBrief(), confirmations: { G0: { code: 'forged', hash: 'forged' } } } });
	assert.equal(v.status.gates[0].state, 'pending');
	await assert.rejects(rpc(f, 'briefConfirm', { gate: 'G0', typed: '好的' }), /确认码/);
	for (const g of ['G0', 'G1', 'G2']) {
		const code = v.status.gates.find((x: any) => x.gate === g).code;
		v = await rpc(f, 'briefConfirm', { gate: g, typed: `确认 ${code}` });
	}
	const lay = await rpc(f, 'layoutCheck', { record: true });
	assert.equal(lay.layout.p0, 0, JSON.stringify(lay.layout.issues.filter((x: any) => x.sev === 'P0')));
	v = lay.brief;
	v = await rpc(f, 'briefConfirm', { gate: 'G3', typed: v.status.gates.find((x: any) => x.gate === 'G3').code });
	// 布线优先级：先按板子梳理，再逐档确认（跳档会被拒绝）
	const pd = await rpc(f, 'priorityDraft', { write: true });
	assert.ok(pd.tiers.length >= 3);
	await assert.rejects(rpc(f, 'tierConfirm', { tier: pd.tiers[1].tier }), /先确认/);
	for (const t of pd.tiers) v = await rpc(f, 'tierConfirm', { tier: t.tier });
	v = await rpc(f, 'briefConfirm', { gate: 'G4', typed: v.status.gates.find((x: any) => x.gate === 'G4').code });
	assert.equal(v.status.stages.route.length, 0);
	// 能力边界：放行走线要点名网络，“全部”、太多网络、夹带没点名的网络都拒绝
	const plan1 = { layers: ['TOP', 'BOTTOM'], nets: [{ name: 'SDA', segs: [[0, 0, 0, 5, 0, 0.2, false]], vias: [], pads: [] }] };
	await assert.rejects(rpc(f, 'gate', { board: plan1 }), /能力边界/);
	await assert.rejects(rpc(f, 'gate', { board: plan1, nets: ['全部'] }), /做不了/);
	await assert.rejects(rpc(f, 'gate', { board: { ...plan1, nets: [...plan1.nets, { name: 'SCL', segs: [[0, 0, 1, 5, 1, 0.2, false]], vias: [], pads: [] }] }, nets: ['SDA'] }), /没点名/);
	assert.equal((await rpc(f, 'gate', { board: plan1, nets: ['SDA'] })).pass, true);
	await rpc(f, 'fixPlan');
	const r = await rpc(f, 'fixApply');
	assert.ok(r.added > 0 && r.removed > 0);
	assert.ok(f.log.includes('commit'));
	assert.ok(r.report.score > before.report.score + 25, `${before.report.score} -> ${r.report.score}`);
	assert.equal(r.report.violations.filter((x: any) => ['RTG-01', 'RTG-02', 'RTG-03', 'RTG-04'].includes(x.rule)).length, 0);
	// 改了 G1 之后写回又被拒绝
	await rpc(f, 'briefUpdate', { set: { 'G1_mechanical.enclosure.max_height_top_mm': 9 } });
	await rpc(f, 'fixPlan');
	await assert.rejects(rpc(f, 'fixApply'), /G1/);
});

it('快速检查弹出得分', async () => {
	const f = fakeEda('principles-bad');
	const ext = loadExt(f.eda);
	await ext.quickCheck();
	assert.ok(f.log.some(l => l.startsWith('info 布线质量 59.1')));
});

it('出图前检查：读丝印文字和位号，读不到泪滴时转人工确认，记录为 G5 依据', async () => {
	const f = fakeEda('principles-bad');
	const ext = loadExt(f.eda);
	ext.activate();
	const r = await rpc(f, 'finishCheck', { record: true });
	const rules = new Set(r.report.issues.map((v: any) => v.rule));
	assert.ok(rules.has('SLK-03'), 'tiny 字高不够');
	assert.ok(rules.has('SLK-06'), '位号隐藏');
	assert.ok(rules.has('SLK-07'), '位号离器件太远');
	assert.equal(r.report.teardrop_source, 'none');
	assert.equal(r.report.silk_graphics_source, 'text');
	assert.ok(r.model.texts.some((t: any) => t.kind === 'ref' && t.owner === 'U1'));
	assert.equal(r.brief.brief.G5_finish.result.kind, 'lpiot-finish-lint');
	assert.ok(r.brief.status.gates.find((g: any) => g.gate === 'G5').detail.some((m: string) => m.includes('推荐')));
});
