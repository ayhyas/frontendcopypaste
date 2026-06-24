// ClipShare Canvas Drawing Engine
// Exposes: window.CanvasApp = { init, open, close }
// Set window.CanvasApp.onSave = async (title, elementsJson, previewDataUrl) before calling open()

(function () {
  'use strict';

  /* ─── State ───────────────────────────────────────────────────────────────── */
  let canvas, ctx, dpr, textArea;
  let elements    = [];
  let history     = ['[]'];
  let histIdx     = 0;
  let activeTool  = 'pen';
  let activeStyle = { stroke: '#e2e8f0', fill: 'none', width: 2, dash: false, fontSize: 20 };
  let bgColor     = '#0b0b16';
  let vp          = { x: 0, y: 0, s: 1 };   // viewport pan + scale
  let drawing     = null;   // element currently being drawn
  let selected    = null;   // id of selected element
  let dragOrigin  = null;   // { dx, dy, snapshot: clone of element at drag start }
  let panOrigin   = null;   // { mx, my, vx, vy }
  let spaceDown   = false;
  let isDown      = false;
  let isOpen      = false;

  /* ─── Public API ──────────────────────────────────────────────────────────── */
  window.CanvasApp = { init, open, close: closeCanvas, onSave: null };

  function init() {
    canvas   = document.getElementById('drawingCanvas');
    ctx      = canvas.getContext('2d');
    textArea = document.getElementById('canvasTextInput');
    setupResize();
    setupEvents();
    setupToolbar();
  }

  function open(existingElementsJson) {
    isOpen   = true;
    elements = existingElementsJson ? JSON.parse(existingElementsJson) : [];
    history  = [JSON.stringify(elements)];
    histIdx  = 0;
    selected = null;
    drawing  = null;
    bgColor  = '#0b0b16';
    vp       = { x: 0, y: 0, s: 1 };
    document.getElementById('drawingTitle').value = '';
    const bgInput = document.getElementById('bgColorInput');
    if (bgInput) bgInput.value = bgColor;
    document.getElementById('canvasOverlay').classList.add('canvas-overlay--open');
    resize();
    render();
  }

  function closeCanvas() {
    isOpen = false;
    finishText();
    selected = null;
    drawing  = null;
    elements = [];
    document.getElementById('canvasOverlay').classList.remove('canvas-overlay--open');
    document.getElementById('drawingTitle').value = '';
  }

  /* ─── Resize ──────────────────────────────────────────────────────────────── */
  function setupResize() {
    const ro = new ResizeObserver(() => { if (isOpen) resize(); });
    ro.observe(document.getElementById('canvasArea'));
  }

  function resize() {
    dpr = window.devicePixelRatio || 1;
    const area = document.getElementById('canvasArea');
    const W = area.clientWidth;
    const H = area.clientHeight;
    canvas.width  = W * dpr;
    canvas.height = H * dpr;
    canvas.style.width  = W + 'px';
    canvas.style.height = H + 'px';
    ctx.scale(dpr, dpr);
    render();
  }

  /* ─── Viewport ────────────────────────────────────────────────────────────── */
  function clientPos(e) {
    const rect = canvas.getBoundingClientRect();
    const src  = e.touches ? e.touches[0] : e;
    return { mx: src.clientX - rect.left, my: src.clientY - rect.top };
  }

  function toDoc(mx, my) {
    return { x: (mx - vp.x) / vp.s, y: (my - vp.y) / vp.s };
  }

  function docPos(e) {
    const { mx, my } = clientPos(e);
    return toDoc(mx, my);
  }

  /* ─── History ─────────────────────────────────────────────────────────────── */
  function pushHistory() {
    history = history.slice(0, histIdx + 1);
    history.push(JSON.stringify(elements));
    histIdx = history.length - 1;
  }

  function undo() {
    if (histIdx > 0) { histIdx--; elements = JSON.parse(history[histIdx]); selected = null; render(); }
  }

  function redo() {
    if (histIdx < history.length - 1) { histIdx++; elements = JSON.parse(history[histIdx]); selected = null; render(); }
  }

  /* ─── ID ──────────────────────────────────────────────────────────────────── */
  const genId = () => Math.random().toString(36).slice(2, 9);

  /* ─── Render ──────────────────────────────────────────────────────────────── */
  function render() {
    if (!canvas || !ctx) return;
    const W = canvas.width / dpr;
    const H = canvas.height / dpr;
    ctx.fillStyle = bgColor;
    ctx.fillRect(0, 0, W, H);
    drawGrid(W, H);

    ctx.save();
    ctx.translate(vp.x, vp.y);
    ctx.scale(vp.s, vp.s);
    elements.forEach(el => renderEl(ctx, el));
    if (drawing) renderEl(ctx, drawing);
    ctx.restore();

    if (selected) {
      const el = elements.find(e => e.id === selected);
      if (el) drawSelBox(el);
    }
    updateZoomLabel();
  }

  function drawGrid(W, H) {
    const gs = 22 * vp.s;
    const ox = ((vp.x % gs) + gs) % gs;
    const oy = ((vp.y % gs) + gs) % gs;
    ctx.fillStyle = 'rgba(148,163,184,0.1)';
    for (let x = ox - gs; x < W + gs; x += gs)
      for (let y = oy - gs; y < H + gs; y += gs)
        ctx.fillRect(x - 1.5, y - 1.5, 3, 3);
  }

  function renderEl(c, el) {
    c.save();
    c.globalAlpha = el.opacity ?? 1;
    c.strokeStyle = el.stroke  ?? '#e2e8f0';
    c.lineWidth   = el.width   ?? 2;
    c.lineJoin    = 'round';
    c.lineCap     = 'round';
    c.setLineDash(el.dash ? [el.width * 5, el.width * 3] : []);

    switch (el.type) {
      case 'pen':     drawPen    (c, el); break;
      case 'rect':    drawRect   (c, el); break;
      case 'ellipse': drawEllipse(c, el); break;
      case 'line':    drawLine   (c, el); break;
      case 'arrow':   drawArrow  (c, el); break;
      case 'text':    drawText   (c, el); break;
    }
    c.restore();
  }

  function drawPen(c, el) {
    const pts = el.points;
    if (!pts || pts.length < 2) return;
    c.beginPath();
    c.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length - 1; i++) {
      const mx = (pts[i].x + pts[i + 1].x) / 2;
      const my = (pts[i].y + pts[i + 1].y) / 2;
      c.quadraticCurveTo(pts[i].x, pts[i].y, mx, my);
    }
    c.lineTo(pts[pts.length - 1].x, pts[pts.length - 1].y);
    c.stroke();
  }

  function drawRect(c, el) {
    if (el.fill && el.fill !== 'none') { c.fillStyle = el.fill; c.fillRect(el.x, el.y, el.w, el.h); }
    c.strokeRect(el.x, el.y, el.w, el.h);
  }

  function drawEllipse(c, el) {
    const cx = el.x + el.w / 2, cy = el.y + el.h / 2;
    const rx = Math.abs(el.w / 2), ry = Math.abs(el.h / 2);
    if (rx < 1 || ry < 1) return;
    c.beginPath();
    c.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
    if (el.fill && el.fill !== 'none') { c.fillStyle = el.fill; c.fill(); }
    c.stroke();
  }

  function drawLine(c, el) {
    c.beginPath();
    c.moveTo(el.x, el.y);
    c.lineTo(el.x2, el.y2);
    c.stroke();
  }

  function drawArrow(c, el) {
    drawLine(c, el);
    const angle  = Math.atan2(el.y2 - el.y, el.x2 - el.x);
    const len    = Math.max(14, el.width * 5);
    const spread = 0.42;
    c.beginPath();
    c.moveTo(el.x2, el.y2);
    c.lineTo(el.x2 - len * Math.cos(angle - spread), el.y2 - len * Math.sin(angle - spread));
    c.moveTo(el.x2, el.y2);
    c.lineTo(el.x2 - len * Math.cos(angle + spread), el.y2 - len * Math.sin(angle + spread));
    c.stroke();
  }

  function drawText(c, el) {
    if (!el.text) return;
    c.font      = `${el.fontSize || 20}px Inter, system-ui, sans-serif`;
    c.fillStyle = el.stroke;
    const lh    = (el.fontSize || 20) * 1.4;
    el.text.split('\n').forEach((line, i) => c.fillText(line, el.x, el.y + i * lh));
  }

  /* ─── Bounds & hit-testing ────────────────────────────────────────────────── */
  function bounds(el) {
    switch (el.type) {
      case 'pen': {
        const xs = el.points.map(p => p.x), ys = el.points.map(p => p.y);
        const x  = Math.min(...xs), y = Math.min(...ys);
        return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
      }
      case 'rect': case 'ellipse':
        return { x: el.x, y: el.y, w: el.w, h: el.h };
      case 'line': case 'arrow':
        return { x: Math.min(el.x, el.x2), y: Math.min(el.y, el.y2),
                 w: Math.abs(el.x2 - el.x), h: Math.abs(el.y2 - el.y) };
      case 'text': {
        // measure approximate bounds
        const lines = (el.text || ' ').split('\n');
        const fs    = el.fontSize || 20;
        const lh    = fs * 1.4;
        ctx.font    = `${fs}px Inter, system-ui, sans-serif`;
        const maxW  = Math.max(...lines.map(l => ctx.measureText(l).width));
        return { x: el.x, y: el.y - fs, w: maxW || 50, h: lh * lines.length };
      }
    }
    return { x: 0, y: 0, w: 0, h: 0 };
  }

  function hitTest(dx, dy) {
    const T = 10 / vp.s;
    for (let i = elements.length - 1; i >= 0; i--) {
      if (isHit(elements[i], dx, dy, T)) return elements[i].id;
    }
    return null;
  }

  function isHit(el, dx, dy, T) {
    switch (el.type) {
      case 'pen':
        return el.points.some((p, i) => {
          if (i === 0) return false;
          return segDist(dx, dy, el.points[i - 1].x, el.points[i - 1].y, p.x, p.y) < T;
        });
      case 'rect': case 'ellipse': {
        const b = bounds(el);
        const x1 = Math.min(b.x, b.x + b.w), x2 = Math.max(b.x, b.x + b.w);
        const y1 = Math.min(b.y, b.y + b.h), y2 = Math.max(b.y, b.y + b.h);
        return dx >= x1 - T && dx <= x2 + T && dy >= y1 - T && dy <= y2 + T;
      }
      case 'line': case 'arrow':
        return segDist(dx, dy, el.x, el.y, el.x2, el.y2) < T;
      case 'text': {
        const b = bounds(el);
        return dx >= b.x - T && dx <= b.x + b.w + T && dy >= b.y - T && dy <= b.y + b.h + T;
      }
    }
    return false;
  }

  function segDist(px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay;
    const l2 = dx * dx + dy * dy;
    if (l2 === 0) return Math.hypot(px - ax, py - ay);
    const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2));
    return Math.hypot(px - ax - t * dx, py - ay - t * dy);
  }

  /* ─── Selection box ───────────────────────────────────────────────────────── */
  function drawSelBox(el) {
    const b   = bounds(el);
    const pad = 8 / vp.s;
    const sx  = (b.x - pad) * vp.s + vp.x;
    const sy  = (b.y - pad) * vp.s + vp.y;
    const sw  = (Math.abs(b.w) + pad * 2) * vp.s;
    const sh  = (Math.abs(b.h) + pad * 2) * vp.s;
    ctx.save();
    ctx.strokeStyle = '#7c3aed';
    ctx.lineWidth   = 1.5;
    ctx.setLineDash([5, 4]);
    ctx.strokeRect(sx, sy, Math.max(sw, 20), Math.max(sh, 20));
    ctx.restore();
  }

  /* ─── Mouse / touch events ────────────────────────────────────────────────── */
  function setupEvents() {
    canvas.addEventListener('mousedown',   onDown);
    canvas.addEventListener('mousemove',   onMove);
    canvas.addEventListener('mouseup',     onUp);
    canvas.addEventListener('mouseleave',  onUp);
    canvas.addEventListener('click',       onCanvasClick);
    canvas.addEventListener('wheel',       onWheel, { passive: false });
    canvas.addEventListener('touchstart',  e => { e.preventDefault(); onDown(e); }, { passive: false });
    canvas.addEventListener('touchmove',   e => { e.preventDefault(); onMove(e); }, { passive: false });
    canvas.addEventListener('touchend',    e => { e.preventDefault(); onCanvasClick(e); }, { passive: false });
    document.addEventListener('keydown',   onKey);
    document.addEventListener('keyup',     e => {
      if (e.key === ' ') { spaceDown = false; syncCursor(); }
    });
  }

  function onKey(e) {
    if (!isOpen) return;
    const mod = e.ctrlKey || e.metaKey;
    const focused = document.activeElement;
    const inInput = focused === textArea || focused === document.getElementById('drawingTitle');

    if (mod && e.key === 'z' && !e.shiftKey) { e.preventDefault(); undo(); return; }
    if (mod && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) { e.preventDefault(); redo(); return; }
    if ((e.key === 'Delete' || e.key === 'Backspace') && selected && !inInput) {
      elements = elements.filter(el => el.id !== selected);
      selected = null;
      pushHistory();
      render();
      return;
    }
    if (e.key === 'Escape') { selected = null; finishText(); render(); return; }
    if (e.key === ' ' && !inInput) { e.preventDefault(); spaceDown = true; canvas.style.cursor = 'grab'; }

    // Tool shortcuts (only when not typing)
    if (!inInput && !mod) {
      const shortcuts = { v: 'select', p: 'pen', r: 'rect', e: 'ellipse', l: 'line', a: 'arrow', t: 'text', x: 'eraser' };
      if (shortcuts[e.key]) selectTool(shortcuts[e.key]);
    }
  }

  function onCanvasClick(e) {
    if (activeTool !== 'text' || spaceDown || e.button === 2) return;
    const { mx, my } = clientPos(e);
    const { x: dx, y: dy } = toDoc(mx, my);
    placeText(mx, my, dx, dy);
  }

  function onDown(e) {
    if (e.button === 2) return; // ignore right-click
    if (activeTool === 'text') return; // text placement handled by click event
    isDown = true;
    const { mx, my } = clientPos(e);

    if (spaceDown || e.button === 1) {
      panOrigin = { mx, my, vx: vp.x, vy: vp.y };
      canvas.style.cursor = 'grabbing';
      return;
    }

    const { x: dx, y: dy } = toDoc(mx, my);

    if (activeTool === 'select') {
      const id = hitTest(dx, dy);
      selected = id;
      if (id) {
        const el = elements.find(el => el.id === id);
        dragOrigin = { dx, dy, snap: JSON.parse(JSON.stringify(el)) };
        syncToolbarToElement(el);
      }
      render();
      return;
    }

    if (activeTool === 'eraser') {
      eraseAt(dx, dy);
      return;
    }

    // Start drawing shape
    const base = { id: genId(), stroke: activeStyle.stroke, fill: activeStyle.fill, width: activeStyle.width, dash: activeStyle.dash, opacity: 1 };
    if (activeTool === 'pen')
      drawing = { ...base, type: 'pen', points: [{ x: dx, y: dy }] };
    else if (activeTool === 'rect' || activeTool === 'ellipse')
      drawing = { ...base, type: activeTool, x: dx, y: dy, w: 0, h: 0 };
    else if (activeTool === 'line' || activeTool === 'arrow')
      drawing = { ...base, type: activeTool, x: dx, y: dy, x2: dx, y2: dy };
  }

  function onMove(e) {
    if (!isDown) return;
    const { mx, my } = clientPos(e);

    if (panOrigin) {
      vp.x = panOrigin.vx + mx - panOrigin.mx;
      vp.y = panOrigin.vy + my - panOrigin.my;
      render();
      return;
    }

    const { x: dx, y: dy } = toDoc(mx, my);

    if (activeTool === 'select' && dragOrigin && selected) {
      const ddx = dx - dragOrigin.dx, ddy = dy - dragOrigin.dy;
      const el  = elements.find(e => e.id === selected);
      if (el) moveEl(el, dragOrigin.snap, ddx, ddy);
      render();
      return;
    }

    if (activeTool === 'eraser') { eraseAt(dx, dy); return; }

    if (!drawing) return;
    if (drawing.type === 'pen') {
      drawing.points.push({ x: dx, y: dy });
    } else if (drawing.type === 'rect' || drawing.type === 'ellipse') {
      drawing.w = dx - drawing.x;
      drawing.h = dy - drawing.y;
    } else if (drawing.type === 'line' || drawing.type === 'arrow') {
      drawing.x2 = dx; drawing.y2 = dy;
    }
    render();
  }

  function onUp() {
    if (!isDown) return;
    isDown = false;

    if (panOrigin) { panOrigin = null; syncCursor(); return; }

    if (activeTool === 'select' && dragOrigin) { pushHistory(); dragOrigin = null; return; }

    if (!drawing) return;
    const el = drawing;
    drawing  = null;

    // Discard noise
    if (el.type === 'pen' && el.points.length < 3) { render(); return; }
    if ((el.type === 'rect' || el.type === 'ellipse') && Math.abs(el.w) < 3 && Math.abs(el.h) < 3) { render(); return; }
    if ((el.type === 'line' || el.type === 'arrow') && Math.abs(el.x2 - el.x) < 3 && Math.abs(el.y2 - el.y) < 3) { render(); return; }

    elements.push(el);
    pushHistory();
    render();
  }

  function onWheel(e) {
    e.preventDefault();
    const { mx, my } = clientPos(e);
    if (e.ctrlKey || e.metaKey) {
      const delta = e.deltaY > 0 ? 0.9 : 1.1;
      const newS  = Math.max(0.1, Math.min(8, vp.s * delta));
      vp.x = mx - (mx - vp.x) * (newS / vp.s);
      vp.y = my - (my - vp.y) * (newS / vp.s);
      vp.s = newS;
    } else {
      vp.x -= e.deltaX;
      vp.y -= e.deltaY;
    }
    render();
  }

  function eraseAt(dx, dy) {
    const id = hitTest(dx, dy);
    if (id) {
      elements = elements.filter(e => e.id !== id);
      if (selected === id) selected = null;
      pushHistory();
      render();
    }
  }

  function moveEl(el, snap, ddx, ddy) {
    switch (el.type) {
      case 'pen':
        el.points = snap.points.map(p => ({ x: p.x + ddx, y: p.y + ddy }));
        break;
      case 'rect': case 'ellipse': case 'text':
        el.x = snap.x + ddx; el.y = snap.y + ddy;
        break;
      case 'line': case 'arrow':
        el.x = snap.x + ddx; el.y = snap.y + ddy;
        el.x2 = snap.x2 + ddx; el.y2 = snap.y2 + ddy;
        break;
    }
  }

  /* ─── Text tool ───────────────────────────────────────────────────────────── */
  function placeText(mx, my, dx, dy) {
    // Commit any in-progress text before starting a new one
    if (textArea.style.display === 'block') {
      if (textArea.value.trim()) commitText();
      else finishText();
    }

    const fs   = activeStyle.fontSize * vp.s;
    const lineH = fs * 1.35;

    textArea.style.display    = 'block';
    textArea.style.left       = mx + 'px';
    textArea.style.top        = (my - fs * 0.82) + 'px';
    textArea.style.fontSize   = fs + 'px';
    textArea.style.lineHeight = lineH + 'px';
    textArea.style.color      = activeStyle.stroke;
    textArea.style.width      = '180px';
    textArea.style.height     = lineH + 'px';
    textArea.dataset.dx       = dx;
    textArea.dataset.dy       = dy;
    textArea.dataset.fontSize = activeStyle.fontSize;
    textArea.dataset.stroke   = activeStyle.stroke;
    textArea.value            = '';

    function grow() {
      textArea.style.height = 'auto';
      textArea.style.height = textArea.scrollHeight + 'px';
      textArea.style.width  = Math.max(180, textArea.scrollWidth + 20) + 'px';
    }

    textArea.oninput = () => {
      grow();
      drawing = mkTextPreview(dx, dy);
      render();
    };
    textArea.onblur = () => {
      if (textArea.value.trim()) commitText();
      else finishText();
      render();
    };
    textArea.onkeydown = e => {
      if (e.key === 'Escape') { e.preventDefault(); finishText(); render(); return; }
      // Plain Enter = commit; Shift+Enter = newline
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (textArea.value.trim()) commitText();
        else finishText();
        render();
      }
    };

    requestAnimationFrame(() => textArea.focus());
  }

  function mkTextPreview(dx, dy) {
    const fs = parseFloat(textArea.dataset.fontSize) || activeStyle.fontSize;
    return { id: '__txt__', type: 'text', x: dx, y: dy, text: textArea.value,
             stroke: textArea.dataset.stroke || activeStyle.stroke,
             fontSize: fs, fill: 'none', width: 1, dash: false, opacity: 0.6 };
  }

  function commitText() {
    const dx = parseFloat(textArea.dataset.dx);
    const dy = parseFloat(textArea.dataset.dy);
    const fs = parseFloat(textArea.dataset.fontSize) || activeStyle.fontSize;
    if (isNaN(dx) || isNaN(dy)) { finishText(); return; }
    elements.push({ id: genId(), type: 'text', x: dx, y: dy,
                    text: textArea.value.trim(),
                    stroke: textArea.dataset.stroke || activeStyle.stroke,
                    fontSize: fs, fill: 'none', width: 1, dash: false, opacity: 1 });
    pushHistory();
    finishText();
    render();
  }

  function finishText() {
    drawing = null;
    if (!textArea) return;
    textArea.style.display = 'none';
    textArea.value         = '';
    textArea.oninput       = null;
    textArea.onblur        = null;
    textArea.onkeydown     = null;
  }

  /* ─── Sync toolbar UI to selected element's properties ───────────────────── */
  function syncToolbarToElement(el) {
    if (!el) return;
    // Stroke color
    if (el.stroke) {
      activeStyle.stroke = el.stroke;
      document.querySelectorAll('[data-color]').forEach(s => s.classList.toggle('color-active', s.dataset.color === el.stroke));
      const si = document.getElementById('strokeColorInput');
      if (si) si.value = el.stroke;
    }
    // Fill
    if (el.fill !== undefined) {
      activeStyle.fill = el.fill;
      const isSolid = el.fill !== 'none';
      document.querySelectorAll('[data-fill]').forEach(b => {
        b.classList.toggle('fill-active', isSolid ? b.dataset.fill === 'solid' : b.dataset.fill === 'none');
      });
      if (isSolid) {
        const fi = document.getElementById('fillColorInput');
        if (fi) fi.value = el.fill;
      }
    }
    // Stroke width
    if (el.width !== undefined) {
      activeStyle.width = el.width;
      document.querySelectorAll('[data-sw]').forEach(b => b.classList.toggle('sw-active', +b.dataset.sw === el.width));
    }
    // Dash
    if (el.dash !== undefined) {
      activeStyle.dash = !!el.dash;
      document.getElementById('dashToggle')?.classList.toggle('tool-active', activeStyle.dash);
    }
    // Font size (text only)
    if (el.fontSize) {
      activeStyle.fontSize = el.fontSize;
      const fi = document.getElementById('fontSizeInput');
      if (fi) fi.value = el.fontSize;
    }
  }

  /* ─── Apply style to selected element ────────────────────────────────────── */
  function applyToSelected(props) {
    if (!selected) return;
    const el = elements.find(e => e.id === selected);
    if (!el) return;
    Object.assign(el, props);
    pushHistory();
    render();
  }

  /* ─── Toolbar ─────────────────────────────────────────────────────────────── */
  function setupToolbar() {
    document.querySelectorAll('[data-tool]').forEach(btn => {
      btn.addEventListener('click', () => selectTool(btn.dataset.tool));
    });

    document.querySelectorAll('[data-color]').forEach(sw => {
      sw.addEventListener('click', () => {
        activeStyle.stroke = sw.dataset.color;
        document.querySelectorAll('[data-color]').forEach(s => s.classList.remove('color-active'));
        sw.classList.add('color-active');
        document.getElementById('strokeColorInput').value = activeStyle.stroke;
        applyToSelected({ stroke: activeStyle.stroke });
      });
    });

    const strokeInput = document.getElementById('strokeColorInput');
    strokeInput?.addEventListener('input', () => {
      activeStyle.stroke = strokeInput.value;
      document.querySelectorAll('[data-color]').forEach(s => s.classList.remove('color-active'));
      applyToSelected({ stroke: activeStyle.stroke });
    });

    document.querySelectorAll('[data-fill]').forEach(btn => {
      btn.addEventListener('click', () => {
        const val = btn.dataset.fill;
        activeStyle.fill = val === 'solid'
          ? (document.getElementById('fillColorInput')?.value || '#7c3aed')
          : val;
        document.querySelectorAll('[data-fill]').forEach(b => b.classList.remove('fill-active'));
        btn.classList.add('fill-active');
        applyToSelected({ fill: activeStyle.fill });
      });
    });

    document.getElementById('fillColorInput')?.addEventListener('input', (e) => {
      // Only apply when solid fill is active (fill !== 'none')
      if (activeStyle.fill !== 'none') {
        activeStyle.fill = e.target.value;
        applyToSelected({ fill: activeStyle.fill });
      }
    });

    document.querySelectorAll('[data-sw]').forEach(btn => {
      btn.addEventListener('click', () => {
        activeStyle.width = +btn.dataset.sw;
        document.querySelectorAll('[data-sw]').forEach(b => b.classList.remove('sw-active'));
        btn.classList.add('sw-active');
        applyToSelected({ width: activeStyle.width });
      });
    });

    document.getElementById('dashToggle')?.addEventListener('click', e => {
      activeStyle.dash = !activeStyle.dash;
      e.currentTarget.classList.toggle('tool-active', activeStyle.dash);
      applyToSelected({ dash: activeStyle.dash });
    });

    const fsInput = document.getElementById('fontSizeInput');
    fsInput?.addEventListener('change', () => {
      activeStyle.fontSize = +fsInput.value || 20;
      applyToSelected({ fontSize: activeStyle.fontSize });
    });

    // Background color
    const bgInput = document.getElementById('bgColorInput');
    bgInput?.addEventListener('input', () => {
      bgColor = bgInput.value;
      render();
    });

    document.getElementById('canvasUndo')?.addEventListener('click', undo);
    document.getElementById('canvasRedo')?.addEventListener('click', redo);
    document.getElementById('canvasClear')?.addEventListener('click', () => {
      if (!elements.length) return;
      elements = []; selected = null; pushHistory(); render();
    });
    document.getElementById('canvasZoomIn')  ?.addEventListener('click', () => zoom(1.25));
    document.getElementById('canvasZoomOut') ?.addEventListener('click', () => zoom(0.8));
    document.getElementById('canvasZoomReset')?.addEventListener('click', () => { vp = { x: 0, y: 0, s: 1 }; render(); });
    document.getElementById('saveDrawingBtn')?.addEventListener('click', doSave);
    document.getElementById('cancelDrawingBtn')?.addEventListener('click', closeCanvas);
    document.getElementById('canvasCloseBtn')?.addEventListener('click', closeCanvas);
    document.getElementById('downloadDrawingBtn')?.addEventListener('click', doDownload);
  }

  function selectTool(tool) {
    activeTool = tool;
    finishText();
    document.querySelectorAll('[data-tool]').forEach(b => b.classList.toggle('tool-active', b.dataset.tool === tool));
    syncCursor();
  }

  function syncCursor() {
    const map = { select: 'default', pen: 'crosshair', rect: 'crosshair', ellipse: 'crosshair', line: 'crosshair', arrow: 'crosshair', text: 'text', eraser: 'cell' };
    canvas.style.cursor = spaceDown ? 'grab' : (map[activeTool] || 'crosshair');
  }

  function zoom(f) {
    const cx = canvas.clientWidth / 2, cy = canvas.clientHeight / 2;
    const ns = Math.max(0.1, Math.min(8, vp.s * f));
    vp.x = cx - (cx - vp.x) * (ns / vp.s);
    vp.y = cy - (cy - vp.y) * (ns / vp.s);
    vp.s = ns;
    render();
  }

  function updateZoomLabel() {
    const el = document.getElementById('canvasZoomLevel');
    if (el) el.textContent = Math.round(vp.s * 100) + '%';
  }

  /* ─── Export ──────────────────────────────────────────────────────────────── */
  function snapshot(w, h, bgColor) {
    const off = document.createElement('canvas');
    off.width  = w; off.height = h;
    const oc   = off.getContext('2d');
    const sw   = canvas.clientWidth;
    const sh   = canvas.clientHeight;
    const rx   = w / sw, ry = h / sh;

    oc.fillStyle = bgColor;
    oc.fillRect(0, 0, w, h);
    oc.save();
    oc.translate(vp.x * rx, vp.y * ry);
    oc.scale(vp.s * rx, vp.s * ry);

    // temporarily swap ctx so renderEl uses oc
    const saved = ctx;
    ctx = oc;
    elements.forEach(el => renderEl(oc, el));
    ctx = saved;

    oc.restore();
    return off;
  }

  function exportPreview() {
    const W = Math.min(canvas.clientWidth, 900);
    const H = Math.round(canvas.clientHeight * W / canvas.clientWidth);
    return snapshot(W, H).toDataURL('image/jpeg', 0.75);
  }

  function doDownload() {
    const title = document.getElementById('drawingTitle')?.value?.trim() || 'drawing';
    const W = canvas.clientWidth * 2;
    const H = canvas.clientHeight * 2;
    const off = snapshot(W, H);
    const url = off.toDataURL('image/png');
    const a   = document.createElement('a');
    a.href     = url;
    a.download = title + '.png';
    a.click();
  }

  async function doSave() {
    const btn   = document.getElementById('saveDrawingBtn');
    const title = document.getElementById('drawingTitle')?.value?.trim() || 'Untitled';
    btn.disabled    = true;
    btn.textContent = 'Saving…';
    try {
      const preview = exportPreview();
      const elemJson = JSON.stringify(elements);
      if (typeof window.CanvasApp.onSave === 'function') {
        await window.CanvasApp.onSave(title, elemJson, preview);
      }
      closeCanvas();
    } catch (e) {
      console.error(e);
    } finally {
      btn.disabled    = false;
      btn.textContent = 'Save & Share';
    }
  }
})();
