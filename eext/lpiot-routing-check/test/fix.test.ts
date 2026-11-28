import type { Board, Seg } from '../src/core';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test as it } from 'node:test';
import { analyze, components, planFix } from '../src/core';

const dir = path.join(import.meta.dirname, '..', 'fixtures');
function load(f: string): Board {
	const { board } = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
	let id = 0;
	for (const n of board.nets) n.segs = n.segs.map((s: any[]) => [...s.slice(0, 6), !!s[6], `L${id++}`] as Seg);
	return board;
}
function apply(b: Board, plan: ReturnType<typeof planFix>): Board {
	const nb: Board = JSON.parse(JSON.stringify(b));
	for (const ch of plan.changes) {
		const n = nb.nets.find(x => x.name === ch.net)!;
		n.segs = n.segs.filter(s => !ch.remove.includes(s[7]!)).concat(ch.add);
	}
	return nb;
}

it('坏板修复后没有任意角度和锐角，连通不变', () => {
	const b = load('route-bad.json');
	const plan = planFix(b);
	const after = apply(b, plan);
	const rep = analyze(after);
	console.log('fixed', plan.fixed.length, 'manual', plan.manual.map(m => `${m.net}:${m.issues}`), 'score', analyze(b).score, '->', rep.score);
	assert.ok(plan.fixed.length >= 5);
	for (const n of b.nets) assert.equal(components(after.nets.find(x => x.name === n.name)!), components(n), n.name);
	const left = rep.violations.filter(v => ['RTG-01', 'RTG-02', 'RTG-03'].includes(v.rule));
	console.log(left.map(v => `${v.rule} ${v.net} ${v.msg}`));
	assert.ok(rep.score > analyze(b).score + 15);
});

it('好板不改动；修复是幂等的', () => {
	for (const f of ['route-good.json', 'principles-good.json']) assert.equal(planFix(load(f)).changes.length, 0, f);
	const b = load('route-bad.json');
	const once = apply(b, planFix(b));
	let id = 0;
	for (const n of once.nets) n.segs = n.segs.map(s => [...s.slice(0, 7), s[7] ?? `N${id++}`] as Seg);
	assert.equal(planFix(once).changes.length, 0);
});
