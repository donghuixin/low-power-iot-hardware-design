/**
 * AI 接口：把检查报告整理成提示词，调用用户自己配置的大模型（Anthropic Claude 或 OpenAI 兼容接口）。
 * API Key 只保存在本机扩展配置里（eda.sys_Storage），不写进扩展包、不上传到别处；请求经 eda.sys_ClientUrl 发出，需要用户开启扩展的“外部交互”权限。
 */
import type { Board, OrderRow, Report, Violation } from './core';
import { dist } from './core';

export interface AiConfig { provider: 'anthropic' | 'openai'; endpoint: string; model: string; apiKey: string; maxTokens: number }

export const DEFAULT_AI: AiConfig = { provider: 'anthropic', endpoint: 'https://api.anthropic.com/v1/messages', model: 'claude-sonnet-5-5', apiKey: '', maxTokens: 2000 };

const SYSTEM = `你是一位做过多款量产低功耗 IoT 产品的资深硬件工程师，正在评审一块 PCB 的走线。
评审依据：只用 0/45/90/135° 线段、禁止锐角和随机角度；关键信号优先（射频 → 晶振 → 开关回路与高压 → 高速差分 → 时钟 → 模拟 → 电源 → 一般信号 → 地）；
就近原则（去耦电容贴电源引脚、负载电容贴晶振、ESD 贴接口并串在线上、串阻贴驱动端、地焊盘旁打地过孔）；差分线同层、并行、等距、等长、过孔成对；
电流走环路、单一完整地加分区布局、敏感网络远离攻击网络（ADI AN-1142、TI ZHCAAE6B 的布局原则）。
回答要求：用中文；先给结论和最该先改的 3–5 件事，再逐条说明“为什么、怎么改”；按 P0/P1/P2/P3 分级；
只根据给出的数据说话，数据里没有的就说需要用户确认；不要编造坐标或器件；不确定时说不确定。`;

function brief(v: Violation): string {
	return `[${v.sev}] ${v.rule} ${v.net ?? ''} ${v.layer !== null && v.layer !== undefined ? `L${v.layer + 1}` : ''}：${v.msg}`;
}

/** 整板评审提示词 */
export function boardPrompt(rep: Report, order: OrderRow[], board: Board, note = ''): string {
	const m = Object.entries(rep.metrics).map(([k, e]) => `${k} ${e.name}：扣 ${e.deduct}/${e.weight}（${e.level}）`).join('\n');
	const classes: Record<string, string[]> = {};
	for (const [n, c] of Object.entries(rep.classes)) (classes[c] ??= []).push(n);
	const cls = Object.entries(classes).map(([c, ns]) => `${c}: ${ns.slice(0, 12).join(', ')}${ns.length > 12 ? ` 等 ${ns.length} 个` : ''}`).join('\n');
	const vs = rep.violations.slice(0, 60).map(brief).join('\n');
	const ord = order.slice(0, 30).map((r, i) => `${i + 1}. ${r.net}（${r.class}，第 ${r.tier} 档）`).join('\n');
	return `板子：${board.layers.length} 层，${board.nets.length} 个网络，${board.parts?.length ?? 0} 个器件。
布线质量 ${rep.score}/100，${rep.grade}。
各项指标：
${m}

网络类：
${cls}

违规（共 ${rep.violations.length} 条，下面列前 60 条）：
${vs || '（无）'}

推荐布线顺序（前 30）：
${ord}
${note ? `\n用户补充：${note}` : ''}
请给出评审意见。`;
}

/** 单条违规的提示词：附上附近 3 mm 内的其他网络和器件焊盘 */
export function violationPrompt(v: Violation, rep: Report, board: Board, question = ''): string {
	const near: string[] = [];
	if (v.at) {
		for (const n of board.nets) {
			if (n.name === v.net)
				continue;
			const close = n.segs.some(s => Math.min(dist([s[1], s[2]], v.at!), dist([s[3], s[4]], v.at!)) < 3) || n.pads.some(p => dist([p.x, p.y], v.at!) < 3);
			if (close)
				near.push(`${n.name}（${rep.classes[n.name]}）`);
		}
	}
	const self = board.nets.find(n => n.name === v.net);
	const pads = self ? self.pads.map(p => `${p.ref}.${p.pin}`).slice(0, 12).join(', ') : '';
	const ns = rep.nets.find(n => n.net === v.net);
	return `违规：${brief(v)}
位置（mm）：${v.at ? v.at.join(', ') : '无'}
该网络：${v.net ?? '—'}，类 ${v.net ? rep.classes[v.net] ?? '—' : '—'}，走线 ${ns?.len ?? '—'} mm，过孔 ${ns?.vias ?? '—'} 个，连接 ${pads}
附近 3 mm 内的其他网络：${near.slice(0, 15).join('、') || '无'}
${question ? `用户的问题：${question}` : '请解释这个问题会造成什么后果，并给出具体改法（走法、换层、挪器件或豁免的条件）。'}`;
}

/** 调用模型，返回文本 */
export async function callModel(cfg: AiConfig, prompt: string): Promise<string> {
	if (!cfg.apiKey && !/localhost|127\.0\.0\.1/.test(cfg.endpoint))
		throw new Error('还没有配置 API Key：在面板的“AI 设置”里填写');
	let body: string;
	const headers: Record<string, string> = { 'content-type': 'application/json' };
	if (cfg.provider === 'anthropic') {
		headers['x-api-key'] = cfg.apiKey;
		headers['anthropic-version'] = '2023-06-01';
		headers['anthropic-dangerous-direct-browser-access'] = 'true';
		body = JSON.stringify({ model: cfg.model, max_tokens: cfg.maxTokens, system: SYSTEM, messages: [{ role: 'user', content: prompt }] });
	}
	else {
		if (cfg.apiKey)
			headers.authorization = `Bearer ${cfg.apiKey}`;
		body = JSON.stringify({ model: cfg.model, max_tokens: cfg.maxTokens, messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: prompt }] });
	}
	const res = await eda.sys_ClientUrl.request(cfg.endpoint, 'POST', body, { headers });
	const text = await res.text();
	if (!res.ok)
		throw new Error(`模型接口返回 ${res.status}：${text.slice(0, 300)}`);
	const j = JSON.parse(text);
	if (cfg.provider === 'anthropic')
		return (j.content ?? []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n');
	return j.choices?.[0]?.message?.content ?? '';
}
