---
project: samples
handle: api-metrics-dashboard
title: API Metrics Dashboard (Prometheus)
type: widget
tags: [observability, metrics, prometheus, dashboard, canvas, example]
---
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Metrics Dashboard</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;background:#0f0f0f;color:#e0e0e0;padding:20px}
.hdr{display:flex;align-items:center;justify-content:space-between;margin-bottom:20px}
.hdr h1{font-size:16px;font-weight:600;color:#f0f0f0}
.st{display:flex;align-items:center;gap:6px;font-size:12px;color:#888}
.dot{width:8px;height:8px;border-radius:50%;background:#333}
.dot.ok{background:#22c55e}.dot.err{background:#ef4444}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:16px}
.card{background:#1a1a1a;border:1px solid #2a2a2a;border-radius:8px;padding:16px}
.card h2{font-size:12px;font-weight:500;color:#888;text-transform:uppercase;letter-spacing:.5px;margin-bottom:12px}
.val{font-size:28px;font-weight:600;color:#f0f0f0;line-height:1}
.unit{font-size:13px;font-weight:400;color:#666;margin-left:4px}
.sub{font-size:12px;color:#666;margin-top:6px}
.full{grid-column:1/-1}
canvas{width:100%;height:140px;display:block}
.tbl-wrap{margin-top:8px;max-height:220px;overflow-y:auto}
table{width:100%;border-collapse:collapse;font-size:12px}
th{text-align:left;color:#666;font-weight:500;padding:4px 8px;border-bottom:1px solid #2a2a2a;position:sticky;top:0;background:#1a1a1a}
td{padding:4px 8px;border-bottom:1px solid #1f1f1f;color:#ccc}
td.n{text-align:right;font-variant-numeric:tabular-nums}
tr:hover td{background:#222}
.bar-r{display:flex;align-items:center;gap:10px;margin-bottom:8px}
.bar-l{font-size:12px;color:#aaa;min-width:140px;text-align:right;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bar-t{flex:1;height:18px;background:#222;border-radius:4px;overflow:hidden}
.bar-f{height:100%;border-radius:4px;transition:width .5s ease}
.bar-v{font-size:11px;color:#888;min-width:60px}
.meter{margin-top:10px}
.meter-t{height:10px;background:#222;border-radius:5px;overflow:hidden}
.meter-f{height:100%;border-radius:5px;transition:width .5s ease}
.meter-lb{display:flex;justify-content:space-between;font-size:11px;color:#666;margin-top:4px}
.kv-grid{display:grid;grid-template-columns:1fr 1fr;gap:6px 16px;margin-top:8px}
.kv-item{display:flex;justify-content:space-between;padding:3px 0;border-bottom:1px solid #1f1f1f;font-size:12px}
.kv-k{color:#888}.kv-v{color:#ccc;font-variant-numeric:tabular-nums}
.err-ban{background:#2a1a1a;border:1px solid #4a2020;border-radius:6px;padding:10px 14px;font-size:12px;color:#f87171;margin-bottom:16px;display:none}
</style>
</head>
<body>

<script type="application/json" id="dashboard-config">
{
  "title": "API Metrics",
  "api": "/api/metrics",
  "refresh": 5000,
  "panels": [
    {
      "type": "kpi",
      "title": "Request Rate",
      "query": "sum(rate(khef_http_requests_total{route!=\"/metrics\"}[1m]))",
      "format": "number",
      "decimals": 2,
      "unit": "req/s",
      "sub": { "query": "sum(khef_http_requests_total{route!=\"/metrics\"})", "format": "si", "template": "{v} total requests" }
    },
    {
      "type": "kpi",
      "title": "Avg Latency",
      "query": "sum(khef_http_request_duration_seconds_sum{route!=\"/metrics\"}) / sum(khef_http_request_duration_seconds_count{route!=\"/metrics\"})",
      "format": "duration_ms",
      "unit": "ms",
      "sub": { "label": "request duration" }
    },
    {
      "type": "kpi",
      "title": "Memory (RSS)",
      "query": "khef_process_resident_memory_bytes",
      "format": "bytes",
      "sub": { "query": "khef_nodejs_heap_size_used_bytes", "format": "bytes", "template": "Heap: {v}" }
    },
    {
      "type": "kpi",
      "title": "Event Loop Lag",
      "query": "khef_nodejs_eventloop_lag_seconds",
      "format": "duration_ms",
      "unit": "ms",
      "sub": { "query": "khef_nodejs_eventloop_lag_max_seconds", "format": "duration_ms", "template": "Max: {v} ms" }
    },
    {
      "type": "chart",
      "title": "Request Rate (5m)",
      "query": "sum(rate(khef_http_requests_total{route!=\"/metrics\"}[30s]))",
      "range": 300,
      "step": 15,
      "color": "#8b5cf6",
      "yLabel": "req/s"
    },
    {
      "type": "table",
      "title": "Top Routes (by request count)",
      "columns": [
        { "header": "Method", "field": "method" },
        { "header": "Route", "field": "route" },
        { "header": "Count", "field": "_count", "align": "right" },
        { "header": "Avg (ms)", "field": "_avg", "align": "right", "decimals": 1 }
      ],
      "queries": {
        "_count": "sum by (method, route) (khef_http_requests_total{route!=\"/metrics\"})",
        "_avg": "sum by (method, route) (khef_http_request_duration_seconds_sum{route!=\"/metrics\"}) / sum by (method, route) (khef_http_request_duration_seconds_count{route!=\"/metrics\"})"
      },
      "sortBy": "_count",
      "sortDir": "desc",
      "limit": 10,
      "keyFields": ["method", "route"],
      "transforms": { "_avg": "mul1000" }
    }
  ]
}
</script>

<div class="hdr"><h1 id="title"></h1><div class="st"><div class="dot" id="dot"></div><span id="stxt">connecting...</span></div></div>
<div class="err-ban" id="err"></div>
<div class="grid" id="grid"></div>

<script>
var CFG = JSON.parse(document.getElementById('dashboard-config').textContent);
var API = (function() { var a = CFG.api || '/api/metrics'; if (a.startsWith('http')) return a; try { var r = document.referrer; if (r) { var u = new URL(r); return u.origin + a; } } catch(e) {} return 'http://localhost:3201' + a; })();
document.getElementById('title').textContent = CFG.title || 'Metrics';

function pq(expr) {
  return fetch(API + '/query?query=' + encodeURIComponent(expr)).then(function(r) { return r.json(); }).then(function(d) { if (d.status !== 'success') throw new Error(d.error || 'query failed'); return d.data.result; });
}
function pqr(expr, start, end, step) {
  var p = new URLSearchParams({ query: expr, start: String(start), end: String(end), step: String(step) });
  return fetch(API + '/query_range?' + p).then(function(r) { return r.json(); }).then(function(d) { if (d.status !== 'success') throw new Error(d.error || 'query_range failed'); return d.data.result; });
}
function v1(res) { return res.length ? parseFloat(res[0].value[1]) : null; }

function fmtBytes(n) {
  if (n == null || isNaN(n)) return '--';
  if (n >= 1e9) return (n/1e9).toFixed(1) + ' GB';
  if (n >= 1e6) return (n/1e6).toFixed(1) + ' MB';
  if (n >= 1e3) return (n/1e3).toFixed(1) + ' KB';
  return n.toFixed(0) + ' B';
}
function fmtSi(n, d) {
  d = d || 1;
  if (n == null || isNaN(n)) return '--';
  if (n >= 1e9) return (n/1e9).toFixed(d) + 'B';
  if (n >= 1e6) return (n/1e6).toFixed(d) + 'M';
  if (n >= 1e3) return (n/1e3).toFixed(d) + 'K';
  return n.toFixed(d);
}
function fmt(n, format, decimals) {
  if (n == null || isNaN(n)) return '--';
  if (format === 'bytes') return fmtBytes(n);
  if (format === 'si') return fmtSi(n, decimals || 0);
  if (format === 'duration_ms') return (n * 1000).toFixed(decimals || 1);
  if (format === 'integer') return Math.round(n).toString();
  return n.toFixed(decimals || 1);
}

function setStatus(ok, text) {
  document.getElementById('dot').className = 'dot ' + (ok ? 'ok' : 'err');
  document.getElementById('stxt').textContent = text;
}
function showErr(msg) {
  var b = document.getElementById('err');
  if (msg) { b.textContent = msg; b.style.display = 'block'; } else b.style.display = 'none';
}

function drawChart(canvas, series, color, yLabel) {
  var ctx = canvas.getContext('2d');
  var dpr = window.devicePixelRatio || 1;
  var rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * dpr; canvas.height = rect.height * dpr;
  ctx.scale(dpr, dpr);
  var W = rect.width, H = rect.height;
  ctx.clearRect(0, 0, W, H);
  if (!series.length) return;
  var values = series[0].values.map(function(v) { return parseFloat(v[1]); });
  var times = series[0].values.map(function(v) { return v[0]; });
  if (!values.length) return;
  var max = Math.max.apply(null, values.concat([0.001]));
  var pad = { top: 8, bottom: 20, left: 0, right: 0 };
  var cw = W - pad.left - pad.right, ch = H - pad.top - pad.bottom;
  ctx.beginPath(); ctx.moveTo(pad.left, pad.top + ch);
  values.forEach(function(v, i) { ctx.lineTo(pad.left + (i/(values.length-1))*cw, pad.top + ch - (v/max)*ch); });
  ctx.lineTo(pad.left + cw, pad.top + ch); ctx.closePath();
  var grad = ctx.createLinearGradient(0, pad.top, 0, pad.top + ch);
  grad.addColorStop(0, color + '40'); grad.addColorStop(1, color + '05');
  ctx.fillStyle = grad; ctx.fill();
  ctx.beginPath();
  values.forEach(function(v, i) { var x = pad.left+(i/(values.length-1))*cw, y = pad.top+ch-(v/max)*ch; i===0 ? ctx.moveTo(x,y) : ctx.lineTo(x,y); });
  ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.stroke();
  ctx.fillStyle = '#555'; ctx.font = '10px system-ui'; ctx.textAlign = 'center';
  for (var i = 0; i < 5; i++) {
    var ix = Math.floor(i*(times.length-1)/4);
    ctx.fillText(new Date(times[ix]*1000).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}), pad.left+(ix/(values.length-1))*cw, H-4);
  }
  ctx.textAlign = 'right'; ctx.fillText(fmtSi(max,2) + ' ' + (yLabel||''), W-4, pad.top+10);
}

var grid = document.getElementById('grid');
var panels = CFG.panels.map(function(p, i) {
  var card = document.createElement('div');
  card.className = 'card' + (['chart','table','bars','kvgrid'].indexOf(p.type) >= 0 ? ' full' : '');
  card.innerHTML = '<h2>' + p.title + '</h2>';
  var id = 'p' + i;
  if (p.type === 'kpi') {
    card.innerHTML += '<div class="val" id="' + id + '">--</div><div class="sub" id="' + id + 's"></div>';
  } else if (p.type === 'chart') {
    card.innerHTML += '<canvas id="' + id + '"></canvas>';
  } else if (p.type === 'table') {
    var ths = p.columns.map(function(c) { return '<th' + (c.align === 'right' ? ' style="text-align:right"' : '') + '>' + c.header + '</th>'; }).join('');
    card.innerHTML += '<div class="tbl-wrap"><table><thead><tr>' + ths + '</tr></thead><tbody id="' + id + '"></tbody></table></div>';
  }
  grid.appendChild(card);
  return Object.assign({}, p, { id: id });
});

function refresh() {
  var promises = panels.map(function(p) {
    if (p.type === 'kpi') {
      return pq(p.query).then(function(res) {
        var n = v1(res);
        var formatted = fmt(n, p.format, p.decimals);
        var unitHtml = p.unit ? '<span class="unit">' + p.unit + '</span>' : '';
        document.getElementById(p.id).innerHTML = formatted + unitHtml;
        var subEl = document.getElementById(p.id + 's');
        if (subEl && p.sub) {
          if (p.sub.query) {
            return pq(p.sub.query).then(function(sr) {
              var sv = v1(sr);
              var sfmt = fmt(sv, p.sub.format, p.sub.decimals);
              subEl.textContent = (p.sub.template || '{v}').replace('{v}', sfmt);
            });
          } else if (p.sub.label) { subEl.textContent = p.sub.label; }
        }
      });
    } else if (p.type === 'chart') {
      var now = Math.floor(Date.now()/1000);
      return pqr(p.query, now - (p.range||300), now, p.step||15).then(function(series) {
        drawChart(document.getElementById(p.id), series, p.color||'#8b5cf6', p.yLabel);
      });
    } else if (p.type === 'table') {
      var dataMap = {};
      var queryEntries = Object.entries(p.queries);
      return queryEntries.reduce(function(chain, entry) {
        return chain.then(function() {
          return pq(entry[1]).then(function(res) {
            res.forEach(function(r) {
              var key = p.keyFields.map(function(f) { return r.metric[f] || ''; }).join('|');
              if (!dataMap[key]) { dataMap[key] = {}; p.keyFields.forEach(function(f) { dataMap[key][f] = r.metric[f] || ''; }); }
              var val = parseFloat(r.value[1]);
              if (p.transforms && p.transforms[entry[0]] === 'mul1000') val *= 1000;
              dataMap[key][entry[0]] = val;
            });
          });
        });
      }, Promise.resolve()).then(function() {
        var rows = Object.values(dataMap);
        if (p.sortBy) rows.sort(function(a, b) { return p.sortDir === 'asc' ? (a[p.sortBy]||0) - (b[p.sortBy]||0) : (b[p.sortBy]||0) - (a[p.sortBy]||0); });
        if (p.limit) rows = rows.slice(0, p.limit);
        document.getElementById(p.id).innerHTML = rows.map(function(r) {
          return '<tr>' + p.columns.map(function(c) {
            var v = r[c.field];
            var display = typeof v === 'number' ? v.toFixed(c.decimals || 0) : (v || '');
            return '<td' + (c.align === 'right' ? ' class="n"' : '') + '>' + display + '</td>';
          }).join('') + '</tr>';
        }).join('');
      });
    }
    return Promise.resolve();
  });
  Promise.all(promises).then(function() {
    setStatus(true, 'live \u00b7 ' + new Date().toLocaleTimeString());
    showErr(null);
  }).catch(function(e) {
    setStatus(false, 'error');
    showErr('Metrics query failed: ' + e.message);
  });
}

refresh();
setInterval(refresh, CFG.refresh || 5000);
</script>
</body>
</html>
