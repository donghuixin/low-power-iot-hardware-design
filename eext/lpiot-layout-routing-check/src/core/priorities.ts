/**
 * 布线优先级梳理（与 scripts/design_gate.py 的 draft_priorities 一致）：按网络类和连接的器件，把网络分到 1…9 档，
 * 每档给出理由、建议走法和规则；用户在“确认”页逐档确认。
 */
import type { Board } from './model';
import { roleOf } from './layout';
import { upgradePairs } from './lint';
import { inferClass, mergeCons } from './model';
import { routingOrder, TIERS } from './principles';

export interface Tier { tier: number; name: string; classes: string[]; nets: string[]; notes: Record<string, string>; why: string; method: string; rules: string }

export const CLASS_ZH: Record<string, string> = { RF50: '射频 50 Ω', XTAL: '晶振', SW: '开关节点', HV: '高压', USB90: 'USB 差分', DIFF100: '100 Ω 差分', CLK: '时钟', ANALOG: '模拟', PWR_MAIN: '主电源', PWR_LOW: '电源', SIG: '一般信号', GND: '地' };
const ROLE_ZH: Record<string, string> = { antenna: '天线', rf_match: '射频匹配', crystal: '晶振', inductor: '电感', connector: '接口', cap: '电容', res: '电阻', diode: '二极管', ic: '芯片', soc_rf: '无线 SoC', dcdc: 'DCDC', ldo: 'LDO', charger: '充电', imu: 'IMU', button: '按键', testpoint: '测试点', battery: '电池', magnetometer: '磁力计', temp_humidity: '温湿度', rf_module: '无线模组' };
export const RULES_BY_CLASS: Record<string, string> = {
	RF50: '50 Ω 共面波导（线宽按叠层计算），不打过孔、不分支，两侧密打地过孔，拐角 135° 或圆弧',
	XTAL: '≤ 5 mm、不打过孔，负载电容贴晶振，下方完整地，远离开关节点和时钟',
	SW: '热回路面积最小，开关节点铜皮最小，线宽 ≥ 0.6 mm',
	HV: '先按电压定间距和爬电距离，再布线',
	USB90: '90 Ω 差分，同层、并行、等距、对内等长 ≤ 0.5 mm，过孔成对',
	DIFF100: '100 Ω 差分，同层、并行、等距、对内等长 ≤ 0.13 mm，过孔成对',
	CLK: '串阻贴驱动端，少拐弯少过孔，远离模拟和射频',
	ANALOG: '远离攻击网络，走在完整地正上方，必要时包地',
	PWR_MAIN: '按电流定线宽（见电源网络表），先干线后支路，去耦就近',
	PWR_LOW: '按电流定线宽（见电源网络表），去耦电容贴引脚',
	SIG: '八方向、拐角只用 135°，总线成束等距',
	GND: '最后铺铜、补缝合过孔，修补被切开的地',
};

export function draftPriorities(board: Board, roles: Record<string, string> = {}): Tier[] {
	const values = new Map((board.parts ?? []).map(p => [p.ref, p.value ?? undefined]));
	const classes: Record<string, string> = {};
	const notes: Record<string, string> = {};
	for (const n of board.nets) {
		const [c, , why] = inferClass(n.name, n.pads);
		classes[n.name] = c;
		notes[n.name] = why.includes('网络名匹配') ? '按网络名判断' : why;
	}
	upgradePairs(classes, board.nets, mergeCons(null), []);
	for (const n of board.nets) {
		const refs = [...new Set(n.pads.map(p => p.ref).filter(r => r && r !== 'PAD'))];
		const lab = refs.slice(0, 5).map((r) => {
			const role = ROLE_ZH[roleOf(r, values.get(r) || undefined, roles)] ?? '';
			const v = values.get(r);
			const inner = `${role}${v ? ` ${v}` : ''}`.trim();
			return inner ? `${r}（${inner}）` : r;
		});
		notes[n.name] = `${CLASS_ZH[classes[n.name]] ?? classes[n.name]}，${notes[n.name]}；连接 ${lab.join('、')}${refs.length > 5 ? ' 等' : ''}`;
	}
	const rows = routingOrder(board.nets, classes);
	const out: Tier[] = [];
	for (const [t, name, , why] of TIERS) {
		const ns = rows.filter(r => r.tier === t).map(r => r.net);
		if (!ns.length)
			continue;
		const cls = [...new Set(ns.map(x => classes[x]))].sort();
		out.push({ tier: t, name, classes: cls, nets: ns, notes: Object.fromEntries(ns.map(x => [x, notes[x]])), why, method: t === 9 ? '铺铜' : t === 8 ? '工具辅助' : '手工', rules: cls.filter(c => RULES_BY_CLASS[c]).map(c => RULES_BY_CLASS[c]).join('；') });
	}
	return out;
}
