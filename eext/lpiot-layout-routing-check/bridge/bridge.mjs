#!/usr/bin/env node
/**
 * 布局布线检查助手 · 本地桥：把本机的 AI 客户端（Claude Code、Codex、Cursor 等）和本机脚本接到嘉立创 EDA 里的扩展。
 *
 *   扩展   ⇄  ws://127.0.0.1:49731        扩展菜单“连接本地 AI 助手…”连过来（嘉立创扩展只能主动连出，不能监听端口）
 *   脚本   →  http://127.0.0.1:49732/rpc  POST {"method": "...", "params": {}}，请求头 X-LPIOT-Token: <令牌>
 *   AI     ⇄  stdio MCP                   node bridge/bridge.mjs --mcp
 *
 * 枢纽与转发：第一个启动的进程成为“枢纽”，占住两个端口并把端口和令牌写进 ~/.lpiot/bridge.json（只有本人可读）；
 * 之后再启动的（例如另一个 AI 客户端各自拉起的 --mcp 进程）发现端口被占，就自动变成转发端，经 HTTP 把调用交给枢纽。
 * 这样同一时间只有一条到编辑器的连接，多个 AI 客户端和脚本共用。
 *
 * 安全：只监听 127.0.0.1；HTTP 必须带令牌，带 Origin 头（来自浏览器网页）的请求一律拒绝；
 * 设计确认、逐档确认只能在扩展面板里由人完成，写回修复要求闸门放行并在编辑器里弹窗确认（扩展侧强制）。
 * 依赖 ws（在本目录或扩展目录 npm install 后即可）。
 */
import { Buffer } from 'node:buffer';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline';
import { WebSocketServer } from 'ws';

export const PROTOCOL = 1;
const VERSION = '0.4.0';
const WS_PORT = Number(process.env.LPIOT_WS_PORT ?? 49731);
const HTTP_PORT = Number(process.env.LPIOT_HTTP_PORT ?? 49732);
const HOME = process.env.LPIOT_HOME ?? path.join(os.homedir(), '.lpiot');
const INFO = path.join(HOME, 'bridge.json');
const MCP = process.argv.includes('--mcp');
const log = (...a) => (MCP ? console.error : console.log)('[lpiot-bridge]', ...a);

let ext = null;
let extInfo = null;
let hub = null; // 转发端：{ http_port, token }
const waiting = new Map();
let seq = 0;

// ------------------------------------------------------------------ 枢纽：WebSocket（扩展）+ HTTP（脚本 / 转发端）
function listenWs() {
	return new Promise((resolve, reject) => {
		const wss = new WebSocketServer({ host: '127.0.0.1', port: WS_PORT });
		wss.once('listening', () => resolve(wss));
		wss.once('error', reject);
		wss.on('connection', (ws) => {
			ext = ws;
			log('扩展已连接');
			ws.on('message', (buf) => {
				let m;
				try {
					m = JSON.parse(String(buf));
				}
				catch {
					return;
				}
				if (m.hello) {
					extInfo = { name: m.hello, version: m.version, protocol: m.protocol ?? 0, project: m.project };
					log(`扩展 ${m.hello} v${m.version}（协议 ${extInfo.protocol}）`);
					if (extInfo.protocol !== PROTOCOL)
						log(`警告：扩展协议 ${extInfo.protocol} 与本地桥协议 ${PROTOCOL} 不一致，请把扩展和本地桥更新到同一版本`);
				}
				const w = m.id && waiting.get(m.id);
				if (w) {
					waiting.delete(m.id);
					m.error ? w.rej(new Error(m.error)) : w.res(m.result);
				}
			});
			ws.on('close', () => {
				if (ext === ws) {
					ext = null;
					extInfo = null;
				}
				log('扩展已断开');
			});
		});
	});
}

function writeInfo(token) {
	fs.mkdirSync(HOME, { recursive: true, mode: 0o700 });
	fs.writeFileSync(INFO, JSON.stringify({ ws_port: WS_PORT, http_port: HTTP_PORT, token, pid: process.pid, version: VERSION, protocol: PROTOCOL, started_at: new Date().toISOString() }, null, 1), { mode: 0o600 });
}

