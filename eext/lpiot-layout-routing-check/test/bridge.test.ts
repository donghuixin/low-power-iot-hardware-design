import type { Board } from '../src/core';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { test as it } from 'node:test';
import WebSocket from 'ws';
import { analyze, routingOrder } from '../src/core';
import demo from '../src/panel/demo.json';

const root = path.join(import.meta.dirname, '..', '..');

function mcp(env: NodeJS.ProcessEnv) {
	const br = spawn(process.execPath, [path.join(root, 'bridge/bridge.mjs'), '--mcp'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
	const lines = readline.createInterface({ input: br.stdout! });
	const replies = new Map<number, any>();
	lines.on('line', (l) => {
		const m = JSON.parse(l);
		replies.set(m.id, m);
	});
	const ask = async (id: number, method: string, params: any = {}) => {
		br.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
		for (let i = 0; i < 100 && !replies.has(id); i++) await new Promise(r => setTimeout(r, 50));
		return replies.get(id);
	};
	return { br, ask };
}

function get(port: number, p: string, headers: Record<string, string>): Promise<{ status: number; body: any }> {
	return new Promise((resolve, reject) => {
		http.get({ host: '127.0.0.1', port, path: p, headers }, (res) => {
			let s = '';
			res.on('data', c => (s += c));
			res.on('end', () => resolve({ status: res.statusCode!, body: JSON.parse(s) }));
		}).on('error', reject);
	});
}

it('本地桥：枢纽 + 转发端共用一条编辑器连接；HTTP 必须带令牌、拒绝浏览器请求；MCP 没有确认工具', async () => {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lpiot-'));
	const env = { ...process.env, LPIOT_WS_PORT: '49841', LPIOT_HTTP_PORT: '49842', LPIOT_HOME: home };
	const a = mcp(env);
	await new Promise(r => setTimeout(r, 500));
	const info = JSON.parse(fs.readFileSync(path.join(home, 'bridge.json'), 'utf8'));
	assert.equal(info.token.length, 48);
	// 假扩展：用核心对示例板做检查
	const board = (demo as any).motherboard as Board;
	const ws = new WebSocket('ws://127.0.0.1:49841');
	await new Promise(r => ws.on('open', r));
	ws.send(JSON.stringify({ hello: 'lpiot-layout-routing-check', version: '0.4.0', protocol: 1 }));
	ws.on('message', (buf) => {
		const m = JSON.parse(String(buf));
		if (m.method === 'check') {
			const report = analyze(board);
			ws.send(JSON.stringify({ id: m.id, result: { board, report, order: routingOrder(board.nets, report.classes) } }));
		}
	});
	const init = await a.ask(1, 'initialize', { protocolVersion: '2024-11-05' });
	assert.equal(init.result.serverInfo.name, 'lpiot-layout-routing-check');
	const names = (await a.ask(2, 'tools/list')).result.tools.map((t: any) => t.name);
	for (const n of ['routing_check', 'design_brief_status', 'design_brief_update', 'priority_draft', 'layout_check', 'board_export', 'bridge_status'])
		assert.ok(names.includes(n), n);
	assert.ok(!names.some((n: string) => /confirm/i.test(n)), 'MCP 不能提供确认工具');
	const res = await a.ask(3, 'tools/call', { name: 'routing_check', arguments: { limit: 5 } });
	const out = JSON.parse(res.result.content[0].text);
	assert.equal(out.score, analyze(board).score);
	assert.equal(out.violations.length, 5);
	// 第二个 AI 客户端：端口被占，自动变成转发端
	const b = mcp(env);
	await new Promise(r => setTimeout(r, 500));
	const res2 = await b.ask(4, 'tools/call', { name: 'routing_check', arguments: { limit: 3 } });
	assert.equal(JSON.parse(res2.result.content[0].text).score, out.score);
	const st = JSON.parse((await b.ask(5, 'tools/call', { name: 'bridge_status', arguments: {} })).result.content[0].text);
	assert.equal(st.role, 'hub');
	assert.equal(st.extension.protocol, 1);
	// HTTP：无令牌 401，带 Origin 403，带令牌 200
	assert.equal((await get(49842, '/status', {})).status, 401);
	assert.equal((await get(49842, '/status', { 'x-lpiot-token': info.token, 'origin': 'https://evil.example' })).status, 403);
	const ok = await get(49842, '/status', { 'x-lpiot-token': info.token });
	assert.equal(ok.status, 200);
	assert.equal(ok.body.extension.name, 'lpiot-layout-routing-check');
	ws.close();
	a.br.kill();
	b.br.kill();
});
