'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadLP } = require('./load');

test('placement observes board margins, face-specific regions and symmetric projected separation', () => {
  const { placementLimits } = loadLP();
  const project = {board:{outline:{type:'rect',w:30,h:20}},placementLimits:{
    edgeMm:.6,edgeExempt:['J1'],gapMm:.22,
    regions:[{box:[10,4,15,10],gap:.4,side:'bottom',except:['J1']}],
    separation:[{a:['U1'],b:['L1'],gap:4,name:'analogue clearance'}]
  }};
  const box = (x,y) => ({x0:x,y0:y,x1:x+1,y1:y+1});
  const item = (ref,x,y,side) => ({item:{ref},rect:box(x,y),side});
  const check = (ref,x,y,side,others=[]) => placementLimits.violation(project,{ref},{side},box(x,y),others)?.reason;
  assert.equal(check('R1',0,2,'top'),'outside');
  assert.equal(check('J1',0,2,'top'),undefined);
  assert.equal(check('R1',9,5,'bottom'),'keepout');
  assert.equal(check('R1',9,5,'top'),undefined);
  assert.equal(check('J1',10,5,'bottom'),undefined);
  assert.equal(check('R1',5,6,'top',[item('R2',6.2,6,'top')]),'overlap');
  assert.equal(check('R1',5,6,'top',[item('R2',6.22,6,'top')]),undefined);
  assert.equal(check('R1',5,6,'top',[item('R2',5,6,'bottom')]),undefined);
  assert.equal(check('U1',4,2,'bottom',[item('L1',8,2,'top')]),'keepout');
  assert.equal(check('L1',8,2,'top',[item('U1',4,2,'bottom')]),'keepout');
  assert.equal(check('L1',9,2,'top',[item('U1',4,2,'bottom')]),undefined);
});