function startHttp(token) {
	return new Promise((resolve, reject) => {
		const srv = http.createServer((req, res) => {
			res.setHeader('content-type', 'application/json; charset=utf-8');
			// 浏览器网页发来的请求都带 Origin：一律拒绝，防止网页借本机端口操作编辑器
			if (req.headers.origin) {
				res.statusCode = 403;
				return res.end('{"error":"拒绝来自浏览器网页的请求"}');
			}
			const tk = req.headers['x-lpiot-token'] ?? String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
			const ok = typeof tk === 'string' && tk.length === token.length && crypto.timingSafeEqual(Buffer.from(tk), Buffer.from(token));
			if (!ok) {
				res.statusCode = 401;
				return res.end(`{"error":"缺少或错误的令牌：读取 ${INFO.replace(/\\/g, '/')} 里的 token，放在请求头 X-LPIOT-Token"}`);
			}
			if (req.method === 'GET' && req.url === '/status')
				return res.end(JSON.stringify(status()));
			if (req.method !== 'POST' || req.url !== '/rpc') {
				res.statusCode = 404;
				return res.end('{"error":"GET /status 或 POST /rpc"}');
			}
			let body = '';
			req.on('data', c => (body += c));
			req.on('end', async () => {
				try {
					const { method, params, tool } = JSON.parse(body || '{}');
					// eslint-disable-next-line no-use-before-define
					const t = TOOLS.find(x => x.name === (tool ?? method));
					const out = t ? await t.run(params ?? {}) : await call(method, params);
					res.end(JSON.stringify({ result: out }));
				}
				catch (e) {
					res.statusCode = 500;
					res.end(JSON.stringify({ error: String(e?.message ?? e) }));
				}
			});
		});
		srv.once('error', reject);
		srv.listen(HTTP_PORT, '127.0.0.1', () => resolve(srv));
	});
}

function status() {
	return { bridge: VERSION, protocol: PROTOCOL, role: hub ? 'forwarder' : 'hub', extension: ext ? (extInfo ?? { connected: true }) : null, ws_port: WS_PORT, http_port: HTTP_PORT };
}

// ------------------------------------------------------------------ 调用扩展（枢纽直接发；转发端经 HTTP 交给枢纽）
function postHub(body, timeout) {
	return new Promise((resolve, reject) => {
		const data = JSON.stringify(body);
		const req = http.request({ host: '127.0.0.1', port: hub.http_port, path: '/rpc', method: 'POST', timeout, headers: { 'content-type': 'application/json', 'x-lpiot-token': hub.token, 'content-length': Buffer.byteLength(data) } }, (res) => {
			let s = '';
			res.on('data', c => (s += c));
			res.on('end', () => {
				try {
					const j = JSON.parse(s);
					j.error ? reject(new Error(j.error)) : resolve(j.result);
				}
				catch {
					reject(new Error(`枢纽返回了无法解析的内容（HTTP ${res.statusCode}）`));
				}
			});
		});
		req.on('timeout', () => req.destroy(new Error('枢纽响应超时')));
		req.on('error', reject);
		req.end(data);
	});
}

export function call(method, params = {}, timeout = 120000) {
	if (hub)
		return postHub({ method, params }, timeout);
	if (!ext || ext.readyState !== 1)
		return Promise.reject(new Error('扩展没有连接：在嘉立创 EDA 的 PCB 编辑器里点“布局布线检查 → 连接本地 AI 助手…”，并在扩展管理里开启本扩展的“外部交互”权限'));
	const id = `b${Date.now().toString(36)}${(seq++).toString(36)}`;
	return new Promise((res, rej) => {
		waiting.set(id, { res, rej });
		ext.send(JSON.stringify({ id, method, params }));
		setTimeout(() => {
			if (waiting.delete(id))
				rej(new Error('扩展响应超时'));
		}, timeout);
	});
}

/** 去掉几何数据，只留给模型看的结论 */
function summarize(r, limit = 80) {
	if (!r?.report)
		return r;
	const rep = r.report;
	return {
		score: rep.score,
		grade: rep.grade,
		pass: rep.pass,
		layers: r.board?.layers?.length,
		nets: r.board?.nets?.length,
		metrics: Object.fromEntries(Object.entries(rep.metrics).map(([k, e]) => [k, { name: e.name, deduct: e.deduct, weight: e.weight, value: e.value }])),
		violations: rep.violations.slice(0, limit).map((v, i) => ({ index: i, rule: v.rule, sev: v.sev, net: v.net, layer: v.layer, at_mm: v.at, msg: v.msg })),
		total_violations: rep.violations.length,
		pairs: rep.pairs,
		confirm_classes: rep.confirm,
		order: (r.order ?? []).slice(0, 40).map(o => ({ tier: o.tier, tier_name: o.tier_name, net: o.net, class: o.class })),
		gate: r.gate,
		warnings: r.warnings,
	};
}

