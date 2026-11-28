import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test as it } from 'node:test';
import { analyze } from '../src/core/lint';

const dir = path.join(import.meta.dirname, '..', 'fixtures');
for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.json'))) {
	it(`与 Python 版一致：${f}`, () => {
		const { board, expect, cons } = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
		for (const n of board.nets) n.segs = n.segs.map((s: any[]) => [...s.slice(0, 6), !!s[6]]);
		const rep = analyze(board, cons);
		const key = (v: any[]) => v.join('|');
		const got = rep.violations.map(v => key([v.rule, v.sev, v.net])).sort();
		const exp = expect.violations.map((v: any[]) => key(v)).sort();
		assert.deepEqual(got, exp);
		for (const [k, d] of Object.entries(expect.metrics)) assert.equal(rep.metrics[k].deduct, d, k);
		assert.equal(rep.score, expect.score);
	});
}
