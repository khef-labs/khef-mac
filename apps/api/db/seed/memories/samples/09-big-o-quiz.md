---
project: samples
handle: big-o-quiz
title: Big-O Complexity Quiz
type: quiz
tags: [algorithms, big-o, quiz, example, canvas]
---
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Big-O Quiz</title>
<style>
  *, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }
  :root {
    --bg: #0f1117; --surface: #1a1d27; --border: #2a2d3a;
    --text: #e2e4ea; --muted: #6b7084; --accent: #6366f1;
    --correct: #10b981; --wrong: #ef4444;
  }
  body { font-family: system-ui, -apple-system, sans-serif; background: var(--bg); color: var(--text); min-height: 100vh; display: flex; align-items: center; justify-content: center; }
  .app { width: 100%; max-width: 540px; padding: 24px; }
  .header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 20px; }
  h1 { font-size: 1.1rem; font-weight: 600; }
  h1 span { color: var(--accent); }
  .score { font-size: 0.8rem; color: var(--muted); font-variant-numeric: tabular-nums; }
  .progress { height: 4px; background: var(--surface); border-radius: 2px; margin-bottom: 20px; overflow: hidden; }
  .progress-fill { height: 100%; background: var(--accent); border-radius: 2px; transition: width 0.3s; }
  .card { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 20px; }
  .question-num { font-size: 0.7rem; color: var(--muted); text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: 8px; }
  .code-block { font-family: 'SF Mono', 'Fira Code', monospace; font-size: 0.82rem; line-height: 1.6; background: var(--bg); border: 1px solid var(--border); border-radius: 6px; padding: 12px 16px; margin-bottom: 16px; white-space: pre; overflow-x: auto; color: #a5b4fc; }
  .prompt { font-size: 0.9rem; margin-bottom: 14px; font-weight: 500; }
  .options { display: flex; flex-direction: column; gap: 8px; }
  .option {
    padding: 10px 14px; background: var(--bg); border: 1px solid var(--border); border-radius: 8px;
    font-size: 0.85rem; cursor: pointer; transition: all 0.2s; font-family: 'SF Mono', 'Fira Code', monospace;
  }
  .option:hover { border-color: var(--accent); }
  .option.correct { border-color: var(--correct); background: rgba(16,185,129,0.1); color: var(--correct); }
  .option.wrong { border-color: var(--wrong); background: rgba(239,68,68,0.1); color: var(--wrong); }
  .option.disabled { pointer-events: none; opacity: 0.5; }
  .option.correct.disabled { opacity: 1; }
  .feedback { margin-top: 14px; font-size: 0.82rem; line-height: 1.5; padding: 10px 14px; border-radius: 8px; display: none; }
  .feedback.show { display: block; }
  .feedback.correct-fb { background: rgba(16,185,129,0.1); border: 1px solid rgba(16,185,129,0.3); color: var(--correct); }
  .feedback.wrong-fb { background: rgba(239,68,68,0.1); border: 1px solid rgba(239,68,68,0.3); color: var(--wrong); }
  .next-btn {
    display: none; margin-top: 14px; width: 100%; padding: 10px; font-family: inherit; font-size: 0.85rem;
    background: rgba(99,102,241,0.15); border: 1px solid rgba(99,102,241,0.4); border-radius: 8px;
    color: var(--accent); cursor: pointer; transition: all 0.2s; font-weight: 500;
  }
  .next-btn:hover { background: rgba(99,102,241,0.25); }
  .next-btn.show { display: block; }
  .results { text-align: center; padding: 32px 0; }
  .results h2 { font-size: 1.3rem; margin-bottom: 8px; }
  .results .grade { font-size: 2.5rem; font-weight: 700; color: var(--accent); margin-bottom: 12px; }
  .results p { color: var(--muted); font-size: 0.85rem; margin-bottom: 16px; }
  .restart-btn { font-family: inherit; font-size: 0.85rem; padding: 10px 24px; background: var(--accent); border: none; border-radius: 8px; color: white; cursor: pointer; font-weight: 500; }
  .restart-btn:hover { opacity: 0.9; }
</style>
</head>
<body>
<div class="app">
  <div class="header">
    <h1>Big-O <span>Quiz</span></h1>
    <div class="score" id="score">0 / 0</div>
  </div>
  <div class="progress"><div class="progress-fill" id="progress"></div></div>
  <div class="card" id="card"></div>
</div>
<script>
const QUESTIONS = [
  {
    code: `for (let i = 0; i < n; i++) {\n  for (let j = 0; j < n; j++) {\n    sum += arr[i][j];\n  }\n}`,
    prompt: 'What is the time complexity?',
    options: ['O(n)', 'O(n log n)', 'O(n\u00B2)', 'O(2\u207F)'],
    answer: 2,
    explanation: 'Two nested loops each iterating n times gives n \u00D7 n = O(n\u00B2).'
  },
  {
    code: `let lo = 0, hi = n - 1;\nwhile (lo <= hi) {\n  let mid = (lo + hi) >> 1;\n  if (arr[mid] === target) return mid;\n  if (arr[mid] < target) lo = mid + 1;\n  else hi = mid - 1;\n}`,
    prompt: 'What is the time complexity?',
    options: ['O(1)', 'O(log n)', 'O(n)', 'O(n log n)'],
    answer: 1,
    explanation: 'Binary search halves the search space each iteration \u2192 O(log n).'
  },
  {
    code: `function fib(n) {\n  if (n <= 1) return n;\n  return fib(n - 1) + fib(n - 2);\n}`,
    prompt: 'What is the time complexity?',
    options: ['O(n)', 'O(n\u00B2)', 'O(2\u207F)', 'O(n log n)'],
    answer: 2,
    explanation: 'Each call branches into two recursive calls, creating an exponential tree \u2192 O(2\u207F).'
  },
  {
    code: `for (let i = 0; i < n; i++) {\n  doSomething(arr[i]);\n}\nfor (let j = 0; j < n; j++) {\n  doOther(arr[j]);\n}`,
    prompt: 'What is the time complexity?',
    options: ['O(n)', 'O(n\u00B2)', 'O(2n)', 'O(n log n)'],
    answer: 0,
    explanation: 'Two sequential loops of n: O(n) + O(n) = O(2n) = O(n). Constants drop.'
  },
  {
    code: `for (let i = 1; i < n; i *= 2) {\n  console.log(i);\n}`,
    prompt: 'What is the time complexity?',
    options: ['O(n)', 'O(log n)', 'O(n\u00B2)', 'O(\u221An)'],
    answer: 1,
    explanation: 'The loop variable doubles each iteration, so it runs log\u2082(n) times \u2192 O(log n).'
  },
  {
    code: `arr.sort((a, b) => a - b);\nfor (let i = 0; i < n; i++) {\n  process(arr[i]);\n}`,
    prompt: 'What is the overall time complexity?',
    options: ['O(n)', 'O(n log n)', 'O(n\u00B2)', 'O(log n)'],
    answer: 1,
    explanation: 'Comparison sort is O(n log n), the loop is O(n). Dominant term: O(n log n).'
  }
];

let current = 0, correct = 0, answered = false;

function render() {
  const card = document.getElementById('card');
  if (current >= QUESTIONS.length) {
    const pct = Math.round((correct / QUESTIONS.length) * 100);
    card.innerHTML = `
      <div class="results">
        <div class="grade">${pct}%</div>
        <h2>${pct >= 80 ? 'Great job!' : pct >= 50 ? 'Not bad!' : 'Keep studying!'}</h2>
        <p>${correct} out of ${QUESTIONS.length} correct</p>
        <button class="restart-btn" onclick="restart()">Try Again</button>
      </div>`;
    return;
  }
  const q = QUESTIONS[current];
  answered = false;
  document.getElementById('score').textContent = `${correct} / ${current}`;
  document.getElementById('progress').style.width = `${(current / QUESTIONS.length) * 100}%`;
  card.innerHTML = `
    <div class="question-num">Question ${current + 1} of ${QUESTIONS.length}</div>
    <div class="code-block">${q.code}</div>
    <div class="prompt">${q.prompt}</div>
    <div class="options">${q.options.map((o, i) => `<div class="option" data-idx="${i}">${o}</div>`).join('')}</div>
    <div class="feedback" id="feedback"></div>
    <button class="next-btn" id="nextBtn" onclick="next()">Next</button>`;
  card.querySelectorAll('.option').forEach(el => el.addEventListener('click', () => choose(Number(el.dataset.idx))));
}

function choose(idx) {
  if (answered) return;
  answered = true;
  const q = QUESTIONS[current];
  const options = document.querySelectorAll('.option');
  options.forEach((el, i) => {
    if (i === q.answer) el.classList.add('correct');
    if (i === idx && i !== q.answer) el.classList.add('wrong');
    if (i !== idx && i !== q.answer) el.classList.add('disabled');
  });
  const fb = document.getElementById('feedback');
  if (idx === q.answer) { correct++; fb.className = 'feedback show correct-fb'; fb.textContent = '\u2713 Correct! ' + q.explanation; }
  else { fb.className = 'feedback show wrong-fb'; fb.textContent = '\u2717 ' + q.explanation; }
  document.getElementById('score').textContent = `${correct} / ${current + 1}`;
  document.getElementById('nextBtn').classList.add('show');
}

function next() { current++; render(); }
function restart() { current = 0; correct = 0; render(); }
render();
</script>
</body>
</html>