function briefSummary(v) {
	if (!v?.status)
		return v;
	const list = Array.isArray(v.brief?.G4_routing_plan?.priorities) ? v.brief.G4_routing_plan.priorities : [];
	return {
		stages: v.status.stages,
		gates: v.status.gates.map(g => ({ gate: g.gate, title: g.title, state: g.state, missing: g.state === 'missing' ? g.detail : undefined, code_for_user: (g.state === 'pending' || g.state === 'stale') ? g.code : undefined, summary_for_user: (g.state === 'pending' || g.state === 'stale') ? v.summaries[g.gate] : undefined })),
		tiers: (v.tiers ?? []).map((t) => {
			const e = list.find(x => x.tier === t.tier) ?? {};
			return { tier: t.tier, name: t.name, state: t.state, nets: e.nets, method: e.method, why: e.why, notes: t.state !== 'confirmed' ? e.notes : undefined };
		}),
		rule: '确认只能由用户在嘉立创 EDA“布局布线检查助手 → 确认”页完成：各级手动输入确认码，布线优先级逐档点确认。把 summary_for_user、各档的网络和理由转告用户，等用户自己确认；不要替用户编造“待填”的内容。',
	};
}

const BOUNDARY = '能力边界：本工具是检查图、改图，不是完全自由的自动布线。布线上只做检查已有布线（含几何修复），以及按用户点名的网络逐批布线（每批 ≤ 8 个网络、在已确认的优先级里）。用户要求“全局布线 / 把板子布完 / 剩下的都布了”时，先说明做不了并拒绝，请用户点名这一批网络，或自己用 EDA 的自动布线器布普通网络后再回来检查。';
const BRIEF_RULE = `布局布线前的强制确认流程（references/19-design-gate.md）：G0 需求与工艺、G1 板框外壳与固定件、G2 功能分区（用户看过布局截图）、G3 布局检查、G4 布线规划（布线优先级逐档确认）、G5 丝印位号与泪滴（20 个决定逐项问用户）、G6 交付验收。G0–G4 未放行时 routing_fix_apply 和 routing_gate 会拒绝。${BOUNDARY}`;

