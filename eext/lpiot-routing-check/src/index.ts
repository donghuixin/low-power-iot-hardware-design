/**
 * 布线检查助手 / Routing Check Assistant —— 嘉立创 EDA 专业版扩展入口。
 *
 * 菜单（PCB 编辑器）：
 *   打开布线检查面板    读当前 PCB → 检查评分 → 面板里看结论、板子动画、AI 解读、修复预览
 *   快速检查            只弹出得分和最严重的几条
 *   连接本地 AI 助手    通过 WebSocket 连到本机桥（bridge/bridge.mjs），让 Claude Code 等 AI 代理调用检查与修复
 *   断开本地 AI 助手
 *   关于
 *
 * 面板（iframe）与主线程用 eda.sys_MessageBus 通信：面板发 lpiot-req {id, cmd, args}，主线程回 lpiot-res {id, ok, data | error}。
 *
 * 设计确认闸门（references/19-design-gate.md）：设计确认内容按工程保存在本机扩展配置里。写回修复和走线闸门要求 G0–G4
 * 已确认；确认只能在面板里由用户手动输入确认码完成（briefConfirm 只接受来自面板的请求），本地 AI 代理只能读取和填写内容。
 */
import type { AiConfig } from './ai';
import type { Board, FixPlan, Gate, LayoutReport, Report } from './core';
import extensionConfig from '../extension.json' with { type: 'json' };
import { boardPrompt, callModel, DEFAULT_AI, violationPrompt } from './ai';
import { analyze, status as briefStatus, template as briefTemplate, confirm as confirmGate, gate, GATES, summary as gateSummary, layoutCheck, planFix, requireStage, routingOrder } from './core';
import { applyChanges, locate, readBoard } from './eda';

const REQ = 'lpiot-req';
const RES = 'lpiot-res';
const PANEL_ID = 'lpiot-routing-panel';
const WS_ID = 'lpiot-agent-bridge';

interface State { board?: Board; bbox?: [number, number, number, number]; report?: Report; plan?: FixPlan; layout?: LayoutReport; warnings?: string[]; at?: number }
type Source = 'panel' | 'agent' | 'menu';
const state: State = {};
let busReady = false;
const handled = new Set<string>();

function publish(topic: string, msg: unknown): void {
	try {
		eda.sys_MessageBus.publish(topic, msg);
	}
	catch {}
	try {
		eda.sys_MessageBus.publishPublic(topic, msg);
	}
	catch {}
}

/** 吐司提示：优先用 sys_Message.showToastMessage（sys_ToastMessage.showMessage 已弃用） */
function toast(msg: string, type: 'info' | 'success' | 'warn' | 'error' = 'info'): void {
	try {
		eda.sys_Message.showToastMessage(msg, type as any);
	}
	catch {
		try {
			eda.sys_ToastMessage.showMessage(msg);
		}
		catch {}
	}
}

function aiConfig(): AiConfig {
	const c = eda.sys_Storage.getExtensionUserConfig('ai') ?? {};
	return { ...DEFAULT_AI, ...c };
}

async function refresh(): Promise<State> {
	const r = await readBoard();
	state.board = r.board;
	state.bbox = r.bbox;
	state.warnings = r.warnings;
	state.report = analyze(r.board);
	state.plan = undefined;
	state.at = Date.now();
	return state;
}

// ------------------------------------------------------------------ 设计确认（按工程保存）
async function projectKey(): Promise<string> {
	try {
		const info = await eda.dmt_Project.getCurrentProjectInfo();
		if (info?.uuid)
			return `brief:${info.uuid}`;
	}
	catch {}
	return 'brief:default';
}

async function loadBrief(): Promise<any> {
	const b = eda.sys_Storage.getExtensionUserConfig(await projectKey());
	return b && typeof b === 'object' && b.kind === 'lpiot-design-brief' ? b : briefTemplate();
}

async function saveBrief(b: any): Promise<void> {
	await eda.sys_Storage.setExtensionUserConfig(await projectKey(), b);
}

