---
project: samples
handle: sorting-visualizer
title: Sorting Algorithm Visualizer
type: widget
tags: [algorithms, visualization, example, canvas]
---
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Sorting Visualizer</title>
<style>
  *, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }
  :root {
    --bg: #0f1117;
    --surface: #1a1d27;
    --border: #2a2d3a;
    --text: #e2e4ea;
    --muted: #6b7084;
    --accent: #6366f1;
    --accent-dim: rgba(99, 102, 241, 0.15);
    --compare: #f59e0b;
    --swap: #ef4444;
    --sorted: #10b981;
    --bar: #4b5072;
  }
  body { font-family: system-ui, -apple-system, sans-serif; background: var(--bg); color: var(--text); min-height: 100vh; display: flex; align-items: center; justify-content: center; }
  .app { width: 100%; max-width: 640px; padding: 24px; }
  h1 { font-size: 1.1rem; font-weight: 600; margin-bottom: 16px; }
  h1 span { color: var(--accent); }
  .controls { display: flex; gap: 8px; margin-bottom: 16px; flex-wrap: wrap; align-items: center; }
  select, button {
    font-family: inherit; font-size: 0.8rem; padding: 6px 14px;
    background: var(--surface); border: 1px solid var(--border); border-radius: 6px;
    color: var(--text); cursor: pointer; transition: border-color 0.2s;
  }
  select:hover, button:hover { border-color: var(--accent); }
  button.primary { background: var(--accent-dim); border-color: rgba(99,102,241,0.4); color: var(--accent); }
  .info { font-size: 0.75rem; color: var(--muted); margin-left: auto; font-variant-numeric: tabular-nums; }
  .canvas-wrap { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 16px; }
  canvas { display: block; width: 100%; height: 220px; }
  .legend { display: flex; gap: 14px; margin-top: 10px; flex-wrap: wrap; }
  .legend-item { display: flex; align-items: center; gap: 5px; font-size: 0.7rem; color: var(--muted); }
  .legend-swatch { width: 10px; height: 10px; border-radius: 3px; }
</style>
</head>
<body>
<div class="app">
  <h1>Sorting <span>Visualizer</span></h1>
  <div class="controls">
    <select id="algo">
      <option value="bubble">Bubble Sort</option>
      <option value="selection">Selection Sort</option>
      <option value="insertion">Insertion Sort</option>
    </select>
    <button class="primary" id="btnSort">Sort</button>
    <button id="btnShuffle">Shuffle</button>
    <span class="info" id="info">—</span>
  </div>
  <div class="canvas-wrap">
    <canvas id="c"></canvas>
    <div class="legend">
      <div class="legend-item"><div class="legend-swatch" style="background:var(--bar)"></div>Unsorted</div>
      <div class="legend-item"><div class="legend-swatch" style="background:var(--compare)"></div>Comparing</div>
      <div class="legend-item"><div class="legend-swatch" style="background:var(--swap)"></div>Swapping</div>
      <div class="legend-item"><div class="legend-swatch" style="background:var(--sorted)"></div>Sorted</div>
    </div>
  </div>
</div>
<script>
const canvas = document.getElementById('c');
const ctx = canvas.getContext('2d');
const N = 40;
let arr = [], colors = [], running = false, comparisons = 0, swaps = 0;

function resize() {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = canvas.clientWidth * dpr;
  canvas.height = canvas.clientHeight * dpr;
  ctx.scale(dpr, dpr);
}
window.addEventListener('resize', () => { resize(); draw(); });

function shuffle() {
  arr = Array.from({length: N}, (_, i) => i + 1);
  for (let i = N - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; }
  colors = new Array(N).fill('default');
  comparisons = 0; swaps = 0;
  updateInfo();
  draw();
}

function draw() {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  ctx.clearRect(0, 0, w, h);
  const barW = (w - (N - 1) * 2) / N;
  const maxH = h - 8;
  for (let i = 0; i < N; i++) {
    const bh = (arr[i] / N) * maxH;
    const x = i * (barW + 2);
    const y = h - bh;
    const c = colors[i];
    ctx.fillStyle = c === 'compare' ? '#f59e0b' : c === 'swap' ? '#ef4444' : c === 'sorted' ? '#10b981' : '#4b5072';
    ctx.fillRect(x, y, barW, bh);
  }
}

function updateInfo() {
  document.getElementById('info').textContent = `${comparisons} comparisons · ${swaps} swaps`;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function bubbleSort() {
  for (let i = 0; i < N - 1; i++) {
    for (let j = 0; j < N - 1 - i; j++) {
      colors[j] = 'compare'; colors[j+1] = 'compare'; comparisons++; updateInfo(); draw(); await sleep(20);
      if (arr[j] > arr[j+1]) {
        colors[j] = 'swap'; colors[j+1] = 'swap'; draw(); await sleep(20);
        [arr[j], arr[j+1]] = [arr[j+1], arr[j]]; swaps++; updateInfo();
      }
      colors[j] = 'default'; colors[j+1] = 'default';
    }
    colors[N - 1 - i] = 'sorted';
  }
  colors[0] = 'sorted';
}

async function selectionSort() {
  for (let i = 0; i < N - 1; i++) {
    let min = i;
    for (let j = i + 1; j < N; j++) {
      colors[j] = 'compare'; colors[min] = 'compare'; comparisons++; updateInfo(); draw(); await sleep(15);
      if (arr[j] < arr[min]) { colors[min] = 'default'; min = j; }
      else colors[j] = 'default';
    }
    if (min !== i) {
      colors[i] = 'swap'; colors[min] = 'swap'; draw(); await sleep(30);
      [arr[i], arr[min]] = [arr[min], arr[i]]; swaps++; updateInfo();
    }
    colors.fill('default'); for (let k = 0; k <= i; k++) colors[k] = 'sorted';
    draw();
  }
  colors[N-1] = 'sorted';
}

async function insertionSort() {
  colors[0] = 'sorted'; draw();
  for (let i = 1; i < N; i++) {
    let key = arr[i], j = i - 1;
    colors[i] = 'compare'; draw(); await sleep(20);
    while (j >= 0 && arr[j] > key) {
      comparisons++; updateInfo();
      colors[j] = 'swap'; draw(); await sleep(15);
      arr[j+1] = arr[j]; swaps++; updateInfo();
      colors[j] = 'sorted'; j--;
    }
    if (j >= 0) { comparisons++; updateInfo(); }
    arr[j+1] = key;
    for (let k = 0; k <= i; k++) colors[k] = 'sorted';
    draw();
  }
}

document.getElementById('btnSort').onclick = async () => {
  if (running) return;
  running = true;
  comparisons = 0; swaps = 0; colors.fill('default');
  const algo = document.getElementById('algo').value;
  if (algo === 'bubble') await bubbleSort();
  else if (algo === 'selection') await selectionSort();
  else await insertionSort();
  colors.fill('sorted'); draw();
  running = false;
};

document.getElementById('btnShuffle').onclick = () => { if (!running) shuffle(); };
window.addEventListener('load', () => { resize(); shuffle(); });
</script>
</body>
</html>