export const TOOLS = [
	{ name: 'bridge_status', description: '本地桥和扩展的连接状态（枢纽 / 转发端、扩展版本与协议）', inputSchema: { type: 'object', properties: {} }, run: async () => (hub ? postHub({ tool: 'bridge_status' }, 10000) : status()) },
	{ name: 'design_brief_status', description: `查看当前工程的设计确认状态：每一级缺什么、待用户确认的摘要和确认码、布线优先级各档的状态、能否摆放 / 布线 / 交付。${BRIEF_RULE}`, inputSchema: { type: 'object', properties: {} }, run: async () => briefSummary(await call('briefStatus')) },
	{ name: 'design_brief_get', description: '读取当前工程完整的设计确认内容（design-brief.json 格式）', inputSchema: { type: 'object', properties: {} }, run: async () => (await call('briefGet'))?.brief },
	{ name: 'design_brief_update', description: '填写设计确认内容。set 是 {字段路径: 值}，例如 {"G1_mechanical.fixed": [{"ref":"J1","what":"USB-C","edge":"bottom","along_mm":19,"tol_mm":1,"reason":"外壳开孔"}]}。只能写用户明确给出或认可的信息；内容一改，相关级别和档位的确认自动失效。不能写确认记录。', inputSchema: { type: 'object', properties: { set: { type: 'object' } }, required: ['set'] }, run: async a => briefSummary(await call('briefUpdate', { set: a.set })) },
	{ name: 'priority_draft', description: '按板子的功能梳理网络优先级（1 射频 → 2 晶振 → 3 开关回路 → 4 高速差分 → 5 时钟 → 6 模拟 → 7 电源 → 8 一般信号 → 9 地），每档给出网络、每个网络的作用、理由、走法和规则。write=true 写进 G4 并清掉已有的档位确认；ai=true 用扩展里配置的模型结合器件型号修正。梳理完把每一档转告用户，由用户在面板里逐档确认。', inputSchema: { type: 'object', properties: { write: { type: 'boolean' }, ai: { type: 'boolean' } } }, run: async (a) => {
		const r = await call('priorityDraft', { write: !!a?.write, ai: !!a?.ai }, 180000);
		return { note: r.note, tiers: r.tiers, gates: briefSummary(r.brief) };
	} },
	{ name: 'layout_check', description: '对照设计确认内容检查当前 PCB 的器件摆放：板框、重叠、固定件位置、功能分区、禁布区、天线净空、干扰源间距、IMU 应力与热、磁力计、电源流向、去耦与晶振负载电容距离（LAY-01…15、RTP-01…08）', inputSchema: { type: 'object', properties: { limit: { type: 'number' } } }, run: async (a) => {
		const r = await call('layoutCheck', {});
		const L = r.layout;
		return { p0: L.p0, p1: L.p1, p2: L.p2, p3: L.p3, pass: L.pass, note: L.note, brief_complete: L.brief_complete, issues: L.issues.slice(0, a?.limit ?? 80).map(v => ({ rule: v.rule, sev: v.sev, refs: v.refs, msg: v.msg, fix: v.fix, at_mm: v.at })), gates: briefSummary(r.brief) };
	} },
	{ name: 'board_export', description: '把编辑器里的当前 PCB 导出成铜皮数据包（与 skill 的 route_lint.py / layout_lint.py / design_gate.py priorities 通用）。给 path 时写到本机文件，只返回摘要，几何数据不进入对话。', inputSchema: { type: 'object', properties: { path: { type: 'string', description: '写到这个本机路径（建议给，避免把整块板的几何读进对话）' } } }, run: async (a) => {
		const pack = await call('export', {}, 180000);
		if (a?.path) {
			fs.writeFileSync(a.path, JSON.stringify(pack));
			return { path: path.resolve(a.path), layers: pack.layers, nets: pack.nets.length, parts: pack.parts.length, bytes: fs.statSync(a.path).size };
		}
		return pack;
	} },
	{ name: 'routing_check', description: '读取嘉立创 EDA 当前 PCB，做布线检查（直角与锐角、任意角度、抖动、出焊盘方向、过孔、绕行、就近、差分、布线优先级）并返回得分、指标和违规列表（坐标单位 mm）', inputSchema: { type: 'object', properties: { limit: { type: 'number', description: '最多返回多少条违规，默认 80' } } }, run: async a => summarize(await call('check'), a?.limit ?? 80) },
	{ name: 'routing_order', description: '按布线优先级给出逐网布线顺序', inputSchema: { type: 'object', properties: {} }, run: () => call('order') },
	{ name: 'routing_locate', description: '在嘉立创 EDA 里选中并定位一条违规（index 来自 routing_check），或高亮一个网络', inputSchema: { type: 'object', properties: { index: { type: 'number' }, net: { type: 'string' } } }, run: async (a) => {
		if (a?.index !== undefined) {
			const rep = await call('report');
			const v = rep?.violations?.[a.index];
			if (!v)
				throw new Error('没有这条违规，先运行 routing_check');
			return call('locate', { ids: v.ids, at: v.at, net: v.net });
		}
		return call('highlightNet', { net: a?.net ?? null });
	} },
	{ name: 'routing_fix_plan', description: '计算几何修复方案（直角斜切成两个 135° 拐角，任意角度、锐角、抖动、斜出焊盘、悬空线头、重叠线段 → 八方向折线），不修改板子', inputSchema: { type: 'object', properties: { nets: { type: 'array', items: { type: 'string' }, description: '只修这些网络（可选）' } } }, run: async (a) => {
		const p = await call('fixPlan', { nets: a?.nets });
		return { fixed: p.fixed.map(f => ({ net: f.net, layer: f.layer, issues: f.issues, how: f.how })), manual: p.manual, changes: p.changes.map(c => ({ net: c.net, remove: c.remove.length, add: c.add.length })), gate: p.gate };
	} },
	{ name: 'routing_fix_apply', description: '把上一次 routing_fix_plan 的方案写回 PCB。设计确认 G0–G4 未放行时拒绝；放行后嘉立创 EDA 会弹窗请用户确认，修改可一次撤销', inputSchema: { type: 'object', properties: {} }, run: async () => {
		const r = await call('fixApply', { confirmed: false }, 600000);
		return r?.cancelled ? { cancelled: true } : { removed: r.removed, added: r.added, score: r.report?.score };
	} },
	{ name: 'finish_check', description: '出图前检查（G5）：丝印离焊盘、线宽字高、超出板框、重叠、位号缺失 / 指认不清 / 被器件盖住、阅读方向、底面镜像、板名版本与接口说明、订单号位置（SLK），位号未编号 / 重复 / 前缀与值不符 / 编号顺序 / BOM 不一致（ANN），泪滴（TDR，扩展读不到泪滴，转为人工确认）。G5 的决定没回答时先用 design_brief_status 把引导问题逐项转告用户，用户说“按推荐”才能填推荐值。record=true 记为 G5 依据；bom 是 BOM 里的位号列表。', inputSchema: { type: 'object', properties: { record: { type: 'boolean' }, bom: { type: 'array', items: { type: 'string' } }, limit: { type: 'number' } } }, run: async (a) => {
		const r = await call('finishCheck', { record: !!a?.record, bom: a?.bom });
		const rep = r.report;
		return { p0: rep.p0, p1: rep.p1, unresolved_p1: rep.unresolved_p1, p2: rep.p2, p3: rep.p3, pass: rep.pass, teardrop_source: rep.teardrop_source, silk_graphics_source: rep.silk_graphics_source, issues: rep.issues.slice(0, a?.limit ?? 60), warnings: r.warnings, gate: r.brief?.status?.stages?.finish };
	} },
	{ name: 'routing_gate', description: `写入走线前的闸门：先要求设计确认 G0–G4 已放行，并且 nets 点名了这一批要布的网络（≤ 8 个、在已确认的优先级里、走线里不能夹带别的网络），再检查一批线段是否只有 0/45/90/135° 方向、拐角只有 135°（无直角、无锐角）。board = {layers: [...], nets: [{name, segs: [[层序号, x1, y1, x2, y2, 线宽, false]], vias: [], pads: [{ref, pin, l, x, y, w, h, rot, shape}]}]}，单位 mm。${BOUNDARY}`, inputSchema: { type: 'object', properties: { board: { type: 'object' }, nets: { type: 'array', items: { type: 'string' }, description: '用户点名的这一批网络' } }, required: ['board', 'nets'] }, run: a => call('gate', { board: a.board, nets: a.nets }) },
];

