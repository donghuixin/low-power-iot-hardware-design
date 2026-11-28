#!/usr/bin/env node
/**
 * 布线检查助手 · 本地桥：让本机的 AI 代理（Claude Code、Cursor 等）调用嘉立创 EDA 里的布线检查扩展。
 *
 *   扩展  ⇄  ws://127.0.0.1:49731   （扩展菜单“连接本地 AI 助手…”连过来）
 *   代理  →  http://127.0.0.1:49732/rpc   POST {"method": "check", "params": {}}       （HTTP 模式，默认）
 *   代理  ⇄  stdio MCP                  node bridge/bridge.mjs --mcp                （MCP 模式，给 Claude Code 等用）
 *
 * 只监听 127.0.0.1。依赖 ws（npm install 后即可）。
 */
import http from 'node:http';
import process from 'node:process';
import readline from 'node:readline';
import { WebSocketServer } from 'ws';

const WS_PORT = Number(process.env.LPIOT_WS_PORT ?? 49731);
const HTTP_PORT = Number(process.env.LPIOT_HTTP_PORT ?? 49732);
const MCP = process.argv.includes('--mcp');
const log = (...a) => (MCP ? console.error : console.log)('[lpiot-bridge]', ...a);

let ext = null;
const waiting = new Map();
let seq = 0;
const wss = new WebSocketServer({ host: '127.0.0.1', port: WS_PORT });
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
		if (m.hello)
			log(`扩展 ${m.hello} v${m.version}`);
		const w = m.id && waiting.get(m.id);
		if (w) {
			waiting.delete(m.id);
			m.error ? w.rej(new Error(m.error)) : w.res(m.result);
		}
	});
	ws.on('close', () => {
		if (ext === ws)
			ext = null;
		log('扩展已断开');
	});
});
log(`等待扩展连接 ws://127.0.0.1:${WS_PORT}`);

function call(method, params = {}, timeout = 120000) {
	if (!ext || ext.readyState !== 1)
		return Promise.reject(new Error('扩展没有连接：在嘉立创 EDA 的 PCB 编辑器里点“布线检查 → 连接本地 AI 助手…”，并在扩展管理里开启外部交互权限'));
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
		warnings: r.warnings,
	};
}

function briefSummary(v) {
	if (!v?.status)
		return v;
	return {
		stages: v.status.stages,
		gates: v.status.gates.map(g => ({ gate: g.gate, title: g.title, state: g.state, missing: g.state === 'missing' ? g.detail : undefined, code_for_user: (g.state === 'pending' || g.state === 'stale') ? g.code : undefined, summary_for_user: (g.state === 'pending' || g.state === 'stale') ? v.summaries[g.gate] : undefined })),
		rule: '确认只能由用户在嘉立创 EDA“布线检查助手 → 设计确认”页手动输入确认码完成。把 summary_for_user 和确认码转告用户，等用户自己确认；不要替用户编造“待填”的内容。',
	};
}

const BRIEF_RULE = '布局布线前的强制确认流程（references/19-design-gate.md）：G0 需求与工艺、G1 板框外壳与固定件、G2 功能分区（用户看过布局截图）、G3 布局检查、G4 布线规划、G5 交付验收。G0–G4 未放行时 routing_fix_apply 和 routing_gate 会拒绝。';