function briefView(b: any): unknown {
	const st = briefStatus(b);
	return { brief: b, status: st, summaries: Object.fromEntries(GATES.map(g => [g, gateSummary(b, g)])) };
}

/** 写操作前的闸门：未放行就抛错，错误信息列出缺什么 */
async function requireRoute(what: string): Promise<void> {
	const miss = requireStage(await loadBrief(), 'route');
	if (miss.length)
		throw new Error(`拒绝${what}：设计确认闸门未放行（布线前必须由用户在“设计确认”页逐级确认 G0–G4）。\n${miss.map(m => `· ${m}`).join('\n')}`);
}

function nCopper(): number {
	return state.board?.layers.length ?? 2;
}

/** 面板和本地 AI 代理共用的命令 */
async function handle(cmd: string, args: any = {}, source: Source = 'agent'): Promise<unknown> {
	args = args ?? {};
	switch (cmd) {
		case 'check': {
			await refresh();
			const b = await loadBrief();
			return { board: state.board, bbox: state.bbox, report: state.report, order: routingOrder(state.board!.nets, state.report!.classes), warnings: state.warnings, at: state.at, gate: { route: requireStage(b, 'route'), deliver: requireStage(b, 'deliver') } };
		}
		case 'briefGet':
		case 'briefStatus':
			return briefView(await loadBrief());
		case 'briefUpdate': {
			// 可以由面板或 AI 代理填写内容；确认记录不接受外部传入，内容一改，相关确认自动失效
			const cur = await loadBrief();
			let next: any;
			if (args.brief && typeof args.brief === 'object') {
				next = { ...briefTemplate(), ...args.brief, kind: 'lpiot-design-brief', confirmations: args.reset ? {} : (cur.confirmations ?? {}) };
			}
			else {
				next = JSON.parse(JSON.stringify(cur));
				for (const [path, v] of Object.entries(args.set ?? {})) {
					if (path.startsWith('confirmations'))
						throw new Error('不能直接修改确认记录');
					const ks = path.split('.');
					let o = next;
					for (const k of ks.slice(0, -1)) o = (o[k] && typeof o[k] === 'object' && !Array.isArray(o[k])) ? o[k] : (o[k] = {});
					o[ks[ks.length - 1]] = v;
				}
			}
			await saveBrief(next);
			return briefView(next);
		}
		case 'briefConfirm': {
			if (source !== 'panel')
				throw new Error('确认只能由用户在“设计确认”页手动输入确认码完成，AI 代理不能确认。请把摘要和确认码转告用户。');
			const b = await loadBrief();
			const code = confirmGate(b, args.gate as Gate, String(args.typed ?? ''), 'panel');
			// 再用编辑器原生弹窗确认一次：消息总线上的其他来源无法替用户点这个按钮
			const ok = await new Promise<boolean>(resolve => eda.sys_Dialog.showConfirmationMessage(`确认 ${code}（${args.gate} 的全部内容已逐项核对无误）？\n确认后才能进入下一步；之后修改这一级或之前的内容，确认会自动失效。`, '设计确认', '确认', '取消', r => resolve(r)));
			if (!ok)
				return { cancelled: true, ...(briefView(await loadBrief()) as object) };
			await saveBrief(b);
			toast(`已确认 ${code}`);
			return briefView(b);
		}
		case 'layoutCheck': {
			if (!state.board || args.refresh !== false)
				await refresh();
			const b = await loadBrief();
			state.layout = layoutCheck(state.board!, b, { yUp: args.yUp !== false });
			if (args.record) {
				b.G3_layout_check = { ...(b.G3_layout_check ?? {}), report: '扩展布局检查', result: { kind: state.layout.kind, p0: state.layout.p0, p1: state.layout.p1, p2: state.layout.p2, brief_hash: state.layout.brief_hash, at: new Date().toISOString() } };
				await saveBrief(b);
			}
			return { board: state.board, bbox: state.bbox, layout: state.layout, brief: briefView(b) };
		}
		case 'routeRecord': {
			if (!state.report)
				await refresh();
			const b = await loadBrief();
			const p0 = state.report!.violations.filter(v => v.sev === 'P0').length;
			b.G5_acceptance = { ...(b.G5_acceptance ?? {}), route_report: '扩展布线检查', route_result: { score: state.report!.score, pass: state.report!.pass, p0, at: new Date().toISOString() } };
			await saveBrief(b);
			return briefView(b);
		}
		case 'order': {
			if (!state.board)
				await refresh();
			return routingOrder(state.board!.nets, state.report!.classes);
		}
		case 'locate':
			await locate(args.ids, args.at, args.net);
			return true;
		case 'highlightNet':
			await eda.pcb_Net.unhighlightAllNets();
			if (args.net)
				await eda.pcb_Net.highlightNet(args.net);
			return true;
		case 'fixPlan': {
			if (!state.board)
				await refresh();
			state.plan = planFix(state.board!, { nets: args.nets });
			return { ...state.plan, gate: requireStage(await loadBrief(), 'route') };
		}
		case 'fixApply': {
			await requireRoute('写回修复');
			const plan = state.plan;
			if (!plan || !plan.changes.length)
				return { removed: 0, added: 0 };
			// 只有面板自己的确认按钮可以跳过编辑器弹窗；AI 代理发起的写回一律弹窗请用户确认
			const go = (source === 'panel' && args.confirmed) ? true : await new Promise<boolean>(resolve => eda.sys_Dialog.showConfirmationMessage(`将修改 ${plan.changes.length} 个网络的走线（删除 ${plan.changes.reduce((s, c) => s + c.remove.length, 0)} 段、新建 ${plan.changes.reduce((s, c) => s + c.add.length, 0)} 段）。修改放在一个操作里，可以撤销。继续吗？`, '应用布线修复', '应用', '取消', ok => resolve(ok)));
			if (!go)
				return { cancelled: true };
			const r = await applyChanges(plan.changes, nCopper());
			toast(`布线修复完成：删除 ${r.removed} 段、新建 ${r.added} 段。请重新铺铜并跑一次 DRC。`);
			await refresh();
			return { ...r, report: state.report };
		}
		case 'gate': {
			// 外部代理写线前的闸门：先查设计确认，再检查 args.board（mm 坐标）里的任意角度、锐角、锐角分支
			await requireRoute('放行走线');
			return gate(args.board);
		}
		case 'aiGet': {
			const c = aiConfig();
			return { ...c, apiKey: c.apiKey ? `${c.apiKey.slice(0, 4)}…${c.apiKey.slice(-4)}` : '', hasKey: !!c.apiKey };
		}
		case 'aiSet': {
			const cur = aiConfig();
			const next = { ...cur, ...args };
			if (!args.apiKey || String(args.apiKey).includes('…'))
				next.apiKey = cur.apiKey;
			await eda.sys_Storage.setExtensionUserConfig('ai', next);
			return true;
		}
		case 'aiReview': {
			if (!state.report)
				await refresh();
			const miss = requireStage(await loadBrief(), 'route');
			const gateNote = miss.length ? `设计确认闸门未放行（${miss.join('；')}）。请先指出还缺哪些设计信息、该问用户什么，只评审已有走线，不要给出直接动手布线的步骤。` : '';
			const prompt = boardPrompt(state.report!, routingOrder(state.board!.nets, state.report!.classes), state.board!, [gateNote, args.note].filter(Boolean).join('\n'));
			return { text: await callModel(aiConfig(), prompt), prompt };
		}
		case 'aiAsk': {
			if (!state.report)
				await refresh();
			const v = state.report!.violations[args.index];
			if (!v)
				throw new Error('找不到这条违规，请重新检查');
			const prompt = violationPrompt(v, state.report!, state.board!, args.question);
			return { text: await callModel(aiConfig(), prompt), prompt };
		}
		case 'report':
			return state.report ?? null;
		default:
			throw new Error(`未知命令 ${cmd}`);
	}
}

