// Worker 入口：收到 {id, op, args}，调用 LP.analysis[op](...args)，回传结果。
// 主线程降级执行同一段代码时（有 document），这里什么也不做。
(function (LP) {
  'use strict';
  if (typeof document !== 'undefined' || typeof self === 'undefined' || typeof self.postMessage !== 'function') return;
  self.onmessage = (e) => {
    const { id, op, args } = e.data || {};
    try {
      const fn = LP.analysis[op];
      if (typeof fn !== 'function') throw new Error('未知操作 ' + op);
      const t0 = Date.now();
      const result = fn(...(args || []));
      self.postMessage({ id, result, ms: Date.now() - t0 });
    } catch (err) {
      self.postMessage({ id, error: String((err && err.stack) || err) });
    }
  };
})(globalThis.LP = globalThis.LP || {});