const TOOLS = [
	{ name: 'design_brief_status', description: `查看当前工程的设计确认状态：每一级缺什么、待用户确认的摘要和确认码、能否摆放 / 布线 / 交付。${BRIEF_RULE}`, inputSchema: { type: 'object', properties: {} }, run: async () => briefSummary(await call('briefStatus')) },
	{ name: 'design_brief_get', description: '读取当前工程完整的设计确认内容（design-brief.json 格式）', inputSchema: { type: 'object', properties: {} }, run: async () => (await call('briefGet'))?.brief },
	{ name: 'design_brief_update', description: '填写设计确认内容。set 是 {字段路径: 值}，例如 {"G1_mechanical.fixed": [{"ref":"J1","what":"USB-C","edge":"bottom","along_mm":19,"tol_mm":1,"reason":"外壳开孔"}]}。只能写用户明确给出或认可的信息；内容一改，相关级别的确认自动失效。不能写确认记录。', inputSchema: { type: 'object', properties: { set: { type: 'object' } }, required: ['set'] }, run: async a => briefSummary(await call('briefUpdate', { set: a.set })) },
	{ name: 'layout_check', description: '对照设计确认内容检查当前 PCB 的器件摆放：板框、重叠、固定件位置、功能分区、禁布区、天线净空、干扰源间距、去耦与晶振负载电容距离（LAY-01…10、RTP-01…08）', inputSchema: { type: 'object', properties: { limit: { type: 'number' } } }, run: async (a) => {
		const r = await call('layoutCheck', {});
		const L = r.layout;
		return { p0: L.p0, p1: L.p1, p2: L.p2, p3: L.p3, pass: L.pass, note: L.note, brief_complete: L.brief_complete, issues: L.issues.slice(0, a?.limit ?? 80).map(v => ({ rule: v.rule, sev: v.sev, refs: v.refs, msg: v.msg, fix: v.fix, at_mm: v.at })), gates: briefSummary(r.brief) };
	} },
	{ name: 'routing_check', description: '读取嘉立创 EDA 当前 PCB，做布线检查（任意角度、锐角、抖动、出焊盘方向、过孔、绕行、就近、差分、布线优先级）并返回得分、指标和违规列表（坐标单位 mm）', inputSchema: { type: 'object', properties: { limit: { type: 'number', description: '最多返回多少条违规，默认 80' } } }, run: async a => summarize(await call('check'), a?.limit ?? 80) },
	{ name: 'routing_order', description: '按布线优先级（射频 → 晶振 → 开关回路与高压 → 高速差分 → 时钟 → 模拟 → 电源 → 一般信号 → 地）给出逐网布线顺序', inputSchema: { type: 'object', properties: {} }, run: () => call('order') },
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
	{ name: 'routing_fix_plan', description: '计算几何修复方案（任意角度、锐角、抖动、斜出焊盘、悬空线头、重叠线段 → 八方向折线），不修改板子', inputSchema: { type: 'object', properties: { nets: { type: 'array', items: { type: 'string' }, description: '只修这些网络（可选）' } } }, run: async (a) => {
		const p = await call('fixPlan', { nets: a?.nets });
		return { fixed: p.fixed.map(f => ({ net: f.net, layer: f.layer, issues: f.issues, how: f.how })), manual: p.manual, changes: p.changes.map(c => ({ net: c.net, remove: c.remove.length, add: c.add.length })) };
	} },
	{ name: 'routing_fix_apply', description: '把上一次 routing_fix_plan 的方案写回 PCB。设计确认 G0–G4 未放行时拒绝；放行后嘉立创 EDA 会弹窗请用户确认，修改可一次撤销', inputSchema: { type: 'object', properties: {} }, run: async () => {
		const r = await call('fixApply', { confirmed: false }, 600000);
		return r?.cancelled ? { cancelled: true } : { removed: r.removed, added: r.added, score: r.report?.score };
	} },
	{ name: 'routing_gate', description: '写入走线前的闸门：先要求设计确认 G0–G4 已放行，再检查一批线段是否只有 0/45/90/135° 且没有锐角。board = {layers: [...], nets: [{name, segs: [[层序号, x1, y1, x2, y2, 线宽, false]], vias: [], pads: [{ref, pin, l, x, y, w, h, rot, shape}]}]}，单位 mm', inputSchema: { type: 'object', properties: { board: { type: 'object' } }, required: ['board'] }, run: a => call('gate', { board: a.board }) },
];

if (MCP) {
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
			return reply({ protocolVersion: m.params?.protocolVersion ?? '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'lpiot-routing-check', version: '0.2.0' } });
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
else {
	http.createServer(async (req, res) => {
		res.setHeader('content-type', 'application/json; charset=utf-8');
		if (req.method === 'GET' && req.url === '/health')
			return res.end(JSON.stringify({ ok: true, extension: !!ext }));
		if (req.method !== 'POST' || req.url !== '/rpc') {
			res.statusCode = 404;
			return res.end('{"error":"POST /rpc"}');
		}
		let body = '';
		req.on('data', c => (body += c));
		req.on('end', async () => {
			try {
				const { method, params } = JSON.parse(body || '{}');
				const tool = TOOLS.find(t => t.name === method || t.name === `routing_${method}`);
				const out = tool ? await tool.run(params ?? {}) : await call(method, params);
				res.end(JSON.stringify({ result: out }));
			}
			catch (e) {
				res.statusCode = 500;
				res.end(JSON.stringify({ error: String(e?.message ?? e) }));
			}
		});
	}).listen(HTTP_PORT, '127.0.0.1', () => log(`AI 代理接口 http://127.0.0.1:${HTTP_PORT}/rpc`));
}