// ------------------------------------------------------------------ 启动
async function start() {
	const token = crypto.randomBytes(24).toString('hex');
	try {
		await listenWs();
		await startHttp(token);
		writeInfo(token);
		log(`枢纽已启动：等待扩展连接 ws://127.0.0.1:${WS_PORT}；脚本接口 http://127.0.0.1:${HTTP_PORT}/rpc（令牌见 ${INFO}）`);
	}
	catch (e) {
		if (e?.code !== 'EADDRINUSE')
			throw e;
		try {
			const info = JSON.parse(fs.readFileSync(INFO, 'utf8'));
			hub = { http_port: info.http_port, token: info.token };
			log(`端口已被另一个本地桥占用，作为转发端连接枢纽（pid ${info.pid}）`);
		}
		catch {
			throw new Error(`端口 ${WS_PORT} 被占用，且读不到 ${INFO}：请关掉占用端口的程序后重试`);
		}
	}
	if (MCP)
		runMcp();
}

function runMcp() {
	const rl = readline.createInterface({ input: process.stdin });
	const send = m => process.stdout.write(`${JSON.stringify(m)}\n`);
	rl.on('line', async (line) => {
		let m;
		try {
			m = JSON.parse(line);
		}
		catch {
			return;
		}
		const reply = result => m.id !== undefined && send({ jsonrpc: '2.0', id: m.id, result });
		if (m.method === 'initialize')
			return reply({ protocolVersion: m.params?.protocolVersion ?? '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'lpiot-layout-routing-check', version: VERSION } });
		if (m.method === 'tools/list')
			return reply({ tools: TOOLS.map(({ run, ...t }) => t) });
		if (m.method === 'tools/call') {
			const t = TOOLS.find(x => x.name === m.params?.name);
			try {
				if (!t)
					throw new Error(`未知工具 ${m.params?.name}`);
				const out = await t.run(m.params?.arguments ?? {});
				return reply({ content: [{ type: 'text', text: JSON.stringify(out, null, 1) }] });
			}
			catch (e) {
				return reply({ content: [{ type: 'text', text: String(e?.message ?? e) }], isError: true });
			}
		}
		if (m.method === 'ping')
			return reply({});
		if (m.id !== undefined && !String(m.method).startsWith('notifications/'))
			send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: `不支持 ${m.method}` } });
	});
}

start().catch((e) => {
	log(String(e?.message ?? e));
	process.exit(1);
});