function ensureBus(): void {
	if (busReady)
		return;
	busReady = true;
	const onReq = async (m: any) => {
		if (!m || !m.id || handled.has(m.id))
			return;
		handled.add(m.id);
		try {
			const data = await handle(m.cmd, m.args, 'panel');
			publish(RES, { id: m.id, ok: true, data });
		}
		catch (e: any) {
			publish(RES, { id: m.id, ok: false, error: String(e?.message ?? e) });
		}
	};
	try {
		eda.sys_MessageBus.subscribe(REQ, onReq);
	}
	catch {}
	try {
		eda.sys_MessageBus.subscribePublic(REQ, onReq);
	}
	catch {}
}

// eslint-disable-next-line unused-imports/no-unused-vars
export function activate(status?: 'onStartupFinished', arg?: string): void {
	ensureBus();
}

export async function openPanel(): Promise<void> {
	ensureBus();
	await eda.sys_IFrame.openIFrame('/iframe/index.html', 1180, 760, PANEL_ID, { title: '布线检查助手', maximizeButton: true, minimizeButton: true });
}

export async function quickCheck(): Promise<void> {
	try {
		await refresh();
		const r = state.report!;
		const top = r.violations.slice(0, 5).map(v => `· [${v.sev}] ${v.rule} ${v.net ?? ''}：${v.msg}`).join('\n');
		eda.sys_Dialog.showInformationMessage(`布线质量 ${r.score}/100 · ${r.grade}\n违规 ${r.violations.length} 条\n${top}\n\n打开“布线检查面板”查看全部、动画和修复预览。`, '快速检查');
	}
	catch (e: any) {
		eda.sys_Dialog.showInformationMessage(`检查失败：${e?.message ?? e}`, '快速检查');
	}
}

