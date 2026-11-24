'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { loadLP, SRC } = require('./load.js');

test('mounted BGA exposes only the body and the native A1 corner in both views', async () => {
  const LP = loadLP();
  const context = vm.createContext({ LP });
  for (const file of ['render2d.js', 'render3d.js']) vm.runInContext(fs.readFileSync(path.join(SRC, file), 'utf8'), context);
  const item = { shape: 'soic', footprint: 'BGA-135_L15.0-W9.0-R15-C9-P1.00-BL', w: 15, h: 9, z: 1.4,
    physicalPads: [{ n: 'A1', xy: [[-7, -4]] }] };
  const index = LP.model.bgaMark(item);
  assert(index.x < 0 && index.y < 0);
  for (const footprint of ['FBGA96', 'Package_BGA:FCBGA-96', 'UFBGA_96']) assert(LP.model.bgaMark({ ...item, footprint }));
  assert.equal(LP.model.bgaMark({ ...item, footprint: 'SOIC-8' }), null);
  assert(LP.model.bgaMark({ ...item, physicalPads: [{ n: 'A1', xy: [[7, -4]] }] }).x > 0);

  const circles = [];
  const ctx = { beginPath() {}, moveTo() {}, arcTo() {}, closePath() {}, fill() {},
    arc(...args) { circles.push(args); }, createLinearGradient() { return { addColorStop() {} }; } };
  LP.render2d.drawItem(ctx, item, false, {});
  assert.equal(circles.length, 1);
  assert.deepEqual(circles[0].slice(0, 3), [index.x, index.y, index.r]);

  const library = fs.readFileSync(path.join(SRC, '..', '..', 'vendor', 'three.module.min.js'), 'base64');
  const T = await import('data:text/javascript;base64,' + library);
  const renderer = Object.assign(Object.create(LP.Renderer3D.prototype), { T, geoCache: new Map(), matCache: new Map() });
  const model = renderer.partModel(item);
  assert.equal(model.children.length, 2);
  const dot = model.getObjectByName('A1');
  assert.equal(dot.position.x, index.x);
  assert.equal(dot.position.z, -index.y);
});
