// 计算客户端：优先在 Blob Worker 里计算；创建失败时在主线程执行同一段代码（分批让出，界面不冻结）。
(function (LP) {
  'use strict';
  class Client {
    constructor() {
      this.src = (document.getElementById('worker-src') || {}).textContent || '';
      this.seq = 0; this.pending = new Map(); this.mode = 'worker';
      try {
        const url = URL.createObjectURL(new Blob([this.src], { type: 'text/javascript' }));
        this.w = new Worker(url);
        this.w.onmessage = (e) => this.done(e.data);
        this.w.onerror = (e) => { e.preventDefault(); this.fallback('Worker 出错：' + (e.message || '')); };
      } catch (err) {
        this.fallback(String(err));
      }
    }
    fallback(why) {
      if (this.mode === 'main') return;
      this.mode = 'main'; this.why = why;
      if (this.w) { try { this.w.terminate(); } catch (e) { /* 忽略 */ } this.w = null; }
      if (!LP.analysis) (0, eval)(this.src);
      // 把已经发出的请求改在主线程执行
      const list = [...this.pending.values()];
      this.pending.clear();
      for (const p of list) this.runLocal(p);
    }
    done(msg) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error)); else p.resolve(msg.result);
    }
    runLocal(p) {
      setTimeout(() => {
        try { p.resolve(LP.analysis[p.op](...p.args)); } catch (err) { p.reject(err); }
      }, 0);
    }
    call(op, ...args) {
      return new Promise((resolve, reject) => {
        const id = ++this.seq, p = { id, op, args, resolve, reject };
        if (this.mode === 'worker' && this.w) { this.pending.set(id, p); this.w.postMessage({ id, op, args }); }
        else this.runLocal(p);
      });
    }
  }
  LP.Client = Client;
})(globalThis.LP = globalThis.LP || {});
