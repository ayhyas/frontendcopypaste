// ClipShare Canvas Drawing Engine
// Exposes: window.CanvasApp = { init, open, close }
// Set window.CanvasApp.onSave = async (title, elementsJson, previewDataUrl) before calling open()

(function () {
  'use strict';

  /* ─── State ───────────────────────────────────────────────────────────────── */
  let canvas, ctx, dpr, textArea;
  let elements     = [];
  let history      = ['[]'];
  let histIdx      = 0;
  let activeTool   = 'pen';
  let activeStyle  = { stroke: '#e2e8f0', fill: 'none', width: 2, dash: false, fontSize: 20 };
  const BG_COLOR   = '#0b0b16';
  let vp           = { x: 0, y: 0, s: 1 };
  let drawing      = null;
  let selection    = new Set();   // set of selected element IDs
  let clipboard    = [];          // internal copy/paste buffer (deep clones)
  let lasso        = null;        // rubber-band { x1,y1,x2,y2,additive }
  let dragOrigin   = null;        // { dx, dy, snap|snaps, isGroup }
  let resizeHandle = null;        // { handleId, originDx, originDy, snap|snaps, uBounds?, isGroup }
  let panOrigin    = null;
  let spaceDown    = false;
  let isDown       = false;
  let isOpen       = false;
  let resources    = [];

  let imgRafId     = null;
  let textFocusRaf = null;

  const imgCache   = new Map();

  /* ─── Public API ──────────────────────────────────────────────────────────── */
  window.CanvasApp = {
    init,
    open: openCanvas,
    close: closeCanvas,
    onSave: null,
    setResources(arr) {
      resources = arr || [];
      renderResPanel();
    },
  };

  function init() {
    canvas   = document.getElementById('drawingCanvas');
    ctx      = canvas.getContext('2d');
    textArea = document.getElementById('canvasTextInput');
    setupResize();
    setupEvents();
    setupToolbar();
    setupCtxMenu();
    setupFullscreen();
  }

  function openCanvas(existingElementsJson) {
    isOpen    = true;
    elements  = existingElementsJson ? JSON.parse(existingElementsJson) : [];
    history   = [JSON.stringify(elements)];
    histIdx   = 0;
    selection.clear();
    drawing   = null;
    lasso     = null;
    vp        = { x: 0, y: 0, s: 1 };
    document.getElementById('drawingTitle').value = '';
    elements.filter(el => el.type === 'image').forEach(el => loadImg(el.src));
    hideResPanel();
    document.getElementById('canvasOverlay').classList.add('canvas-overlay--open');
    resize();
    render();
  }

  function closeCanvas() {
    isOpen = false;
    finishText();
    hideCtxMenu();
    selection.clear();
    drawing  = null;
    lasso    = null;
    elements = [];
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
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

  /* ─── History ─────────────────────────────────────────────────────────────── */
  function pushHistory() {
    history = history.slice(0, histIdx + 1);
    history.push(JSON.stringify(elements));
    histIdx = history.length - 1;
  }

  function undo() {
    if (histIdx > 0) {
      histIdx--;
      elements = JSON.parse(history[histIdx]);
      selection.clear(); resizeHandle = null; dragOrigin = null;
      render();
    }
  }

  function redo() {
    if (histIdx < history.length - 1) {
      histIdx++;
      elements = JSON.parse(history[histIdx]);
      selection.clear(); resizeHandle = null; dragOrigin = null;
      render();
    }
  }

  /* ─── ID ──────────────────────────────────────────────────────────────────── */
  const genId = () => Math.random().toString(36).slice(2, 9);

  /* ─── Render ──────────────────────────────────────────────────────────────── */
  function render() {
    if (!canvas || !ctx) return;
    const W = canvas.width / dpr;
    const H = canvas.height / dpr;
    ctx.fillStyle = BG_COLOR;
    ctx.fillRect(0, 0, W, H);
    drawGrid(W, H);

    ctx.save();
    ctx.translate(vp.x, vp.y);
    ctx.scale(vp.s, vp.s);
    elements.forEach(el => renderEl(ctx, el));
    if (drawing) renderEl(ctx, drawing);
    ctx.restore();

    if (selection.size === 1) {
      const el = elements.find(e => e.id === [...selection][0]);
      if (el) drawSelBox(el);
    } else if (selection.size > 1) {
      drawGroupSelBox();
    }

    if (lasso) drawLasso();
    updateZoomLabel();
    updateSelCount();
  }

  function scheduleRender() {
    if (imgRafId) return;
    imgRafId = requestAnimationFrame(() => { imgRafId = null; render(); });
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
      case 'image':   drawImageEl(c, el); break;
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

  /* ─── Image helpers ───────────────────────────────────────────────────────── */
  function loadImg(src) {
    if (imgCache.has(src)) return imgCache.get(src);
    const img = new Image();
    img.onload = () => { imgCache.set(src, img); scheduleRender(); };
    img.src = src;
    imgCache.set(src, img);
    return img;
  }

  function drawImageEl(c, el) {
    const img = imgCache.get(el.src);
    if (!img || !img.complete || img.naturalWidth === 0) { loadImg(el.src); return; }
    c.drawImage(img, el.x, el.y, el.w, el.h);
  }

  function compressImg(dataUrl, maxPx) {
    return new Promise(resolve => {
      const img = new Image();
      img.onload = () => {
        let w = img.width, h = img.height;
        if (w > maxPx || h > maxPx) {
          if (w > h) { h = Math.round(h * maxPx / w); w = maxPx; }
          else       { w = Math.round(w * maxPx / h); h = maxPx; }
        }
        const off = document.createElement('canvas');
        off.width = w; off.height = h;
        off.getContext('2d').drawImage(img, 0, 0, w, h);
        resolve({ dataUrl: off.toDataURL('image/jpeg', 0.85), w, h });
      };
      img.src = dataUrl;
    });
  }

  /* ─── Bounds & hit-testing ────────────────────────────────────────────────── */
  function bounds(el) {
    switch (el.type) {
      case 'pen': {
        const xs = el.points.map(p => p.x), ys = el.points.map(p => p.y);
        const x  = Math.min(...xs), y = Math.min(...ys);
        return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
      }
      case 'rect': case 'ellipse': case 'image':
        return { x: el.x, y: el.y, w: el.w, h: el.h };
      case 'line': case 'arrow':
        return { x: Math.min(el.x, el.x2), y: Math.min(el.y, el.y2),
                 w: Math.abs(el.x2 - el.x), h: Math.abs(el.y2 - el.y) };
      case 'text': {
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
      case 'rect': case 'ellipse': case 'image': {
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

  /* ─── Single-element selection box & resize handles ──────────────────────── */
  const HANDLE_R   = 5;
  const HANDLE_HIT = 9;

  function getHandles(el) {
    if (el.type === 'line' || el.type === 'arrow') {
      return [
        { id: 'p1', sx: el.x  * vp.s + vp.x, sy: el.y  * vp.s + vp.y },
        { id: 'p2', sx: el.x2 * vp.s + vp.x, sy: el.y2 * vp.s + vp.y },
      ];
    }
    const b   = bounds(el);
    const pad = 8 / vp.s;
    const x1  = (b.x - pad)                  * vp.s + vp.x;
    const y1  = (b.y - pad)                  * vp.s + vp.y;
    const x2  = (b.x + Math.abs(b.w) + pad)  * vp.s + vp.x;
    const y2  = (b.y + Math.abs(b.h) + pad)  * vp.s + vp.y;
    const xm  = (x1 + x2) / 2;
    const ym  = (y1 + y2) / 2;
    return [
      { id: 'nw', sx: x1, sy: y1 }, { id: 'n', sx: xm, sy: y1 }, { id: 'ne', sx: x2, sy: y1 },
      { id: 'e',  sx: x2, sy: ym },
      { id: 'se', sx: x2, sy: y2 }, { id: 's', sx: xm, sy: y2 }, { id: 'sw', sx: x1, sy: y2 },
      { id: 'w',  sx: x1, sy: ym },
    ];
  }

  function hitHandle(el, mx, my) {
    for (const h of getHandles(el)) {
      if (Math.hypot(mx - h.sx, my - h.sy) < HANDLE_HIT) return h.id;
    }
    return null;
  }

  function handleCursor(hid) {
    return ({ nw: 'nw-resize', ne: 'ne-resize', sw: 'sw-resize', se: 'se-resize',
              n: 'n-resize', s: 's-resize', e: 'e-resize', w: 'w-resize',
              p1: 'crosshair', p2: 'crosshair' })[hid] || 'default';
  }

  function applyResize(el, snap, handleId, ddx, ddy) {
    if (handleId === 'p1') { el.x  = snap.x  + ddx; el.y  = snap.y  + ddy; return; }
    if (handleId === 'p2') { el.x2 = snap.x2 + ddx; el.y2 = snap.y2 + ddy; return; }

    const b   = bounds(snap);
    let nx1 = b.x, ny1 = b.y, nx2 = b.x + b.w, ny2 = b.y + b.h;

    switch (handleId) {
      case 'nw': nx1 += ddx; ny1 += ddy; break;
      case 'n':               ny1 += ddy; break;
      case 'ne': nx2 += ddx; ny1 += ddy; break;
      case 'e':  nx2 += ddx;             break;
      case 'se': nx2 += ddx; ny2 += ddy; break;
      case 's':               ny2 += ddy; break;
      case 'sw': nx1 += ddx; ny2 += ddy; break;
      case 'w':  nx1 += ddx;             break;
    }

    const newX = Math.min(nx1, nx2), newY = Math.min(ny1, ny2);
    const newW = Math.max(5, Math.abs(nx2 - nx1));
    const newH = Math.max(5, Math.abs(ny2 - ny1));

    switch (el.type) {
      case 'rect': case 'ellipse': case 'image':
        el.x = newX; el.y = newY; el.w = newW; el.h = newH; break;
      case 'text': {
        const sh = b.h || 1;
        el.fontSize = Math.max(8, Math.round((snap.fontSize || 20) * newH / sh));
        el.x = newX;
        el.y = newY + el.fontSize;
        break;
      }
      case 'pen': {
        const sw = b.w || 1, sh = b.h || 1;
        el.points = snap.points.map(p => ({
          x: newX + (p.x - b.x) * newW / sw,
          y: newY + (p.y - b.y) * newH / sh,
        })); break;
      }
    }
  }

  function drawSelBox(el) {
    const b   = bounds(el);
    const pad = 8 / vp.s;

    ctx.save();
    ctx.strokeStyle = '#7c3aed';
    ctx.lineWidth   = 1.5;
    ctx.setLineDash([5, 4]);

    if (el.type === 'line' || el.type === 'arrow') {
      const p1x = el.x  * vp.s + vp.x, p1y = el.y  * vp.s + vp.y;
      const p2x = el.x2 * vp.s + vp.x, p2y = el.y2 * vp.s + vp.y;
      ctx.beginPath(); ctx.moveTo(p1x, p1y); ctx.lineTo(p2x, p2y); ctx.stroke();
    } else {
      const sx = (b.x - pad) * vp.s + vp.x;
      const sy = (b.y - pad) * vp.s + vp.y;
      const sw = (Math.abs(b.w) + pad * 2) * vp.s;
      const sh = (Math.abs(b.h) + pad * 2) * vp.s;
      ctx.strokeRect(sx, sy, Math.max(sw, 20), Math.max(sh, 20));
    }

    ctx.setLineDash([]);
    getHandles(el).forEach(h => {
      ctx.beginPath();
      ctx.arc(h.sx, h.sy, HANDLE_R, 0, Math.PI * 2);
      ctx.fillStyle   = '#ffffff';
      ctx.fill();
      ctx.strokeStyle = '#7c3aed';
      ctx.lineWidth   = 1.5;
      ctx.stroke();
    });

    ctx.restore();
  }

  /* ─── Multi-selection: union bounds, group handles, group sel box ─────────── */
  function selectionBounds() {
    const els = elements.filter(e => selection.has(e.id));
    if (!els.length) return null;
    const bs  = els.map(bounds);
    const x   = Math.min(...bs.map(b => b.x));
    const y   = Math.min(...bs.map(b => b.y));
    const x2  = Math.max(...bs.map(b => b.x + Math.abs(b.w)));
    const y2  = Math.max(...bs.map(b => b.y + Math.abs(b.h)));
    return { x, y, w: x2 - x, h: y2 - y };
  }

  function getGroupHandles() {
    const b = selectionBounds();
    if (!b) return [];
    const pad = 8 / vp.s;
    const x1  = (b.x - pad) * vp.s + vp.x;
    const y1  = (b.y - pad) * vp.s + vp.y;
    const x2  = (b.x + b.w + pad) * vp.s + vp.x;
    const y2  = (b.y + b.h + pad) * vp.s + vp.y;
    const xm  = (x1 + x2) / 2;
    const ym  = (y1 + y2) / 2;
    return [
      { id: 'nw', sx: x1, sy: y1 }, { id: 'n', sx: xm, sy: y1 }, { id: 'ne', sx: x2, sy: y1 },
      { id: 'e',  sx: x2, sy: ym },
      { id: 'se', sx: x2, sy: y2 }, { id: 's', sx: xm, sy: y2 }, { id: 'sw', sx: x1, sy: y2 },
      { id: 'w',  sx: x1, sy: ym },
    ];
  }

  function hitGroupHandle(mx, my) {
    for (const h of getGroupHandles()) {
      if (Math.hypot(mx - h.sx, my - h.sy) < HANDLE_HIT) return h.id;
    }
    return null;
  }

  function drawGroupSelBox() {
    const b = selectionBounds();
    if (!b) return;
    const pad = 8 / vp.s;

    ctx.save();

    // Light per-element highlight
    ctx.strokeStyle = 'rgba(124,58,237,0.45)';
    ctx.lineWidth   = 1;
    ctx.setLineDash([3, 3]);
    elements.filter(e => selection.has(e.id)).forEach(el => {
      if (el.type === 'line' || el.type === 'arrow') {
        ctx.beginPath();
        ctx.moveTo(el.x  * vp.s + vp.x, el.y  * vp.s + vp.y);
        ctx.lineTo(el.x2 * vp.s + vp.x, el.y2 * vp.s + vp.y);
        ctx.stroke();
      } else {
        const eb   = bounds(el);
        const ipad = 4 / vp.s;
        ctx.strokeRect(
          (eb.x - ipad) * vp.s + vp.x,
          (eb.y - ipad) * vp.s + vp.y,
          (Math.abs(eb.w) + ipad * 2) * vp.s,
          (Math.abs(eb.h) + ipad * 2) * vp.s,
        );
      }
    });

    // Union bounding box
    const x1 = (b.x - pad) * vp.s + vp.x;
    const y1 = (b.y - pad) * vp.s + vp.y;
    const x2 = (b.x + b.w + pad) * vp.s + vp.x;
    const y2 = (b.y + b.h + pad) * vp.s + vp.y;

    ctx.strokeStyle = '#7c3aed';
    ctx.lineWidth   = 1.5;
    ctx.setLineDash([5, 4]);
    ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);

    // Handles on union box
    ctx.setLineDash([]);
    getGroupHandles().forEach(h => {
      ctx.beginPath();
      ctx.arc(h.sx, h.sy, HANDLE_R, 0, Math.PI * 2);
      ctx.fillStyle   = '#ffffff';
      ctx.fill();
      ctx.strokeStyle = '#7c3aed';
      ctx.lineWidth   = 1.5;
      ctx.stroke();
    });

    ctx.restore();
  }

  function drawLasso() {
    const sx1 = lasso.x1 * vp.s + vp.x;
    const sy1 = lasso.y1 * vp.s + vp.y;
    const sx2 = lasso.x2 * vp.s + vp.x;
    const sy2 = lasso.y2 * vp.s + vp.y;
    const lx  = Math.min(sx1, sx2), ly = Math.min(sy1, sy2);
    const lw  = Math.abs(sx2 - sx1), lh = Math.abs(sy2 - sy1);
    ctx.save();
    ctx.fillStyle   = 'rgba(124,58,237,0.07)';
    ctx.strokeStyle = '#7c3aed';
    ctx.lineWidth   = 1;
    ctx.setLineDash([4, 3]);
    ctx.fillRect  (lx, ly, lw, lh);
    ctx.strokeRect(lx, ly, lw, lh);
    ctx.restore();
  }

  function updateSelCount() {
    const el = document.getElementById('canvasSelCount');
    if (!el) return;
    if (selection.size > 1) {
      el.textContent  = selection.size + ' selected';
      el.style.display = '';
    } else {
      el.style.display = 'none';
    }
  }

  /* ─── Group resize (proportional scale of all selected elements) ──────────── */
  function applyGroupResize(snaps, uBounds, handleId, ddx, ddy) {
    let nx1 = uBounds.x, ny1 = uBounds.y;
    let nx2 = uBounds.x + uBounds.w, ny2 = uBounds.y + uBounds.h;
    switch (handleId) {
      case 'nw': nx1 += ddx; ny1 += ddy; break;
      case 'n':               ny1 += ddy; break;
      case 'ne': nx2 += ddx; ny1 += ddy; break;
      case 'e':  nx2 += ddx;              break;
      case 'se': nx2 += ddx; ny2 += ddy; break;
      case 's':               ny2 += ddy; break;
      case 'sw': nx1 += ddx; ny2 += ddy; break;
      case 'w':  nx1 += ddx;              break;
    }
    const newX = Math.min(nx1, nx2), newY = Math.min(ny1, ny2);
    const newW = Math.max(5, Math.abs(nx2 - nx1));
    const newH = Math.max(5, Math.abs(ny2 - ny1));
    const scX  = uBounds.w > 1 ? newW / uBounds.w : 1;
    const scY  = uBounds.h > 1 ? newH / uBounds.h : 1;

    for (const [id, snap] of Object.entries(snaps)) {
      const el = elements.find(e => e.id === id);
      if (!el) continue;
      const b = bounds(snap);
      switch (snap.type) {
        case 'rect': case 'ellipse': case 'image':
          el.x = newX + (b.x - uBounds.x) * scX;
          el.y = newY + (b.y - uBounds.y) * scY;
          el.w = Math.max(5, b.w * scX);
          el.h = Math.max(5, b.h * scY);
          break;
        case 'text':
          el.fontSize = Math.max(8, Math.round((snap.fontSize || 20) * scY));
          el.x        = newX + (b.x - uBounds.x) * scX;
          el.y        = newY + (b.y - uBounds.y) * scY + el.fontSize;
          break;
        case 'pen':
          el.points = snap.points.map(p => ({
            x: newX + (p.x - uBounds.x) * scX,
            y: newY + (p.y - uBounds.y) * scY,
          }));
          break;
        case 'line': case 'arrow':
          el.x  = newX + (snap.x  - uBounds.x) * scX;
          el.y  = newY + (snap.y  - uBounds.y) * scY;
          el.x2 = newX + (snap.x2 - uBounds.x) * scX;
          el.y2 = newY + (snap.y2 - uBounds.y) * scY;
          break;
      }
    }
  }

  /* ─── Copy / Paste / Select-all ──────────────────────────────────────────── */
  function copySelected() {
    if (!selection.size) return;
    clipboard = elements
      .filter(el => selection.has(el.id))
      .map(el => JSON.parse(JSON.stringify(el)));
  }

  function pasteClipboard() {
    if (!clipboard.length) return;
    const off = 20 / vp.s;
    selection.clear();
    clipboard.forEach(snap => {
      const clone = JSON.parse(JSON.stringify(snap));
      clone.id = genId();
      offsetEl(clone, off, off);
      elements.push(clone);
      selection.add(clone.id);
    });
    // Shift clipboard for staircase paste (like Figma)
    clipboard = clipboard.map(snap => {
      const c = JSON.parse(JSON.stringify(snap));
      offsetEl(c, off, off);
      return c;
    });
    pushHistory();
    render();
  }

  function offsetEl(el, dx, dy) {
    if (el.points) {
      el.points = el.points.map(p => ({ x: p.x + dx, y: p.y + dy }));
    } else {
      el.x = (el.x || 0) + dx;
      el.y = (el.y || 0) + dy;
    }
    if (el.x2 !== undefined) { el.x2 += dx; el.y2 += dy; }
  }

  function selectAll() {
    selection.clear();
    elements.forEach(el => selection.add(el.id));
    render();
  }

  /* ─── Events ──────────────────────────────────────────────────────────────── */
  function setupEvents() {
    canvas.addEventListener('mousedown',   onDown);
    canvas.addEventListener('mousemove',   onMove);
    canvas.addEventListener('mouseup',     onUp);
    canvas.addEventListener('mouseleave',  onUp);
    canvas.addEventListener('click',       onCanvasClick);
    canvas.addEventListener('dblclick',    onDblClick);
    canvas.addEventListener('contextmenu', onContextMenu);
    canvas.addEventListener('wheel',       onWheel, { passive: false });
    canvas.addEventListener('touchstart',  e => { e.preventDefault(); onDown(e); }, { passive: false });
    canvas.addEventListener('touchmove',   e => { e.preventDefault(); onMove(e); }, { passive: false });
    canvas.addEventListener('touchend',    e => { e.preventDefault(); onCanvasClick(e); }, { passive: false });
    document.addEventListener('keydown',   onKey);
    document.addEventListener('keyup',     e => {
      if (e.key === ' ') { spaceDown = false; syncCursor(); }
    });
    document.addEventListener('paste', onPaste);
  }

  function onKey(e) {
    if (!isOpen) return;
    const mod     = e.ctrlKey || e.metaKey;
    const focused = document.activeElement;
    const inInput = focused === textArea || focused === document.getElementById('drawingTitle');

    if (mod && e.key === 'z' && !e.shiftKey) { e.preventDefault(); undo(); return; }
    if (mod && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) { e.preventDefault(); redo(); return; }

    if (mod && e.key === 'a' && !inInput) { e.preventDefault(); selectAll(); return; }
    if (mod && e.key === 'c' && !inInput && selection.size) { e.preventDefault(); copySelected(); return; }
    if (mod && e.key === 'v' && !inInput && clipboard.length) { e.preventDefault(); pasteClipboard(); return; }

    if (mod && e.key === 'd' && !inInput && selection.size) {
      e.preventDefault(); execCtxCmd('duplicate'); return;
    }

    if ((e.key === 'Delete' || e.key === 'Backspace') && selection.size && !inInput) {
      elements = elements.filter(el => !selection.has(el.id));
      selection.clear(); pushHistory(); render(); return;
    }

    if (e.key === 'Escape') {
      hideCtxMenu();
      selection.clear(); resizeHandle = null; dragOrigin = null; lasso = null;
      finishText(); render(); return;
    }

    // Arrow-key nudge (1px; 10px with Shift)
    if (!inInput && selection.size &&
        (e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      e.preventDefault();
      const d  = e.shiftKey ? 10 : 1;
      const dx = e.key === 'ArrowLeft' ? -d : e.key === 'ArrowRight' ? d : 0;
      const dy = e.key === 'ArrowUp'   ? -d : e.key === 'ArrowDown'  ? d : 0;
      elements.filter(el => selection.has(el.id)).forEach(el => {
        const snap = JSON.parse(JSON.stringify(el));
        moveEl(el, snap, dx, dy);
      });
      pushHistory(); render(); return;
    }

    if (e.key === 'f' && !inInput && !mod) { toggleFullscreen(); return; }
    if (e.key === ' ' && !inInput) { e.preventDefault(); spaceDown = true; canvas.style.cursor = 'grab'; }

    if (!inInput && !mod) {
      const shortcuts = { v: 'select', p: 'pen', r: 'rect', e: 'ellipse', l: 'line', a: 'arrow', t: 'text', x: 'eraser' };
      if (shortcuts[e.key]) selectTool(shortcuts[e.key]);
    }
  }

  /* ─── Double-click: re-edit text ──────────────────────────────────────────── */
  function onDblClick(e) {
    if (e.button !== 0 || spaceDown) return;
    const { mx, my } = clientPos(e);
    const { x: dx, y: dy } = toDoc(mx, my);
    const id = hitTest(dx, dy);
    if (!id) return;

    const el = elements.find(el => el.id === id);
    if (!el) return;

    if (el.type === 'text') {
      finishText();
      elements = elements.filter(e => e.id !== id);
      selection.clear();
      activeStyle.fontSize = el.fontSize || 20;
      activeStyle.stroke   = el.stroke   || activeStyle.stroke;
      selectTool('text');
      const sx = el.x * vp.s + vp.x;
      const sy = el.y * vp.s + vp.y;
      placeText(sx, sy, el.x, el.y);
      textArea.value = el.text || '';
      textArea.dispatchEvent(new Event('input'));
    } else {
      finishText();
      selection.clear();
      selection.add(id);
      selectTool('select');
      syncToolbarToElement(el);
      render();
    }
  }

  /* ─── Right-click context menu ────────────────────────────────────────────── */
  function onContextMenu(e) {
    e.preventDefault();
    if (!isOpen) return;
    const { mx, my } = clientPos(e);
    const { x: dx, y: dy } = toDoc(mx, my);
    const id = hitTest(dx, dy);

    if (!id && !selection.size) { hideCtxMenu(); return; }

    if (id && !selection.has(id)) {
      selection.clear();
      selection.add(id);
      const el = elements.find(el => el.id === id);
      if (el) syncToolbarToElement(el);
      render();
    }

    const menu = document.getElementById('canvasCtxMenu');
    if (!menu) return;

    const vw = window.innerWidth, vh = window.innerHeight;
    let left = e.clientX + 4, top = e.clientY + 4;
    menu.style.display = 'block';
    const mw = menu.offsetWidth, mh = menu.offsetHeight;
    if (left + mw > vw) left = e.clientX - mw - 4;
    if (top  + mh > vh) top  = e.clientY - mh - 4;
    menu.style.left = left + 'px';
    menu.style.top  = top  + 'px';
  }

  function hideCtxMenu() {
    const menu = document.getElementById('canvasCtxMenu');
    if (menu) menu.style.display = 'none';
  }

  function execCtxCmd(cmd) {
    hideCtxMenu();
    if (!selection.size) return;

    switch (cmd) {
      case 'copy':
        copySelected();
        break;

      case 'delete':
        elements = elements.filter(el => !selection.has(el.id));
        selection.clear();
        pushHistory(); render();
        break;

      case 'duplicate': {
        const off    = 20 / vp.s;
        const newIds = [];
        elements.filter(el => selection.has(el.id)).forEach(orig => {
          const clone = JSON.parse(JSON.stringify(orig));
          clone.id    = genId();
          offsetEl(clone, off, off);
          elements.push(clone);
          newIds.push(clone.id);
        });
        selection.clear();
        newIds.forEach(id => selection.add(id));
        pushHistory(); render();
        break;
      }

      case 'front': {
        const selEls = elements.filter(el => selection.has(el.id));
        elements     = [...elements.filter(el => !selection.has(el.id)), ...selEls];
        pushHistory(); render();
        break;
      }

      case 'forward': {
        // Move each selected element one step toward front, preserving relative order among selected
        const arr = [...elements];
        for (let i = arr.length - 2; i >= 0; i--) {
          if (selection.has(arr[i].id) && !selection.has(arr[i + 1].id)) {
            [arr[i], arr[i + 1]] = [arr[i + 1], arr[i]];
          }
        }
        elements = arr;
        pushHistory(); render();
        break;
      }

      case 'backward': {
        const arr = [...elements];
        for (let i = 1; i < arr.length; i++) {
          if (selection.has(arr[i].id) && !selection.has(arr[i - 1].id)) {
            [arr[i], arr[i - 1]] = [arr[i - 1], arr[i]];
          }
        }
        elements = arr;
        pushHistory(); render();
        break;
      }

      case 'back': {
        const selEls = elements.filter(el => selection.has(el.id));
        elements     = [...selEls, ...elements.filter(el => !selection.has(el.id))];
        pushHistory(); render();
        break;
      }

      case 'select-all':
        selectAll();
        break;
    }
  }

  function setupCtxMenu() {
    const menu = document.getElementById('canvasCtxMenu');
    if (!menu) return;
    menu.addEventListener('click', e => {
      const btn = e.target.closest('[data-cmd]');
      if (btn) execCtxCmd(btn.dataset.cmd);
    });
    document.addEventListener('mousedown', e => {
      if (menu.style.display !== 'none' && !menu.contains(e.target)) hideCtxMenu();
    }, true);
  }

  /* ─── Fullscreen ──────────────────────────────────────────────────────────── */
  function setupFullscreen() {
    document.getElementById('canvasFullscreenBtn')
      ?.addEventListener('click', toggleFullscreen);

    document.addEventListener('fullscreenchange', () => {
      updateFullscreenBtn();
      requestAnimationFrame(() => { resize(); render(); });
    });
  }

  function toggleFullscreen() {
    const overlay = document.getElementById('canvasOverlay');
    if (!document.fullscreenElement) {
      overlay.requestFullscreen({ navigationUI: 'hide' }).catch(() => {});
    } else {
      document.exitFullscreen().catch(() => {});
    }
  }

  function updateFullscreenBtn() {
    const btn = document.getElementById('canvasFullscreenBtn');
    if (!btn) return;
    const isFs = !!document.fullscreenElement;
    btn.title = isFs ? 'Exit fullscreen (F)' : 'Fullscreen (F)';
    const svg = btn.querySelector('svg');
    if (!svg) return;
    svg.innerHTML = isFs
      ? `<polyline points="8 3 3 3 3 8"/><polyline points="21 3 16 3 16 8"/><polyline points="3 16 3 21 8 21"/><polyline points="16 21 21 21 21 16"/>`
      : `<polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/>`;
  }

  /* ─── Text tool click ─────────────────────────────────────────────────────── */
  function onCanvasClick(e) {
    if (activeTool !== 'text' || spaceDown || e.button === 2) return;
    const { mx, my } = clientPos(e);
    const { x: dx, y: dy } = toDoc(mx, my);
    placeText(mx, my, dx, dy);
  }

  /* ─── Mouse down ──────────────────────────────────────────────────────────── */
  function onDown(e) {
    if (e.button === 2) return;
    if (activeTool === 'text') return;
    hideCtxMenu();
    isDown = true;
    const { mx, my } = clientPos(e);

    if (spaceDown || e.button === 1) {
      panOrigin = { mx, my, vx: vp.x, vy: vp.y };
      canvas.style.cursor = 'grabbing';
      return;
    }

    const { x: dx, y: dy } = toDoc(mx, my);

    if (activeTool === 'select') {
      resizeHandle = null; dragOrigin = null; lasso = null;

      // Check group resize handles first (multi-selection)
      if (selection.size > 1) {
        const h = hitGroupHandle(mx, my);
        if (h) {
          const snaps = {};
          [...selection].forEach(id => {
            const el = elements.find(e => e.id === id);
            if (el) snaps[id] = JSON.parse(JSON.stringify(el));
          });
          resizeHandle = { handleId: h, originDx: dx, originDy: dy, snaps, uBounds: selectionBounds(), isGroup: true };
          return;
        }
      }

      // Single-element resize handles
      if (selection.size === 1) {
        const selId = [...selection][0];
        const selEl = elements.find(el => el.id === selId);
        if (selEl) {
          const h = hitHandle(selEl, mx, my);
          if (h) {
            resizeHandle = { handleId: h, originDx: dx, originDy: dy, snap: JSON.parse(JSON.stringify(selEl)), isGroup: false };
            return;
          }
        }
      }

      const id = hitTest(dx, dy);

      if (id) {
        if (e.shiftKey) {
          // Shift+click toggles element in/out of selection — no drag
          if (selection.has(id)) selection.delete(id);
          else selection.add(id);
          render();
          return;
        }

        // Click on unselected element → replace selection
        if (!selection.has(id)) {
          selection.clear();
          selection.add(id);
          const el = elements.find(el => el.id === id);
          if (el) syncToolbarToElement(el);
        }

        // Start drag for all selected
        if (selection.size > 1) {
          const snaps = {};
          [...selection].forEach(sid => {
            const el = elements.find(e => e.id === sid);
            if (el) snaps[sid] = JSON.parse(JSON.stringify(el));
          });
          dragOrigin = { dx, dy, snaps, isGroup: true };
        } else {
          const el = elements.find(el => el.id === id);
          if (el) {
            dragOrigin = { dx, dy, snap: JSON.parse(JSON.stringify(el)), isGroup: false };
            syncToolbarToElement(el);
          }
        }
      } else {
        // Empty space — clear selection (unless shift) and start lasso
        if (!e.shiftKey) selection.clear();
        lasso = { x1: dx, y1: dy, x2: dx, y2: dy, additive: e.shiftKey };
      }

      render();
      return;
    }

    if (activeTool === 'eraser') { eraseAt(dx, dy); return; }

    const base = { id: genId(), stroke: activeStyle.stroke, fill: activeStyle.fill, width: activeStyle.width, dash: activeStyle.dash, opacity: 1 };
    if (activeTool === 'pen')
      drawing = { ...base, type: 'pen', points: [{ x: dx, y: dy }] };
    else if (activeTool === 'rect' || activeTool === 'ellipse')
      drawing = { ...base, type: activeTool, x: dx, y: dy, w: 0, h: 0 };
    else if (activeTool === 'line' || activeTool === 'arrow')
      drawing = { ...base, type: activeTool, x: dx, y: dy, x2: dx, y2: dy };
  }

  /* ─── Mouse move ──────────────────────────────────────────────────────────── */
  function onMove(e) {
    const { mx, my } = clientPos(e);

    // Hover cursor
    if (!isDown && activeTool === 'select' && !spaceDown) {
      if (selection.size > 1) {
        const h = hitGroupHandle(mx, my);
        canvas.style.cursor = h ? handleCursor(h) : 'default';
      } else if (selection.size === 1) {
        const selId = [...selection][0];
        const el    = elements.find(el => el.id === selId);
        if (el) {
          const h = hitHandle(el, mx, my);
          canvas.style.cursor = h ? handleCursor(h) : 'default';
        }
      }
    }

    if (!isDown) return;

    if (panOrigin) {
      vp.x = panOrigin.vx + mx - panOrigin.mx;
      vp.y = panOrigin.vy + my - panOrigin.my;
      render();
      return;
    }

    const { x: dx, y: dy } = toDoc(mx, my);

    if (activeTool === 'select') {
      if (lasso) {
        lasso.x2 = dx; lasso.y2 = dy;
        render();
        return;
      }

      if (resizeHandle) {
        const ddx = dx - resizeHandle.originDx;
        const ddy = dy - resizeHandle.originDy;
        if (resizeHandle.isGroup) {
          applyGroupResize(resizeHandle.snaps, resizeHandle.uBounds, resizeHandle.handleId, ddx, ddy);
        } else {
          const selId = [...selection][0];
          const el    = elements.find(e => e.id === selId);
          if (el) applyResize(el, resizeHandle.snap, resizeHandle.handleId, ddx, ddy);
        }
        render();
        return;
      }

      if (dragOrigin) {
        const ddx = dx - dragOrigin.dx;
        const ddy = dy - dragOrigin.dy;
        if (dragOrigin.isGroup) {
          Object.entries(dragOrigin.snaps).forEach(([id, snap]) => {
            const el = elements.find(e => e.id === id);
            if (el) moveEl(el, snap, ddx, ddy);
          });
        } else {
          const selId = [...selection][0];
          const el    = elements.find(e => e.id === selId);
          if (el) moveEl(el, dragOrigin.snap, ddx, ddy);
        }
        render();
        return;
      }
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

  /* ─── Mouse up ────────────────────────────────────────────────────────────── */
  function onUp() {
    if (!isDown) return;
    isDown = false;

    if (panOrigin) { panOrigin = null; syncCursor(); return; }

    if (activeTool === 'select') {
      if (lasso) {
        // Select all elements whose bounds overlap with the lasso rect
        const x1 = Math.min(lasso.x1, lasso.x2);
        const y1 = Math.min(lasso.y1, lasso.y2);
        const x2 = Math.max(lasso.x1, lasso.x2);
        const y2 = Math.max(lasso.y1, lasso.y2);

        if (!lasso.additive) selection.clear();

        // Only select if lasso has meaningful size (prevents accidental select-all on click)
        if (Math.abs(x2 - x1) > 2 || Math.abs(y2 - y1) > 2) {
          elements.forEach(el => {
            const b   = bounds(el);
            const ex1 = b.x, ey1 = b.y;
            const ex2 = b.x + Math.abs(b.w), ey2 = b.y + Math.abs(b.h);
            if (ex2 >= x1 && ex1 <= x2 && ey2 >= y1 && ey1 <= y2) selection.add(el.id);
          });
        }

        lasso = null;
        render();
        return;
      }

      if (resizeHandle) { pushHistory(); resizeHandle = null; syncCursor(); return; }
      if (dragOrigin)   { pushHistory(); dragOrigin   = null; return; }
      return;
    }

    if (!drawing) return;
    const el = drawing;
    drawing  = null;

    if (el.type === 'pen' && el.points.length < 3) { render(); return; }
    if ((el.type === 'rect' || el.type === 'ellipse') && Math.abs(el.w) < 3 && Math.abs(el.h) < 3) { render(); return; }
    if ((el.type === 'line' || el.type === 'arrow') && Math.abs(el.x2 - el.x) < 3 && Math.abs(el.y2 - el.y) < 3) { render(); return; }

    elements.push(el);
    selection.clear();
    selection.add(el.id);
    selectTool('select');
    pushHistory();
    render();
  }

  /* ─── Wheel: zoom & pan ───────────────────────────────────────────────────── */
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
      selection.delete(id);
      pushHistory();
      render();
    }
  }

  function moveEl(el, snap, ddx, ddy) {
    switch (el.type) {
      case 'pen':
        el.points = snap.points.map(p => ({ x: p.x + ddx, y: p.y + ddy }));
        break;
      case 'rect': case 'ellipse': case 'text': case 'image':
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
    if (textArea.style.display === 'block') {
      if (textArea.value.trim()) commitText();
      else finishText();
    }

    const fs    = activeStyle.fontSize * vp.s;
    const lineH = fs * 1.35;

    textArea.style.display    = 'block';
    textArea.style.left       = mx + 'px';
    textArea.style.top        = (my - fs * 0.82) + 'px';
    textArea.style.fontSize   = fs + 'px';
    textArea.style.lineHeight = lineH + 'px';
    textArea.style.color      = activeStyle.stroke;
    textArea.style.width      = '4px';
    textArea.style.height     = lineH + 'px';
    textArea.dataset.dx       = dx;
    textArea.dataset.dy       = dy;
    textArea.dataset.fontSize = activeStyle.fontSize;
    textArea.dataset.stroke   = activeStyle.stroke;
    textArea.value            = '';

    function grow() {
      textArea.style.height = 'auto';
      textArea.style.height = Math.max(lineH, textArea.scrollHeight) + 'px';
      textArea.style.width  = Math.max(2, textArea.scrollWidth + 4) + 'px';
    }

    textArea.oninput = () => { grow(); };
    textArea.onblur  = () => {
      if (textArea.value.trim()) commitText();
      else finishText();
      render();
    };
    textArea.onkeydown = e => {
      if (e.key === 'Escape') { e.preventDefault(); finishText(); render(); return; }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (textArea.value.trim()) commitText();
        else finishText();
        render();
      }
    };

    if (textFocusRaf) { cancelAnimationFrame(textFocusRaf); textFocusRaf = null; }
    textFocusRaf = requestAnimationFrame(() => { textFocusRaf = null; textArea.focus(); });
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
    if (textFocusRaf) { cancelAnimationFrame(textFocusRaf); textFocusRaf = null; }
    drawing = null;
    if (!textArea) return;
    textArea.style.display = 'none';
    textArea.value         = '';
    textArea.oninput       = null;
    textArea.onblur        = null;
    textArea.onkeydown     = null;
  }

  /* ─── Toolbar sync ────────────────────────────────────────────────────────── */
  function syncToolbarToElement(el) {
    if (!el) return;
    if (el.stroke) {
      activeStyle.stroke = el.stroke;
      document.querySelectorAll('[data-color]').forEach(s => s.classList.toggle('color-active', s.dataset.color === el.stroke));
      const si = document.getElementById('strokeColorInput');
      if (si) si.value = el.stroke;
    }
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
    if (el.width !== undefined) {
      activeStyle.width = el.width;
      document.querySelectorAll('[data-sw]').forEach(b => b.classList.toggle('sw-active', +b.dataset.sw === el.width));
    }
    if (el.dash !== undefined) {
      activeStyle.dash = !!el.dash;
      document.getElementById('dashToggle')?.classList.toggle('tool-active', activeStyle.dash);
    }
    if (el.fontSize) {
      activeStyle.fontSize = el.fontSize;
      const fi = document.getElementById('fontSizeInput');
      if (fi) fi.value = el.fontSize;
    }
  }

  // Apply style props to ALL selected elements
  function applyToSelected(props) {
    if (!selection.size) return;
    elements.filter(el => selection.has(el.id)).forEach(el => Object.assign(el, props));
    pushHistory();
    render();
  }

  /* ─── Paste image from clipboard ─────────────────────────────────────────── */
  async function onPaste(e) {
    if (!isOpen) return;
    const focused = document.activeElement;
    if (focused && focused !== canvas && focused !== document.body) return;
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of Array.from(items)) {
      if (!item.type.startsWith('image/')) continue;
      e.preventDefault();
      const blob   = item.getAsFile();
      const reader = new FileReader();
      reader.onload = async (ev) => {
        const { dataUrl, w, h } = await compressImg(ev.target.result, 1000);
        const { x: cx, y: cy } = toDoc(canvas.clientWidth / 2, canvas.clientHeight / 2);
        const img = new Image();
        img.onload = () => {
          imgCache.set(dataUrl, img);
          elements.push({ id: genId(), type: 'image', x: cx - w/2, y: cy - h/2, w, h, src: dataUrl, opacity: 1 });
          pushHistory();
          render();
        };
        img.src = dataUrl;
      };
      reader.readAsDataURL(blob);
      break;
    }
  }

  /* ─── Resources panel ─────────────────────────────────────────────────────── */
  function hideResPanel() {
    const panel = document.getElementById('canvasResPanel');
    if (panel) panel.classList.remove('canvas-res-panel--open');
  }

  function renderResPanel() {
    const body = document.getElementById('canvasResPanelBody');
    if (!body) return;
    body.innerHTML = '';
    if (!resources.length) {
      body.innerHTML = '<p class="canvas-res-empty">No resources yet.<br>Add images or text in the Resources tab.</p>';
      return;
    }
    resources.forEach(r => {
      const item = document.createElement('div');
      item.className = 'canvas-res-item canvas-res-item--' + r.type;
      item.title     = r.name || (r.type === 'image' ? 'Image' : r.content.slice(0, 40));
      if (r.type === 'image') {
        const img = document.createElement('img');
        img.src = r.content; img.alt = r.name || 'Resource';
        item.appendChild(img);
      } else {
        item.textContent = r.content.length > 80 ? r.content.slice(0, 80) + '…' : r.content;
      }
      item.addEventListener('click', () => addResourceToCanvas(r));
      body.appendChild(item);
    });
  }

  function addResourceToCanvas(r) {
    const cx = canvas.clientWidth / 2, cy = canvas.clientHeight / 2;
    const { x: dx, y: dy } = toDoc(cx, cy);
    if (r.type === 'image') {
      const cached = imgCache.get(r.content);
      const w = cached ? Math.min(cached.naturalWidth, 400) : 300;
      const h = cached ? Math.min(cached.naturalHeight, 400 * (cached.naturalHeight / (cached.naturalWidth || 1))) : 200;
      loadImg(r.content);
      elements.push({ id: genId(), type: 'image', x: dx - w/2, y: dy - h/2, w, h, src: r.content, opacity: 1 });
    } else {
      elements.push({ id: genId(), type: 'text', x: dx, y: dy,
                      text: r.content, stroke: activeStyle.stroke,
                      fontSize: activeStyle.fontSize, fill: 'none', width: 1, dash: false, opacity: 1 });
    }
    pushHistory();
    render();
  }

  /* ─── Toolbar setup ───────────────────────────────────────────────────────── */
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

    document.getElementById('strokeColorInput')?.addEventListener('input', e => {
      activeStyle.stroke = e.target.value;
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

    document.getElementById('fillColorInput')?.addEventListener('input', e => {
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

    document.getElementById('fontSizeInput')?.addEventListener('change', e => {
      activeStyle.fontSize = +e.target.value || 20;
      applyToSelected({ fontSize: activeStyle.fontSize });
    });

    document.getElementById('canvasResBtn')?.addEventListener('click', () => {
      const panel = document.getElementById('canvasResPanel');
      if (!panel) return;
      panel.classList.toggle('canvas-res-panel--open');
      if (panel.classList.contains('canvas-res-panel--open')) renderResPanel();
    });
    document.getElementById('canvasResClose')?.addEventListener('click', hideResPanel);

    document.getElementById('canvasUndo') ?.addEventListener('click', undo);
    document.getElementById('canvasRedo') ?.addEventListener('click', redo);
    document.getElementById('canvasClear')?.addEventListener('click', () => {
      if (!elements.length) return;
      elements = []; selection.clear(); pushHistory(); render();
    });
    document.getElementById('canvasZoomIn')   ?.addEventListener('click', () => zoom(1.25));
    document.getElementById('canvasZoomOut')  ?.addEventListener('click', () => zoom(0.8));
    document.getElementById('canvasZoomReset')?.addEventListener('click', () => { vp = { x: 0, y: 0, s: 1 }; render(); });
    document.getElementById('saveDrawingBtn')    ?.addEventListener('click', doSave);
    document.getElementById('cancelDrawingBtn')  ?.addEventListener('click', closeCanvas);
    document.getElementById('canvasCloseBtn')    ?.addEventListener('click', closeCanvas);
    document.getElementById('downloadDrawingBtn')?.addEventListener('click', doDownload);
  }

  function selectTool(tool) {
    activeTool = tool;
    finishText();
    document.querySelectorAll('[data-tool]').forEach(b => b.classList.toggle('tool-active', b.dataset.tool === tool));
    const fg = document.getElementById('fontSizeGroup');
    if (fg) fg.style.display = tool === 'text' ? '' : 'none';
    syncCursor();
  }

  function syncCursor() {
    const map = { select: 'default', pen: 'crosshair', rect: 'crosshair', ellipse: 'crosshair',
                  line: 'crosshair', arrow: 'crosshair', text: 'text', eraser: 'cell' };
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
  function snapshot(w, h) {
    const off = document.createElement('canvas');
    off.width = w; off.height = h;
    const oc  = off.getContext('2d');
    const rx  = w / canvas.clientWidth, ry = h / canvas.clientHeight;

    oc.fillStyle = BG_COLOR;
    oc.fillRect(0, 0, w, h);
    oc.save();
    oc.translate(vp.x * rx, vp.y * ry);
    oc.scale(vp.s * rx, vp.s * ry);

    const saved = ctx; ctx = oc;
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
    const off = snapshot(canvas.clientWidth * 2, canvas.clientHeight * 2);
    const a   = document.createElement('a');
    a.href     = off.toDataURL('image/png');
    a.download = title + '.png';
    a.click();
  }

  async function doSave() {
    const btn   = document.getElementById('saveDrawingBtn');
    const title = document.getElementById('drawingTitle')?.value?.trim() || 'Untitled';
    btn.disabled    = true;
    btn.textContent = 'Saving…';
    try {
      if (typeof window.CanvasApp.onSave === 'function') {
        await window.CanvasApp.onSave(title, JSON.stringify(elements), exportPreview());
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
