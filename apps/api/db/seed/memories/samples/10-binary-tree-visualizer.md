---
project: samples
handle: binary-tree-visualizer
title: Validate BST Visualizer
type: widget
tags: [algorithms, visualization, binary-tree, bst, canvas, example]
---
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Validate BST</title>
<style>
*,*::before,*::after{margin:0;padding:0;box-sizing:border-box}
:root{--bg:#0a0b0f;--surface:#12141a;--card:#181b23;--elevated:#1e2130;--border:#2a2d3a;--text:#e8eaf0;--dim:#5a5e72;--muted:#8b8fa4;--cyan:#00e5cc;--amber:#ffb347;--violet:#a78bfa;--rose:#ff6b8a;--green:#34d399;--red:#f87171}
body{font-family:system-ui,-apple-system,sans-serif;background:var(--bg);color:var(--text);min-height:100vh;padding:20px}
.app{max-width:900px;margin:0 auto}
h1{font-size:1.15rem;font-weight:600;margin-bottom:4px}
h1 span{color:var(--cyan)}
.subtitle{font-size:.75rem;color:var(--muted);margin-bottom:16px;font-family:monospace;line-height:1.5}
.controls{display:flex;gap:8px;margin-bottom:14px;flex-wrap:wrap;align-items:center}
select,button{font-family:monospace;font-size:.8rem;padding:6px 14px;background:var(--card);border:1px solid var(--border);border-radius:6px;color:var(--text);cursor:pointer}
button:hover{border-color:var(--cyan)}
button.primary{background:rgba(0,229,204,.1);border-color:rgba(0,229,204,.3);color:var(--cyan)}
.info{font-size:.72rem;color:var(--dim);margin-left:auto;font-family:monospace}
.sel-label{font-family:monospace;font-size:.7rem;color:var(--dim)}
.sel-group{display:flex;align-items:center;gap:4px}
.tree-wrap{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:16px;margin-bottom:12px}
svg{display:block;width:100%;height:260px}
.edge{stroke:var(--border);stroke-width:2;fill:none}
.edge.visited{stroke:var(--cyan);opacity:.4}
.node-c{fill:var(--elevated);stroke:var(--border);stroke-width:2.5;transition:all .3s}
.node-c.current{stroke:var(--cyan);fill:rgba(0,229,204,.1);filter:drop-shadow(0 0 8px rgba(0,229,204,.4))}
.node-c.valid{stroke:var(--green);fill:rgba(52,211,153,.1)}
.node-c.invalid{stroke:var(--red);fill:rgba(248,113,113,.12);filter:drop-shadow(0 0 10px rgba(248,113,113,.4))}
.node-c.unchecked{opacity:.4}
.node-t{fill:var(--text);font-family:monospace;font-size:14px;font-weight:600;text-anchor:middle;dominant-baseline:central;pointer-events:none}
.node-c.current+.node-t{fill:var(--cyan)}
.node-c.valid+.node-t{fill:var(--green)}
.node-c.invalid+.node-t{fill:var(--red)}
.range-label{font-family:monospace;font-size:9px;text-anchor:middle;dominant-baseline:hanging;transition:opacity .3s}
.range-label.active{opacity:1}
.range-label.inactive{opacity:.3}
.range-min{fill:var(--violet)}
.range-max{fill:var(--amber)}
.range-paren{fill:var(--dim)}
.panels{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px}
.panel{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:12px}
.panel-label{font-family:monospace;font-size:.65rem;color:var(--dim);text-transform:uppercase;letter-spacing:.08em;margin-bottom:8px}
.ds-item{font-family:monospace;font-size:.76rem;padding:5px 8px;border-radius:4px;background:var(--elevated);border:1px solid var(--border);border-left:3px solid var(--violet);color:var(--muted);margin-bottom:3px;display:flex;gap:6px;align-items:center;flex-wrap:wrap}
.ds-item .v{color:var(--cyan);font-weight:600;min-width:18px;text-align:center}
.ds-item .range{font-size:.68rem;margin-left:auto;color:var(--dim)}
.ds-item .range .lo{color:var(--violet)}
.ds-item .range .hi{color:var(--amber)}
.ds-item.pass{border-left-color:var(--green)}.ds-item.pass .v{color:var(--green)}
.ds-item.fail{border-left-color:var(--red)}.ds-item.fail .v{color:var(--red)}
.ds-empty{font-family:monospace;font-size:.72rem;color:var(--dim);font-style:italic}
.verdict-box{padding:10px 14px;border-radius:8px;font-family:monospace;font-size:.85rem;font-weight:600;text-align:center;margin-bottom:12px;display:none}
.verdict-box.show{display:block}
.verdict-box.pass{background:rgba(52,211,153,.1);border:1px solid rgba(52,211,153,.3);color:var(--green)}
.verdict-box.fail{background:rgba(248,113,113,.08);border:1px solid rgba(248,113,113,.25);color:var(--red)}
.step-box{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:12px}
.step-text{font-family:monospace;font-size:.8rem;color:var(--muted);line-height:1.6;min-height:40px}
.step-text code{color:var(--cyan);background:rgba(0,229,204,.1);padding:1px 4px;border-radius:3px}
.step-text .hl{color:var(--amber);font-weight:600}
.step-text .good{color:var(--green);font-weight:600}
.step-text .bad{color:var(--red);font-weight:600}
.step-text .lo{color:var(--violet);font-weight:500}
.step-text .hi{color:var(--amber);font-weight:500}
.legend{display:flex;gap:10px;margin-top:8px;flex-wrap:wrap}
.legend-item{display:flex;align-items:center;gap:4px;font-size:.65rem;color:var(--dim);font-family:monospace}
.legend-sw{width:8px;height:8px;border-radius:50%;border:2px solid}
</style>
</head>
<body>
<div class="app">
<h1>Validate <span>BST</span></h1>
<p class="subtitle">Range propagation: each node must be within (min, max). Going left tightens max, going right tightens min. The classic trap is checking only local neighbors -- a deep node can violate the root's bound.</p>
<div class="controls">
<div class="sel-group"><span class="sel-label">Tree:</span>
<select id="selTree">
<option value="valid">Valid BST [5,3,7,1,4]</option>
<option value="trap" selected>Classic trap [5,1,6,null,null,3,7]</option>
<option value="subtle">Subtle violation [10,5,15,null,null,6,20]</option>
<option value="equal">Equal values [2,2,3]</option>
<option value="skewed">Left-skewed valid [3,2,null,1]</option>
</select></div>
<button class="primary" id="btnPlay">▶ Play</button>
<button id="btnStep">Step →</button>
<button id="btnReset">Reset</button>
<span class="info" id="info">Step 0 / 0</span>
</div>
<div class="verdict-box" id="verdict"></div>
<div class="tree-wrap">
<svg id="svg" viewBox="0 0 520 250"></svg>
<div class="legend">
<div class="legend-item"><div class="legend-sw" style="border-color:var(--cyan);background:rgba(0,229,204,.12)"></div>Checking</div>
<div class="legend-item"><div class="legend-sw" style="border-color:var(--green);background:rgba(52,211,153,.1)"></div>Valid</div>
<div class="legend-item"><div class="legend-sw" style="border-color:var(--red);background:rgba(248,113,113,.1)"></div>Invalid!</div>
</div>
</div>
<div class="panels">
<div class="panel"><div class="panel-label">Call Stack (with bounds)</div><div id="ds"></div></div>
<div class="panel"><div class="panel-label">Validation Log</div><div id="log"></div></div>
</div>
<div class="step-box"><div class="panel-label">What's happening</div><div class="step-text" id="desc">Select a tree and press Play or Step.</div></div>
</div>
<script>
const TREES={
valid:{
nodes:{5:{l:3,r:7},3:{l:1,r:4},7:{l:null,r:null},1:{l:null,r:null},4:{l:null,r:null}},
pos:{5:{x:260,y:35},3:{x:140,y:110},7:{x:380,y:110},1:{x:75,y:190},4:{x:205,y:190}},
edges:[[5,3],[5,7],[3,1],[3,4]],all:[5,3,7,1,4],root:5,isValid:true,
label:'Valid BST -- every node within its bounds'},
trap:{
nodes:{5:{l:1,r:6},1:{l:null,r:null},6:{l:3,r:7},3:{l:null,r:null},7:{l:null,r:null}},
pos:{5:{x:260,y:35},1:{x:140,y:110},6:{x:380,y:110},3:{x:315,y:190},7:{x:445,y:190}},
edges:[[5,1],[5,6],[6,3],[6,7]],all:[5,1,6,3,7],root:5,isValid:false,
label:'Classic trap -- node 3 in right subtree is less than root 5'},
subtle:{
nodes:{10:{l:5,r:15},5:{l:null,r:null},15:{l:6,r:20},6:{l:null,r:null},20:{l:null,r:null}},
pos:{10:{x:260,y:35},5:{x:140,y:110},15:{x:380,y:110},6:{x:315,y:190},20:{x:445,y:190}},
edges:[[10,5],[10,15],[15,6],[15,20]],all:[10,5,15,6,20],root:10,isValid:false,
label:'Subtle violation -- 6 is valid child of 15 but violates root bound (6 < 10)'},
equal:{
nodes:{2:{l:2,r:3},'2b':{l:null,r:null},3:{l:null,r:null}},
pos:{2:{x:260,y:50},'2b':{x:150,y:140},3:{x:370,y:140}},
edges:[[2,'2b'],[2,3]],all:[2,'2b',3],root:2,isValid:false,
vals:{2:2,'2b':2,3:3},
label:'Equal values -- BST requires strictly less, so left child 2 = parent 2 is invalid'},
skewed:{
nodes:{3:{l:2,r:null},2:{l:1,r:null},1:{l:null,r:null}},
pos:{3:{x:300,y:35},2:{x:200,y:120},1:{x:100,y:200}},
edges:[[3,2],[2,1]],all:[3,2,1],root:3,isValid:true,
label:'Left-skewed -- valid, bounds narrow correctly going left'}
};

function getVal(tree,n){if(tree.vals)return tree.vals[n];return typeof n==='number'?n:parseInt(n)}
function fmt(v){if(v===Infinity)return '\u221E';if(v===-Infinity)return '-\u221E';return v}

let curTree=null;let steps=[];let idx=-1;let playing=false;let timer=null;

function buildSvg(){
const t=curTree;const s=document.getElementById('svg');s.innerHTML='';
t.edges.forEach(([a,b])=>{const l=document.createElementNS('http://www.w3.org/2000/svg','line');l.setAttribute('x1',t.pos[a].x);l.setAttribute('y1',t.pos[a].y);l.setAttribute('x2',t.pos[b].x);l.setAttribute('y2',t.pos[b].y);l.classList.add('edge');l.id='e-'+a+'-'+b;s.appendChild(l)});
t.all.forEach(n=>{const p=t.pos[n];const g=document.createElementNS('http://www.w3.org/2000/svg','g');
const c=document.createElementNS('http://www.w3.org/2000/svg','circle');c.setAttribute('cx',p.x);c.setAttribute('cy',p.y);c.setAttribute('r',20);c.classList.add('node-c');c.id='c-'+n;
const txt=document.createElementNS('http://www.w3.org/2000/svg','text');txt.setAttribute('x',p.x);txt.setAttribute('y',p.y);txt.classList.add('node-t');txt.textContent=getVal(t,n);
const rl=document.createElementNS('http://www.w3.org/2000/svg','text');rl.setAttribute('x',p.x);rl.setAttribute('y',p.y+30);rl.classList.add('range-label','inactive');rl.id='rl-'+n;
g.appendChild(c);g.appendChild(txt);g.appendChild(rl);s.appendChild(g)})}

function genSteps(){
const t=curTree;const steps=[];const cs=[];const checked={};const logEntries=[];

function validate(nodeKey,min,max){
if(nodeKey===null){return true}
const v=getVal(t,nodeKey);
cs.push({node:nodeKey,val:v,min,max});
steps.push({cur:nodeKey,cs:cs.map(x=>({...x})),checked:{...checked},log:[...logEntries],desc:'Enter <code>validate('+v+', '+fmt(min)+', '+fmt(max)+')</code> -- check if <span class="hl">'+v+'</span> is in (<span class="lo">'+fmt(min)+'</span>, <span class="hi">'+fmt(max)+'</span>)',ranges:{...Object.fromEntries(cs.map(x=>[x.node,{min:x.min,max:x.max}]))}});

if(v<=min||v>=max){
checked[nodeKey]='fail';
logEntries.push({node:nodeKey,val:v,min,max,pass:false});
steps.push({cur:nodeKey,cs:cs.map(x=>({...x})),checked:{...checked},log:[...logEntries],desc:'<span class="bad">INVALID!</span> '+v+' is NOT in (<span class="lo">'+fmt(min)+'</span>, <span class="hi">'+fmt(max)+'</span>)'+(v<=min?' -- '+v+' \u2264 min '+fmt(min):' -- '+v+' \u2265 max '+fmt(max)),ranges:{...Object.fromEntries(cs.map(x=>[x.node,{min:x.min,max:x.max}]))}});
cs.pop();return false}

checked[nodeKey]='pass';
logEntries.push({node:nodeKey,val:v,min,max,pass:true});
steps.push({cur:nodeKey,cs:cs.map(x=>({...x})),checked:{...checked},log:[...logEntries],desc:'<span class="good">Valid!</span> '+v+' is in (<span class="lo">'+fmt(min)+'</span>, <span class="hi">'+fmt(max)+'</span>)',ranges:{...Object.fromEntries(cs.map(x=>[x.node,{min:x.min,max:x.max}]))}});

const leftNode=t.nodes[nodeKey]?.l??null;
if(leftNode!==null){
steps.push({cur:nodeKey,cs:cs.map(x=>({...x})),checked:{...checked},log:[...logEntries],desc:'Go left from '+v+': tighten max to <span class="hi">'+v+'</span> -- validate('+getVal(t,leftNode)+', '+fmt(min)+', '+v+')',ranges:{...Object.fromEntries(cs.map(x=>[x.node,{min:x.min,max:x.max}]))}});
}
if(!validate(leftNode,min,v)){cs.pop();return false}

const rightNode=t.nodes[nodeKey]?.r??null;
if(rightNode!==null){
steps.push({cur:nodeKey,cs:cs.map(x=>({...x})),checked:{...checked},log:[...logEntries],desc:'Go right from '+v+': tighten min to <span class="lo">'+v+'</span> -- validate('+getVal(t,rightNode)+', '+v+', '+fmt(max)+')',ranges:{...Object.fromEntries(cs.map(x=>[x.node,{min:x.min,max:x.max}]))}});
}
if(!validate(rightNode,v,max)){cs.pop();return false}

steps.push({cur:nodeKey,cs:cs.map(x=>({...x})),checked:{...checked},log:[...logEntries],desc:'Both subtrees of '+v+' valid -- return true, pop frame',ranges:{...Object.fromEntries(cs.map(x=>[x.node,{min:x.min,max:x.max}]))}});
cs.pop();return true}

const result=validate(t.root,-Infinity,Infinity);
steps.push({cur:null,cs:[],checked:{...checked},log:[...logEntries],desc:result?'<span class="good">Tree is a valid BST!</span>':'<span class="bad">Tree is NOT a valid BST</span>',ranges:{},result});
return steps}

function render(){
const s=idx>=0&&idx<steps.length?steps[idx]:null;
const t=curTree;
t.all.forEach(n=>{
const c=document.getElementById('c-'+n);
c.classList.remove('current','valid','invalid','unchecked');
const rl=document.getElementById('rl-'+n);
rl.classList.remove('active');rl.classList.add('inactive');rl.innerHTML='';
if(s){
if(s.checked[n]==='pass')c.classList.add('valid');
else if(s.checked[n]==='fail')c.classList.add('invalid');
else if(!s.cs.some(f=>f.node===n)&&s.cur!==n)c.classList.add('unchecked');
if(s.cur===n){c.classList.remove('valid','unchecked');if(s.checked[n]==='fail')c.classList.add('invalid');else c.classList.add('current')}
if(s.ranges&&s.ranges[n]){rl.classList.remove('inactive');rl.classList.add('active');
const r=s.ranges[n];
rl.innerHTML='<tspan class="range-paren">(</tspan><tspan class="range-min">'+fmt(r.min)+'</tspan><tspan class="range-paren">,</tspan><tspan class="range-max">'+fmt(r.max)+'</tspan><tspan class="range-paren">)</tspan>'}}});
t.edges.forEach(([a,b])=>{const e=document.getElementById('e-'+a+'-'+b);e.classList.remove('visited');
if(s&&(s.checked[a]||s.cur===a)&&(s.checked[b]||s.cur===b))e.classList.add('visited')});

var dEl=document.getElementById('ds');dEl.innerHTML='';
if(!s||s.cs.length===0)dEl.innerHTML='<div class="ds-empty">Empty</div>';
else{[...s.cs].reverse().forEach(f=>{
var cls=s.checked[f.node]==='pass'?'pass':s.checked[f.node]==='fail'?'fail':'';
var div=document.createElement('div');div.className='ds-item '+cls;
div.innerHTML='<span class="v">'+f.val+'</span>validate('+f.val+')<span class="range">(<span class="lo">'+fmt(f.min)+'</span>, <span class="hi">'+fmt(f.max)+'</span>)</span>';
dEl.appendChild(div)})}

var lEl=document.getElementById('log');lEl.innerHTML='';
if(!s||s.log.length===0)lEl.innerHTML='<div class="ds-empty">No checks yet</div>';
else{s.log.forEach(e=>{
var div=document.createElement('div');div.className='ds-item '+(e.pass?'pass':'fail');
div.innerHTML='<span class="v">'+(e.pass?'\u2713':'\u2717')+'</span>'+e.val+' in ('+fmt(e.min)+', '+fmt(e.max)+')';
lEl.appendChild(div)})}

var vEl=document.getElementById('verdict');
if(s&&s.result!==undefined){vEl.classList.add('show');vEl.classList.remove('pass','fail');
vEl.classList.add(s.result?'pass':'fail');vEl.textContent=s.result?'\u2713 Valid BST':'\u2717 Not a valid BST -- '+t.label}
else{vEl.classList.remove('show')}

document.getElementById('desc').innerHTML=s?s.desc:'Select a tree and press Play or Step.';
document.getElementById('info').textContent='Step '+(idx+1)+' / '+steps.length}

function stop(){playing=false;if(timer){clearTimeout(timer);timer=null}document.getElementById('btnPlay').textContent='\u25B6 Play'}
function load(){stop();var k=document.getElementById('selTree').value;curTree=TREES[k];buildSvg();steps=genSteps();idx=-1;document.getElementById('verdict').classList.remove('show');render()}
function playStep(){if(!playing)return;if(idx<steps.length-1){idx++;render();timer=setTimeout(playStep,800)}else stop()}
document.getElementById('btnPlay').onclick=function(){if(playing){stop()}else{playing=true;document.getElementById('btnPlay').textContent='\u23F8 Pause';playStep()}};
document.getElementById('btnStep').onclick=function(){stop();if(idx<steps.length-1){idx++;render()}};
document.getElementById('btnReset').onclick=function(){stop();idx=-1;document.getElementById('verdict').classList.remove('show');render()};
document.getElementById('selTree').onchange=load;
load();
</script>
</body>
</html>
