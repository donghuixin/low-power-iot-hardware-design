// 验证器界面：三个页签（电流 / 电磁 / 温度），左侧对象列表与"假如"控制，中间板图，右侧结论。
(function (LP) {
  'use strict';
  const PR = LP.render;

  const h = (tag, attrs = {}, ...kids) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'html') el.innerHTML = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const c of kids.flat(Infinity)) if (c != null && c !== false) el.append(c.nodeType ? c : String(c));
    return el;
  };
  const $ = (id) => document.getElementById(id);
  const put = (el, ...kids) => el.replaceChildren(...kids.flat(Infinity).filter((k) => k != null && k !== false));
  const fmt = (v, d = 1) => (v == null || !Number.isFinite(v) ? '—' : (+v).toFixed(d));
  const KIND = { dc: '直流', switching: '开关', rf: '射频' };
  const SUP = { plane: '整层电源平面', route: '走线（按候选路径估计）', copper: '实际铜皮' };
  const RET = { image: '贴着去程走（高频）', plane: '在地平面上扩散（直流）', detour: '被缺口挡住，绕行', route: '走线（没有整层地）', copper: '实际地铜皮' };
  const store = { get(k, d) { try { const v = localStorage.getItem('lv:' + k); return v == null ? d : v; } catch (e) { return d; } }, set(k, v) { try { localStorage.setItem('lv:' + k, v); } catch (e) { /* 忽略 */ } } };

  const App = {
    sum: null, tab: 'current', busy: 0, token: 0,
    sel: { load: 0, emiSub: 'map', emiOnly: null, emiSide: 'top', mode: 0, heatRef: null },
    opt: { stack: 'project', sup: true, ret: true, heatsinks: {}, airflow: 0, ta: null, sealed: false, fullCopper: false, compare: true, split: 0.5, layer: 0 },
    res: {},

    async boot(project, copper) {
      this.viewer = new PR.Viewer($('stage-canvas'));
      this.parts = new LP.Particles(this.viewer);
      this.parts.enabled = store.get('anim', '1') === '1';
      this.parts.onDegrade = (lv) => this.toast(['', '动效已减半以保持流畅', '已关闭拖尾以保持流畅', '已改为静态流线以保持流畅'][lv]);
      this.viewer.onView = () => { this.parts.reset(); this.drawOverlay(); if (this.emiAnim) this.emiAnim.reset(); };
      this.viewer.onHover = (x, y, px, py) => this.hover(x, y, px, py);
      this.viewer.onDragStart = (px) => this.tab === 'thermal' && this.opt.compare && Math.abs(px - this.opt.split * this.viewer.W) < 14;
      this.viewer.onDragMove = (px) => { this.opt.split = Math.min(0.95, Math.max(0.05, px / this.viewer.W)); this.applyThermalClip(); };
      this.viewer.onDragEnd = () => { this.parts.reset(); };
      this.client = new LP.Client();
      this.bindChrome();
      await this.load(project, copper);
    },

    async load(project, copper) {
      this.res = {}; this.token++;
      this.setBusy(true, '正在读入项目…');
      try {
        this.sum = await this.client.call('init', project, copper || null);
      } catch (err) { this.setBusy(false); this.fatal('读入失败：' + err.message); return; }
      this.setBusy(false);
      this.project = project; this.copper = copper || null;
      const s = this.sum;
      this.opt.ta = s.env.ta_c;
      this.sel.load = s.loads.length ? s.loads.reduce((b, l, i) => (l.i_avg_ma > s.loads[b].i_avg_ma ? i : b), 0) : -1;
      this.sel.heatRef = s.thermal.length ? s.thermal.reduce((b, t) => (t.p_w > b.p_w ? t : b), s.thermal[0]).part : null;
      $('proj-name').textContent = s.name || '未命名项目';
      const badge = $('stage-badge');
      badge.textContent = s.stage === 'R' ? '布线后 · 简化模型' : '布线前 · 估计';
      badge.className = 'badge ' + (s.stage === 'R' ? 'r' : 'p');
      $('calc-mode').textContent = this.client.mode === 'worker' ? '' : '（主线程计算）';
      this.viewer.setBoard(s);
      if (s.stage === 'R') await this.loadCopperImage();
      this.renderTab();
    },

    // ---------- 外框 ----------
    bindChrome() {
      document.querySelectorAll('#tabs button').forEach((b) => b.addEventListener('click', () => { this.tab = b.dataset.tab; this.renderTab(); }));
      const anim = $('btn-anim');
      const syncAnim = () => { anim.setAttribute('aria-pressed', String(this.parts.enabled)); anim.classList.toggle('on', this.parts.enabled); };
      syncAnim();
      anim.addEventListener('click', () => { this.parts.setEnabled(!this.parts.enabled); store.set('anim', this.parts.enabled ? '1' : '0'); syncAnim(); if (this.emiAnim) this.emiAnim.setEnabled(this.parts.enabled); if (this.modeAnim) this.modeAnim.setEnabled(this.parts.enabled); });
      $('btn-perf').addEventListener('click', () => { const on = this.parts.level < 2; this.parts.level = on ? 2 : 0; $('btn-perf').classList.toggle('on', on); this.parts.reset(); this.toast(on ? '性能模式：粒子减到四分之一、不画拖尾' : '已恢复默认动效'); });
      $('btn-report').addEventListener('click', () => this.exportReport());
      $('btn-png').addEventListener('click', () => this.exportPNG());
      $('btn-open').addEventListener('click', () => $('file-in').click());
      $('file-in').addEventListener('change', (e) => this.openFiles(e.target.files));
      document.addEventListener('dragover', (e) => { e.preventDefault(); document.body.classList.add('drop'); });
      document.addEventListener('dragleave', (e) => { if (!e.relatedTarget) document.body.classList.remove('drop'); });
      document.addEventListener('drop', (e) => { e.preventDefault(); document.body.classList.remove('drop'); this.openFiles(e.dataTransfer.files); });
    },
    async openFiles(files) {
      let project = null, copper = null;
      for (const f of files || []) {
        try {
          const j = JSON.parse(await f.text());
          if (j.kind === 'copper-pack') copper = j; else if (j.board && j.parts) project = j;
        } catch (e) { this.toast(`${f.name} 不是有效的 JSON`); }
      }
      if (!project && !copper) return;
      if (copper && !project) { project = this.project; this.toast('已载入铜皮数据包，切换到布线后验证'); }
      await this.load(project, copper || (project === this.project ? this.copper : null));
    },
    setBusy(on, text) {
      this.busy += on ? 1 : -1;
      if (this.busy < 0) this.busy = 0;
      $('busy').hidden = !this.busy;
      if (text) $('busy-text').textContent = text;
    },
    toast(msg) {
      if (!msg) return;
      const t = h('div', { class: 'toast' }, msg);
      $('toasts').append(t);
      setTimeout(() => t.remove(), 3500);
    },
    fatal(msg) { put($('right'), h('div', { class: 'card err' }, msg)); },

    // ---------- 页签 ----------
    renderTab() {
      document.querySelectorAll('#tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === this.tab)));
      this.stopAnims();
      this.viewer.highlight = new Set();
      this.viewer.setHeats([]);
      this.viewer.setOverlay({});
      if (this.tab === 'current') this.showCurrent();
      else if (this.tab === 'emi') this.showEmi();
      else this.showThermal();
      this.renderAssume();
    },
    stopAnims() {
      this.parts.stop();
      if (this.emiAnim) { this.emiAnim.stop(); this.emiAnim = null; }
      if (this.modeAnim) { this.modeAnim.stop(); this.modeAnim = null; }
      this.hoverFields = [];
    },
    async run(op, args, label) {
      const tk = ++this.token;
      this.setBusy(true, label);
      try {
        const r = await this.client.call(op, ...args);
        return tk === this.token ? r : null;
      } catch (err) { this.toast('计算出错：' + err.message.split('\n')[0]); return null; }
      finally { this.setBusy(false); }
    },

    // ---------- 电流 ----------
    stackupFor() {
      const s = this.sum.stackup, L = this.sum.layers;
      if (this.opt.stack === '2l') return { ...s, planes: [], h_mm: 1.6 };
      if (this.opt.stack === '4l') { const pwr = (this.sum.sources[0] || {}).net; return { ...s, planes: [{ layer: 1, net: this.sum.gnd }, ...(pwr ? [{ layer: 2, net: pwr }] : [])], cu_oz: s.cu_oz.length >= 4 ? s.cu_oz : [1, 0.5, 0.5, 1], h_mm: 0.2 }; }
      return null;
    },
    async showCurrent() {
      const s = this.sum;
      const left = $('left');
      put(left, 
        h('h3', {}, '选择负载'),
        h('p', { class: 'muted' }, '每次只看一个器件：它的电流从电源起点来，回流从它的地脚回到起点的地。'),
        h('div', { class: 'list' }, s.loads.map((l) => h('button', { class: 'item' + (l.i === this.sel.load ? ' sel' : ''), onclick: () => { this.sel.load = l.i; this.showCurrent(); } },
          h('b', {}, l.part), h('span', {}, `${l.net} · ${fmt(l.i_avg_ma, l.i_avg_ma < 1 ? 2 : 1)} mA · ${KIND[l.kind] || l.kind}`), l.def ? h('em', {}, '默认值') : null))),
        !s.loads.length ? h('p', { class: 'muted' }, '项目里没有可选的负载：请在 verify.loads 中填写，或给电源网络标上 class: "power"。') : null,
        h('h3', {}, '显示'),
        chk('去程（暖色）', this.opt.sup, (v) => { this.opt.sup = v; this.drawCurrent(); }),
        chk('回流（冷色）', this.opt.ret, (v) => { this.opt.ret = v; this.drawCurrent(); }),
        s.stage === 'P' ? h('div', {}, h('h3', {}, '假如'),
          sel('叠层', [['project', `按项目（${s.layers} 层）`], ['2l', '2 层，没有整层地'], ['4l', '4 层，整层地 + 电源层']], this.opt.stack, (v) => { this.opt.stack = v; this.showCurrent(); })) : null,
        legendBox('fire', '|J| A/mm²（对数）', 'cur-legend'),
      );
      if (this.sel.load < 0) return;
      const st = this.stackupFor();
      const r = await this.run('current', [this.sel.load, st ? { stackup: st } : {}], '正在估算电流路径…');
      if (!r || this.tab !== 'current') return;
      this.res.current = r;
      if (r.error) { put($('right'), h('div', { class: 'card err' }, r.error)); return; }
      this.drawCurrent();
      this.renderCurrentRight(r);
    },
    drawCurrent() {
      const r = this.res.current;
      if (!r || r.error) return;
      const g = this.sum.grid;
      let hi = 0;
      for (const f of [r.sup, r.ret]) for (let c = 0; c < f.mag.length; c++) if (f.mag[c] > hi) hi = f.mag[c];
      const lo = hi / 1e3;
      const heats = [];
      if (this.opt.sup) heats.push({ field: r.sup.mag, grid: g, pal: 'fire', min: lo, max: hi, log: true, fade: true, zeroClear: true, alpha: 0.85, blend: 'lighter' });
      if (this.opt.ret) heats.push({ field: r.ret.mag, grid: g, pal: 'ice', min: lo, max: hi, log: true, fade: true, zeroClear: true, alpha: 0.55, blend: 'lighter' });
      this.viewer.setHeats(heats);
      this.hoverFields = [{ f: r.sup.mag, g, label: '去程', unit: 'A/mm²', d: 3 }, { f: r.ret.mag, g, label: '回流', unit: 'A/mm²', d: 3 }];
      const sys = [];
      if (this.opt.sup) sys.push({ fx: r.sup.fx, fy: r.sup.fy, mag: r.sup.mag, grid: g, pal: 'fire', share: this.opt.ret ? 0.6 : 1, jitter: r.jitter, lo, hi });
      if (this.opt.ret) sys.push({ fx: r.ret.fx, fy: r.ret.fy, mag: r.ret.mag, grid: g, pal: 'ice', share: this.opt.sup ? 0.4 : 1, lo, hi, speed: 0.8, alpha: 0.7 });
      this.parts.set(sys); this.parts.start();
      const l = this.sum.loads[this.sel.load];
      this.viewer.highlight = new Set([l.part, r.pins && this.sum.sources.find((x) => x.net === l.net) ? this.sum.sources.find((x) => x.net === l.net).part : null, ...(r.decaps || []).map((d) => d.ref)].filter(Boolean));
      const lg = $('cur-legend-range');
      if (lg) lg.textContent = `${fmt(lo, 3)} – ${fmt(hi, 1)}`;
      this.drawOverlay();
    },
    renderCurrentRight(r) {
      const l = this.sum.loads[this.sel.load];
      const rows = [
        ['电流', `平均 ${fmt(l.i_avg_ma, 2)} mA，峰值 ${fmt(l.i_peak_ma, 1)} mA（${KIND[l.kind] || l.kind}）`],
        ['去程', SUP[r.supMode] || r.supMode],
        ['回流', RET[r.retMode] || r.retMode],
        ['去程长度', `${fmt(r.supLen)} mm`],
        r.loopArea != null ? ['回路面积', `${fmt(r.loopArea)} mm²`] : null,
        r.hfLoop != null ? ['高频小回路', `${fmt(r.hfLoop, 2)} mm²（最近的去耦电容）`] : null,
        r.corridor != null ? ['通道最窄', `${fmt(r.corridor, 2)} mm`] : null,
        ['建议线宽', `≥ ${fmt(r.wReq, 2)} mm`],
        r.dropV != null ? ['直流压降', `${fmt(r.dropV * 1000, 3)} mV`] : null,
        r.spread != null ? ['路径不确定度', `约 ±${fmt(r.spread, 1)} mm（候选路径的离散程度）`] : null,
      ].filter(Boolean);
      put($('right'), 
        h('h3', {}, `${l.part} 的供电与回流`),
        kv(rows),
        r.decaps && r.decaps.length ? h('div', {}, h('h4', {}, '旁边的电容'), kv(r.decaps.map((d) => [d.ref, `离引脚 ${d.d} mm，回路约 ${d.area} mm²`]))) : null,
        this.findingsBox(r.findings || []),
      );
    },

    // ---------- 电磁 ----------
    async showEmi() {
      const s = this.sum;
      const left = $('left');
      const sub = this.sel.emiSub;
      put(left, 
        seg([['map', '受扰地图'], ['modes', '平面谐振']], sub, (v) => { this.sel.emiSub = v; this.renderTab(); }),
      );
      if (sub === 'map') return this.showEmiMap();
      return this.showModes();
    },
    async showEmiMap() {
      const r = await this.run('emi', [{ side: this.sel.emiSide, only: this.sel.emiOnly }], '正在估算受扰分布…');
      if (!r || this.tab !== 'emi') return;
      this.res.emi = r;
      const left = $('left');
      left.append(
        sel('看哪一面', [['top', '正面'], ['bottom', '背面']], this.sel.emiSide, (v) => { this.sel.emiSide = v; this.showEmi(); }),
        h('h3', {}, '干扰源'),
        h('div', { class: 'list' },
          h('button', { class: 'item' + (this.sel.emiOnly == null ? ' sel' : ''), onclick: () => { this.sel.emiOnly = null; this.showEmi(); } }, h('b', {}, '全部'), h('span', {}, '叠加所有干扰源')),
          r.emitters.map((e) => h('button', { class: 'item' + (this.sel.emiOnly === e.id ? ' sel' : ''), onclick: () => { this.sel.emiOnly = e.id; this.showEmi(); } },
            h('b', {}, e.label), h('span', {}, `${EK[e.kind] || e.kind} · ${fmt(e.level, 0)} dB${e.f ? ' · ' + fhz(e.f) : ''}`)))),
        h('h3', {}, '敏感对象'),
        h('div', { class: 'list' }, r.victims.map((v) => h('div', { class: 'item static' }, h('b', {}, v.label), h('span', { class: 'grade ' + v.grade }, GRADE[v.grade]), h('span', {}, `${fmt(v.level, 0)} dB`)))),
        legendBox('plasma', '受扰等级 dB（相对天线）', 'emi-legend', '−60 – 0'),
      );
      const g = this.sum.grid, map = r.maps[this.sel.emiSide];
      this.viewer.setHeats([{ field: map, grid: g, pal: 'plasma', min: -60, max: 0, log: false, alpha: 0.8 }]);
      this.hoverFields = [{ f: map, g, label: '受扰', unit: 'dB', d: 0 }];
      this.viewer.highlight = new Set(r.victims.filter((v) => v.grade !== 'low').map((v) => v.label));
      this.emiAnim = new EmiAnim(this.viewer, r.emitters.filter((e) => this.sel.emiOnly == null || e.id === this.sel.emiOnly), r.victims, this.parts.enabled);
      this.drawOverlay();
      put($('right'), 
        h('h3', {}, '受扰情况'),
        h('p', { class: 'muted' }, '每个敏感对象取它所在位置的受扰等级，列出贡献最大的两个干扰源。'),
        kv(r.victims.map((v) => [v.label, `${GRADE[v.grade]}（${fmt(v.level, 0)} dB）· ${v.top.map((t) => `${t.label} ${fmt(t.db, 0)}`).join('，')}`])),
        this.findingsBox(r.findings),
      );
    },
    async showModes() {
      const r = await this.run('modes', [{}], '正在求平面谐振模态…');
      if (!r || this.tab !== 'emi') return;
      this.res.modes = r;
      const left = $('left');
      if (r.na) { left.append(h('p', { class: 'muted' }, r.na)); put($('right'), h('h3', {}, '平面谐振'), h('p', { class: 'muted' }, r.na)); return; }
      const k = Math.min(this.sel.mode, r.modes.length - 1);
      left.append(
        h('h3', {}, '模态'),
        h('div', { class: 'list' }, r.modes.map((m, i) => h('button', { class: 'item' + (i === k ? ' sel' : ''), onclick: () => { this.sel.mode = i; this.showEmi(); } },
          h('b', {}, `第 ${i + 1} 模`), h('span', {}, fhz(m.f)), m.near.length ? h('em', { class: 'warn' }, '接近工作频率') : null))),
        h('p', { class: 'muted' }, '红蓝表示两块平面之间电压的正负，白线是节线。波腹（颜色最深处）最容易被激励，也最容易受扰。'),
        legendBox('div', '模态幅度（归一化）', 'mode-legend', '−1 – +1'),
      );
      const m = r.modes[k], g = r.grid;
      const nodal = PR.contour(m.phi, g, 0);
      this.viewer.setHeats([{ field: m.phi, grid: g, pal: 'div', min: -1, max: 1, alpha: 0.85, scale: 1 }]);
      this.hoverFields = [{ f: m.phi, g, label: '幅度', unit: '', d: 2 }];
      let mx = 0, mc = 0; for (let c = 0; c < m.phi.length; c++) if (Math.abs(m.phi[c]) > mx) { mx = Math.abs(m.phi[c]); mc = c; }
      this.overlayExtra = { nodal, callout: { x: g.x0 + ((mc % g.nx) + 0.5) * g.cell, y: g.y0 + (((mc / g.nx) | 0) + 0.5) * g.cell, big: fhz(m.f), small: `第 ${k + 1} 模 · 起伏已放大${m.near.length ? ' · 接近 ' + m.near[0] : ''}` } };
      this.modeAnim = new ModeAnim(this.viewer, m.phi, g, this.parts.enabled);
      this.drawOverlay();
      put($('right'), 
        h('h3', {}, '平面谐振'),
        kv(r.modes.map((q, i) => [`第 ${i + 1} 模`, `${fhz(q.f)}${q.near.length ? ' · 接近 ' + q.near.join('、') : ''}`])),
        h('p', { class: 'muted' }, '把模态频率与板上的射频频段、时钟谐波比较，相差 10% 以内要留意。'),
        this.findingsBox(r.findings || []),
      );
    },

    // ---------- 温度 ----------
    thermalOpts(withMeasures) {
      const o = { env: { ta_c: this.opt.ta } };
      if (!withMeasures) return o;
      o.heatsinks = { ...this.opt.heatsinks };
      o.env.airflow_m_s = this.opt.airflow;
      if (this.opt.sealed) o.env.sealed_k_per_w = 10;
      if (this.opt.fullCopper) o.copper = [{ rect: { x0: -1e3, y0: -1e3, x1: 1e3, y1: 1e3 }, cov: 0.8 }];
      return o;
    },
    async showThermal() {
      const s = this.sum;
      const hsOpts = [['0', '无'], ['0.05', '小（约 20 K/W）'], ['0.1', '中（约 10 K/W）'], ['0.25', '大（约 4 K/W）']];
      put($('left'), 
        h('h3', {}, '发热器件'),
        h('div', { class: 'list' }, s.thermal.map((t) => h('div', { class: 'item' + (t.part === this.sel.heatRef ? ' sel' : ''), onclick: (e) => { if (e.target.tagName === 'SELECT') return; this.sel.heatRef = t.part; this.showThermal(); } },
          h('b', {}, t.part), h('span', {}, `${fmt(t.p_w * 1000, t.p_w < 0.1 ? 1 : 0)} mW`), t.def ? h('em', {}, '默认值') : null,
          h('select', { class: 'mini', title: '散热器', onchange: (e) => { const v = +e.target.value; if (v) this.opt.heatsinks[t.part] = v; else delete this.opt.heatsinks[t.part]; this.showThermal(); } },
            hsOpts.map(([v, l]) => h('option', { value: v, selected: String(this.opt.heatsinks[t.part] || 0) === v ? true : null }, '散热器：' + l)))))),
        h('h3', {}, '散热措施（右半边）'),
        sel('空气', [['0', '自然对流'], ['0.5', '微风 0.5 m/s'], ['1', '风扇 1 m/s'], ['2', '风扇 2 m/s']], String(this.opt.airflow), (v) => { this.opt.airflow = +v; this.showThermal(); }),
        chk('各信号层大面积铺铜', this.opt.fullCopper, (v) => { this.opt.fullCopper = v; this.showThermal(); }),
        h('h3', {}, '环境'),
        num('环境温度 °C', this.opt.ta, (v) => { this.opt.ta = v; this.showThermal(); }),
        chk('密闭外壳（壳内升温 10 K/W）', this.opt.sealed, (v) => { this.opt.sealed = v; this.showThermal(); }),
        h('h3', {}, '显示'),
        chk('左右对比：无散热 | 有散热', this.opt.compare, (v) => { this.opt.compare = v; this.showThermal(); }),
        legendBox('heat', '板温 °C', 'th-legend'),
      );
      const base = await this.run('thermal', [this.thermalOpts(false)], '正在求温度分布…');
      if (!base || this.tab !== 'thermal') return;
      const cfg = await this.run('thermal', [this.thermalOpts(true)], '正在求加散热后的温度…');
      if (!cfg || this.tab !== 'thermal') return;
      this.res.thermal = { base, cfg };
      this.drawThermal();
    },
    drawThermal() {
      const { base, cfg } = this.res.thermal, g = this.sum.grid;
      const lo = base.ta, hi = Math.max(base.tmax, cfg.tmax, lo + 5);
      const cmp = this.opt.compare, sp = this.opt.split;
      const heats = cmp
        ? [{ field: base.T, grid: g, pal: 'heat', min: lo, max: hi, alpha: 0.9, clip: [0, sp] }, { field: cfg.T, grid: g, pal: 'heat', min: lo, max: hi, alpha: 0.9, clip: [sp, 1] }]
        : [{ field: cfg.T, grid: g, pal: 'heat', min: lo, max: hi, alpha: 0.9 }];
      this.viewer.setHeats(heats);
      $('th-legend-range').textContent = `${fmt(lo, 1)} – ${fmt(hi, 1)}`;
      this.hoverFields = cmp ? [{ f: base.T, g, label: '无散热', unit: '°C', d: 1, clip: [0, sp] }, { f: cfg.T, g, label: '有散热', unit: '°C', d: 1, clip: [sp, 1] }] : [{ f: cfg.T, g, label: '板温', unit: '°C', d: 1 }];
      const levels = [];
      for (let k = 1; k <= 5; k++) levels.push(lo + ((hi - lo) * k) / 6);
      let contours = [];
      for (const L of levels) contours = contours.concat(PR.contour(cfg.T, g, L));
      const vx = (x) => this.viewer.sx(x) / this.viewer.W;
      const half = (res, left) => {
        const sp2 = new Float32Array(res.flux.length);
        for (let c = 0; c < sp2.length; c++) { const x = g.x0 + ((c % g.nx) + 0.5) * g.cell, f = vx(x); sp2[c] = !cmp || (left ? f < sp : f >= sp) ? res.flux[c] : 0; }
        return sp2;
      };
      let fh = 0; for (const r of [base, cfg]) for (let c = 0; c < r.flux.length; c++) fh = Math.max(fh, r.flux[c]);
      const sys = cmp
        ? [{ fx: base.fx, fy: base.fy, mag: base.flux, spawn: half(base, true), grid: g, pal: 'fire', share: 0.35, lo: fh * 1e-3, hi: fh, speed: 0.4, alpha: 0.4 },
          { fx: cfg.fx, fy: cfg.fy, mag: cfg.flux, spawn: half(cfg, false), grid: g, pal: 'fire', share: 0.35, lo: fh * 1e-3, hi: fh, speed: 0.4, alpha: 0.4 }]
        : [{ fx: cfg.fx, fy: cfg.fy, mag: cfg.flux, grid: g, pal: 'fire', share: 0.7, lo: fh * 1e-3, hi: fh, speed: 0.4, alpha: 0.4 }];
      this.parts.set(sys); this.parts.start();
      const ref = this.sel.heatRef;
      const pb = base.parts.find((q) => q.ref === ref), pc = cfg.parts.find((q) => q.ref === ref);
      const it = this.sum.items.find((x) => x.ref === ref);
      const measures = [this.opt.heatsinks[ref] ? '加散热器' : null, this.opt.airflow ? `风速 ${this.opt.airflow} m/s` : null, this.opt.fullCopper ? '大面积铺铜' : null].filter(Boolean);
      this.overlayExtra = { contours, split: cmp ? sp : null, splitLabels: ['无散热', '有散热'],
        callout: pb && pc && it ? { x: (it.rect.x0 + it.rect.x1) / 2, y: (it.rect.y0 + it.rect.y1) / 2, big: cmp ? `${fmt(pb.tj, 0)} °C → ${fmt(pc.tj, 0)} °C` : `${fmt(pc.tj, 0)} °C`, small: `${ref} 结温 · 同样功耗${measures.length ? ' · ' + measures.join('、') : ''}` } : null };
      this.viewer.highlight = new Set(ref ? [ref] : []);
      this.drawOverlay();
      put($('right'), 
        h('h3', {}, '温度'),
        kv([['环境', `${fmt(base.ta, 1)} °C`], ['总功耗', `${fmt(base.P * 1000, 0)} mW`], ['板面最高', `无散热 ${fmt(base.tmax, 1)} °C · 有散热 ${fmt(cfg.tmax, 1)} °C`], ['能量核对', `散出 ${fmt(cfg.loss * 1000, 1)} mW / 输入 ${fmt(cfg.P * 1000, 1)} mW`]]),
        h('h4', {}, '器件结温（无散热 → 有散热）'),
        kv(base.parts.map((q) => { const c = cfg.parts.find((x) => x.ref === q.ref); return [q.ref, `${fmt(q.tj, 1)} → ${fmt(c ? c.tj : null, 1)} °C（板 ${fmt(c ? c.tb : q.tb, 1)} °C，上限 ${q.tjmax} °C）`]; })),
        this.findingsBox(cfg.findings),
      );
    },
    applyThermalClip() {
      if (!this.res.thermal || !this.opt.compare) return;
      if (this.viewer.heats.length === 2) { this.viewer.heats[0].h.clip = [0, this.opt.split]; this.viewer.heats[1].h.clip = [this.opt.split, 1]; this.viewer.drawBase(); }
      if (this.overlayExtra) this.overlayExtra.split = this.opt.split;
      this.drawOverlay();
    },

    // ---------- 标注、提示、结论 ----------
    drawOverlay() {
      const o = { ...(this.overlayExtra || {}) };
      if (this.tab === 'current' && this.res.current && !this.res.current.error) {
        const r = this.res.current, p = r.pins;
        o.marks = [{ x: p.src.x, y: p.src.y, color: '#7ee787', label: '电源起点' }, { x: p.load.x, y: p.load.y, color: '#ffd166', label: '负载' }];
        if (this.opt.ret) o.marks.push({ x: p.loadGnd.x, y: p.loadGnd.y, color: '#79c0ff', r: 4, label: '地' }, { x: p.srcGnd.x, y: p.srcGnd.y, color: '#79c0ff', r: 4 });
        o.lines = [];
        if (this.opt.sup && r.supPts) o.lines.push({ pts: r.supPts, color: 'rgba(255,190,120,0.45)' });
        if (this.opt.ret && r.retPts && r.retMode !== 'image') o.lines.push({ pts: r.retPts, color: 'rgba(120,200,255,0.45)' });
        o.findings = r.findings || [];
      }
      if (this.tab === 'emi' && this.sel.emiSub === 'map' && this.res.emi) o.findings = this.res.emi.findings;
      if (this.tab === 'emi' && this.sel.emiSub === 'modes' && this.res.modes) o.findings = this.res.modes.findings || [];
      if (this.tab === 'thermal' && this.res.thermal) o.findings = this.res.thermal.cfg.findings;
      if (this.focus != null && o.findings && o.findings[this.focus]) o.findings = o.findings.map((f, i) => (i === this.focus ? { ...f, focus: true } : f));
      if (this.tab !== 'thermal' && !(this.tab === 'emi' && this.sel.emiSub === 'modes')) this.overlayExtra = null;
      this.viewer.setOverlay(o);
    },
    findingsBox(list) {
      this.focus = null;
      const box = h('div', { class: 'findings' }, h('h4', {}, list.length ? `结论（${list.length}）` : '结论'));
      if (!list.length) box.append(h('p', { class: 'ok' }, '这一项没有发现问题。'));
      list.forEach((f, i) => box.append(h('button', { class: 'card sev-' + f.sev, onclick: () => { this.focus = i; this.drawOverlay(); } },
        h('div', { class: 'card-h' }, h('span', { class: 'sev' }, f.sev), h('span', { class: 'rule' }, `${i + 1} · ${f.rule} ${f.name}`)),
        h('div', { class: 'title' }, f.title),
        f.advice ? h('div', { class: 'advice' }, '建议：' + f.advice) : null,
        f.assume ? h('div', { class: 'assume' }, '依据：' + f.assume) : null)));
      return box;
    },
    renderAssume() {
      const s = this.sum, box = $('assume');
      const def = s.defaults.length ? `使用默认值：${s.defaults.map((d) => DEF[d] || d).join('、')}。默认值只能给出方向，请在项目 JSON 的 verify 块里填写实际数值。` : '所有输入都来自项目 JSON 的 verify 块。';
      const st = s.stackup;
      box.textContent = `${s.stage === 'P' ? '布线前估计：路径按引脚朝向与可走通道的概率估计，结论只用于判断方向。' : '布线后简化模型：铜皮来自实际布板数据，网格 ' + fmt(s.grid.cell, 2) + ' mm。'} 叠层 ${s.layers} 层，平面 ${st.planes.map((q) => `L${q.layer + 1}=${q.net}`).join('，') || '无'}。${def}`;
    },
    hover(x, y, px, py) {
      const tip = $('tip');
      if (x == null || !this.hoverFields || !this.hoverFields.length) { tip.hidden = true; return; }
      const parts = [];
      for (const f of this.hoverFields) {
        if (f.clip) { const fr = px / this.viewer.W; if (fr < f.clip[0] || fr > f.clip[1]) continue; }
        const g = f.g, i = Math.floor((x - g.x0) / g.cell), j = Math.floor((y - g.y0) / g.cell);
        if (i < 0 || j < 0 || i >= g.nx || j >= g.ny) continue;
        const v = f.f[j * g.nx + i];
        if (!Number.isFinite(v) || (f.unit === 'A/mm²' && !(v > 0))) continue;
        parts.push(`${f.label} ${f.unit === 'A/mm²' ? sci(v) : fmt(v, f.d)} ${f.unit}`);
      }
      const it = this.sum.items.find((q) => x >= q.rect.x0 && x <= q.rect.x1 && y >= q.rect.y0 && y <= q.rect.y1);
      if (it) parts.unshift(it.ref);
      if (!parts.length) { tip.hidden = true; return; }
      tip.textContent = parts.join(' · ');
      tip.hidden = false;
      tip.style.left = px + 14 + 'px'; tip.style.top = py + 12 + 'px';
    },

    // ---------- 导出 ----------
    async exportReport() {
      const r = await this.run('report', [{}], '正在逐项计算报告…');
      if (!r) return;
      download(`${(this.sum.name || 'layout').replace(/[\\/:*?"<>|]/g, '_')}-verify-report.json`, JSON.stringify(r, null, 2), 'application/json');
      const c = r.findings.reduce((m, f) => ((m[f.sev] = (m[f.sev] || 0) + 1), m), {});
      this.toast(`报告已导出：${['P0', 'P1', 'P2', 'P3'].filter((k) => c[k]).map((k) => `${k} ${c[k]} 条`).join('，') || '没有结论'}`);
    },
    exportPNG() {
      const v = this.viewer, out = document.createElement('canvas');
      out.width = v.base.width; out.height = v.base.height;
      const c = out.getContext('2d');
      c.fillStyle = '#0b0c10'; c.fillRect(0, 0, out.width, out.height);
      for (const cv of [v.base, v.fx, v.top]) c.drawImage(cv, 0, 0);
      out.toBlob((b) => download(`${this.tab}.png`, b, 'image/png'));
    },

    async loadCopperImage() {
      const img = await this.run('copperLayer', ['all', this.opt.layer], '正在载入铜皮…');
      if (!img) return;
      this.viewer.setCopper(PR.rasterize({ field: img.cov, grid: img.grid, pal: 'fire', min: 0, max: 4, alpha: 1, zeroClear: true }));
    },
  };

  const EK = { antenna: '天线', rf_trace: '射频走线', switch_node: '开关节点', inductor: '功率电感', clock: '时钟', hv_pulse: '高压脉冲' };
  const GRADE = { high: '高', mid: '中', low: '低' };
  const DEF = { sources: '电源起点', loads: '负载电流', thermal: '功耗', emitters: '干扰源', victims: '敏感对象', stackup: '叠层', env: '环境' };
  const fhz = (f) => (f >= 1e9 ? `${(f / 1e9).toFixed(2)} GHz` : f >= 1e6 ? `${(f / 1e6).toFixed(1)} MHz` : `${(f / 1e3).toFixed(0)} kHz`);
  const sci = (v) => (v >= 100 ? v.toFixed(0) : v >= 1 ? v.toFixed(1) : v.toExponential(1));
  function chk(label, val, on) { const i = h('input', { type: 'checkbox', checked: val ? true : null, onchange: (e) => on(e.target.checked) }); return h('label', { class: 'chk' }, i, label); }
  function sel(label, opts, val, on) { return h('label', { class: 'field' }, h('span', {}, label), h('select', { onchange: (e) => on(e.target.value) }, opts.map(([v, l]) => h('option', { value: v, selected: v === val ? true : null }, l)))); }
  function num(label, val, on) { return h('label', { class: 'field' }, h('span', {}, label), h('input', { type: 'number', value: val, step: 1, onchange: (e) => { const v = parseFloat(e.target.value); if (Number.isFinite(v)) on(v); } })); }
  function seg(opts, val, on) { return h('div', { class: 'seg', role: 'tablist' }, opts.map(([v, l]) => h('button', { 'aria-selected': String(v === val), onclick: () => on(v) }, l))); }
  function kv(rows) { return h('dl', { class: 'kv' }, rows.map(([k, v]) => [h('dt', {}, k), h('dd', {}, v)])); }
  function legendBox(pal, label, id, range) {
    const cv = h('canvas', { class: 'legend-bar' });
    PR.legend(cv, pal);
    return h('div', { class: 'legend' }, h('div', { class: 'legend-label' }, label), cv, h('div', { class: 'legend-range', id: id + '-range' }, range || ''));
  }
  function download(name, data, type) {
    const blob = data instanceof Blob ? data : new Blob([data], { type });
    const a = h('a', { href: URL.createObjectURL(blob), download: name });
    document.body.append(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }

  /** 受扰地图动效：从干扰源向外扩散的环，亮度按衰减变暗；环扫过敏感对象时按受扰等级闪一下。 */
  class EmiAnim {
    constructor(v, ems, victims, on) { this.v = v; this.ems = ems; this.vic = victims; this.on = on; this.t = 0; this.reset(); if (on) this.loop(); else this.drawStatic(); }
    reset() { const c = this.v.fx.getContext('2d'); c.setTransform(1, 0, 0, 1, 0, 0); c.clearRect(0, 0, this.v.fx.width, this.v.fx.height); if (!this.on) this.drawStatic(); }
    setEnabled(on) { this.on = on; this.stop(); if (on) this.loop(); else this.drawStatic(); }
    stop() { cancelAnimationFrame(this.raf); this.raf = 0; }
    loop() {
      let last = performance.now();
      const tick = (t) => { const dt = Math.min(0.05, (t - last) / 1000); last = t; this.t += dt; this.draw(); if (this.on && !document.hidden) this.raf = requestAnimationFrame(tick); else this.raf = 0; };
      this.raf = requestAnimationFrame(tick);
    }
    draw() {
      const v = this.v, c = v.fx.getContext('2d'), s = v.view.s, size = Math.max(v.board.w, v.board.h);
      c.setTransform(v.dpr, 0, 0, v.dpr, 0, 0);
      c.clearRect(0, 0, v.W, v.H);
      c.save(); v.boardPath(c); c.clip();
      const period = 2.4, maxR = size * 0.9;
      for (const e of this.ems) {
        const amp = Math.pow(10, e.level / 20);
        const centers = e.pts.length > 6 ? e.pts.filter((_, i) => i % Math.ceil(e.pts.length / 6) === 0) : e.pts;
        for (let k = 0; k < 3; k++) {
          const ph = (((this.t / period + k / 3) % 1) + 1) % 1, r = Math.max(0, ph * maxR);
          const a = amp * (1 / (1 + (r / 3) ** 2)) * 0.9 * (1 - ph);
          if (a < 0.01) continue;
          c.strokeStyle = `rgba(255,140,220,${Math.min(0.8, a)})`;
          c.lineWidth = 1.5;
          for (const q of centers) { c.beginPath(); c.arc(v.sx(q[0]), v.sy(q[1]), r * s, 0, Math.PI * 2); c.stroke(); }
        }
        c.fillStyle = 'rgba(255,190,240,0.9)';
        for (const q of e.pts) { c.beginPath(); c.arc(v.sx(q[0]), v.sy(q[1]), 2, 0, Math.PI * 2); c.fill(); }
      }
      c.restore();
      for (const vi of this.vic) {
        const pulse = 0.5 + 0.5 * Math.sin(this.t * (vi.grade === 'high' ? 8 : vi.grade === 'mid' ? 4 : 1.5));
        const col = vi.grade === 'high' ? [255, 90, 90] : vi.grade === 'mid' ? [255, 200, 90] : [140, 220, 160];
        c.strokeStyle = `rgba(${col},${0.35 + 0.6 * pulse * (vi.grade === 'low' ? 0.3 : 1)})`;
        c.lineWidth = 2;
        c.beginPath(); c.arc(v.sx(vi.x), v.sy(vi.y), 7 + 4 * pulse, 0, Math.PI * 2); c.stroke();
      }
    }
    drawStatic() { this.t = 0.8; this.draw(); }
  }

  /** 平面谐振动效：模态幅度按正弦随时间反相。 */
  class ModeAnim {
    constructor(v, phi, g, on) { this.v = v; this.phi = phi; this.g = g; this.on = on; this.t = 0; if (on) this.loop(); }
    setEnabled(on) { this.on = on; this.stop(); if (on) this.loop(); else { this.v.updateHeat(0, { ...this.v.heats[0].h, scale: 1 }); } }
    stop() { cancelAnimationFrame(this.raf); this.raf = 0; }
    reset() {}
    loop() {
      let last = performance.now();
      const tick = (t) => {
        this.t += Math.min(0.05, (t - last) / 1000); last = t;
        if (this.v.heats && this.v.heats[0]) this.v.updateHeat(0, { ...this.v.heats[0].h, scale: Math.sin(this.t * 2.2) });
        if (this.on && !document.hidden) this.raf = requestAnimationFrame(tick); else this.raf = 0;
      };
      this.raf = requestAnimationFrame(tick);
    }
  }

  LP.App = App;
})(globalThis.LP = globalThis.LP || {});
