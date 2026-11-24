'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const {loadLP,SRC} = require('./load.js');

function setup() {
  const LP = loadLP(), ctx = vm.createContext({LP,console,setTimeout,clearTimeout});
  vm.runInContext(fs.readFileSync(path.join(SRC,'app.js'),'utf8'),ctx);
  const make = (ref,w,h,x,y,metadata={}) => ({ref,w,h,role:'other',pins:[{id:'1',side:'E',pos:0.5}],
    sides:['top','bottom'],placed:{x,y,rot:0,side:'top'},...metadata});
  const core = make('U1',4,3,6,7,{placementRole:'main',physicalPads:[{n:'1',net:'P',xy:[[1.7,0.3]]}]});
  const follower = (role,dx) => ({shape:role,placementRole:'satellite',placementParent:['U1','1'],
    placementOffset:{x:dx,y:0,rot:90,side:'same'},physicalPads:[{n:'1',net:'P',xy:[[-0.4,0]]}]});
  const data = {version:1,name:'Grouped board',board:{outline:{type:'rect',w:26,h:19}},
    parts:[core, make('C1',1,0.6,9.2,7,follower('cap',3.2)), make('R1',1,0.6,2.8,7,follower('res',-3.2)),
      make('J1',2,2,17.2,7), make('TP1',1,1,22,15,{placementRole:'board_feature'})],
    nets:[{name:'P',class:'power',pins:[['U1','1'],['C1','1'],['R1','1']]}]};
  const app=LP.App;
  assert(app.load(data,{skipRestore:true}).ok);
  app.scheduleAutosave=()=>{};
  return {LP,app,model:LP.model,by:ref=>LP.model.partByRef(app.p,ref)};
}

test('native connected passives auto-land around their moved core; undo restores their actual poses', () => {
  const {LP,app,model,by}=setup(), c=by('C1'), r=by('R1');
  r.locked=true;
  const before=model.snapshot(app.p);
  assert.equal(model.isTrayPart(c),false);
  assert.equal(model.isTrayPart(by('TP1')),false);
  assert(app.placePart('U1',{x:14,y:7,rot:0,side:'top'}));
  assert(c.placed && (c.placed.x!==17.2 || c.placed.y!==7)); // Connector occupies the preferred site.
  assert(LP.rules.quickLegal(app.p,c,c.placed).ok);
  assert.equal(r.placed.x,2.8);
  const landed=model.snapshot(app.p);
  app.undo(); assert.equal(model.snapshot(app.p),before);
  app.redo(); assert.equal(model.snapshot(app.p),landed);
  app.unplace('U1'); assert.equal(c.placed,null); assert(r.placed);
  assert(app.placePart('U1',{x:14,y:7,rot:90,side:'bottom'}));
  assert.equal(c.placed.side,'bottom');
  assert.equal(c.placed.rot,0);
  assert.equal(c.placed.y,3.8);
  const exported=model.exportLayout(app.p,app.ev);
  assert.equal(exported.nets[0].pins.length,3);
  assert.equal(exported.parts.find(part=>part.ref==='C1').placed.y,3.8);
  app.resetLayout(); assert(by('TP1').placed); assert.equal(by('U1').placed,null);
});

test('a failed landing is reported and retrying the same owner pose can seat the component', () => {
  const {app,by}=setup(), c=by('C1');
  app.unplace('U1');
  c.w=40;
  const pose={x:14,y:7,rot:0,side:'top'};
  assert(app.placePart('U1',pose)); assert.equal(c.placed,null);
  assert(app.ev.unplacedSats.includes('C1'));
  assert(app.ev.issues.some(i=>i.rule==='satellite_slot' && i.refs.includes('C1')));
  c.w=1;
  assert(app.placePart('U1',pose)); assert(c.placed);
  assert(!app.ev.unplacedSats.includes('C1'));
});
