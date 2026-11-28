import type { Seg } from '../src/core/geom';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test as it } from 'node:test';
import { angleBetween } from '../src/core/geom';
import { bumpAdd, bumpAmp, lengthRows, meander, planLengthMatch } from '../src/core/length';
import { analyze } from '../src/core/lint';

const dir = path.join(import.meta.dirname, '..', 'fixtures');
const read = (f: string) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
const exp = read('length-expect.json.txt');

function load() {
	const { board, cons } = read('motherboard.json');
	for (const n of board.nets) n.segs = n.segs.map((s: any[], i: number) => [...s.slice(0, 6), !!s[6], `${n.name}#${i}`]);
	return { board, cons };
}

it('蛇形线只有 135° 拐角，补的长度精确', () => {
	for (const amp of [0.09, 0.2, 0.3, 0.6, 1.2]) {
		const pts = meander([0, 0], [5, 0], 0.15, amp, 2, 1, 1);
		for (let i = 0; i + 2 < pts.length; i++) {
			const a = angleBetween([pts[i][0] - pts[i + 1][0], pts[i][1] - pts[i + 1][1]], [pts[i + 2][0] - pts[i + 1][0], pts[i + 2][1] - pts[i + 1][1]]);
			assert.ok(Math.abs(a - 135) < 0.5 || Math.abs(a - 180) < 0.5, `${amp} ${a}`);
		}
		const L = pts.slice(1).reduce((s, p, i) => s + Math.hypot(p[0] - pts[i][0], p[1] - pts[i][1]), 0);
		assert.ok(Math.abs(L - 5 - 2 * bumpAdd(amp, 0.15)) < 1e-3);
		assert.ok(Math.abs(bumpAmp(bumpAdd(amp, 0.15), 0.15) - amp) < 1e-9);
	}
});

it('真实板等长补偿与 Python 版一致：只改偏短的网络，补完长度相等', () => {
	const { board } = load();
	const plan = planLengthMatch(board, exp.groups, { clearance: 0.1 });
	assert.deepEqual(plan.fixed.map(f => [f.net, f.layer, f.how]), exp.fixed);
	assert.deepEqual(plan.manual.map(m => m.net), exp.manual);
	const nets = board.nets.map((n: any) => ({ ...n, segs: n.segs.slice() }));
	for (const ch of plan.changes) {
		const n = nets.find((x: any) => x.name === ch.net)!;
		n.segs = n.segs.filter((s: Seg) => !ch.remove.includes(s[7]!)).concat(ch.add);
	}
	const rows = lengthRows({ ...board, nets }, exp.groups);
	for (const r of rows) assert.ok(Math.abs(r.len - exp.after[r.net]) < 1e-3, r.net);
	const rep = analyze({ ...board, nets }, { length_groups: exp.groups.slice(0, 1) });
	assert.deepEqual(rep.violations.filter(v => ['TCK', 'TMS', 'TDI', 'TDO'].includes(v.net ?? '') && ['RTG-01', 'RTG-02', 'RTG-03', 'RTG-04', 'RTL-07'].includes(v.rule)), []);
});
