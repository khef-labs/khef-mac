---
project: samples
handle: css-wave-animation
title: CSS Wave Animation
type: animation
tags: [css, animation, example, canvas]
---
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>CSS Wave</title>
<style>
  *, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: system-ui, -apple-system, sans-serif;
    background: #0a0b10;
    color: #e2e4ea;
    min-height: 100vh;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 32px;
    overflow: hidden;
  }
  h1 { font-size: 1rem; font-weight: 500; letter-spacing: 0.08em; text-transform: uppercase; color: #6b7084; }

  .wave-container {
    display: flex;
    align-items: flex-end;
    gap: 4px;
    height: 120px;
    padding: 0 20px;
  }
  .bar {
    width: 6px;
    border-radius: 3px;
    animation: wave 1.4s ease-in-out infinite;
  }
  @keyframes wave {
    0%, 100% { height: 16px; opacity: 0.4; }
    50% { height: 100px; opacity: 1; }
  }

  .wave-container.sine .bar { background: linear-gradient(to top, #6366f1, #a78bfa); }
  .wave-container.ocean .bar { background: linear-gradient(to top, #06b6d4, #67e8f9); }
  .wave-container.fire .bar { background: linear-gradient(to top, #ef4444, #fbbf24); }

  .controls { display: flex; gap: 8px; }
  .controls button {
    font-family: inherit; font-size: 0.75rem; font-weight: 500; padding: 8px 18px;
    background: #1a1d27; border: 1px solid #2a2d3a; border-radius: 6px;
    color: #6b7084; cursor: pointer; transition: all 0.2s; letter-spacing: 0.04em;
  }
  .controls button:hover { border-color: #6366f1; color: #e2e4ea; }
  .controls button.active { background: rgba(99,102,241,0.15); border-color: rgba(99,102,241,0.5); color: #a78bfa; }

  .speed-row { display: flex; align-items: center; gap: 10px; }
  .speed-row label { font-size: 0.7rem; color: #6b7084; text-transform: uppercase; letter-spacing: 0.08em; }
  .speed-row input[type="range"] {
    -webkit-appearance: none; width: 120px; height: 4px; background: #2a2d3a; border-radius: 2px;
  }
  .speed-row input[type="range"]::-webkit-slider-thumb {
    -webkit-appearance: none; width: 14px; height: 14px; border-radius: 50%;
    background: #6366f1; border: 2px solid #0a0b10; cursor: pointer;
  }
</style>
</head>
<body>
<h1>Wave Animation</h1>
<div class="wave-container sine" id="wave"></div>
<div class="controls" id="themeButtons">
  <button class="active" data-theme="sine">Sine</button>
  <button data-theme="ocean">Ocean</button>
  <button data-theme="fire">Fire</button>
</div>
<div class="speed-row">
  <label>Speed</label>
  <input type="range" id="speed" min="0.4" max="3" step="0.1" value="1.4">
</div>
<script>
const wave = document.getElementById('wave');
const COUNT = 32;

// Build bars with staggered delay
for (let i = 0; i < COUNT; i++) {
  const bar = document.createElement('div');
  bar.className = 'bar';
  bar.style.animationDelay = `${(i * 0.06).toFixed(2)}s`;
  wave.appendChild(bar);
}

// Theme switching
document.getElementById('themeButtons').addEventListener('click', e => {
  const btn = e.target.closest('button');
  if (!btn) return;
  const theme = btn.dataset.theme;
  wave.className = 'wave-container ' + theme;
  document.querySelectorAll('.controls button').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
});

// Speed control
document.getElementById('speed').addEventListener('input', e => {
  const dur = e.target.value + 's';
  wave.querySelectorAll('.bar').forEach(bar => {
    bar.style.animationDuration = dur;
  });
});
</script>
</body>
</html>
