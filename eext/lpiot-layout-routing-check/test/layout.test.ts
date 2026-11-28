import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test as it } from 'node:test';
import { codeOf, confirm, confirmTier, gateHash, GATES, gateState, missing, requireStage, template, tierCode, tierList, tierStates } from '../src/core/brief';
import { layoutCheck, partsOf } from '../src/core/layout';
import { draftPriorities } from '../src/core/priorities';

const dir = path.join(import.meta.dirname, '..', 'fixtures');
const read = (f: string) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
const expect = read('layout-expect.json.txt');
const briefSrc = () => read('brief-principles.json.txt');
function board(name: string) {
	const { board } = read(`${name}.json`);
	for (const n of board.nets) n.segs = n.segs.map((s: any[]) => [...s.slice(0, 6), !!s[6]]);
	board.outline = expect[name].outline;
	return board;
}

it('确认码与 Python 版一致（canonical + SHA-256）', () => {
	const b = briefSrc();
	assert.equal(gateHash(b, 'G2'), expect['principles-good'].brief_hash);
	assert.deepEqual(GATES.map(g => codeOf(b, g)), ['G0-8d0dd8', 'G1-6af5f2', 'G2-4869a0', 'G3-803d04', 'G4-37e6d4', 'G5-2d201d', 'G6-e50c7a']);
});

for (const name of ['principles-good', 'principles-bad', 'demo-node']) {
	it(`布局检查与 Python 版一致：${name}`, () => {
		const bd = board(name);
		const rects = Object.fromEntries(partsOf(bd).map(p => [p.ref, p.rect.map(v => Math.round(v * 1000) / 1000)]));
		for (const [ref, r] of Object.entries(expect[name].rects)) assert.deepEqual(rects[ref], r, ref);
		const rep = layoutCheck(bd, read(`${expect[name].brief}.txt`));
		const got = rep.issues.map(v => [v.rule, v.sev, v.refs[0] ?? '']).sort();
		assert.deepEqual(got, expect[name].issues);
		assert.equal(rep.brief_hash, expect[name].brief_hash);
	});
}

it('固定件不在指定的边是 P0，并给出目标位置', () => {
	const b = briefSrc();
	b.G1_mechanical.fixed[0].edge = 'left';
	const rep = layoutCheck(board('principles-good'), b);
	const v = rep.issues.find(x => x.rule === 'LAY-03' && x.sev === 'P0');
	assert.ok(v && v.target && v.target[0] < 2);
	assert.equal(rep.pass, false);
});

it('模板全部缺信息；占位词不算回答', () => {
	const t = template();
	for (const g of GATES) assert.equal(gateState(t, g)[0], 'missing');
	t.G0_requirements.wireless = '你定';
	assert.ok(missing(t, 'G0').some(m => m.includes('无线')));
});

it('确认必须输入当前确认码，改前面的内容会让后面失效', () => {
	const b = briefSrc();
	assert.throws(() => confirm(b, 'G0', '好的'));
	assert.throws(() => confirm(b, 'G1', `确认 ${codeOf(b, 'G1')}`));
	confirm(b, 'G0', `确认 ${codeOf(b, 'G0')}`);
	confirm(b, 'G1', codeOf(b, 'G1'));
	confirm(b, 'G2', ` 确认  ${codeOf(b, 'G2')} `);
	const rep = layoutCheck(board('principles-good'), b);
	b.G3_layout_check.result = { kind: rep.kind, p0: rep.p0, brief_hash: rep.brief_hash };
	confirm(b, 'G3', codeOf(b, 'G3'));
	tierList(b).forEach((t, i) => confirmTier(b, t.tier, tierCode(b, i)));
	confirm(b, 'G4', codeOf(b, 'G4'));
	assert.deepEqual(requireStage(b, 'route'), []);
	b.G1_mechanical.enclosure.max_height_top_mm = 3;
	assert.equal(gateState(b, 'G1')[0], 'stale');
	assert.ok(requireStage(b, 'route').length >= 4);
});

it('布线优先级：梳理结果和逐档确认码与 Python 版一致，必须按顺序确认', () => {
	const exp = read('tier-expect.json.txt');
	const tiers = draftPriorities(board('demo-node'), exp.brief.roles);
	assert.deepEqual(tiers.map(t => [t.tier, t.nets, t.method]), exp.tiers);
	const b = exp.brief;
	assert.deepEqual(tierList(b).map((_, i) => tierCode(b, i)), exp.codes);
	assert.throws(() => confirmTier(b, tierList(b)[1].tier, tierCode(b, 1)));
	confirmTier(b, tierList(b)[0].tier, `确认 ${tierCode(b, 0)}`);
	assert.equal(tierStates(b)[0].state, 'confirmed');
	assert.equal(tierStates(b)[1].state, 'pending');
	assert.equal(tierStates(b)[2].state, 'blocked');
});
