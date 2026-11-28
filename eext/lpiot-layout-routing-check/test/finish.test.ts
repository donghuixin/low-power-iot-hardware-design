import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test as it } from 'node:test';
import { codeOf, FINISH_QUESTIONS, finishAnswered, finishRulesHash, finishTemplate, GATES, migrate, missing, routeScope, template } from '../src/core/brief';
import { finishCheck, parseValueUnit } from '../src/core/finish';

const dir = path.join(import.meta.dirname, '..', 'fixtures');
const read = (f: string) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
const exp = read('finish-expect.json.txt');

it('引导问题与 Python 版一致', () => {
	assert.deepEqual(FINISH_QUESTIONS.map(q => [q.path, q.q, q.opts, q.rec]), exp.questions);
});

it('确认码与 Python 版一致（G5 丝印、G6 交付）', () => {
	assert.deepEqual(GATES.map(g => codeOf(read('brief-principles.json.txt'), g)), exp.codes);
});

for (const [name, c] of Object.entries<any>(exp.cases)) {
	it(`出图前检查与 Python 版一致：${name}`, () => {
		const model = read(`finish-model-${c.board}.json.txt`);
		const brief = exp.briefs[c.brief];
		const rep = finishCheck(model, brief, c.bom);
		assert.deepEqual(rep.issues.map(v => [v.rule, v.sev, v.refs]), c.issues);
		assert.deepEqual(rep.issues.map(v => v.msg), c.msgs);
		assert.equal(rep.rules_hash ?? null, c.rules_hash);
	});
}

it('每个问题都要回答；选项和数值要合法', () => {
	const b = template();
	assert.ok(missing(b, 'G5').filter(m => m.includes('推荐')).length >= FINISH_QUESTIONS.length);
	const ok = JSON.parse(JSON.stringify(exp.briefs.std));
	for (const q of FINISH_QUESTIONS) assert.ok(finishAnswered(ok, q), q.path);
	ok.G5_finish.silk.process = '丝网';
	assert.ok(missing(ok, 'G5').some(m => m.includes('只能选')));
	ok.G5_finish.silk.process = '标准丝印';
	ok.G5_finish.silk.text_height_mm = 0.5;
	assert.ok(missing(ok, 'G5').some(m => m.includes('至少 1 mm')));
});

it('报告过期、未处理的 P1、读不到泪滴', () => {
	const b = JSON.parse(JSON.stringify(exp.briefs.std));
	const model = read('finish-model-finish-good.json.txt');
	b.G5_finish.result = finishCheck(model, b);
	assert.deepEqual(missing(b, 'G5'), []);
	b.G5_finish.silk.designators = '只印关键器件';
	assert.ok(missing(b, 'G5').some(m => m.includes('旧的 G5')));
	b.G5_finish.silk.designators = '全部显示';
	const m2 = { ...model, teardrop_source: 'none', texts: model.texts.filter((t: any) => t.text !== 'JLCJLCJLCJLC') };
	b.G5_finish.result = finishCheck(m2, b);
	b.G5_finish.teardrops.done = '待填';
	const miss = missing(b, 'G5').join(' ');
	assert.ok(miss.includes('SLK-13'));
	assert.ok(miss.includes('执行泪滴'));
	b.G5_finish.accepted_exceptions = [{ rule: 'SLK-13', refs: [], why: '外壳全包' }];
	b.G5_finish.teardrops.done = '已执行并重新铺铜';
	assert.deepEqual(missing(b, 'G5'), []);
});

it('旧文件迁移、规则哈希不受截图影响', () => {
	const old: any = read('brief-principles.json.txt');
	delete old.G5_finish;
	old.G5_acceptance = old.G6_acceptance;
	delete old.G6_acceptance;
	old.confirmations = { G5: { code: 'x', hash: 'y' } };
	const b = migrate(old);
	assert.ok(b.G6_acceptance && !b.G5_acceptance && !b.confirmations.G5 && b.G5_finish);
	const f = JSON.parse(JSON.stringify(exp.briefs.std));
	const h = finishRulesHash(f);
	f.G5_finish.silk.review.screenshot = 'other.png';
	f.G5_finish.teardrops.done = '不加泪滴';
	assert.equal(finishRulesHash(f), h);
	assert.equal(typeof finishTemplate().silk.process, 'string');
});

it('能力边界：只布点名的网络', () => {
	const b = read('brief-principles.json.txt');
	for (const nets of [[], ['*'], ['全部'], ['剩下的'], ['all']])
		assert.ok(routeScope(b, nets)[0].includes('做不了'), JSON.stringify(nets));
	assert.ok(routeScope(b, Array.from({ length: 9 }, (_, i) => `N${i}`)).length);
});

it('器件值单位', () => {
	assert.equal(parseValueUnit('100nF'), 'F');
	assert.equal(parseValueUnit('4u7'), 'F');
	assert.equal(parseValueUnit('4R7'), 'Ω');
	assert.equal(parseValueUnit('2.2uH'), 'H');
	assert.equal(parseValueUnit('LED red'), null);
});
