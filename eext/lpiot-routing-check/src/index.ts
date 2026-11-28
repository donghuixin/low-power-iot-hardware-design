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
 */
import type { AiConfig } from './ai';
import type { Board, FixPlan, Report } from './core';
import extensionConfig from '../extension.json' with { type: 'json' };
import { boardPrompt, callModel, DEFAULT_AI, violationPrompt } from './ai';
import { analyze, gate, planFix, routingOrder } from './core';
import { applyChanges, locate, readBoard } from './eda';

const REQ = 'lpiot-req';
const RES = 'lpiot-res';
const PANEL_ID = 'lpiot-routing-panel';
const WS_ID = 'lpiot-agent-bridge';

interface State { board?: Board; bbox?: [number, number, number, number]; report?: Report; plan?: FixPlan; warnings?: string[]; at?: number }
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

function nCopper(): number {
	return state.board?.layers.length ?? 2;
}

/** 面板和本地 AI 代理共用的命令 */
async function handle(cmd: string, args: any = {}): Promise<unknown> {
	switch (cmd) {
		case 'check': {
			await refresh();
			return { board: state.board, bbox: state.bbox, report: state.report, order: routingOrder(state.board!.nets, state.report!.classes), warnings: state.warnings, at: state.at };
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
			return state.plan;
		}
		case 'fixApply': {
			const plan = state.plan;
			if (!plan || !plan.changes.length)
				return { removed: 0, added: 0 };
			const go = args.confirmed ? true : await new Promise<boolean>(resolve => eda.sys_Dialog.showConfirmationMessage(`将修改 ${plan.changes.length} 个网络的走线（删除 ${plan.changes.reduce((s, c) => s + c.remove.length, 0)} 段、新建 ${plan.changes.reduce((s, c) => s + c.add.length, 0)} 段）。修改放在一个操作里，可以撤销。继续吗？`, '应用布线修复', '应用', '取消', ok => resolve(ok)));
			if (!go)
				return { cancelled: true };
			const r = await applyChanges(plan.changes, nCopper());
			eda.sys_ToastMessage.showMessage(`布线修复完成：删除 ${r.removed} 段、新建 ${r.added} 段。请重新铺铜并跑一次 DRC。`);
			await refresh();
			return { ...r, report: state.report };
		}
		case 'gate': {
			// 外部代理写线前的闸门：args.board 为 mm 坐标的 Board（或只含 nets），检查任意角度、锐角、锐角分支
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
			const prompt = boardPrompt(state.report!, routingOrder(state.board!.nets, state.report!.classes), state.board!, args.note);
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
			const data = await handle(m.cmd, m.args);
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
					const result = await handle(msg.method, msg.params);
					eda.sys_WebSocket.send(WS_ID, JSON.stringify({ id: msg.id, result }));
				}
				catch (e: any) {
					eda.sys_WebSocket.send(WS_ID, JSON.stringify({ id: msg.id, error: String(e?.message ?? e) }));
				}
			}, () => {
				eda.sys_WebSocket.send(WS_ID, JSON.stringify({ hello: extensionConfig.name, version: extensionConfig.version }));
				eda.sys_ToastMessage.showMessage('已连接本地 AI 助手');
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
		eda.sys_ToastMessage.showMessage('已断开本地 AI 助手');
	}
	catch {}
}

export function about(): void {
	eda.sys_Dialog.showInformationMessage(
		`布线检查助手 v${extensionConfig.version}\n检查任意角度、锐角、抖动、出焊盘方向、过孔、绕行、就近、差分与布线优先级，给出质量评分、板子动画和修复预览，并可接入你自己的大模型做解读。\n规则来源：github.com/donghuixin/low-power-iot-hardware-design（references/16–18）`,
		'关于',
	);
}
