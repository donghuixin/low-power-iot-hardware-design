import type { Board } from '../src/core';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import readline from 'node:readline';
import { test as it } from 'node:test';
import WebSocket from 'ws';
import { analyze, routingOrder } from '../src/core';
import demo from '../src/panel/demo.json';

it('MCP 桥：初始化、列工具、调用 routing_check 转发到扩展', async () => {
	const root = path.join(import.meta.dirname, '..', '..');
	const env = { ...process.env, LPIOT_WS_PORT: '49841' };
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
	await new Promise(r => setTimeout(r, 400));
	// 假扩展：用核心对示例板做检查
	const board = (demo as any)['principles-bad'] as Board;
	const ws = new WebSocket('ws://127.0.0.1:49841');
	await new Promise(r => ws.on('open', r));
	ws.on('message', (buf) => {
		const m = JSON.parse(String(buf));
		if (m.method === 'check') {
			const report = analyze(board);
			ws.send(JSON.stringify({ id: m.id, result: { board, report, order: routingOrder(board.nets, report.classes) } }));
		}
	});
	const init = await ask(1, 'initialize', { protocolVersion: '2024-11-05' });
	assert.equal(init.result.serverInfo.name, 'lpiot-routing-check');
	const list = await ask(2, 'tools/list');
	const names = list.result.tools.map((t: any) => t.name);
	for (const n of ['routing_check', 'design_brief_status', 'design_brief_update', 'layout_check'])
		assert.ok(names.includes(n), n);
	assert.ok(!names.some((n: string) => /confirm/i.test(n)), 'MCP 不能提供确认工具');
	const res = await ask(3, 'tools/call', { name: 'routing_check', arguments: { limit: 5 } });
	const out = JSON.parse(res.result.content[0].text);
	assert.equal(out.score, analyze(board).score);
	assert.equal(out.violations.length, 5);
	ws.close();
	br.kill();
});
