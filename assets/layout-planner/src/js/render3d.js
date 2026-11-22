/* render3d.js — 3D 视图（M6 实现）。 */
(function (LP) {
  'use strict';
  LP.three = {
    supported() { try { const c = document.createElement('canvas'); return !!(c.getContext('webgl2') || c.getContext('webgl')); } catch (e) { return false; } },
    create() { return Promise.reject(new Error('3D 视图尚未实现')); },
  };
})(globalThis.LP = globalThis.LP || {});
