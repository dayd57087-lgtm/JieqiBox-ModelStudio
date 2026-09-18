/* 模型工坊 —— 采集 · 标注 · 训练
 *
 * 设计取舍：
 *  - 逐格分类，不做整图检测。棋盘是固定的 9×10 晶格，格子位置由 lattice.js
 *    从截图里拟合出来（亚像素精度），所以识别问题退化成「这一格是什么子」。
 *    好处是模型小、训得快、几百张图就够，而且能在手机上真训。
 *  - 标注用「笔刷」模型：先选棋子，再在盘面上把该棋子的所有位置点一遍。
 *    比一格一格弹菜单快得多，90 格通常 30 秒内完成。
 *  - 标注与截图分开存：截图存 IndexedDB，标注跟着截图记录走。
 */
(function () {
  'use strict';

  // ---------------------------------------------------------------- 常量

  var COLS = 9, ROWS = 10, CELLS = COLS * ROWS;

  // 类别与笔刷（顺序即标签号，0 必须是 empty）
  var CLASSES = [
    { id: 'empty', g: '空', k: 'e' },
    { id: 'r_general', g: '帅', k: 'r' }, { id: 'r_advisor', g: '仕', k: 'r' },
    { id: 'r_elephant', g: '相', k: 'r' }, { id: 'r_horse', g: '马', k: 'r' },
    { id: 'r_chariot', g: '车', k: 'r' }, { id: 'r_cannon', g: '炮', k: 'r' },
    { id: 'r_soldier', g: '兵', k: 'r' },
    { id: 'b_general', g: '将', k: 'b' }, { id: 'b_advisor', g: '士', k: 'b' },
    { id: 'b_elephant', g: '象', k: 'b' }, { id: 'b_horse', g: '马', k: 'b' },
    { id: 'b_chariot', g: '车', k: 'b' }, { id: 'b_cannon', g: '炮', k: 'b' },
    { id: 'b_soldier', g: '卒', k: 'b' },
    { id: 'dark', g: '暗', k: 'd' }
  ];
  var LABEL_IDS = CLASSES.map(function (c) { return c.id; });
  var NC = CLASSES.length;

  var MAX_EDGE = 1600;      // 导入时把长边压到这个尺寸，切片够用又不吃内存
  var CROP_K = 1.14;        // 裁切框 = 格子尺寸 × 这个系数，留一点上下文

  // ---------------------------------------------------------------- 工具
  var $ = function (id) { return document.getElementById(id); };

  var toastTimer = null;
  function toast(msg, ms) {
    var t = $('toast');
    t.textContent = msg;
    t.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('on'); }, ms || 2000);
  }

  var logLines = [];
  function log(msg) {
    logLines.push(msg);
    if (logLines.length > 300) logLines.shift();
    var el = $('log');
    if (el) el.textContent = logLines.join('\n');
  }

  function native() {
    return (typeof window.StudioNative !== 'undefined') ? window.StudioNative : null;
  }

  function fmt(n, d) { return Number(n).toFixed(d === undefined ? 2 : d); }

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

  /** 让出主线程，让界面能重绘。
   *  不能直接用 tf.nextFrame()：它等的是 requestAnimationFrame，而页面不可见时
   *  rAF 根本不触发，训练会永久卡在第一个让步点上。这里让 rAF 和定时器赛跑。 */
  function yieldTick() {
    return new Promise(function (resolve) {
      var done = false;
      var finish = function () { if (!done) { done = true; resolve(); } };
      if (typeof requestAnimationFrame === 'function') {
        try { requestAnimationFrame(finish); } catch (e) { }
      }
      setTimeout(finish, 40);
    });
  }

  function loadImage(src) {
    return new Promise(function (res, rej) {
      var im = new Image();
      im.onload = function () { res(im); };
      im.onerror = function () { rej(new Error('图片加载失败')); };
      im.src = src;
    });
  }

  function canvasToBlob(cv, type, q) {
    return new Promise(function (res) {
      cv.toBlob(function (b) { res(b); }, type || 'image/jpeg', q === undefined ? 0.86 : q);
    });
  }

  function abToBase64(buf) {
    var bytes = new Uint8Array(buf), s = '', CH = 0x8000;
    for (var i = 0; i < bytes.length; i += CH) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
    }
    return btoa(s);
  }

  function strToBase64(str) {
    return abToBase64(new TextEncoder().encode(str).buffer);
  }

  // ---------------------------------------------------------------- 存储
  var DB_NAME = 'model-studio', STORE = 'samples', dbPromise = null;

  function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (res, rej) {
      var r = indexedDB.open(DB_NAME, 1);
      r.onupgradeneeded = function () {
        var db = r.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'key' });
      };
      r.onsuccess = function () { res(r.result); };
      r.onerror = function () { rej(r.error); };
    });
    return dbPromise;
  }

  function tx(mode, fn) {
    return openDB().then(function (db) {
      return new Promise(function (res, rej) {
        var t = db.transaction(STORE, mode);
        var store = t.objectStore(STORE);
        var out = fn(store);
        t.oncomplete = function () { res(out && out.result !== undefined ? out.result : out); };
        t.onerror = function () { rej(t.error); };
      });
    });
  }

  function dbAll() { return tx('readonly', function (s) { return s.getAll(); }); }
  function dbPut(rec) { return tx('readwrite', function (s) { return s.put(rec); }); }
  function dbDel(key) { return tx('readwrite', function (s) { return s.delete(key); }); }
  function dbClear() { return tx('readwrite', function (s) { return s.clear(); }); }

  // ---------------------------------------------------------------- 状态
  var samples = [];         // 内存中的样本列表（含 blob）
  var current = -1;         // 当前标注的样本下标
  var mode = 'paint';       // paint | draw | nudge
  var brush = 0;            // 当前笔刷的类别索引
  var drawStart = null, drawNow = null, nudgeRef = null;
  var grayCache = { key: null, gray: null, w: 0, h: 0 };
  var model = null, inSize = 32, stopFlag = false;

  var stage = null, sctx = null, dpr = window.devicePixelRatio || 1;
  // 取景状态：把图片的某一块映射到舞台盒子里
  var view = { key: null, boxW: 0, boxH: 0, imgW: 0, imgH: 0, fit: 1, zoom: 1, panX: 0, panY: 0 };

  // ---------------------------------------------------------------- 标签页
  var tabs = ['samples', 'annotate', 'train', 'models'];
  function showTab(name) {
    tabs.forEach(function (t) {
      $('tab-' + t).classList.toggle('on', t === name);
    });
    Array.prototype.forEach.call(document.querySelectorAll('.tabs button'), function (b) {
      b.classList.toggle('on', b.dataset.tab === name);
    });
    if (name === 'annotate') renderStage();
    if (name === 'train') refreshTrainTab();
    if (name === 'models') renderModels();
  }
  Array.prototype.forEach.call(document.querySelectorAll('.tabs button'), function (b) {
    b.addEventListener('click', function () { showTab(b.dataset.tab); });
  });
  window.onAndroidBack = function () {
    var on = document.querySelector('.tab.on');
    if (on && on.id !== 'tab-samples') { showTab('samples'); return true; }
    return false;
  };

  // ---------------------------------------------------------------- 样本管理
  function sampleKey(file) {
    return [file.name || 'img', file.size || 0, file.lastModified || 0].join('|');
  }

  async function importFiles(files) {
    if (!files || !files.length) return;
    var added = 0, reused = 0;
    for (var i = 0; i < files.length; i++) {
      var f = files[i];
      // SAF 选出来的 content:// 常常报空 MIME，只按 type 判断会把整批图静默丢掉
      var looksImage = !f.type || /^image\//.test(f.type) || /\.(png|jpe?g|webp|bmp|gif)$/i.test(f.name || '');
      if (!looksImage) continue;
      var key = sampleKey(f);
      var existed = samples.find(function (s) { return s.key === key; });
      if (existed) { reused++; continue; }

      try {
        var url = URL.createObjectURL(f);
        var im = await loadImage(url);
        URL.revokeObjectURL(url);

        // 压到 MAX_EDGE，省内存也省 IndexedDB 配额；格子 ~160px 足够切 32×32
        var sc = Math.min(1, MAX_EDGE / Math.max(im.naturalWidth, im.naturalHeight));
        var w = Math.round(im.naturalWidth * sc), h = Math.round(im.naturalHeight * sc);
        var cv = document.createElement('canvas');
        cv.width = w; cv.height = h;
        cv.getContext('2d').drawImage(im, 0, 0, w, h);
        var blob = await canvasToBlob(cv, 'image/jpeg', 0.88);

        var tw = 160, th = Math.max(1, Math.round(h * (tw / w)));
        var tc = document.createElement('canvas');
        tc.width = tw; tc.height = th;
        tc.getContext('2d').drawImage(cv, 0, 0, tw, th);
        var thumb = tc.toDataURL('image/jpeg', 0.7);

        var rec = {
          key: key, name: f.name || ('图片 ' + (samples.length + 1)),
          w: w, h: h, thumb: thumb, blob: blob,
          lattice: null, cells: null, conf: 0
        };
        await dbPut(rec);
        samples.push(rec);
        added++;
      } catch (e) {
        log('导入失败 ' + (f.name || '') + '：' + e.message);
      }
      if (i % 5 === 4) await new Promise(function (r) { setTimeout(r, 0); });
    }
    renderSamples();
    toast('导入 ' + added + ' 张' + (reused ? '，跳过重复 ' + reused + ' 张' : ''));
  }

  function annotatedCount(s) {
    if (!s.cells) return 0;
    var n = 0;
    for (var i = 0; i < CELLS; i++) if (s.cells[i] > 0) n++;
    return n;
  }

  function renderSamples() {
    var grid = $('sampleGrid');
    grid.innerHTML = '';
    var done = 0;
    samples.forEach(function (s, i) {
      if (s.lattice && s.cells) done++;
      var el = document.createElement('button');
      el.className = 'sample' + (i === current ? ' sel' : '') + (s.lattice && s.cells ? ' done' : '');
      var st = s.lattice
        ? (s.cells ? '已标注 ' + annotatedCount(s) + ' 子' : '待标注')
        : '未标定';
      el.innerHTML =
        '<img src="' + s.thumb + '" alt="">' +
        '<div class="cap"><div class="nm">' + escapeHtml(s.name) + '</div>' +
        '<div class="st">' + st + '</div></div>' +
        '<span class="del" role="button">×</span>';
      el.addEventListener('click', function (ev) {
        if (ev.target.classList.contains('del')) {
          ev.stopPropagation();
          removeSample(s.key);
          return;
        }
        current = i;
        mode = s.lattice ? 'paint' : 'draw';
        updateModeButtons();
        showTab('annotate');
        renderStage();
      });
      grid.appendChild(el);
    });
    $('sampleSummary').innerHTML = samples.length
      ? '共 <b>' + samples.length + '</b> 张截图，其中 <b>' + done + '</b> 张已标定。已标注的非空格子会用于训练。'
      : '还没有样本。导入对局截图，或先点「生成演示局面」验证整条链路。';
    $('annotateEmpty').hidden = samples.length > 0;
    $('annotateBody').hidden = samples.length === 0;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  async function removeSample(key) {
    await dbDel(key);
    var i = samples.findIndex(function (s) { return s.key === key; });
    if (i >= 0) samples.splice(i, 1);
    if (current >= samples.length) current = samples.length - 1;
    renderSamples();
  }

  $('btnImport').addEventListener('click', function () { $('fileInput').click(); });
  $('fileInput').addEventListener('change', function (e) {
    importFiles(e.target.files);
    e.target.value = '';
  });
  $('btnClearSamples').addEventListener('click', async function () {
    if (!confirm('删除全部样本和标注？')) return;
    await dbClear();
    samples = [];
    current = -1;
    renderSamples();
    toast('已清空');
  });

  // ---------------------------------------------------------------- 演示局面
  // 用内置棋盘图合成带标注的样本，让用户在没有任何截图之前就能跑通全流程。
  var boardImg = null;
  var GT = { x0: 46.5, dx: 93.75, y0: 46.5, dy: 93.7778, W: 844, H: 938 };

  async function generateDemo(n) {
    if (!boardImg) boardImg = await loadImage('xiangqi.png');
    var added = 0;
    for (var k = 0; k < n; k++) {
      var W = 1080, H = 2340;
      var s = 1.0 + Math.random() * 0.16;
      var bw = GT.W * s, bh = GT.H * s;
      var ox = Math.round((W - bw) / 2 + (Math.random() - 0.5) * 30);
      var oy = Math.round(180 + Math.random() * 140);

      var cv = document.createElement('canvas');
      cv.width = W; cv.height = H;
      var c = cv.getContext('2d');
      c.fillStyle = '#2b2f36'; c.fillRect(0, 0, W, H);
      c.fillStyle = '#1e2127'; c.fillRect(0, 0, W, 190);
      c.fillStyle = '#111'; c.fillRect(0, H - 120, W, 120);
      c.drawImage(boardImg, ox, oy, bw, bh);

      // 随机摆子
      var cells = new Array(CELLS).fill(0);
      var order = Array.from({ length: CELLS }, function (_, i) { return i; });
      for (var i = order.length - 1; i > 0; i--) {
        var j = Math.floor(Math.random() * (i + 1));
        var t = order[i]; order[i] = order[j]; order[j] = t;
      }
      var count = 20 + Math.floor(Math.random() * 14);
      for (var m = 0; m < count; m++) {
        var cell = order[m];
        var r = Math.floor(cell / COLS), col = cell % COLS;
        var red = Math.random() < 0.5;
        var isDark = Math.random() < 0.3;
        var cls = isDark ? 15 : (red ? 1 + Math.floor(Math.random() * 7) : 8 + Math.floor(Math.random() * 7));
        cells[cell] = cls;
        drawPieceDemo(c, ox + (GT.x0 + col * GT.dx) * s, oy + (GT.y0 + r * GT.dy) * s, GT.dx * s, cls);
      }

      var blob = await canvasToBlob(cv, 'image/jpeg', 0.88);
      var tc = document.createElement('canvas');
      tc.width = 160; tc.height = Math.round(160 * H / W);
      tc.getContext('2d').drawImage(cv, 0, 0, tc.width, tc.height);

      var rec = {
        key: 'demo-' + Date.now() + '-' + k + '-' + Math.random().toString(36).slice(2, 7),
        name: '演示局面 ' + (k + 1),
        w: W, h: H, thumb: tc.toDataURL('image/jpeg', 0.7), blob: blob,
        lattice: {
          x0: (ox + GT.x0 * s) / W, dx: (GT.dx * s) / W,
          y0: (oy + GT.y0 * s) / H, dy: (GT.dy * s) / H
        },
        cells: cells, conf: 99
      };
      await dbPut(rec);
      samples.push(rec);
      added++;
      if (k % 5 === 4) await new Promise(function (r) { setTimeout(r, 0); });
    }
    renderSamples();
    toast('生成 ' + added + ' 个演示局面（已带标注）');
  }

  function drawPieceDemo(ctx, cx, cy, d, cls) {
    var R = d * 0.46;
    var red = cls >= 1 && cls <= 7;
    var isDark = cls === 15;
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.fillStyle = isDark ? '#5c5c5c' : '#f2e3c4';
    ctx.fill();
    ctx.lineWidth = Math.max(1.5, R * 0.09);
    ctx.strokeStyle = isDark ? '#2a2a2a' : (red ? '#c62828' : '#1a1a1a');
    ctx.stroke();
    ctx.beginPath(); ctx.arc(cx, cy, R * 0.74, 0, Math.PI * 2);
    ctx.lineWidth = Math.max(1, R * 0.05);
    ctx.stroke();
    ctx.fillStyle = isDark ? '#d0d0d0' : (red ? '#c62828' : '#1a1a1a');
    ctx.font = 'bold ' + Math.round(R * 1.1) + 'px "PingFang SC",serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(CLASSES[cls].g, cx, cy);
  }

  $('btnDemo').addEventListener('click', async function () {
    var n = 40;
    $('btnDemo').disabled = true;
    try {
      await generateDemo(n);
      log('生成 ' + n + ' 个演示局面');
    } catch (e) {
      toast('生成失败：' + e.message);
    }
    $('btnDemo').disabled = false;
  });

  // ---------------------------------------------------------------- 画布
  function currentSample() { return current >= 0 ? samples[current] : null; }

  async function ensureStage() {
    if (sctx) return;
    stage = $('stage');
    sctx = stage.getContext('2d');
  }

  var stageImg = null;

  function renderStage() {
    ensureStage();
    var s = currentSample();
    var hint = $('stageHint');
    if (!s) { hint.textContent = ''; return; }

    if (!stageImg || stageImg.__key !== s.key) {
      stageImg = new Image();
      stageImg.__key = s.key;
      stageImg.onload = function () { renderStage(); };
      stageImg.src = URL.createObjectURL(s.blob);
      return;
    }

    // 图还没解码完就画，naturalWidth 是 0，fit 会变成 Infinity、pan 会变成 NaN；
    // 而 view.key 一旦落定，等图真的加载好反而不会再重新取景，NaN 就留下来了。
    if (!stageImg.complete || !stageImg.naturalWidth) return;

    // 舞台盒子：高度约占视口一半，保证笔刷和按钮始终留在屏幕上
    var wrapW = $('tab-annotate').clientWidth - 22;
    if (wrapW < 80) wrapW = window.innerWidth - 22;
    var boxW = Math.round(Math.min(wrapW, 560));
    var boxH = Math.round(clamp(window.innerHeight * 0.5, 240, 470));

    dpr = window.devicePixelRatio || 1;
    stage.style.width = boxW + 'px';
    stage.style.height = boxH + 'px';
    stage.width = Math.round(boxW * dpr);
    stage.height = Math.round(boxH * dpr);
    sctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    sctx.clearRect(0, 0, boxW, boxH);

    var IW = stageImg.naturalWidth, IH = stageImg.naturalHeight;
    var pad = 0.7;   // 棋盘四周留出这么多格的余量
    var fr = s.lattice
      ? {
        x: (s.lattice.x0 - s.lattice.dx * pad) * IW,
        y: (s.lattice.y0 - s.lattice.dy * pad) * IH,
        w: s.lattice.dx * (COLS - 1 + pad * 2) * IW,
        h: s.lattice.dy * (ROWS - 1 + pad * 2) * IH
      }
      : { x: 0, y: 0, w: IW, h: IH };

    // 手机截图里棋盘往往只占屏幕一部分。按整图缩放的话格子只剩三十来像素，
    // 点不准；所以标定之后改成「取景框住棋盘」，格子能到 36px 上下，再叠加缩放。
    var viewKey = s.key + '|' + (s.lattice ? 'L' : 'F');
    view.boxW = boxW; view.boxH = boxH; view.imgW = IW; view.imgH = IH;
    view.fit = Math.min(boxW / fr.w, boxH / fr.h);
    if (view.key !== viewKey) {
      view.key = viewKey;
      view.zoom = 1;
      view.panX = (boxW - fr.w * view.fit) / 2 - fr.x * view.fit;
      view.panY = (boxH - fr.h * view.fit) / 2 - fr.y * view.fit;
    }
    clampPan();

    var S = view.fit * view.zoom;
    sctx.save();
    sctx.beginPath(); sctx.rect(0, 0, boxW, boxH); sctx.clip();
    sctx.fillStyle = '#0c0e11'; sctx.fillRect(0, 0, boxW, boxH);
    sctx.translate(view.panX, view.panY);
    sctx.scale(S, S);
    sctx.imageSmoothingEnabled = S < 1;
    sctx.drawImage(stageImg, 0, 0);
    if (s.lattice) { drawLattice(s.lattice, S); drawMarkers(s, S); }
    if (mode === 'draw' && drawStart && drawNow) drawRough(drawStart, drawNow, S);
    sctx.restore();

    $('imgName').textContent = s.name;
    $('calibInfo').textContent = s.lattice
      ? ('已标定 · 置信度 ' + fmt(s.conf, 1) + ' · 格子 ' +
         fmt(Math.max(s.lattice.dx * s.w, s.lattice.dy * s.h) * S, 0) + 'px 显示')
      : '未标定 — 拖动框住棋盘';
    hint.textContent = mode === 'draw'
      ? '在棋盘外沿拖一个框，大致圈住九路十行即可，会自动精修'
      : (mode === 'nudge' ? '拖动整体平移，拖右下角缩放' : '点格子落子。放大后可拖动平移');
    $('zoomLabel').textContent = fmt(view.zoom, 1) + '×';
    updateProgress();
  }

  function clampPan() {
    var S = view.fit * view.zoom;
    var iw = view.imgW * S, ih = view.imgH * S;
    if (iw <= view.boxW) view.panX = (view.boxW - iw) / 2;
    else view.panX = clamp(view.panX, view.boxW - iw, 0);
    if (ih <= view.boxH) view.panY = (view.boxH - ih) / 2;
    else view.panY = clamp(view.panY, view.boxH - ih, 0);
  }

  /** 屏幕坐标 → 图片像素坐标 */
  function toImage(p) {
    var S = view.fit * view.zoom;
    return { x: (p.x - view.panX) / S, y: (p.y - view.panY) / S };
  }

  function setZoom(z, anchor) {
    var S0 = view.fit * view.zoom;
    var a = anchor || { x: view.boxW / 2, y: view.boxH / 2 };
    var ix = (a.x - view.panX) / S0, iy = (a.y - view.panY) / S0;
    view.zoom = clamp(z, 1, 5);
    var S1 = view.fit * view.zoom;
    view.panX = a.x - ix * S1;
    view.panY = a.y - iy * S1;
    clampPan();
    renderStage();
  }

  // 下面这些都在「图片坐标系」里画 —— 调用前 ctx 已经套好了缩放变换
  function drawLattice(lat, S) {
    var IW = view.imgW, IH = view.imgH;
    var x0 = lat.x0 * IW, y0 = lat.y0 * IH, dx = lat.dx * IW, dy = lat.dy * IH;
    sctx.lineWidth = 1 / S;
    sctx.strokeStyle = 'rgba(76,141,255,.72)';
    var c, r;
    for (c = 0; c < COLS; c++) {
      sctx.beginPath();
      sctx.moveTo(x0 + c * dx, y0); sctx.lineTo(x0 + c * dx, y0 + (ROWS - 1) * dy);
      sctx.stroke();
    }
    for (r = 0; r < ROWS; r++) {
      sctx.beginPath();
      sctx.moveTo(x0, y0 + r * dy); sctx.lineTo(x0 + (COLS - 1) * dx, y0 + r * dy);
      sctx.stroke();
    }
    sctx.fillStyle = 'rgba(76,141,255,.9)';
    for (c = 0; c < COLS; c++) {
      for (r = 0; r < ROWS; r++) {
        sctx.beginPath();
        sctx.arc(x0 + c * dx, y0 + r * dy, 1.6 / S, 0, Math.PI * 2);
        sctx.fill();
      }
    }
  }

  function drawMarkers(s, S) {
    if (!s.lattice || !s.cells) return;
    var IW = view.imgW, IH = view.imgH;
    var x0 = s.lattice.x0 * IW, y0 = s.lattice.y0 * IH;
    var dx = s.lattice.dx * IW, dy = s.lattice.dy * IH;
    var R = Math.min(dx, dy) * 0.22;
    for (var r = 0; r < ROWS; r++) {
      for (var c = 0; c < COLS; c++) {
        var v = s.cells[r * COLS + c];
        if (!v) continue;
        var cx = x0 + c * dx, cy = y0 + r * dy;
        sctx.beginPath();
        sctx.arc(cx, cy, R, 0, Math.PI * 2);
        sctx.fillStyle = 'rgba(53,196,106,.88)';
        sctx.fill();
        sctx.fillStyle = '#0b0d10';
        sctx.font = 'bold ' + Math.round(R * 1.3) + 'px "PingFang SC",serif';
        sctx.textAlign = 'center'; sctx.textBaseline = 'middle';
        sctx.fillText(CLASSES[v].g, cx, cy);
      }
    }
  }

  function drawRough(a, b, S) {
    sctx.strokeStyle = '#ffb020';
    sctx.lineWidth = 2 / S;
    sctx.setLineDash([7 / S, 5 / S]);
    sctx.strokeRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
    sctx.setLineDash([]);
  }

  // ---------------------------------------------------------------- 标定
  function grayOfCurrent() {
    var s = currentSample();
    if (!s) return null;
    if (grayCache.key === s.key) return grayCache;
    var cv = document.createElement('canvas');
    cv.width = s.w; cv.height = s.h;
    var c = cv.getContext('2d', { willReadFrequently: true });
    c.drawImage(stageImg, 0, 0, s.w, s.h);
    var d = c.getImageData(0, 0, s.w, s.h).data;
    var g = new Uint8ClampedArray(s.w * s.h);
    for (var i = 0, p = 0; i < g.length; i++, p += 4) {
      g[i] = d[p] * 0.299 + d[p + 1] * 0.587 + d[p + 2] * 0.114;
    }
    grayCache = { key: s.key, gray: g, w: s.w, h: s.h };
    return grayCache;
  }

  function fitFromRough(roughPx) {
    var s = currentSample();
    var gc = grayOfCurrent();
    if (!gc) return null;
    var t0 = performance.now();
    var r = Lattice.fitBoard(gc.gray, gc.w, gc.h, roughPx);
    if (!r.ok) { toast('自动校正失败：' + (r.reason || '未知')); return null; }
    s.lattice = { x0: r.x0 / s.w, y0: r.y0 / s.h, dx: r.dx / s.w, dy: r.dy / s.h };
    s.conf = r.confidence;
    if (!s.cells) s.cells = new Array(CELLS).fill(0);
    log('标定 ' + s.name + '：置信度 ' + fmt(r.confidence, 2) + '，' + fmt(performance.now() - t0, 0) + 'ms');
    return s.lattice;
  }

  // ---------------------------------------------------------------- 互动
  function localPoint(ev) {
    var r = stage.getBoundingClientRect();
    return { x: ev.clientX - r.left, y: ev.clientY - r.top };
  }

  /** 命中测试，入参是图片像素坐标 */
  function cellAt(ip) {
    var s = currentSample();
    if (!s || !s.lattice) return -1;
    var x0 = s.lattice.x0 * s.w, y0 = s.lattice.y0 * s.h;
    var dx = s.lattice.dx * s.w, dy = s.lattice.dy * s.h;
    var c = Math.round((ip.x - x0) / dx), r = Math.round((ip.y - y0) / dy);
    if (c < 0 || c >= COLS || r < 0 || r >= ROWS) return -1;
    return r * COLS + c;
  }

  var lastCell = -1;

  /** 在某个图片像素位置落子 / 擦除 */
  function paintAt(ip) {
    var s = currentSample();
    if (!s) return -1;
    var idx = cellAt(ip);
    if (idx < 0) return -1;
    s.cells = s.cells || new Array(CELLS).fill(0);
    s.cells[idx] = (s.cells[idx] === brush) ? 0 : brush;   // 同笔刷再点 = 擦掉
    lastCell = idx;
    queueSave(s);
    renderStage();
    return idx;
  }

  function bindStage() {
    stage = $('stage');
    var ptrs = new Map();     // 活动手指
    var one = null;           // 单指操作的状态
    var pinch = null;         // 双指手势的基准

    stage.addEventListener('pointerdown', function (ev) {
      var s = currentSample();
      if (!s || !view.key) return;
      ev.preventDefault();
      try { stage.setPointerCapture(ev.pointerId); } catch (e) { }
      var lp = localPoint(ev);
      ptrs.set(ev.pointerId, lp);

      if (ptrs.size === 2) {
        // 双指：取消单指动作，转成缩放/平移
        one = null; nudgeRef = null;
        if (mode === 'draw') { drawStart = drawNow = null; }
        var ps = Array.from(ptrs.values());
        pinch = {
          d0: Math.hypot(ps[0].x - ps[1].x, ps[0].y - ps[1].y),
          c0: { x: (ps[0].x + ps[1].x) / 2, y: (ps[0].y + ps[1].y) / 2 },
          zoom0: view.zoom, panX0: view.panX, panY0: view.panY
        };
        renderStage();
        return;
      }
      if (ptrs.size > 2) return;

      one = { sx: lp.x, sy: lp.y, ip: toImage(lp), t: Date.now(), moved: false };

      if (mode === 'draw') {
        drawStart = one.ip; drawNow = one.ip;
        renderStage();
      } else if (mode === 'nudge' && s.lattice) {
        var x0 = s.lattice.x0 * s.w, y0 = s.lattice.y0 * s.h;
        var dx = s.lattice.dx * s.w, dy = s.lattice.dy * s.h;
        var hx = x0 + (COLS - 1) * dx, hy = y0 + (ROWS - 1) * dy;
        var S = view.fit * view.zoom;
        var near = Math.hypot(one.ip.x - hx, one.ip.y - hy) * S < Math.max(26, dx * S * 0.6);
        nudgeRef = near
          ? { kind: 'scale', hx: hx, hy: hy, d0: Math.max(1, Math.hypot(one.ip.x - hx, one.ip.y - hy)), lat: Object.assign({}, s.lattice) }
          : { kind: 'move', ip: one.ip, lat: Object.assign({}, s.lattice) };
      }
      // paint 模式按下先不落子 —— 等抬手时判断这是「点」还是「拖」
    });

    stage.addEventListener('pointermove', function (ev) {
      if (!ptrs.has(ev.pointerId)) return;
      var s = currentSample();
      if (!s) return;
      var lp = localPoint(ev);
      ptrs.set(ev.pointerId, lp);

      if (ptrs.size >= 2 && pinch) {
        var ps = Array.from(ptrs.values());
        var d1 = Math.hypot(ps[0].x - ps[1].x, ps[0].y - ps[1].y);
        var c1 = { x: (ps[0].x + ps[1].x) / 2, y: (ps[0].y + ps[1].y) / 2 };
        var z1 = clamp(pinch.zoom0 * (pinch.d0 > 1 ? d1 / pinch.d0 : 1), 1, 5);
        var S0 = view.fit * pinch.zoom0;
        // 手势中心下的那个图片点保持不动
        var ix = (pinch.c0.x - pinch.panX0) / S0, iy = (pinch.c0.y - pinch.panY0) / S0;
        var S1 = view.fit * z1;
        view.zoom = z1;
        view.panX = c1.x - ix * S1;
        view.panY = c1.y - iy * S1;
        clampPan();
        renderStage();
        return;
      }

      if (!one) return;
      if (Math.hypot(lp.x - one.sx, lp.y - one.sy) > 9) one.moved = true;

      if (mode === 'draw') {
        drawNow = toImage(lp);
        renderStage();
      } else if (mode === 'nudge' && nudgeRef) {
        var ip = toImage(lp);
        if (nudgeRef.kind === 'move') {
          s.lattice = {
            x0: clamp(nudgeRef.lat.x0 + (ip.x - nudgeRef.ip.x) / s.w, -0.3, 1.3),
            y0: clamp(nudgeRef.lat.y0 + (ip.y - nudgeRef.ip.y) / s.h, -0.3, 1.3),
            dx: nudgeRef.lat.dx, dy: nudgeRef.lat.dy
          };
        } else {
          var d = Math.hypot(ip.x - nudgeRef.hx, ip.y - nudgeRef.hy);
          var k = clamp(d / nudgeRef.d0, 0.6, 1.7);
          s.lattice = {
            x0: nudgeRef.lat.x0, y0: nudgeRef.lat.y0,
            dx: clamp(nudgeRef.lat.dx * k, 0.004, 0.4),
            dy: clamp(nudgeRef.lat.dy * k, 0.004, 0.4)
          };
        }
        renderStage();
      } else if (mode === 'paint' && one.moved) {
        // 放大之后拖动是平移（这是最常用的动作）；未放大时才当连续涂色用
        if (view.zoom > 1.15 || view.imgW * view.fit > view.boxW + 2) {
          view.panX += lp.x - one.sx;
          view.panY += lp.y - one.sy;
          one.sx = lp.x; one.sy = lp.y;
          clampPan();
          renderStage();
        } else {
          paintAt(toImage(lp));
        }
      }
    });

    function up(ev) {
      ptrs.delete(ev.pointerId);
      if (ptrs.size < 2) pinch = null;
      if (ptrs.size > 0) return;

      var s = currentSample();
      var o = one; one = null;
      lastCell = -1;
      if (!s) { renderStage(); return; }

      if (mode === 'draw' && drawStart && drawNow) {
        var x = Math.min(drawStart.x, drawNow.x), y = Math.min(drawStart.y, drawNow.y);
        var w = Math.abs(drawNow.x - drawStart.x), h = Math.abs(drawNow.y - drawStart.y);
        drawStart = drawNow = null;
        if (w < 40 || h < 40) {
          renderStage();
          toast('框太小了，再拖大一点');
          return;
        }
        if (fitFromRough({ x: x, y: y, w: w, h: h })) {
          mode = 'paint';
          updateModeButtons();
          s.cells = s.cells || new Array(CELLS).fill(0);
          queueSave(s);
          toast('已自动校正 · 置信度 ' + fmt(s.conf, 1));
        }
      } else if (mode === 'nudge') {
        nudgeRef = null;
        queueSave(s);
      } else if (mode === 'paint' && o && !o.moved && Date.now() - o.t < 600) {
        paintAt(o.ip);   // 轻点落子
      }
      renderStage();
      renderSamples();
    }

    stage.addEventListener('pointerup', up);
    stage.addEventListener('pointercancel', up);
    // 不用 pointerleave：手指划出画布边缘时不该结束这一次操作
  }

  var saveTimer = null, pendingSave = null;
  function queueSave(s) {
    pendingSave = s;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      if (pendingSave) dbPut(toRecord(pendingSave)).catch(function () { });
      pendingSave = null;
    }, 400);
    updateProgress();
  }

  function toRecord(s) {
    return {
      key: s.key, name: s.name, w: s.w, h: s.h, thumb: s.thumb, blob: s.blob,
      lattice: s.lattice, cells: s.cells, conf: s.conf
    };
  }

  function updateProgress() {
    var s = currentSample();
    if (!s) return;
    var painted = 0;
    if (s.cells) for (var i = 0; i < CELLS; i++) if (s.cells[i] > 0) painted++;
    $('cellProgress').textContent = '已标注 ' + painted + ' / 90';
    renderPaletteCounts();
  }

  function renderPaletteCounts() {
    var s = currentSample();
    var counts = new Array(NC).fill(0);
    if (s && s.cells) for (var i = 0; i < CELLS; i++) counts[s.cells[i]]++;
    Array.prototype.forEach.call(document.querySelectorAll('.brush'), function (b, i) {
      var c = b.querySelector('.cnt');
      if (c) c.textContent = counts[i] ? counts[i] : '';
    });
  }

  function updateModeButtons() {
    $('btnCalib').classList.toggle('on', mode === 'draw');
    $('btnNudge').classList.toggle('on', mode === 'nudge');
  }

  // ---------------------------------------------------------------- 笔刷
  function renderPalette() {
    var p = $('palette');
    p.innerHTML = '';
    CLASSES.forEach(function (c, i) {
      var b = document.createElement('button');
      b.className = 'brush ' + c.k + (i === brush ? ' on' : '');
      b.innerHTML = '<span class="g">' + c.g + '</span><span class="cnt"></span>';
      b.addEventListener('click', function () {
        brush = i;
        Array.prototype.forEach.call(p.children, function (x, j) {
          x.classList.toggle('on', j === i);
        });
      });
      p.appendChild(b);
    });
    renderPaletteCounts();
  }

  $('btnCalib').addEventListener('click', function () {
    mode = 'draw';
    updateModeButtons();
    var s = currentSample();
    if (s) { s.lattice = null; s.conf = 0; }
    renderStage();
    toast('在棋盘上拖一个框');
  });
  $('btnZoomIn').addEventListener('click', function () { setZoom(view.zoom * 1.5); });
  $('btnZoomOut').addEventListener('click', function () { setZoom(view.zoom / 1.5); });
  $('btnZoomFit').addEventListener('click', function () {
    view.zoom = 1;
    view.key = null;          // 触发重新取景
    renderStage();
  });
  $('btnNudge').addEventListener('click', function () {
    mode = mode === 'nudge' ? 'paint' : 'nudge';
    updateModeButtons();
    renderStage();
  });
  $('btnAuto').addEventListener('click', function () {
    var s = currentSample();
    if (!s) return;
    if (!s.lattice) { toast('先框选棋盘'); return; }
    // 以现有晶格为中心再跑一次拟合
    var rough = {
      x: (s.lattice.x0 - s.lattice.dx * 0.4) * s.w,
      y: (s.lattice.y0 - s.lattice.dy * 0.4) * s.h,
      w: (s.lattice.dx * 8.8) * s.w,
      h: (s.lattice.dy * 9.8) * s.h
    };
    if (fitFromRough(rough)) { queueSave(s); renderStage(); toast('已重新校正'); }
  });
  $('btnClearCells').addEventListener('click', function () {
    var s = currentSample();
    if (!s || !s.cells) return;
    s.cells = new Array(CELLS).fill(0);
    queueSave(s);
    renderStage();
    renderSamples();
  });
  $('btnCopyPrev').addEventListener('click', function () {
    var s = currentSample();
    if (!s || current <= 0) { toast('没有上一局'); return; }
    var prev = samples[current - 1];
    if (!prev.cells) { toast('上一局还没标注'); return; }
    s.cells = prev.cells.slice();
    if (!s.lattice && prev.lattice) s.lattice = Object.assign({}, prev.lattice);
    queueSave(s);
    renderStage();
    renderSamples();
    toast('已复制上一局的标注');
  });
  $('btnPrev').addEventListener('click', function () {
    if (current > 0) { current--; mode = 'paint'; updateModeButtons(); renderStage(); renderSamples(); }
  });
  $('btnNext').addEventListener('click', function () {
    if (current < samples.length - 1) { current++; mode = 'paint'; updateModeButtons(); renderStage(); renderSamples(); }
  });

  // ---------------------------------------------------------------- 切片
  function cropCells(img, lat, imgW, imgH, out) {
    var x0 = lat.x0 * imgW, y0 = lat.y0 * imgH;
    var dx = lat.dx * imgW, dy = lat.dy * imgH;
    var side = Math.max(dx, dy) * CROP_K;
    var cv = document.createElement('canvas');
    cv.width = out; cv.height = out;
    var c = cv.getContext('2d');
    var out8 = new Uint8Array(CELLS * out * out * 3);
    var p = 0;
    for (var r = 0; r < ROWS; r++) {
      for (var col = 0; col < COLS; col++) {
        c.clearRect(0, 0, out, out);
        c.drawImage(img, x0 + col * dx - side / 2, y0 + r * dy - side / 2, side, side, 0, 0, out, out);
        var d = c.getImageData(0, 0, out, out).data;
        for (var i = 0; i < out * out; i++) {
          out8[p++] = d[i * 4];
          out8[p++] = d[i * 4 + 1];
          out8[p++] = d[i * 4 + 2];
        }
      }
    }
    return out8;
  }

  async function imageOf(s) {
    if (s.__img) return s.__img;
    var url = URL.createObjectURL(s.blob);
    s.__img = await loadImage(url);
    URL.revokeObjectURL(url);
    return s.__img;
  }

  // ---------------------------------------------------------------- 数据集
  var master = null, masterLabels = null, trainIdx = null, valIdx = null, valLabelsArr = null;

  function usable() {
    return samples.filter(function (s) { return s.lattice && s.cells; });
  }

  function refreshTrainTab() {
    var u = usable();
    if (!u.length) {
      $('dataSummary').innerHTML = '还没有已标注的样本。去「样本」导入截图并标定。';
      $('btnTrain').disabled = true;
      $('btnBuild').disabled = true;
      return;
    }
    var nonEmpty = 0, total = 0;
    u.forEach(function (s) {
      for (var i = 0; i < CELLS; i++) if (s.cells[i] > 0) nonEmpty++;
      total += CELLS;
    });
    $('dataSummary').innerHTML =
      '可用图片 <b>' + u.length + '</b> 张 · 共 <b>' + total + '</b> 格，其中非空 <b>' + nonEmpty +
      '</b> 格（' + fmt(nonEmpty / total * 100, 1) + '%）';
    $('btnBuild').disabled = false;
    $('btnTrain').disabled = !master;
  }

  async function buildDataset() {
    var u = usable();
    if (!u.length) { toast('没有可用样本'); return; }

    $('btnBuild').disabled = true;
    $('btnBuild').textContent = '构建中…';
    log('开始构建数据集，输入尺寸 ' + inSize);

    // 按图片划分训练/验证，避免同一局面的格子同时出现在两边（那是数据泄漏）
    var valRatio = clamp(parseInt($('pVal').value, 10) / 100, 0.05, 0.5);
    var nVal = Math.max(1, Math.round(u.length * valRatio));
    var valSet = {};
    var shuffled = u.slice();
    for (var i = shuffled.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = shuffled[i]; shuffled[i] = shuffled[j]; shuffled[j] = t;
    }
    for (var k = 0; k < nVal; k++) valSet[shuffled[k].key] = 1;

    var keepEmpty = clamp(parseInt($('pEmpty').value, 10) / 100, 0, 1);

    var trSlices = [], vaSlices = [];
    var trLab = [], vaLab = [];
    var px = inSize * inSize * 3;

    for (var n = 0; n < u.length; n++) {
      var s = u[n];
      var img = await imageOf(s);
      var slice = cropCells(img, s.lattice, s.w, s.h, inSize);
      var isVal = !!valSet[s.key];
      for (var c = 0; c < CELLS; c++) {
        var lab = s.cells[c];
        if (lab === 0 && Math.random() > keepEmpty) continue;
        var src = new Uint8Array(px);
        src.set(slice.subarray(c * px, c * px + px));
        if (isVal) { vaSlices.push(src); vaLab.push(lab); }
        else { trSlices.push(src); trLab.push(lab); }
      }
      if (n % 5 === 4) await new Promise(function (r) { setTimeout(r, 0); });
    }

    if (master) { master = null; masterLabels = null; }
    master = new Uint8Array(trSlices.length * px);
    masterLabels = new Int32Array(trSlices.length);
    for (var q = 0; q < trSlices.length; q++) {
      master.set(trSlices[q], q * px);
      masterLabels[q] = trLab[q];
    }

    var vMaster = new Uint8Array(vaSlices.length * px);
    for (var q2 = 0; q2 < vaSlices.length; q2++) vMaster.set(vaSlices[q2], q2 * px);
    valLabelsArr = new Int32Array(vaLab);
    window.__vMaster = vMaster;

    var mb = (master.length + vMaster.length) / 1048576;
    log('训练切片 ' + trSlices.length + ' · 验证切片 ' + vaSlices.length + ' · 共 ' + fmt(mb, 1) + ' MB');
    $('dataSummary').innerHTML += '<br>训练切片 <b>' + trSlices.length + '</b> · 验证切片 <b>' +
      vaSlices.length + '</b> · ' + fmt(mb, 1) + ' MB';

    $('btnBuild').disabled = false;
    $('btnBuild').textContent = '构建数据集';
    $('btnTrain').disabled = false;
    $('btnPreviewCells').disabled = false;
    return true;
  }

  $('btnBuild').addEventListener('click', function () {
    inSize = clamp(parseInt($('pSize').value, 10) || 32, 16, 64);
    $('pSize').value = inSize;
    buildDataset().then(function () { toast('数据集就绪'); })
      .catch(function (e) { log('构建失败 ' + e.message); toast('构建失败'); });
  });

  $('btnPreviewCells').addEventListener('click', function () {
    var u = usable();
    if (!u.length) { toast('没有可用样本'); return; }
    var s = u[0];
    imageOf(s).then(function (img) {
      var px = inSize * inSize * 3;
      var data = cropCells(img, s.lattice, s.w, s.h, inSize);
      var cv = $('cellPreview');
      var SW = Math.max(18, Math.min(40, inSize));
      cv.width = COLS * SW; cv.height = ROWS * SW;
      cv.hidden = false;
      var c = cv.getContext('2d');
      c.fillStyle = '#0c0e11'; c.fillRect(0, 0, cv.width, cv.height);
      var tmp = document.createElement('canvas');
      tmp.width = inSize; tmp.height = inSize;
      var tcx = tmp.getContext('2d');
      for (var r = 0; r < ROWS; r++) {
        for (var col = 0; col < COLS; col++) {
          var i = r * COLS + col;
          var id = tcx.createImageData(inSize, inSize);
          for (var k = 0; k < inSize * inSize; k++) {
            id.data[k * 4] = data[i * px + k * 3];
            id.data[k * 4 + 1] = data[i * px + k * 3 + 1];
            id.data[k * 4 + 2] = data[i * px + k * 3 + 2];
            id.data[k * 4 + 3] = 255;
          }
          tcx.putImageData(id, 0, 0);
          c.drawImage(tmp, col * SW, r * SW, SW - 1, SW - 1);
        }
      }
    }).catch(function (e) { toast('预览失败：' + e.message); });
  });

  // ---------------------------------------------------------------- 模型
  function buildModel(size) {
    var m = tf.sequential();
    m.add(tf.layers.conv2d({ inputShape: [size, size, 3], filters: 16, kernelSize: 3, padding: 'same', activation: 'relu' }));
    m.add(tf.layers.maxPooling2d({ poolSize: 2 }));
    m.add(tf.layers.conv2d({ filters: 32, kernelSize: 3, padding: 'same', activation: 'relu' }));
    m.add(tf.layers.maxPooling2d({ poolSize: 2 }));
    m.add(tf.layers.conv2d({ filters: 48, kernelSize: 3, padding: 'same', activation: 'relu' }));
    m.add(tf.layers.maxPooling2d({ poolSize: 2 }));
    m.add(tf.layers.flatten());
    m.add(tf.layers.dense({ units: 96, activation: 'relu' }));
    m.add(tf.layers.dropout({ rate: 0.25 }));
    m.add(tf.layers.dense({ units: NC }));   // 输出 logits，softmax 交给损失函数
    return m;
  }

  function makeBatch(idx, size) {
    var px = size * size * 3;
    var xsArr = new Float32Array(idx.length * px);
    var ysArr = new Int32Array(idx.length);
    for (var i = 0; i < idx.length; i++) {
      var src = idx[i] * px;
      var dst = i * px;
      for (var j = 0; j < px; j++) xsArr[dst + j] = master[src + j] / 255;
      ysArr[i] = masterLabels[idx[i]];
    }
    return {
      xs: tf.tensor4d(xsArr, [idx.length, size, size, 3]),
      ys: tf.oneHot(tf.tensor1d(ysArr, 'int32'), NC)
    };
  }

  function shuffledIdx() {
    var a = new Int32Array(masterLabels.length);
    for (var i = 0; i < a.length; i++) a[i] = i;
    for (var j = a.length - 1; j > 0; j--) {
      var k = Math.floor(Math.random() * (j + 1));
      var t = a[j]; a[j] = a[k]; a[k] = t;
    }
    return a;
  }

  async function evaluate() {
    var vM = window.__vMaster;
    var size = inSize, px = size * size * 3;
    var n = valLabelsArr.length;
    if (!n) return null;
    var preds = new Int32Array(n);
    var CH = 128;
    for (var b = 0; b < n; b += CH) {
      var end = Math.min(n, b + CH);
      var arr = new Float32Array((end - b) * px);
      for (var i = b; i < end; i++) {
        var src = i * px, dst = (i - b) * px;
        for (var j = 0; j < px; j++) arr[dst + j] = vM[src + j] / 255;
      }
      var t = tf.tidy(function () {
        var xs = tf.tensor4d(arr, [end - b, size, size, 3]);
        var logits = model.apply(xs, { training: false });
        return tf.argMax(logits, -1);
      });
      var d = await t.data();
      t.dispose();
      for (var k = 0; k < d.length; k++) preds[b + k] = d[k];
      await new Promise(function (r) { setTimeout(r, 0); });
    }

    var conf = [];
    for (var a = 0; a < NC; a++) conf.push(new Int32Array(NC));
    var correct = 0, deepCorrect = 0, deepTotal = 0;
    for (var p = 0; p < n; p++) {
      var g = valLabelsArr[p], q = preds[p];
      conf[g][q]++;
      if (q === g) correct++;
      if (g !== 0) { deepTotal++; if (q === g) deepCorrect++; }
    }
    return {
      n: n, acc: correct / n,
      deepAcc: deepTotal ? deepCorrect / deepTotal : 0,
      deepTotal: deepTotal, conf: conf, preds: preds
    };
  }

  function renderEval(r, secondsPerEpoch, totalSeconds) {
    var rows = [];
    for (var g = 1; g < NC; g++) {
      var tot = 0, hit = r.conf[g][g];
      for (var p = 0; p < NC; p++) tot += r.conf[g][p];
      if (!tot) continue;
      if (hit < tot) rows.push({ idx: g, hit: hit, tot: tot, rate: hit / tot });
    }
    rows.sort(function (a, b) { return a.rate - b.rate; });

    var html =
      '<div class="statline"><span>验证集准确率</span><b class="big">' + fmt(r.acc * 100, 2) + '%</b></div>' +
      '<div class="statline"><span>非空格子准确率</span><b class="big">' + fmt(r.deepAcc * 100, 2) + '%</b></div>' +
      '<div class="statline"><span>验证切片</span><b>' + r.n + '（非空 ' + r.deepTotal + '）</b></div>' +
      '<div class="statline"><span>训练耗时</span><b>' + fmt(totalSeconds, 0) + 's</b></div>' +
      '<div class="statline"><span>每轮耗时</span><b>' + fmt(secondsPerEpoch, 2) + 's</b></div>';

    if (rows.length) {
      html += '<div class="muted tiny" style="margin-top:8px">未完全命中的类别：</div><table>' +
        rows.slice(0, 10).map(function (x) {
          return '<tr><td>' + CLASSES[x.idx].g + '　' + CLASSES[x.idx].id +
            '</td><td>' + x.hit + '/' + x.tot + '</td></tr>';
        }).join('') + '</table>';
    } else {
      html += '<div class="muted tiny mt6">所有出现过的类别全部命中</div>';
    }
    $('evalStat').innerHTML = html;
    $('resultCard').hidden = false;
  }

  $('btnStop').addEventListener('click', function () {
    stopFlag = true;
    log('收到停止请求，会在本轮结束时停下');
  });

  $('btnTrain').addEventListener('click', async function () {
    if (!master) { toast('先构建数据集'); return; }
    var epochs = clamp(parseInt($('pEpochs').value, 10) || 40, 1, 400);
    var batch = clamp(parseInt($('pBatch').value, 10) || 64, 8, 512);
    var size = inSize;

    $('btnTrain').disabled = true;
    $('btnBuild').disabled = true;
    $('btnStop').disabled = false;
    $('resultCard').hidden = true;
    stopFlag = false;

    if (native()) native().keepAwake(true);

    if (model) { model.dispose(); model = null; }
    model = buildModel(size);
    var params = 0;
    model.layers.forEach(function (l) { l.getWeights().forEach(function (w) { params += w.size; }); });
    log('模型参数量 ' + params.toLocaleString() + ' · 输入 ' + size + '×' + size + ' · 类别 ' + NC);

    var opt = tf.train.adam(1e-3);
    var t0 = performance.now();
    var firstEpoch = 0, lastEpoch = 0;

    for (var ep = 0; ep < epochs && !stopFlag; ep++) {
      var idx = shuffledIdx();
      var epStart = performance.now();
      var lossSum = 0, batches = 0;

      for (var b = 0; b < idx.length; b += batch) {
        var slice = Array.prototype.slice.call(idx.subarray(b, Math.min(idx.length, b + batch)));
        var bt = makeBatch(slice, size);
        var lossVal = opt.minimize(function () {
          var logits = model.apply(bt.xs, { training: true });
          return tf.losses.softmaxCrossEntropy(bt.ys, logits).mean();
        }, true);
        lossSum += lossVal.dataSync()[0];
        lossVal.dispose();
        bt.xs.dispose(); bt.ys.dispose();
        batches++;
        if (stopFlag) break;
      }

      var epMs = performance.now() - epStart;
      if (ep === 0) firstEpoch = epMs;
      lastEpoch = epMs;

      $('trainProg').style.width = ((ep + 1) / epochs * 100) + '%';
      $('trainStat').innerHTML = '第 ' + (ep + 1) + '/' + epochs + ' 轮 · loss <b>' +
        fmt(lossSum / Math.max(1, batches), 4) + '</b> · 本轮 ' + fmt(epMs / 1000, 1) +
        's<br><span class="muted">首轮（含编译）' + fmt(firstEpoch / 1000, 1) + 's</span>';
      if (ep % 2 === 1 || ep === epochs - 1) await yieldTick();
      if (ep % 5 === 0) log('第 ' + (ep + 1) + ' 轮 loss ' + fmt(lossSum / Math.max(1, batches), 4));
    }

    var total = (performance.now() - t0) / 1000;
    $('trainStat').innerHTML += '<br><span class="muted">训练结束，共 ' + fmt(total, 0) + 's</span>';
    log('训练结束，用时 ' + fmt(total, 1) + 's');

    try {
      log('在验证集上评估…');
      var r = await evaluate();
      if (r) {
        renderEval(r, lastEpoch / 1000, total);
        log('验证准确率 ' + fmt(r.acc * 100, 2) + '% · 非空 ' + fmt(r.deepAcc * 100, 2) + '%');
        currentMeta = '验证集 ' + fmt(r.acc * 100, 1) + '% / 非空 ' + fmt(r.deepAcc * 100, 1) +
          '% · 样本 ' + usable().length + ' 张 · ' + epochs + ' 轮';
      }
    } catch (e) {
      log('评估失败 ' + e.message);
    }

    if (native()) native().keepAwake(false);
    $('btnTrain').disabled = false;
    $('btnBuild').disabled = false;
    $('btnStop').disabled = true;
    $('trainProg').style.width = '100%';
  });

  // ---------------------------------------------------------------- 保存模型
  $('btnSaveModel').addEventListener('click', async function () {
    if (!model) { toast('还没有训练好的模型'); return; }
    $('btnSaveModel').disabled = true;
    try {
      var stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 13);
      var base = 'jieqi-cells-' + inSize + '-' + stamp;
      var saved = { json: null, bin: null, weights: 0 };

      await model.save(tf.io.withSaveHandler(async function (artifacts) {
        var meta = {
          format: 'layers-model',
          generatedBy: 'JieqiBox Model Studio',
          convertedBy: null,
          modelTopology: artifacts.modelTopology,
          weightSpecs: artifacts.weightSpecs,
          userData: {
            labels: LABEL_IDS,
            inputSize: inSize,
            grid: { cols: COLS, rows: ROWS },
            cropK: CROP_K,
            note: '逐格分类器：输入为以交叉点为中心的方格裁切，输出 logits（推理时需 softmax）'
          }
        };
        var weightBuf = artifacts.weightData;
        if (weightBuf instanceof ArrayBuffer) {
          meta.weightsManifest = [{
            paths: [base + '.bin'],
            weights: artifacts.weightSpecs
          }];
        }
        saved.json = JSON.stringify(meta);
        saved.bin = weightBuf;
        saved.weights = weightBuf.byteLength;
      }));

      var nat = native();
      var where;
      if (nat) {
        where = nat.saveFile(base + '.bin', abToBase64(saved.bin));
        var r2 = nat.saveFile(base + '.json', strToBase64(saved.json));
        if (String(where).indexOf('ERROR') === 0) throw new Error(where);
        where = String(where).replace(/[^/]*$/, '');
      } else {
        // 浏览器预览模式：直接下载
        downloadBlob(new Blob([saved.bin]), base + '.bin');
        downloadBlob(new Blob([saved.json], { type: 'application/json' }), base + '.json');
        where = '下载目录';
      }

      var meta = {
        name: base, size: inSize, labels: NC,
        bytes: saved.weights, at: Date.now(),
        description: currentMeta
      };
      modelMeta.unshift(meta);
      localStorage.setItem('studio.models', JSON.stringify(modelMeta.slice(0, 50)));

      log('模型已导出：' + base + '.json / .bin（' + fmt(saved.weights / 1024, 0) + ' KB 权重）');
      toast('已保存到 ' + where, 2800);
      renderModels();
    } catch (e) {
      log('保存失败 ' + e.message);
      toast('保存失败：' + e.message);
    }
    $('btnSaveModel').disabled = false;
  });

  function downloadBlob(blob, name) {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
  }

  var modelMeta = [];
  var currentMeta = null;

  function renderModels() {
    var el = $('modelList');
    try { modelMeta = JSON.parse(localStorage.getItem('studio.models') || '[]'); } catch (e) { modelMeta = []; }
    if (!modelMeta.length) {
      el.innerHTML = '<span class="muted">还没有保存过模型。训练后点「保存模型」，文件会写进「下载/模型工坊」。</span>';
      return;
    }
    el.innerHTML = modelMeta.map(function (m) {
      return '<div class="m"><div><b>' + escapeHtml(m.name) + '</b></div>' +
        '<div class="muted tiny">输入 ' + m.size + '×' + m.size + ' · ' + m.labels + ' 类 · ' +
        fmt(m.bytes / 1024, 0) + ' KB · ' + new Date(m.at).toLocaleString() + '</div>' +
        (m.description ? '<div class="muted tiny">' + escapeHtml(m.description) + '</div>' : '') +
        '</div>';
    }).join('');
  }

  // 轻量调试出口：出问题时可在控制台核对取景与命中，不影响正常使用
  window.__studio = {
    state: function () {
      var s = currentSample();
      return {
        mode: mode, brush: brush, current: current, samples: samples.length,
        view: { boxW: view.boxW, boxH: view.boxH, imgW: view.imgW, imgH: view.imgH, fit: view.fit, zoom: view.zoom, panX: view.panX, panY: view.panY },
        lattice: s ? s.lattice : null,
        sampleWH: s ? [s.w, s.h] : null,
        name: s ? s.name : null
      };
    },
    hit: function (lx, ly) { return cellAt(toImage({ x: lx, y: ly })); },
    imagePoint: function (lx, ly) { return toImage({ x: lx, y: ly }); },
    paint: function (lx, ly) { paintAt(toImage({ x: lx, y: ly })); }
  };

  // ---------------------------------------------------------------- 启动
  async function boot() {
    renderPalette();
    bindStage();
    updateModeButtons();

    var backend = 'cpu';
    try {
      await tf.setBackend('webgl');
      await tf.ready();
      backend = tf.getBackend();
    } catch (e) {
      try { await tf.setBackend('cpu'); await tf.ready(); backend = tf.getBackend(); } catch (e2) { }
    }

    var nat = native();
    $('aboutBox').innerHTML =
      'tfjs <b>' + tf.version.tfjs + '</b> · 后端 <b>' + backend + '</b><br>' +
      (nat ? ('原生外壳 <b>' + nat.appVersion() + '</b> · ' + nat.platform()) : '浏览器预览模式') +
      '<br><br>类别 ' + NC + ' 个：' + LABEL_IDS.join('、') +
      '<br>裁切系数 ×' + CROP_K + '，导入时图片长边压到 ' + MAX_EDGE + 'px';

    log('tfjs ' + tf.version.tfjs + ' / backend ' + backend);

    try {
      var all = await dbAll();
      samples = (all || []).sort(function (a, b) { return a.key < b.key ? -1 : 1; });
      log('从本地读回 ' + samples.length + ' 张样本');
    } catch (e) {
      log('读取本地样本失败：' + e.message);
      samples = [];
    }
    current = samples.length ? 0 : -1;
    renderSamples();
    refreshTrainTab();
    renderModels();

    window.addEventListener('resize', function () { if ($('tab-annotate').classList.contains('on')) renderStage(); });
  }

  boot();
})();
