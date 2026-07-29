/* ============================================================
   轻量 Canvas 图表模块（零依赖，离线）
   提供 line / bar / doughnut，含坐标轴、网格、悬停提示。
   用法：Charts.line(canvas, { labels, series, ... })
   ============================================================ */
(function (global) {
  const PALETTE = ['#0f766e', '#2563eb', '#f59e0b', '#db2777', '#7c3aed', '#0891b2'];
  const AXIS = '#9ca3af';
  const GRID = '#eef0f2';
  const TEXT = '#55555e';
  const FONT = '11px "Segoe UI","Microsoft YaHei UI",sans-serif';

  function dpiSetup(canvas) {
    const ratio = global.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const w = rect.width || canvas.width || 300;
    const h = rect.height || canvas.height || 160;
    canvas.width = w * ratio;
    canvas.height = h * ratio;
    const ctx = canvas.getContext('2d');
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    return { ctx, w, h };
  }

  function fmtNum(n) {
    n = Number(n) || 0;
    const abs = Math.abs(n);
    if (abs >= 1e8) return (n / 1e8).toFixed(1) + '亿';
    if (abs >= 1e4) return (n / 1e4).toFixed(1) + '万';
    return String(Math.round(n));
  }

  function niceMax(max) {
    if (max <= 0) return 10;
    const pow = Math.pow(10, Math.floor(Math.log10(max)));
    const norm = max / pow;
    const step = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
    return step * pow;
  }

  function ensureTip() {
    let tip = document.getElementById('__chartTip');
    if (!tip) {
      tip = document.createElement('div');
      tip.id = '__chartTip';
      tip.style.cssText =
        'position:fixed;z-index:999;pointer-events:none;background:#1f1f24;color:#fff;' +
        'font:11.5px/1.5 sans-serif;padding:6px 9px;border-radius:6px;opacity:0;transition:opacity .1s;' +
        'box-shadow:0 4px 14px rgba(0,0,0,.2);white-space:nowrap;';
      document.body.appendChild(tip);
    }
    return tip;
  }
  function showTip(html, x, y) {
    const tip = ensureTip();
    tip.innerHTML = html;
    tip.style.left = (x + 12) + 'px';
    tip.style.top = (y + 12) + 'px';
    tip.style.opacity = '1';
  }
  function hideTip() {
    const tip = document.getElementById('__chartTip');
    if (tip) tip.style.opacity = '0';
  }

  /* ---------- 折线图 ---------- */
  function line(canvas, opts) {
    const { ctx, w, h } = dpiSetup(canvas);
    const labels = opts.labels || [];
    const series = opts.series || [];
    const padL = 44, padR = 12, padT = 12, padB = 24;
    const plotW = w - padL - padR, plotH = h - padT - padB;
    ctx.clearRect(0, 0, w, h);
    if (!labels.length) { emptyState(ctx, w, h); return; }

    let max = 0;
    series.forEach(s => s.data.forEach(v => { if (v > max) max = v; }));
    max = niceMax(max);

    // 网格 + Y 轴
    ctx.font = FONT; ctx.fillStyle = TEXT; ctx.strokeStyle = GRID; ctx.lineWidth = 1;
    const yTicks = 4;
    for (let i = 0; i <= yTicks; i++) {
      const y = padT + plotH - (plotH * i / yTicks);
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w - padR, y); ctx.stroke();
      ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
      ctx.fillText(fmtNum(max * i / yTicks), padL - 6, y);
    }

    const xAt = (i) => padL + (labels.length === 1 ? plotW / 2 : plotW * i / (labels.length - 1));
    const yAt = (v) => padT + plotH - (plotH * v / max);

    // X 轴稀疏标签
    ctx.textAlign = 'center'; ctx.textBaseline = 'top'; ctx.fillStyle = AXIS;
    const stepX = Math.ceil(labels.length / 7);
    labels.forEach((lb, i) => {
      if (i % stepX === 0 || i === labels.length - 1) {
        ctx.fillText(String(lb).slice(5), xAt(i), padT + plotH + 6);
      }
    });

    // 折线 + 面积
    series.forEach((s, si) => {
      const color = s.color || PALETTE[si % PALETTE.length];
      ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.lineJoin = 'round';
      ctx.beginPath();
      s.data.forEach((v, i) => { const x = xAt(i), y = yAt(v); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
      ctx.stroke();
      if (s.fill !== false) {
        const grad = ctx.createLinearGradient(0, padT, 0, padT + plotH);
        grad.addColorStop(0, color + '22'); grad.addColorStop(1, color + '00');
        ctx.lineTo(xAt(s.data.length - 1), padT + plotH);
        ctx.lineTo(xAt(0), padT + plotH); ctx.closePath();
        ctx.fillStyle = grad; ctx.fill();
      }
    });

    attachHover(canvas, w, (mx) => {
      let idx = Math.round((mx - padL) / (plotW / Math.max(1, labels.length - 1)));
      idx = Math.max(0, Math.min(labels.length - 1, idx));
      const rows = series.map((s, si) =>
        `<span style="color:${s.color || PALETTE[si % PALETTE.length]}">●</span> ${s.name || ''} <b>${fmtNum(s.data[idx])}</b>`).join('<br>');
      return { html: `<b>${labels[idx]}</b><br>${rows}`, hit: true };
    });
  }

  /* ---------- 柱状图 ---------- */
  function bar(canvas, opts) {
    const { ctx, w, h } = dpiSetup(canvas);
    const labels = opts.labels || [];
    const data = opts.data || [];
    const colors = opts.colors || labels.map((_, i) => PALETTE[i % PALETTE.length]);
    const padL = 44, padR = 12, padT = 12, padB = 26;
    const plotW = w - padL - padR, plotH = h - padT - padB;
    ctx.clearRect(0, 0, w, h);
    if (!labels.length) { emptyState(ctx, w, h); return; }
    let max = niceMax(Math.max(...data, 0));

    ctx.font = FONT; ctx.strokeStyle = GRID; ctx.fillStyle = TEXT; ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const y = padT + plotH - (plotH * i / 4);
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w - padR, y); ctx.stroke();
      ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
      ctx.fillText(fmtNum(max * i / 4), padL - 6, y);
    }

    const bw = plotW / labels.length;
    const barW = Math.min(38, bw * 0.55);
    const rects = [];
    labels.forEach((lb, i) => {
      const val = data[i] || 0;
      const bh = plotH * val / max;
      const x = padL + bw * i + (bw - barW) / 2;
      const y = padT + plotH - bh;
      ctx.fillStyle = colors[i];
      roundRect(ctx, x, y, barW, bh, 4); ctx.fill();
      ctx.fillStyle = AXIS; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      ctx.fillText(String(lb).slice(0, 4), padL + bw * i + bw / 2, padT + plotH + 6);
      rects.push({ x, y, w: barW, h: bh, label: lb, val });
    });

    attachHoverRects(canvas, rects, (r) => `<b>${r.label}</b><br><b>${fmtNum(r.val)}</b>`);
  }

  /* ---------- 堆叠柱状图（账号互动对比） ---------- */
  function stackedBar(canvas, opts) {
    const { ctx, w, h } = dpiSetup(canvas);
    const labels = opts.labels || [];
    const series = opts.series || [];   // [{ name, data[], color }]
    const padL = 44, padR = 12, padT = 24, padB = 42;
    const plotW = w - padL - padR, plotH = h - padT - padB;
    ctx.clearRect(0, 0, w, h);
    if (!labels.length || !series.length) { emptyState(ctx, w, h); return; }

    const totals = labels.map((_, i) => series.reduce((s, sr) => s + (sr.data[i] || 0), 0));
    const max = niceMax(Math.max(...totals, 0));

    ctx.font = FONT; ctx.strokeStyle = GRID; ctx.fillStyle = TEXT; ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const y = padT + plotH - (plotH * i / 4);
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w - padR, y); ctx.stroke();
      ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
      ctx.fillText(fmtNum(max * i / 4), padL - 6, y);
    }

    // 顶部图例
    let lx = padL;
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    series.forEach((sr, si) => {
      const color = sr.color || PALETTE[si % PALETTE.length];
      ctx.fillStyle = color;
      roundRect(ctx, lx, 4, 9, 9, 2); ctx.fill();
      ctx.fillStyle = TEXT;
      ctx.fillText(sr.name, lx + 13, 9);
      lx += 13 + ctx.measureText(sr.name).width + 16;
    });

    const bw = plotW / labels.length;
    const barW = Math.min(42, bw * 0.6);
    const rects = [];
    labels.forEach((lb, i) => {
      let yTop = padT + plotH;
      const x = padL + bw * i + (bw - barW) / 2;
      series.forEach((sr, si) => {
        const val = sr.data[i] || 0;
        if (val <= 0) return;
        const bh = plotH * val / max;
        yTop -= bh;
        ctx.fillStyle = sr.color || PALETTE[si % PALETTE.length];
        ctx.fillRect(x, yTop, barW, bh);
      });
      ctx.fillStyle = AXIS; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      const fullLabel = String(lb);
      const separatorIndex = fullLabel.lastIndexOf(' · ');
      const accountName = separatorIndex >= 0 ? fullLabel.slice(0, separatorIndex) : fullLabel;
      const platform = separatorIndex >= 0 ? fullLabel.slice(separatorIndex + 3) : '';
      const shortName = accountName.length > 7 ? `${accountName.slice(0, 7)}…` : accountName;
      const labelX = padL + bw * i + bw / 2;
      ctx.fillText(shortName, labelX, padT + plotH + 6);
      if (platform) ctx.fillText(platform, labelX, padT + plotH + 20);
      rects.push({ x, y: yTop, w: barW, h: padT + plotH - yTop, label: lb, idx: i, total: totals[i] });
    });

    attachHoverRects(canvas, rects, (r) => {
      const rows = series.map((sr, si) =>
        `<span style="color:${sr.color || PALETTE[si % PALETTE.length]}">●</span> ${sr.name} <b>${fmtNum(sr.data[r.idx] || 0)}</b>`).join('<br>');
      return `<b>${r.label}</b><br>${rows}<br>合计 <b>${fmtNum(r.total)}</b>`;
    });
  }

  /* ---------- 环形图 ---------- */
  function doughnut(canvas, opts) {
    const { ctx, w, h } = dpiSetup(canvas);
    const items = (opts.items || []).filter(it => it.value > 0);
    ctx.clearRect(0, 0, w, h);
    if (!items.length) { emptyState(ctx, w, h); return; }
    const total = items.reduce((s, it) => s + it.value, 0);
    const cx = h / 2 + 6, cy = h / 2, r = h / 2 - 14, ir = r * 0.62;
    let ang = -Math.PI / 2;
    const arcs = [];
    items.forEach((it, i) => {
      const slice = (it.value / total) * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, r, ang, ang + slice);
      ctx.closePath();
      ctx.fillStyle = it.color || PALETTE[i % PALETTE.length];
      ctx.fill();
      arcs.push({ start: ang, end: ang + slice, ...it });
      ang += slice;
    });
    // 挖空中心
    ctx.globalCompositeOperation = 'destination-out';
    ctx.beginPath(); ctx.arc(cx, cy, ir, 0, Math.PI * 2); ctx.fill();
    ctx.globalCompositeOperation = 'source-over';
    // 中心总数
    ctx.fillStyle = '#1a1a1e'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = 'bold 15px "Segoe UI",sans-serif';
    ctx.fillText(fmtNum(total), cx, cy - 6);
    ctx.font = '10px "Segoe UI",sans-serif'; ctx.fillStyle = TEXT;
    ctx.fillText('总互动', cx, cy + 11);
    // 图例
    let ly = 16;
    const lx = cx + r + 18;
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.font = FONT;
    items.forEach((it, i) => {
      ctx.fillStyle = it.color || PALETTE[i % PALETTE.length];
      roundRect(ctx, lx, ly - 4, 9, 9, 2); ctx.fill();
      ctx.fillStyle = TEXT;
      ctx.fillText(`${it.label}  ${fmtNum(it.value)} (${Math.round(it.value / total * 100)}%)`, lx + 15, ly);
      ly += 19;
    });

    attachHoverAngle(canvas, cx, cy, ir, r, arcs, (a) =>
      `<b>${a.label}</b><br><b>${fmtNum(a.value)}</b> · ${Math.round(a.value / total * 100)}%`);
  }

  /* ---------- 辅助 ---------- */
  function roundRect(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    if (h <= 0) { ctx.beginPath(); return; }
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
  function emptyState(ctx, w, h) {
    ctx.fillStyle = '#b8b8c0'; ctx.font = FONT;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('暂无数据', w / 2, h / 2);
  }
  function attachHover(canvas, w, resolve) {
    canvas.onmousemove = (e) => {
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const res = resolve(mx);
      if (res && res.hit) showTip(res.html, e.clientX, e.clientY); else hideTip();
    };
    canvas.onmouseleave = hideTip;
  }
  function attachHoverRects(canvas, rects, html) {
    canvas.onmousemove = (e) => {
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left, my = e.clientY - rect.top;
      const hit = rects.find(r => mx >= r.x && mx <= r.x + r.w && my >= r.y - 4 && my <= r.y + r.h);
      if (hit) showTip(html(hit), e.clientX, e.clientY); else hideTip();
    };
    canvas.onmouseleave = hideTip;
  }
  function attachHoverAngle(canvas, cx, cy, ir, r, arcs, html) {
    canvas.onmousemove = (e) => {
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left, my = e.clientY - rect.top;
      const dx = mx - cx, dy = my - cy;
      const dist = Math.hypot(dx, dy);
      if (dist < ir || dist > r) { hideTip(); return; }
      let a = Math.atan2(dy, dx);
      if (a < -Math.PI / 2) a += Math.PI * 2;
      const hit = arcs.find(arc => a >= arc.start && a < arc.end);
      if (hit) showTip(html(hit), e.clientX, e.clientY); else hideTip();
    };
    canvas.onmouseleave = hideTip;
  }

  global.Charts = { line, bar, stackedBar, doughnut, fmtNum, PALETTE };
})(window);