/** 本地 AI 代理桥：扩展作为 WebSocket 客户端连到 bridge/bridge.mjs，代理发 {id, method, params}，扩展回 {id, result | error} */
export async function connectAgent(): Promise<void> {
	ensureBus();
	const saved = eda.sys_Storage.getExtensionUserConfig('bridgeUrl') ?? 'ws://127.0.0.1:49731';
	eda.sys_Dialog.showInputDialog('本地桥地址（先在电脑上运行 node bridge/bridge.mjs）', '需要在扩展管理里开启本扩展的“外部交互”权限', '连接本地 AI 助手', 'url', saved, undefined, async (url: string) => {
		if (!url)
			return;
		await eda.sys_Storage.setExtensionUserConfig('bridgeUrl', url);
		try {
			eda.sys_WebSocket.register(WS_ID, url, async (ev: MessageEvent) => {
				let msg: any;
				try {
					msg = JSON.parse(String(ev.data));
				}
				catch {
					return;
				}
				if (!msg?.id || !msg.method)
					return;
				try {
					const result = await handle(msg.method, msg.params, 'agent');
					eda.sys_WebSocket.send(WS_ID, JSON.stringify({ id: msg.id, result }));
				}
				catch (e: any) {
					eda.sys_WebSocket.send(WS_ID, JSON.stringify({ id: msg.id, error: String(e?.message ?? e) }));
				}
			}, () => {
				eda.sys_WebSocket.send(WS_ID, JSON.stringify({ hello: extensionConfig.name, version: extensionConfig.version }));
				toast('已连接本地 AI 助手');
			});
		}
		catch (e: any) {
			eda.sys_Dialog.showInformationMessage(`连接失败：${e?.message ?? e}\n请确认已开启扩展的外部交互权限，并且本地桥正在运行。`, '连接本地 AI 助手');
		}
	});
}

export function disconnectAgent(): void {
	try {
		eda.sys_WebSocket.close(WS_ID);
		toast('已断开本地 AI 助手');
	}
	catch {}
}

export function about(): void {
	eda.sys_Dialog.showInformationMessage(
		`布线检查助手 v${extensionConfig.version}\n布局布线前先在“设计确认”页和用户逐级确认需求、外壳与固定件、功能分区、布局检查和布线规划；未确认时不写回修复。\n检查任意角度、锐角、抖动、出焊盘方向、过孔、绕行、就近、差分与布线优先级，给出质量评分、板子动画和修复预览，并可接入你自己的大模型做解读。\n规则来源：github.com/donghuixin/low-power-iot-hardware-design（references/16–18）`,
		'关于',
	);
}
