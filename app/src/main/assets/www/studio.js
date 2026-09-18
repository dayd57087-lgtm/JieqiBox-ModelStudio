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
  //
  // c = 主色，用来把「这一格被标成了什么」一眼画出来。
  // 以前所有标记都是同一个绿圈，看不出标的是红子还是黑子，
  // 只能靠读圈里的字来判断，核对时很费眼。
  var CLASSES = [
    { id: 'empty', g: '空', k: 'e', c: '#6b7684' },
    { id: 'r_general', g: '帅', k: 'r', c: '#e5555f' }, { id: 'r_advisor', g: '仕', k: 'r', c: '#e5555f' },
    { id: 'r_elephant', g: '相', k: 'r', c: '#e5555f' }, { id: 'r_horse', g: '马', k: 'r', c: '#e5555f' },
    { id: 'r_chariot', g: '车', k: 'r', c: '#e5555f' }, { id: 'r_cannon', g: '炮', k: 'r', c: '#e5555f' },
    { id: 'r_soldier', g: '兵', k: 'r', c: '#e5555f' },
    { id: 'b_general', g: '将', k: 'b', c: '#cbd3dd' }, { id: 'b_advisor', g: '士', k: 'b', c: '#cbd3dd' },
    { id: 'b_elephant', g: '象', k: 'b', c: '#cbd3dd' }, { id: 'b_horse', g: '马', k: 'b', c: '#cbd3dd' },
    { id: 'b_chariot', g: '车', k: 'b', c: '#cbd3dd' }, { id: 'b_cannon', g: '炮', k: 'b', c: '#cbd3dd' },
    { id: 'b_soldier', g: '卒', k: 'b', c: '#cbd3dd' },
    { id: 'dark', g: '暗', k: 'd', c: '#8b94a1' }
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

  /**
   * 画布 -> Blob。
   *
   * 不用 canvas.toBlob：它在部分 WebView 里回调**根本不触发**（实测 JPEG/PNG 都是
   * 100% 超时），整个流程会静默卡死在那次 await 上。
   * toDataURL 是同步的、到处都能用，虽然编码在主线程上，但一次几十毫秒可以接受。
   */
  function canvasToBlob(cv, type, q) {
    return new Promise(function (res, rej) {
      var mime = type || 'image/jpeg';
      try {
        var url = cv.toDataURL(mime, q === undefined ? 0.86 : q);
        var comma = url.indexOf(',');
        if (comma < 0) throw new Error('画布编码失败');
        var bin = atob(url.slice(comma + 1));
        var u8 = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
        res(new Blob([u8], { type: mime }));
      } catch (e) {
        rej(e);
      }
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
    if (name === 'models') refreshSavedModels();
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
    var added = 0, reused = 0, failed = 0;
    var total = files.length;
    // 批量导入几十上百张要花时间，给个明确的进度
    setBusy(true, '导入截图', '0 / ' + total);
    if (native()) native().keepAwake(true);
    for (var i = 0; i < total; i++) {
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

        var thumb = makeThumb(cv, w, h, null);

        var rec = {
          key: key, name: f.name || ('图片 ' + (samples.length + 1)),
          w: w, h: h, thumb: thumb, blob: blob,
          lattice: null, cells: null, auto: null, conf: 0
        };
        await dbPut(rec);
        samples.push(rec);
        added++;
      } catch (e) {
        failed++;
        log('导入失败 ' + (f.name || '') + '：' + e.message);
      }
      $('busySub').textContent = (i + 1) + ' / ' + total;
      if (i % 3 === 2) await yieldTick();
    }
    if (native()) native().keepAwake(false);
    setBusy(false);
    renderSamples();
    var msg = '导入 ' + added + ' 张';
    if (reused) msg += '，跳过重复 ' + reused + ' 张';
    if (failed) msg += '，失败 ' + failed + ' 张';
    toast(msg, 2600);
    if (added) log('批量导入完成：' + msg);
  }

  /**
   * 生成列表用的缩略图。
   *
   * 以前是整张手机截图压进去 —— 棋盘只占中间一小块，缩略图上根本看不清棋子，
   * 卡片下方还留一大片空白。这里直接裁到棋盘范围，一目了然。
   */
  function makeThumb(src, w, h, lattice) {
    var TW = 200;
    var tc = document.createElement('canvas');
    var tcx;

    if (lattice) {
      // 棋盘外扩半格，让边路棋子也有余量
      var x0 = (lattice.x0 - lattice.dx * 0.5) * w;
      var y0 = (lattice.y0 - lattice.dy * 0.5) * h;
      var bw = lattice.dx * (COLS + 1) * w;
      var bh = lattice.dy * (ROWS + 1) * h;
      x0 = Math.max(0, x0); y0 = Math.max(0, y0);
      bw = Math.min(bw, w - x0); bh = Math.min(bh, h - y0);

      var TH = Math.max(1, Math.round(TW * bh / bw));
      tc.width = TW; tc.height = TH;
      tcx = tc.getContext('2d');
      tcx.drawImage(src, x0, y0, bw, bh, 0, 0, TW, TH);
    } else {
      // 还没标定：取中间偏上那块，大致就是棋盘常在的位置
      var ch = Math.min(h, w * (10 / 9) * 1.25);
      tc.width = TW;
      tc.height = Math.max(1, Math.round(TW * ch / w));
      tcx = tc.getContext('2d');
      tcx.drawImage(src, 0, Math.max(0, (h - ch) * 0.35), w, ch, 0, 0, TW, tc.height);
    }
    return tc.toDataURL('image/jpeg', 0.72);
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
      var pending = 0;
      if (s.auto) for (var q = 0; q < CELLS; q++) if (s.auto[q]) pending++;
      var st = s.lattice
        ? (s.cells ? '已标注 ' + annotatedCount(s) + ' 子' +
            (pending ? ' · <span style="color:#e0a33a">' + pending + ' 待核对</span>' : '')
          : '待标注')
        : '未标定';
      var badge = pending ? '<span class="badge auto">模型</span>'
        : (s.cells && annotatedCount(s) ? '<span class="badge manual">已核</span>' : '');
      el.innerHTML =
        badge + '<img src="' + s.thumb + '" alt="">' +
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
        showPred = false;
        lastPred = null;
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
    updateBatchInfo();
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
      var lat = {
        x0: (ox + GT.x0 * s) / W, dx: (GT.dx * s) / W,
        y0: (oy + GT.y0 * s) / H, dy: (GT.dy * s) / H
      };

      var rec = {
        key: 'demo-' + Date.now() + '-' + k + '-' + Math.random().toString(36).slice(2, 7),
        name: '演示局面 ' + (k + 1),
        w: W, h: H, thumb: makeThumb(cv, W, H, lat), blob: blob,
        lattice: lat,
        cells: cells, auto: null, conf: 99
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
    setBusy(true, '生成演示局面', '0 / ' + n);
    try {
      await generateDemo(n);
      log('生成 ' + n + ' 个演示局面（内置棋盘）');
      toast('已生成 ' + n + ' 个演示局面');
    } catch (e) {
      toast('生成失败：' + e.message);
    }
    setBusy(false);
    $('btnDemo').disabled = false;
  });

  // ------------------------------------------------ 按指定样本生成
  //
  // 「演示局面」用的是应用内置的棋盘图，和真实对局的皮肤、光照都不一样，
  // 拿它训出来的模型迁移过去会掉点。这里改成以用户自己的一张图为模板：
  //   1. 把模板里的棋子抹掉，得到一块干净的棋盘底（用空格子的图块覆盖）
  //   2. 从模板里抠出每种棋子的图样（圆形羽化遮罩）
  //   3. 在新画布上按抖动过的位置/缩放出棋盘，再随机摆子
  // 这样生成出来的样本和用户实际看到的一致，训练数据才有意义。

  var SPR = 96;   // 棋子图样的边长

  /** 用空格子的图块盖住有子的格子，得到没有棋子的棋盘底 */
  function makeCleanBoard(img, lat, cells) {
    var dx = lat.dx, dy = lat.dy;
    var bw = Math.round(dx * COLS), bh = Math.round(dy * ROWS);
    var out = document.createElement('canvas');
    out.width = bw; out.height = bh;
    var c = out.getContext('2d');
    c.drawImage(img,
      lat.x0 - dx / 2, lat.y0 - dy / 2, dx * COLS, dy * ROWS,
      0, 0, bw, bh);

    // 收集空格子
    var empties = [];
    for (var r = 0; r < ROWS; r++) {
      for (var col = 0; col < COLS; col++) {
        if (!cells[r * COLS + col]) empties.push({ r: r, c: col });
      }
    }
    if (!empties.length) return out;   // 全是子，没法清，原样返回

    for (var r2 = 0; r2 < ROWS; r2++) {
      for (var c2 = 0; c2 < COLS; c2++) {
        if (!cells[r2 * COLS + c2]) continue;
        // 找最近的空格子：同一行/列优先，格子线的走向才对得上
        var best = empties[0], bestD = 1e9;
        for (var k = 0; k < empties.length; k++) {
          var d = Math.abs(empties[k].r - r2) + Math.abs(empties[k].c - c2);
          if (d < bestD) { bestD = d; best = empties[k]; }
        }
        c.drawImage(out,
          Math.round(best.c * dx), Math.round(best.r * dy), Math.round(dx), Math.round(dy),
          Math.round(c2 * dx), Math.round(r2 * dy), Math.round(dx), Math.round(dy));
      }
    }
    return out;
  }

  /** 从模板里抠出每种棋子的图样；模板里没有的类别用内置画法补上 */
  function extractSprites(img, lat, cells) {
    var sprites = new Array(NC).fill(null);
    var side = Math.max(lat.dx, lat.dy);

    for (var i = 0; i < CELLS; i++) {
      var cls = cells[i];
      if (!cls || sprites[cls]) continue;
      var r = Math.floor(i / COLS), col = i % COLS;
      var cx = lat.x0 + col * lat.dx;
      var cy = lat.y0 + r * lat.dy;

      var sc = document.createElement('canvas');
      sc.width = SPR; sc.height = SPR;
      var sctx2 = sc.getContext('2d');
      // 圆形羽化遮罩：棋子本身接近正圆，羽化边缘让它压到新底上不留硬边
      var g = sctx2.createRadialGradient(
        SPR / 2, SPR / 2, SPR * 0.36,
        SPR / 2, SPR / 2, SPR * 0.47
      );
      g.addColorStop(0, 'rgba(0,0,0,1)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      sctx2.beginPath();
      sctx2.rect(0, 0, SPR, SPR);
      sctx2.fillStyle = g;
      sctx2.fill();
      sctx2.globalCompositeOperation = 'source-in';
      sctx2.drawImage(img,
        cx - side / 2, cy - side / 2, side, side,
        0, 0, SPR, SPR);
      sctx2.globalCompositeOperation = 'source-over';
      sprites[cls] = sc;
    }

    // 模板里没出现过的类别：用内置画法生成一个，保证任意类别都能摆
    for (var k = 1; k < NC; k++) {
      if (sprites[k]) continue;
      var cv = document.createElement('canvas');
      cv.width = SPR; cv.height = SPR;
      drawPieceDemo(cv.getContext('2d'), SPR / 2, SPR / 2, SPR * 0.94, k);
      sprites[k] = cv;
    }
    return sprites;
  }

  async function generateFromTemplate(s, n) {
    if (!s || !s.lattice) throw new Error('这张图还没标定，先在标注页框选棋盘');
    var img = await imageOf(s);

    var lat = {
      x0: s.lattice.x0 * s.w, y0: s.lattice.y0 * s.h,
      dx: s.lattice.dx * s.w, dy: s.lattice.dy * s.h
    };
    var srcCells = s.cells && s.cells.some(function (v) { return v > 0; })
      ? s.cells.slice()
      : null;

    var clean = null, sprites = null;
    if (srcCells) {
      clean = makeCleanBoard(img, lat, srcCells);
      sprites = extractSprites(img, lat, srcCells);
      log('已从模板提取：棋盘底 ' + clean.width + '×' + clean.height +
          ' · 棋子图样 ' + sprites.filter(Boolean).length + ' 种');
    }

    // 取模板的界面底色，让生成的图看起来像同一个 App
    var probe = document.createElement('canvas');
    probe.width = s.w; probe.height = s.h;
    var pc = probe.getContext('2d', { willReadFrequently: true });
    pc.drawImage(img, 0, 0);
    function px(x, y) {
      var d = pc.getImageData(Math.max(0, Math.min(s.w - 1, x)),
                              Math.max(0, Math.min(s.h - 1, y)), 1, 1).data;
      return 'rgb(' + d[0] + ',' + d[1] + ',' + d[2] + ')';
    }
    var bgCol = px(8, 8), topCol = px(Math.round(s.w / 2), 30),
        botCol = px(Math.round(s.w / 2), s.h - 30);

    var baseCount = srcCells ? srcCells.filter(function (v) { return v > 0; }).length : 26;
    var added = 0;

    for (var k = 0; k < n; k++) {
      var W = s.w, H = s.h;
      // 抖动：位置和缩放在小范围内随机，模拟不同局面/窗口位置
      var scale = 0.95 + Math.random() * 0.16;
      var dx2 = lat.dx * scale, dy2 = lat.dy * scale;
      var bw = dx2 * COLS, bh = dy2 * ROWS;
      var ox = lat.x0 - dx2 / 2 + (Math.random() - 0.5) * 36;
      var oy = lat.y0 - dy2 / 2 + (Math.random() - 0.5) * 36;

      var cv = document.createElement('canvas');
      cv.width = W; cv.height = H;
      var c = cv.getContext('2d');
      c.fillStyle = bgCol; c.fillRect(0, 0, W, H);
      c.fillStyle = topCol; c.fillRect(0, 0, W, Math.max(1, oy - 6));
      c.fillStyle = botCol; c.fillRect(0, Math.min(H, oy + bh + 6), W,
                                       H - Math.min(H, oy + bh + 6));

      if (clean) {
        c.drawImage(clean, ox, oy, bw, bh);
      } else {
        // 模板没标注时退化成内置棋盘，至少比例是对的
        if (!boardImg) boardImg = await loadImage('xiangqi.png');
        c.drawImage(boardImg, ox, oy, bw, bh);
      }

      // 随机摆子
      var cells = new Array(CELLS).fill(0);
      var order = Array.from({ length: CELLS }, function (_, i) { return i; });
      for (var i2 = order.length - 1; i2 > 0; i2--) {
        var j = Math.floor(Math.random() * (i2 + 1));
        var t = order[i2]; order[i2] = order[j]; order[j] = t;
      }
      var count = Math.max(4, Math.round(baseCount * (0.8 + Math.random() * 0.4)));
      count = Math.min(count, CELLS - 1);
      for (var m = 0; m < count; m++) {
        var cell = order[m];
        var rr = Math.floor(cell / COLS), cc = cell % COLS;
        // 类别分布沿用模板：模板里出现过的类别更可能再出现
        var cls = pickClass(srcCells);
        cells[cell] = cls;
        if (sprites) {
          var sp = sprites[cls];
          var side = Math.max(dx2, dy2) * 0.94;
          c.drawImage(sp,
            ox + cc * dx2 + dx2 / 2 - side / 2,
            oy + rr * dy2 + dy2 / 2 - side / 2,
            side, side);
        } else {
          drawPieceDemo(c, ox + cc * dx2 + dx2 / 2, oy + rr * dy2 + dy2 / 2, dx2 * 0.94, cls);
        }
      }

      var blob = await canvasToBlob(cv, 'image/jpeg', 0.88);
      var lat2 = {
        x0: (ox + dx2 / 2) / W, dx: dx2 / W,
        y0: (oy + dy2 / 2) / H, dy: dy2 / H
      };

      var rec = {
        key: 'tpl-' + Date.now() + '-' + k + '-' + Math.random().toString(36).slice(2, 7),
        name: '模板生成 ' + (k + 1),
        w: W, h: H, thumb: makeThumb(cv, W, H, lat2), blob: blob,
        lattice: lat2,
        cells: cells, auto: null, conf: 99, src: s.name
      };
      await dbPut(rec);
      samples.push(rec);
      added++;
      $('busySub').textContent = (k + 1) + ' / ' + n;
      if (k % 3 === 2) await yieldTick();
    }
    return added;
  }

  /** 按模板里出现过的类别随机挑一个；模板没标注时红黑平均分 */
  function pickClass(srcCells) {
    if (srcCells) {
      var pool = [];
      for (var i = 0; i < CELLS; i++) if (srcCells[i]) pool.push(srcCells[i]);
      if (pool.length) return pool[Math.floor(Math.random() * pool.length)];
    }
    var red = Math.random() < 0.5;
    if (Math.random() < 0.3) return 15;   // 暗子
    return red ? 1 + Math.floor(Math.random() * 7) : 8 + Math.floor(Math.random() * 7);
  }

  $('btnDemoFrom').addEventListener('click', async function () {
    var s = currentSample();
    if (!s) { toast('先在样本列表里点一张图'); return; }
    if (!s.lattice) { toast('这张图还没标定 —— 先到「标注」页框选棋盘'); return; }

    var n = clamp(parseInt($('demoCount').value, 10) || 30, 5, 300);
    var btn = $('btnDemoFrom');
    btn.disabled = true;
    setBusy(true, '按模板生成', '0 / ' + n);
    try {
      var added = await generateFromTemplate(s, n);
      renderSamples();
      refreshTrainTab();
      log('按模板「' + s.name + '」生成 ' + added + ' 张');
      toast('已生成 ' + added + ' 张（模板：' + s.name + '）', 2600);
    } catch (e) {
      log('模板生成失败：' + e.message);
      toast('生成失败：' + e.message);
    }
    setBusy(false);
    btn.disabled = false;
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
    if (s.lattice) {
      drawLattice(s.lattice, S);
      if (showPred && lastPred) drawPredMarks(s, lastPred, S);
      else drawMarkers(s, S);
    }
    if (mode === 'draw' && drawStart && drawNow) drawRough(drawStart, drawNow, S);
    sctx.restore();

    $('imgName').textContent = s.name;
    $('calibInfo').textContent = s.lattice
      ? ('已标定 · 置信度 ' + fmt(s.conf, 1) + ' · 格子 ' +
         fmt(Math.max(s.lattice.dx * s.w, s.lattice.dy * s.h) * S, 0) + 'px 显示')
      : '未标定 — 拖动框住棋盘';
    if (showPred && lastPred) {
      var dd = diffOf(s, lastPred);
      hint.textContent = dd.diff.length === 0
        ? '模型预测与标注完全一致 ✓'
        : ('模型预测有 ' + dd.diff.length + ' 格不符（其中非空 ' + dd.wrongNonEmpty +
           ' 格）· 红=模型判错，绿=判对');
    } else {
      hint.textContent = mode === 'draw'
        ? '在棋盘外沿拖一个框，大致圈住九路十行即可，会自动精修'
        : (mode === 'nudge' ? '拖动整体平移，拖右下角缩放' : '点格子落子。放大后可拖动平移');
    }
    $('zoomLabel').textContent = fmt(view.zoom, 1) + '×';
    renderLegend(s);
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

  /**
   * 画标注标记。
   *
   * 颜色按阵营走：红子暖红、黑子冷白、暗子灰。
   * 模型预标注出来的格子（s.auto[i] 为真且用户还没动过）画成虚线环，
   * 提醒「这一格是模型猜的，还没人核对过」。
   */
  function drawMarkers(s, S) {
    if (!s.lattice || !s.cells) return;
    var IW = view.imgW, IH = view.imgH;
    var x0 = s.lattice.x0 * IW, y0 = s.lattice.y0 * IH;
    var dx = s.lattice.dx * IW, dy = s.lattice.dy * IH;
    var R = Math.min(dx, dy) * 0.3;

    for (var r = 0; r < ROWS; r++) {
      for (var c = 0; c < COLS; c++) {
        var i = r * COLS + c;
        var v = s.cells[i];
        if (!v) continue;
        var auto = s.auto && s.auto[i];
        var col = CLASSES[v].c;
        var cx = x0 + c * dx, cy = y0 + r * dy;

        // 底：半透明填充，压住底下的棋子但仍看得见轮廓
        sctx.beginPath();
        sctx.arc(cx, cy, R, 0, Math.PI * 2);
        sctx.fillStyle = hexA(col, auto ? 0.22 : 0.3);
        sctx.fill();

        // 环：模型猜的用虚线，人工确认的用实线
        sctx.lineWidth = (auto ? 2 : 2.6) / S;
        if (auto) sctx.setLineDash([3 / S, 2.5 / S]);
        sctx.strokeStyle = col;
        sctx.stroke();
        sctx.setLineDash([]);

        // 字
        sctx.fillStyle = col;
        sctx.font = 'bold ' + Math.round(R * 1.15) + 'px "PingFang SC",serif';
        sctx.textAlign = 'center'; sctx.textBaseline = 'middle';
        sctx.fillText(CLASSES[v].g, cx, cy);
      }
    }
  }

  /** #rrggbb + alpha -> rgba() */
  function hexA(hex, a) {
    var h = hex.replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var n = parseInt(h, 16);
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
  }

  /** 画布左上角的阵营图例 */
  function renderLegend(s) {
    var el = $('legend');
    if (!el) return;
    if (!s || !s.lattice) { el.innerHTML = ''; return; }
    var counts = { r: 0, b: 0, d: 0, auto: 0 };
    if (s.cells) {
      for (var i = 0; i < CELLS; i++) {
        var v = s.cells[i];
        if (!v) continue;
        counts[CLASSES[v].k]++;
        if (s.auto && s.auto[i]) counts.auto++;
      }
    }
    var parts = [];
    if (counts.r) parts.push('<span class="lg"><i style="background:#e5555f"></i>红 ' + counts.r + '</span>');
    if (counts.b) parts.push('<span class="lg"><i style="background:#cbd3dd"></i>黑 ' + counts.b + '</span>');
    if (counts.d) parts.push('<span class="lg"><i style="background:#8b94a1"></i>暗 ' + counts.d + '</span>');
    if (counts.auto) parts.push('<span class="lg"><i style="background:#e0a33a"></i>模型猜 ' + counts.auto + '</span>');
    el.innerHTML = parts.join('');
  }

  /** 叠加显示模型预测：绿=与标注一致，红=不一致（包括「实际有子却预测成空」） */
  function drawPredMarks(s, pred, S) {
    var IW = view.imgW, IH = view.imgH;
    var x0 = s.lattice.x0 * IW, y0 = s.lattice.y0 * IH;
    var dx = s.lattice.dx * IW, dy = s.lattice.dy * IH;
    var R = Math.min(dx, dy) * 0.34;
    for (var r = 0; r < ROWS; r++) {
      for (var c = 0; c < COLS; c++) {
        var i = r * COLS + c;
        var truth = s.cells ? s.cells[i] : 0;
        var p = pred[i];
        var wrong = p !== truth;
        if (p === 0 && !wrong) continue;         // 两边都是空，没什么可看的
        var cx = x0 + c * dx, cy = y0 + r * dy;
        sctx.beginPath();
        sctx.arc(cx, cy, R, 0, Math.PI * 2);
        sctx.fillStyle = wrong ? 'rgba(224,82,82,.32)' : 'rgba(53,196,106,.24)';
        sctx.fill();
        sctx.lineWidth = (wrong ? 2.6 : 1.4) / S;
        sctx.strokeStyle = wrong ? '#ff5a5a' : '#35c46a';
        sctx.stroke();
        sctx.fillStyle = wrong ? '#ffe0e0' : '#d8f5e2';
        sctx.font = 'bold ' + Math.round(R * 1.05) + 'px "PingFang SC",serif';
        sctx.textAlign = 'center'; sctx.textBaseline = 'middle';
        sctx.fillText(p === 0 ? '空' : CLASSES[p].g, cx, cy);
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
    refreshThumb(s);
    log('标定 ' + s.name + '：置信度 ' + fmt(r.confidence, 2) + '，' + fmt(performance.now() - t0, 0) + 'ms');
    return s.lattice;
  }

  /** 标定好了就把缩略图换成裁到棋盘的那版 */
  function refreshThumb(s) {
    var img = s.__img || stageImg;
    if (!img || !s.lattice) return;
    try {
      s.thumb = makeThumb(img, s.w, s.h, s.lattice);
    } catch (e) {
      /* 缩略图是锦上添花，失败不影响标定 */
    }
  }

  /** 取某张图的灰度（不只是当前这张），供批量标定用 */
  function grayOf(s) {
    if (!s) return null;
    if (grayCache.key === s.key && grayCache.gray) return grayCache;

    var cv = document.createElement('canvas');
    cv.width = s.w; cv.height = s.h;
    var c = cv.getContext('2d', { willReadFrequently: true });
    // 同步画需要已解码的图；批量时用缓存过的
    var img = s.__img;
    if (!img) return null;
    c.drawImage(img, 0, 0, s.w, s.h);
    var d = c.getImageData(0, 0, s.w, s.h).data;
    var g = new Uint8ClampedArray(s.w * s.h);
    for (var i = 0, p = 0; i < g.length; i++, p += 4) {
      g[i] = d[p] * 0.299 + d[p + 1] * 0.587 + d[p + 2] * 0.114;
    }
    grayCache = { key: s.key, gray: g, w: s.w, h: s.h };
    return grayCache;
  }

  /**
   * 不用框选，自动找棋盘。
   * 批量标定走这条 —— 几十张图一张张拖框不现实。
   */
  async function calibrateAuto(s) {
    await imageOf(s);                 // 确保已解码
    var gc = grayOf(s);
    if (!gc) return null;
    var r = Lattice.fitBoardAuto(gc.gray, gc.w, gc.h);
    if (!r || !r.ok) return null;
    s.lattice = { x0: r.x0 / s.w, y0: r.y0 / s.h, dx: r.dx / s.w, dy: r.dy / s.h };
    s.conf = r.confidence;
    s.edgeRatio = r.edgeRatio;
    if (!s.cells) s.cells = new Array(CELLS).fill(0);
    refreshThumb(s);
    return s.lattice;
  }

  $('btnBatchCalib').addEventListener('click', async function () {
    var targets = samples.filter(function (s) { return !s.lattice; });
    if (!targets.length) { toast('所有图都已经标定过了'); return; }

    var btn = $('btnBatchCalib');
    btn.disabled = true;
    setBusy(true, '批量标定', '0 / ' + targets.length);
    if (native()) native().keepAwake(true);

    var ok = 0, fail = 0;
    try {
      for (var i = 0; i < targets.length; i++) {
        try {
          var lat = await calibrateAuto(targets[i]);
          if (lat) { ok++; await dbPut(toRecord(targets[i])); }
          else fail++;
        } catch (e) {
          fail++;
          log('标定失败 ' + targets[i].name + '：' + e.message);
        }
        $('busySub').textContent = (i + 1) + ' / ' + targets.length;
        if (i % 3 === 2) await yieldTick();
      }
    } catch (e) {
      log('批量标定中断：' + e.message);
    }

    if (native()) native().keepAwake(false);
    setBusy(false);
    btn.disabled = false;
    renderSamples();
    updateBatchInfo();
    refreshTrainTab();
    log('批量标定：成功 ' + ok + ' 张，失败 ' + fail + ' 张');
    toast('标定完成：成功 ' + ok + (fail ? '，失败 ' + fail + '（可逐张手动框选）' : ''), 2800);
  });

  /** 样本页那张卡片上的统计 */
  function updateBatchInfo() {
    var el = $('batchInfo');
    if (!el) return;
    if (!samples.length) {
      $('batchCard').hidden = true;
      return;
    }
    $('batchCard').hidden = false;
    var calib = 0, labeled = 0, pending = 0;
    samples.forEach(function (s) {
      if (s.lattice) calib++;
      if (s.cells) {
        for (var i = 0; i < CELLS; i++) {
          if (s.cells[i] > 0) labeled++;
          if (s.auto && s.auto[i]) pending++;
        }
      }
    });
    var uncalib = samples.length - calib;
    el.innerHTML = '已标定 <b>' + calib + '</b> / ' + samples.length +
      (uncalib ? ' · <span style="color:#e0a33a">待标定 ' + uncalib + '</span>' : '') +
      ' · 已落子 ' + labeled + ' 格' +
      (pending ? ' · <span style="color:#e0a33a">其中 ' + pending + ' 格是模型猜的，还没核对</span>' : '');
    $('btnBatchCalib').disabled = !uncalib;
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
    // 人手点过这一格，就不再是「模型猜的」，虚线环随之变成实线
    if (s.auto) s.auto[idx] = 0;
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
      lattice: s.lattice, cells: s.cells, conf: s.conf, auto: s.auto, src: s.src
    };
  }

  function updateProgress() {
    var s = currentSample();
    if (!s) return;
    var painted = 0, pending = 0;
    if (s.cells) {
      for (var i = 0; i < CELLS; i++) {
        if (s.cells[i] > 0) painted++;
        if (s.auto && s.auto[i]) pending++;
      }
    }
    var text = '已标注 ' + painted + ' / 90';
    $('cellProgress').innerHTML = text + (pending
      ? ' · <span style="color:#e0a33a">待核对 ' + pending + '</span>'
      : '');
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
  // 用模型检查当前这张图：把预测叠加到棋盘上，错的格子标红
  $('btnCheckModel').addEventListener('click', async function () {
    var s = currentSample();
    if (!s || !s.lattice) { toast('先框选标定棋盘'); return; }
    if (!model) { toast('先在「训练」页训一次，或到「模型」页载入一个模型'); return; }

    if (showPred) { showPred = false; renderStage(); return; }

    if (backtest[s.key]) {
      lastPred = backtest[s.key].pred;
    } else {
      $('btnCheckModel').disabled = true;
      $('btnCheckModel').textContent = '推理中…';
      try {
        var pred = await predictCells(s, inSize);
        backtest[s.key] = { pred: pred, diff: diffOf(s, pred) };
        lastPred = pred;
      } catch (e) {
        toast('推理失败：' + e.message);
        $('btnCheckModel').disabled = false;
        $('btnCheckModel').textContent = '用模型检查';
        return;
      }
      $('btnCheckModel').disabled = false;
      $('btnCheckModel').textContent = '用模型检查';
    }
    showPred = true;
    renderStage();
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
  // 训练数据。之前存的是 Uint8 + 标签号，每个 batch 都要在 JS 里
  // 逐元素除 255、再做一次 oneHot —— 一轮下来几千万次 JS 运算，
  // 全压在主线程上。改成建库时归一化一次、one-hot 也预先做好，
  // 训练时每个 batch 只需要几段 memcpy。
  var trainX = null, trainY = null;
  var valX = null, valY = null, valLabelsArr = null;
  var valKeys = {};      // 上一轮训练用到的验证图，回测时用来分开统计

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
    $('btnTrain').disabled = !trainX;
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
    valKeys = valSet;

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

    var nTrain = trSlices.length, nVal = vaSlices.length;
    trainX = new Float32Array(nTrain * px);
    trainY = new Float32Array(nTrain * NC);
    for (var q = 0; q < nTrain; q++) {
      var srcQ = trSlices[q], dstQ = q * px;
      for (var j = 0; j < px; j++) trainX[dstQ + j] = srcQ[j] / 255;
      trainY[q * NC + trLab[q]] = 1;
    }
    var vaSlices0 = vaSlices;
    // 切片缓冲用完就放掉，省一半内存
    trSlices = null; vaSlices = null;

    valX = new Float32Array(nVal * px);
    valY = new Float32Array(nVal * NC);
    for (var q2 = 0; q2 < nVal; q2++) {
      var srcV = vaSlices0[q2], dstV = q2 * px;
      for (var j2 = 0; j2 < px; j2++) valX[dstV + j2] = srcV[j2] / 255;
      valY[q2 * NC + vaLab[q2]] = 1;
    }
    valLabelsArr = new Int32Array(vaLab);

    var mb = (trainX.byteLength + valX.byteLength) / 1048576;
    log('训练切片 ' + nTrain + ' · 验证切片 ' + nVal + ' · 共 ' + fmt(mb, 1) + ' MB');
    $('dataSummary').innerHTML += '<br>训练切片 <b>' + nTrain + '</b> · 验证切片 <b>' +
      nVal + '</b> · ' + fmt(mb, 1) + ' MB';

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

  /**
   * 按数据量给一组能直接用的参数。
   * 新手最常卡在「轮数/批大小填多少」，其实和数据量强相关。
   */
  $('btnRecommend').addEventListener('click', function () {
    var u = usable();
    var imgs = u.length;
    var cells = imgs * CELLS;
    var size = 32, epochs = 40, batch = 64, empty = 30, val = 20, patience = 10;
    var note = '';

    if (imgs < 30) {
      size = 24; epochs = 80; batch = 32; empty = 40; val = 25; patience = 20;
      note = '图还很少（' + imgs + ' 张）—— 用更小的输入尺寸、更多的轮数，' +
             '保留更多空格子，免得模型只会猜「空」。建议再补几组图。';
    } else if (imgs < 120) {
      size = 32; epochs = 60; batch = 64; empty = 35; val = 20; patience = 15;
      note = '中等数据量（' + imgs + ' 张）—— 32×32 输入、60 轮是个稳的选择。';
    } else {
      size = 32; epochs = 40; batch = 128; empty = 30; val = 15; patience = 10;
      note = '数据比较充足（' + imgs + ' 张）—— 可以用更大的批大小，轮数反而不必多。';
    }

    $('pSize').value = size;
    $('pEpochs').value = epochs;
    $('pBatch').value = batch;
    $('pEmpty').value = empty;
    $('pVal').value = val;
    $('pPatience').value = patience;
    log('推荐参数：输入 ' + size + ' · 轮数 ' + epochs + ' · 批 ' + batch +
        ' · 保留空格 ' + empty + '% · 早停 ' + patience);
    toast(note, 4200);
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

  /**
   * 取一个 batch。
   *
   * 数据已经归一化并做成 one-hot，这里只做定点搬运：
   * 每行一次 TypedArray.set（memcpy），不再有逐元素的 JS 循环。
   * 这是训练提速的主要来源。
   */
  function makeBatch(order, from, to, size) {
    var px = size * size * 3;
    var count = to - from;
    var xsArr = new Float32Array(count * px);
    var ysArr = new Float32Array(count * NC);
    for (var i = 0; i < count; i++) {
      var src = order[from + i];
      xsArr.set(trainX.subarray(src * px, src * px + px), i * px);
      ysArr.set(trainY.subarray(src * NC, src * NC + NC), i * NC);
    }
    return {
      xs: tf.tensor4d(xsArr, [count, size, size, 3]),
      ys: tf.tensor2d(ysArr, [count, NC])
    };
  }

  /** 打乱索引。复用同一个缓冲，省掉每轮一次分配 */
  var orderBuf = null;
  function shuffledOrder() {
    var n = trainY.length / NC;
    if (!orderBuf || orderBuf.length !== n) {
      orderBuf = new Int32Array(n);
    }
    var a = orderBuf;
    for (var i = 0; i < n; i++) a[i] = i;
    for (var j = n - 1; j > 0; j--) {
      var k = Math.floor(Math.random() * (j + 1));
      var t = a[j]; a[j] = a[k]; a[k] = t;
    }
    return a;
  }

  /** 快速验证集准确率，供每轮显示进度用（分块跑，避免一次占满显存） */
  async function quickValAcc() {
    var n = valLabelsArr ? valLabelsArr.length : 0;
    if (!n) return 0;
    var px = inSize * inSize * 3;
    var CH = 256;
    var correct = 0;
    for (var b = 0; b < n; b += CH) {
      var end = Math.min(n, b + CH);
      var arr = valX.subarray(b * px, end * px);
      var t = tf.tidy(function () {
        var xs = tf.tensor4d(arr, [end - b, inSize, inSize, 3]);
        return tf.argMax(model.apply(xs, { training: false }), -1);
      });
      var d = t.dataSync();
      t.dispose();
      for (var i = 0; i < d.length; i++) if (d[i] === valLabelsArr[b + i]) correct++;
    }
    return correct / n;
  }

  // ------------------------------------------------ 用训练好的模型跑单张图

  /** 对一张已标定的图逐格推理，返回 90 个预测类别 */
  async function predictCells(s, size) {
    if (!model) return null;
    var img = await imageOf(s);
    var px = size * size * 3;
    var data = cropCells(img, s.lattice, s.w, s.h, size);
    var arr = new Float32Array(CELLS * px);
    for (var i = 0; i < arr.length; i++) arr[i] = data[i] / 255;

    var t = tf.tidy(function () {
      var xs = tf.tensor4d(arr, [CELLS, size, size, 3]);
      var logits = model.apply(xs, { training: false });
      return tf.argMax(logits, -1);
    });
    var d = await t.data();
    t.dispose();

    var out = new Int32Array(CELLS);
    for (var j = 0; j < CELLS; j++) out[j] = d[j];
    return out;
  }

  /** 对比预测与人工标注 */
  function diffOf(s, pred) {
    var diff = [], wrongNonEmpty = 0, wrongEmpty = 0;
    for (var i = 0; i < CELLS; i++) {
      var truth = s.cells ? s.cells[i] : 0;
      if (pred[i] === truth) continue;
      diff.push({ idx: i, truth: truth, pred: pred[i] });
      if (truth > 0) wrongNonEmpty++; else wrongEmpty++;
    }
    return { diff: diff, wrongNonEmpty: wrongNonEmpty, wrongEmpty: wrongEmpty };
  }

  // 回测结果：key -> {pred, diff}
  var backtest = {};
  var showPred = false;    // 标注画布是否叠加显示模型预测
  var lastPred = null;     // 当前图的预测

  // ------------------------------------------------ 忙碌遮罩
  // 批量操作动辄几十秒，没有反馈的话用户会以为卡死了。

  var busyDepth = 0;
  function setBusy(on, text, sub) {
    var el = $('busy');
    if (!el) return;
    if (on) {
      busyDepth++;
      if (text) $('busyText').textContent = text;
      $('busySub').textContent = sub || '';
      el.hidden = false;
    } else {
      busyDepth = Math.max(0, busyDepth - 1);
      if (busyDepth === 0) el.hidden = true;
    }
  }

  // ------------------------------------------------ 模型辅助标注
  //
  // 先让模型把 90 个格子全猜一遍，人只负责核对改错。
  // 比从零开始点 90 格快得多 —— 模型对了就不用动，只改错的。
  //
  // 写进去的格子会打上 auto 标记（画布上显示为虚线环），
  // 人一旦点过就转成实线，于是「还有哪些没核对」一目了然。

  function hasManualMarks(s) {
    if (!s.cells) return false;
    for (var i = 0; i < CELLS; i++) {
      if (s.cells[i] > 0 && !(s.auto && s.auto[i])) return true;
    }
    return false;
  }

  /**
   * 给一张图做预标注。
   * 已经有人工标注时只补空格子，不覆盖人手点过的。
   * @returns 实际写入的格数，失败返回 -1
   */
  async function preLabelOne(s) {
    if (!s || !s.lattice) return -1;
    var pred = await predictCells(s, inSize);
    if (!pred) return -1;

    var keepManual = hasManualMarks(s);
    s.cells = s.cells || new Array(CELLS).fill(0);
    s.auto = s.auto || new Array(CELLS).fill(0);

    var wrote = 0;
    for (var i = 0; i < CELLS; i++) {
      if (keepManual && s.cells[i] > 0) continue;   // 人手标的优先
      var v = pred[i];
      s.cells[i] = v;
      // 预测成空的格子不用留痕 —— 画布上本来就画不出东西
      s.auto[i] = v > 0 ? 1 : 0;
      if (v > 0) wrote++;
    }
    return wrote;
  }

  $('btnPreLabel').addEventListener('click', async function () {
    var s = currentSample();
    if (!s || !s.lattice) { toast('先框选标定棋盘'); return; }
    if (!model) { toast('先在「训练」页训一次，或到「模型」页载入一个模型'); return; }

    var btn = $('btnPreLabel');
    btn.disabled = true; btn.textContent = '推理中…';
    try {
      var n = await preLabelOne(s);
      if (n < 0) { toast('推理失败'); return; }
      queueSave(s);
      renderStage();
      renderSamples();
      toast('模型标了 ' + n + ' 个非空格子（虚线环 = 还没核对）', 2600);
    } catch (e) {
      log('预标注失败 ' + e.message);
      toast('预标注失败：' + e.message);
    }
    btn.disabled = false; btn.textContent = '模型预标注';
  });

  /** 批量预标注：只处理已标定、且还没怎么人工标注过的图 */
  async function preLabelAll() {
    if (!model) { toast('先在「训练」页训一次，或到「模型」页载入一个模型'); return; }
    var targets = samples.filter(function (s) { return s.lattice; });
    if (!targets.length) { toast('还没有已标定的图，先点「批量标定」'); return; }

    setBusy(true, '模型预标注', '0 / ' + targets.length);
    if (native()) native().keepAwake(true);
    var done = 0, skipped = 0, cells = 0;
    try {
      for (var i = 0; i < targets.length; i++) {
        var s = targets[i];
        if (hasManualMarks(s)) { skipped++; continue; }
        var n = await preLabelOne(s);
        if (n >= 0) { cells += n; await dbPut(toRecord(s)); }
        done++;
        $('busySub').textContent = (i + 1) + ' / ' + targets.length;
        if (i % 3 === 2) await yieldTick();
      }
    } catch (e) {
      log('批量预标注中断：' + e.message);
    }
    if (native()) native().keepAwake(false);
    setBusy(false);
    renderSamples();
    refreshTrainTab();
    if (current >= 0) renderStage();
    log('批量预标注完成：处理 ' + done + ' 张，跳过已人工标注的 ' + skipped +
        ' 张，共写入 ' + cells + ' 个非空格子');
    toast('预标注完成：' + done + ' 张' + (skipped ? '，跳过 ' + skipped + ' 张已人工标注的' : ''), 2800);
  }

  $('btnPreLabelAll').addEventListener('click', function () { preLabelAll(); });

  // ------------------------------------------------ 模型持久化
  // 不存下来的话，关掉应用模型就没了，等于没法「训练完隔天再测」。

  var MODEL_PREFIX = 'model:';
  var AUTO_MODEL_NAME = '最近一次训练';

  function isModelRecord(r) { return r && String(r.key || '').indexOf(MODEL_PREFIX) === 0; }

  function saveModelToDb(name, meta) {
    return new Promise(function (resolve, reject) {
      model.save(tf.io.withSaveHandler(function (artifacts) {
        var rec = {
          key: MODEL_PREFIX + name,
          name: name,
          size: inSize,
          classIds: LABEL_IDS,
          cropK: CROP_K,
          grid: { cols: COLS, rows: ROWS },
          modelTopology: artifacts.modelTopology,
          weightSpecs: artifacts.weightSpecs,
          weightData: artifacts.weightData,
          meta: meta || null,
          at: Date.now()
        };
        dbPut(rec).then(function () { resolve(rec); }).catch(reject);
      })).catch(reject);
    });
  }

  function loadModelFromRecord(rec) {
    try {
      var m = tf.loadLayersModel(tf.io.fromMemory({
        modelTopology: rec.modelTopology,
        weightSpecs: rec.weightSpecs,
        weightData: rec.weightData
      }));
      return Promise.resolve(m).then(function (mm) {
        if (model) { model.dispose(); }
        model = mm;
        inSize = rec.size || inSize;
        $('pSize').value = inSize;
        log('已载入模型「' + rec.name + '」· 输入 ' + inSize + '×' + inSize);
        return mm;
      });
    } catch (e) {
      log('载入模型失败：' + e.message);
      return Promise.reject(e);
    }
  }

  var savedModels = [];

  function refreshSavedModels() {
    return dbAll().then(function (all) {
      savedModels = (all || []).filter(isModelRecord).sort(function (a, b) { return b.at - a.at; });
      renderSavedModels();
    });
  }

  function renderSavedModels() {
    var el = $('modelList');
    if (!el) return;
    if (!savedModels.length) {
      el.innerHTML = '<span class="muted">还没有模型。去「训练」跑一次 —— 训完会自动存一份在应用里，' +
        '关掉再打开也能继续回测和导出。</span>';
      return;
    }
    el.innerHTML = savedModels.map(function (m, i) {
      var d = m.meta || {};
      return '<div class="m"><div><b>' + escapeHtml(m.name) + '</b>' +
        (i === 0 ? ' <span class="tag">最近</span>' : '') + '</div>' +
        '<div class="muted tiny">输入 ' + m.size + '×' + m.size + ' · ' +
        ((m.classIds || []).length) + ' 类 · ' +
        fmt((m.weightData ? m.weightData.byteLength : 0) / 1024, 0) + ' KB · ' +
        new Date(m.at).toLocaleString() + '</div>' +
        (d.desc ? '<div class="muted tiny">' + escapeHtml(d.desc) + '</div>' : '') +
        '<div class="row mt6"><button data-load="' + i + '">载入并测试</button>' +
        '<button data-export="' + i + '">导出</button>' +
        '<button data-onnx="' + i + '">ONNX</button>' +
        '<button data-del="' + i + '" class="danger-ghost">删除</button></div></div>';
    }).join('');

    Array.prototype.forEach.call(el.querySelectorAll('button[data-load]'), function (b) {
      b.addEventListener('click', function () {
        var rec = savedModels[+b.dataset.load];
        b.disabled = true;
        loadModelFromRecord(rec).then(function () {
          toast('已载入「' + rec.name + '」，可以回测了');
          refreshTrainTab();
          b.disabled = false;
        }).catch(function (e) {
          toast('载入失败：' + e.message);
          b.disabled = false;
        });
      });
    });
    Array.prototype.forEach.call(el.querySelectorAll('button[data-export]'), function (b) {
      b.addEventListener('click', function () { exportModelRecord(savedModels[+b.dataset.export]); });
    });
    Array.prototype.forEach.call(el.querySelectorAll('button[data-onnx]'), function (b) {
      b.addEventListener('click', function () {
        var rec = savedModels[+b.dataset.onnx];
        b.disabled = true;
        exportOnnxFromRecord(rec).then(function () { b.disabled = false; });
      });
    });
    Array.prototype.forEach.call(el.querySelectorAll('button[data-del]'), function (b) {
      b.addEventListener('click', function () {
        var rec = savedModels[+b.dataset.del];
        if (!confirm('删除模型「' + rec.name + '」？')) return;
        dbDel(rec.key).then(refreshSavedModels);
      });
    });
  }

  async function evaluate() {
    var size = inSize, px = size * size * 3;
    var n = valLabelsArr ? valLabelsArr.length : 0;
    if (!n) return null;
    var preds = new Int32Array(n);
    var CH = 256;
    for (var b = 0; b < n; b += CH) {
      var end = Math.min(n, b + CH);
      // 数据已经归一化过，直接切片即可，不用再拷一遍
      var arr = valX.subarray(b * px, end * px);
      var t = tf.tidy(function () {
        var xs = tf.tensor4d(arr, [end - b, size, size, 3]);
        var logits = model.apply(xs, { training: false });
        return tf.argMax(logits, -1);
      });
      var d = t.dataSync();
      t.dispose();
      for (var k = 0; k < d.length; k++) preds[b + k] = d[k];
      await yieldTick();
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

  /** 训练 loss 曲线：一眼看出是否还在下降（欠拟合）或已经平了（该加数据了） */
  /** 训练曲线：同时画 loss（左轴）和验证准确率（右轴） */
  function drawLossCurve(hist, valHist) {
    var cv = $('lossCurve');
    if (!hist || hist.length < 2) { cv.hidden = true; return; }
    cv.hidden = false;

    var w = Math.max(200, cv.clientWidth || 320), h = 130;
    var dpr = window.devicePixelRatio || 1;
    cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
    cv.style.height = h + 'px';
    var c = cv.getContext('2d');
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, w, h);

    var padL = 34, padR = 8, padT = 14, padB = 18;
    var lo = Math.min.apply(null, hist), hi = Math.max.apply(null, hist);
    if (hi - lo < 1e-6) hi = lo + 1;
    var X = function (i) { return padL + (w - padL - padR) * (i / (hist.length - 1)); };
    var Y = function (v) { return padT + (h - padT - padB) * (1 - (v - lo) / (hi - lo)); };

    c.strokeStyle = '#262c34'; c.lineWidth = 1;
    for (var g = 0; g <= 3; g++) {
      var yy = padT + (h - padT - padB) * g / 3;
      c.beginPath(); c.moveTo(padL, yy); c.lineTo(w - padR, yy); c.stroke();
    }
    c.beginPath(); c.strokeStyle = '#4c8dff'; c.lineWidth = 2;
    hist.forEach(function (v, i) { i ? c.lineTo(X(i), Y(v)) : c.moveTo(X(i), Y(v)); });
    c.stroke();

    // 验证准确率叠加在同一张图上（0~100% 映射到整个高度）。
    // 只看 loss 会误判 —— loss 降了不代表真的会认棋子。
    if (valHist && valHist.length === hist.length) {
      c.beginPath(); c.strokeStyle = '#3fbf74'; c.lineWidth = 2;
      c.setLineDash([4, 3]);
      valHist.forEach(function (v, i) {
        var yy = padT + (h - padT - padB) * (1 - v);
        i ? c.lineTo(X(i), yy) : c.moveTo(X(i), yy);
      });
      c.stroke();
      c.setLineDash([]);
    }

    c.fillStyle = '#98a0ac'; c.font = '9px ui-monospace,monospace';
    c.textAlign = 'right'; c.textBaseline = 'middle';
    c.fillText(hi.toFixed(2), padL - 4, padT);
    c.fillText(lo.toFixed(2), padL - 4, h - padB);
    c.textAlign = 'right'; c.textBaseline = 'top';
    c.fillStyle = '#ffb020';
    c.fillText('100%', w - padR - 2, padT - 1);
    c.fillText('0%', w - padR - 2, h - padB - 10);
    c.textAlign = 'left'; c.textBaseline = 'top';
    c.fillStyle = '#4c8dff';
    c.fillText('— loss', padL + 3, 1);
    if (valHist && valHist.length === hist.length) {
      c.fillStyle = '#3fbf74';
      c.fillText('-- 验证准确率', padL + 48, 1);
    }
    c.fillStyle = '#98a0ac';
    c.textAlign = 'right';
    c.fillText(hist.length + ' 轮', w - padR, h - padB + 4);
  }

  /** 错分去向：比单纯列准确率有用得多 —— 能看出是哪两类在互相混 */
  function matrixHtml(conf) {
    var rows = [];
    for (var g = 1; g < NC; g++) {
      var tot = 0, p;
      for (p = 0; p < NC; p++) tot += conf[g][p];
      if (!tot) continue;
      var miss = tot - conf[g][g];
      if (!miss) continue;
      var dest = [];
      for (p = 0; p < NC; p++) if (p !== g && conf[g][p]) dest.push({ p: p, n: conf[g][p] });
      dest.sort(function (a, b) { return b.n - a.n; });
      rows.push({ g: g, tot: tot, miss: miss, top: dest[0] || null });
    }
    if (!rows.length) return '<div class="muted tiny mt6">没有错分的格子</div>';
    rows.sort(function (a, b) { return (b.miss / b.tot) - (a.miss / a.tot); });

    var html = '<div class="muted tiny" style="margin-top:8px">错分去向（容易混的在前）：</div>' +
      '<table class="matrix"><tr><th style="text-align:left">真实 → 最常错认成</th><th>错/总</th></tr>';
    rows.slice(0, 8).forEach(function (x) {
      html += '<tr><td style="text-align:left">' + CLASSES[x.g].g + ' ' + CLASSES[x.g].id +
        (x.top ? ' <span class="muted">→ ' + CLASSES[x.top.p].g + ' ' + CLASSES[x.top.p].id +
          ' ×' + x.top.n + '</span>' : '') +
        '</td><td class="err">' + x.miss + '/' + x.tot + '</td></tr>';
    });
    html += '</table>';
    return html;
  }

  function renderEval(r, secondsPerEpoch, totalSeconds) {
    var html =
      '<div class="statline"><span>验证集准确率</span><b class="big">' + fmt(r.acc * 100, 2) + '%</b></div>' +
      '<div class="statline"><span>非空格子准确率</span><b class="big">' + fmt(r.deepAcc * 100, 2) + '%</b></div>' +
      '<div class="statline"><span>验证切片</span><b>' + r.n + '（非空 ' + r.deepTotal + '）</b></div>' +
      '<div class="statline"><span>训练耗时</span><b>' + fmt(totalSeconds, 0) + 's</b></div>' +
      '<div class="statline"><span>每轮耗时</span><b>' + fmt(secondsPerEpoch, 2) + 's</b></div>' +
      matrixHtml(r.conf);

    $('evalStat').innerHTML = html;
    $('resultCard').hidden = false;
  }

  // ---------------------------------------------------------------- 逐图回测
  // 不只给一个准确率：逐张列出错了几格，并且把「训练见过的图」和「验证图」分开统计。
  // 两组差得越多，说明模型越是在背答案而不是真认识棋子。

  function gotoBacktest(key) {
    var i = -1;
    for (var k = 0; k < samples.length; k++) if (samples[k].key === key) { i = k; break; }
    if (i < 0) return;
    current = i;
    mode = 'paint';
    showPred = !!backtest[key];
    lastPred = backtest[key] ? backtest[key].pred : null;
    updateModeButtons();
    showTab('annotate');
    renderStage();
    renderSamples();
  }

  $('btnBacktest').addEventListener('click', async function () {
    var u = usable();
    if (!u.length) { toast('先在「样本」里标定并标注一些图'); return; }
    if (!model) { toast('先在「训练」页训一次，或到「模型」页载入一个模型'); return; }

    var btn = $('btnBacktest');
    btn.disabled = true;
    if (native()) native().keepAwake(true);

    backtest = {};
    var rows = [];
    // 训练图 vs 验证图分开记
    var g = {
      train: { cells: 0, wrong: 0, neTotal: 0, neWrong: 0 },
      val: { cells: 0, wrong: 0, neTotal: 0, neWrong: 0 }
    };
    var conf = [];
    for (var z = 0; z < NC; z++) conf.push(new Int32Array(NC));

    try {
      for (var i = 0; i < u.length; i++) {
        var s = u[i];
        var pred = await predictCells(s, inSize);
        var d = diffOf(s, pred);
        backtest[s.key] = { pred: pred, diff: d };

        var grp = valKeys[s.key] ? g.val : g.train;
        grp.cells += CELLS;
        grp.wrong += d.diff.length;
        grp.neWrong += d.wrongNonEmpty;
        for (var c = 0; c < CELLS; c++) {
          var truth = s.cells[c];
          if (truth > 0) { grp.neTotal++; }
          conf[truth][pred[c]]++;
        }
        rows.push({
          key: s.key, name: s.name, thumb: s.thumb,
          wrong: d.diff.length, wrongNE: d.wrongNonEmpty,
          isVal: !!valKeys[s.key]
        });

        btn.textContent = '回测中… ' + (i + 1) + '/' + u.length;
        if (i % 3 === 2) await yieldTick();
      }
    } catch (e) {
      log('回测失败 ' + e.message);
      toast('回测失败：' + e.message);
      btn.disabled = false; btn.textContent = '逐图回测';
      if (native()) native().keepAwake(false);
      return;
    }

    if (native()) native().keepAwake(false);
    btn.disabled = false; btn.textContent = '逐图回测';

    rows.sort(function (a, b) { return b.wrong - a.wrong || b.wrongNE - a.wrongNE; });

    var pct = function (w, t) { return t ? (1 - w / t) * 100 : 0; };
    var trainAcc = pct(g.train.wrong, g.train.cells);
    var valAcc = pct(g.val.wrong, g.val.cells);
    var gap = trainAcc - valAcc;

    var verdict, vclass;
    if (g.train.cells && g.val.cells) {
      if (gap > 8) { verdict = '训练图明显好于验证图（差 ' + fmt(gap, 1) + ' 个点）—— 有过拟合迹象，加图 或 减少轮数'; vclass = 'predbadge'; }
      else if (gap > 3) { verdict = '训练图略好于验证图（差 ' + fmt(gap, 1) + ' 个点），属正常范围'; vclass = 'predok'; }
      else { verdict = '两组基本一致，没有明显过拟合'; vclass = 'predok'; }
    } else {
      verdict = '这次回测只有一组图（另一组为空）'; vclass = 'predok';
    }

    $('backtestSummary').innerHTML =
      '<div class="statline"><span>验证图准确率</span><b class="big">' +
      (g.val.cells ? fmt(valAcc, 2) + '%' : '—') + '</b></div>' +
      '<div class="statline"><span>训练图准确率</span><b>' +
      (g.train.cells ? fmt(trainAcc, 2) + '%' : '—') + '</b></div>' +
      '<div class="statline"><span>非空格子准确率</span><b>' +
      fmt(pct(g.train.neWrong + g.val.neWrong, g.train.neTotal + g.val.neTotal), 2) + '%</b></div>' +
      '<div class="statline"><span>回测范围</span><b>' + u.length + ' 张已标注图</b></div>' +
      '<div class="mt8 tiny"><span class="' + vclass + '">' + verdict + '</span></div>' +
      matrixHtml(conf);

    $('backtestList').innerHTML = rows.map(function (r) {
      var cls = r.wrong === 0 ? 'good' : (r.wrong <= 3 ? 'mid' : 'bad');
      return '<div class="bt-row ' + cls + '" data-key="' + escapeHtml(r.key) + '">' +
        '<img class="sw" src="' + r.thumb + '" alt="">' +
        '<span class="nm">' + escapeHtml(r.name) +
        (r.isVal ? ' <span class="muted">·验证图</span>' : '') + '</span>' +
        '<span class="bd">' + r.wrong + ' 错</span></div>';
    }).join('');
    $('backtestCard').hidden = false;

    Array.prototype.forEach.call($('backtestList').querySelectorAll('.bt-row'), function (el) {
      el.addEventListener('click', function () { gotoBacktest(el.dataset.key); });
    });

    log('逐图回测：验证图 ' + (g.val.cells ? fmt(valAcc, 2) + '%' : '—') +
        ' · 训练图 ' + (g.train.cells ? fmt(trainAcc, 2) + '%' : '—'));
  });

  $('btnStop').addEventListener('click', function () {
    stopFlag = true;
    log('收到停止请求，会在本轮结束时停下');
  });

  $('btnTrain').addEventListener('click', async function () {
    if (!trainX) { toast('先构建数据集'); return; }
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
    backtest = {};          // 模型换了，之前的回测结果不再成立
    showPred = false;
    lastPred = null;
    $('backtestCard').hidden = true;
    var params = 0;
    model.layers.forEach(function (l) { l.getWeights().forEach(function (w) { params += w.size; }); });
    log('模型参数量 ' + params.toLocaleString() + ' · 输入 ' + size + '×' + size + ' · 类别 ' + NC);

    var opt = tf.train.adam(1e-3);
    var t0 = performance.now();
    var firstEpoch = 0, lastEpoch = 0;
    var lossHist = [];
    var valHist = [];
    var patience = clamp(parseInt($('pPatience').value, 10) || 0, 0, 200);
    var bestVal = -1, bestEp = -1, stale = 0;
    var nTrainSamples = trainY.length / NC;
    var stoppedEarly = false;

    for (var ep = 0; ep < epochs && !stopFlag; ep++) {
      var order = shuffledOrder();
      var epStart = performance.now();
      var lossSum = 0, batches = 0;

      for (var b = 0; b < nTrainSamples; b += batch) {
        var to = Math.min(nTrainSamples, b + batch);
        var bt = makeBatch(order, b, to, size);
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
      var epLoss = lossSum / Math.max(1, batches);
      lossHist.push(epLoss);

      // 每轮跑一遍验证集：只看 loss 是看不出「到底会不会认棋子」的。
      // 验证集不大，前向一遍的开销相对反传可以忽略。
      var valAcc = 0;
      try { valAcc = await quickValAcc(); } catch (e) { valAcc = 0; }
      valHist.push(valAcc);

      if (valAcc > bestVal) { bestVal = valAcc; bestEp = ep; stale = 0; }
      else stale++;

      var elapsed = (performance.now() - t0) / 1000;
      var steady = ep > 0 ? (elapsed - firstEpoch / 1000) / ep : 0;
      var remain = steady > 0 ? Math.max(0, (epochs - ep - 1) * steady) : 0;
      var thru = epMs > 0 ? Math.round(nTrainSamples / (epMs / 1000)) : 0;

      $('trainProg').style.width = ((ep + 1) / epochs * 100) + '%';
      $('trainStat').innerHTML =
        '第 ' + (ep + 1) + '/' + epochs + ' 轮 · loss <b>' + fmt(epLoss, 4) +
        '</b> · 验证 <b>' + fmt(valAcc * 100, 1) + '%</b>' +
        '<br><span class="muted">本轮 ' + fmt(epMs / 1000, 1) + 's · ' + thru +
        ' 样本/秒 · 已用 ' + fmt(elapsed, 0) + 's</span>';
      $('etaText').textContent = remain > 0
        ? '预计还需 ' + (remain >= 60 ? fmt(remain / 60, 1) + ' 分钟' : fmt(remain, 0) + ' 秒') +
          '（首轮含编译 ' + fmt(firstEpoch / 1000, 1) + 's）'
        : '';

      if (ep % 2 === 1 || ep === epochs - 1) await yieldTick();
      if (ep % 5 === 0) {
        log('第 ' + (ep + 1) + ' 轮 loss ' + fmt(epLoss, 4) + ' · 验证 ' + fmt(valAcc * 100, 1) + '%');
      }

      // 早停：验证准确率连续若干轮不再提升就收手，省掉后面白跑的轮数
      if (patience > 0 && stale >= patience) {
        stoppedEarly = true;
        log('早停：验证准确率已连续 ' + patience + ' 轮没有提升（最好 ' +
            fmt(bestVal * 100, 1) + '% @ 第 ' + (bestEp + 1) + ' 轮）');
        break;
      }
    }

    var total = (performance.now() - t0) / 1000;
    $('etaText').textContent = '';
    $('trainStat').innerHTML += '<br><span class="muted">训练结束，共 ' + fmt(total, 0) +
      's' + (stoppedEarly ? ' · 早停' : '') + ' · 最好验证 ' + fmt(bestVal * 100, 1) + '%</span>';
    drawLossCurve(lossHist, valHist);
    log('训练结束，用时 ' + fmt(total, 1) + 's · 最好验证 ' + fmt(bestVal * 100, 2) +
        '%（第 ' + (bestEp + 1) + ' 轮）');

    try {
      log('在验证集上评估…');
      var r = await evaluate();
      if (r) {
        renderEval(r, lastEpoch / 1000, total);
        log('验证准确率 ' + fmt(r.acc * 100, 2) + '% · 非空 ' + fmt(r.deepAcc * 100, 2) + '%');
        currentMeta = '验证集 ' + fmt(r.acc * 100, 1) + '% / 非空 ' + fmt(r.deepAcc * 100, 1) +
          '% · 样本 ' + usable().length + ' 张 · ' + epochs + ' 轮';
      }

      // 自动留一份：不然关掉应用模型就没了，隔天想回测还得重训
      try {
        await saveModelToDb(AUTO_MODEL_NAME, { desc: currentMeta });
        await refreshSavedModels();
        log('已自动保存本次训练结果，可在「模型」页重新载入');
      } catch (e2) {
        log('自动保存失败：' + e2.message);
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

  // ---------------------------------------------------------------- 保存 / 导出

  var currentMeta = null;

  function downloadBlob(blob, name) {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
  }

  /** 把库里的模型记录拼成 TF.js layers-model 的 json + bin */
  function buildExport(rec) {
    var base = rec.name;
    var json = {
      format: 'layers-model',
      generatedBy: 'JieqiBox Model Studio',
      convertedBy: null,
      modelTopology: rec.modelTopology,
      weightSpecs: rec.weightSpecs,
      weightsManifest: [{ paths: [base + '.bin'], weights: rec.weightSpecs }],
      userData: {
        labels: rec.classIds,
        inputSize: rec.size,
        grid: rec.grid,
        cropK: rec.cropK,
        note: '逐格分类器：输入为以交叉点为中心的方格裁切，输出 logits（推理时需 softmax）'
      }
    };
    return { json: JSON.stringify(json), bin: rec.weightData, base: base };
  }

  function exportModelRecord(rec) {
    var e = buildExport(rec);
    var nat = native();
    if (nat) {
      var r = nat.saveFile(e.base + '.bin', abToBase64(e.bin));
      if (String(r).indexOf('ERROR') === 0) { toast('导出失败：' + r); return; }
      nat.saveFile(e.base + '.json', strToBase64(e.json));
      var dir = String(r).replace(/[^/]*$/, '');
      log('已导出 ' + e.base + '.json / .bin（' + fmt(e.bin.byteLength / 1024, 0) + ' KB 权重）');
      toast('已导出到 ' + dir, 2800);
    } else {
      downloadBlob(new Blob([e.bin]), e.base + '.bin');
      downloadBlob(new Blob([e.json], { type: 'application/json' }), e.base + '.json');
      toast('已导出到下载目录');
    }
  }

  // ------------------------------------------------ ONNX 导出

  /** 组装导出用的元数据：拿到 .onnx 的人不必再翻源码就知道类别顺序 */
  function onnxMeta(size, desc) {
    return {
      labels: LABEL_IDS.join(','),
      input_size: String(size) + 'x' + String(size),
      input_layout: 'NHWC',
      output: 'logits (未过 softmax)',
      grid: COLS + 'x' + ROWS,
      crop_k: String(CROP_K),
      note: desc || '逐格分类器：输入是以交叉点为中心的方格裁切'
    };
  }

  function saveBytes(name, bytes, mime) {
    var nat = native();
    if (nat) {
      var r = nat.saveFile(name, abToBase64(bytes));
      if (String(r).indexOf('ERROR') === 0) { toast('导出失败：' + r); return null; }
      return String(r).replace(/[^/]*$/, '');
    }
    downloadBlob(new Blob([bytes], { type: mime || 'application/octet-stream' }), name);
    return '下载目录';
  }

  /** 把内存里的模型导出成 ONNX */
  function exportOnnx(m, size, baseName, desc) {
    if (!m) { toast('还没有模型'); return false; }
    if (typeof OnnxExport === 'undefined') { toast('ONNX 导出模块未加载'); return false; }
    var built;
    try {
      built = OnnxExport.buildOnnx(m, {
        size: size,
        numClasses: NC,
        meta: onnxMeta(size, desc)
      });
    } catch (e) {
      log('ONNX 导出失败：' + e.message);
      toast('ONNX 导出失败：' + e.message);
      return false;
    }
    var where = saveBytes(baseName + '.onnx', built.bytes, 'application/octet-stream');
    if (!where) return false;
    log('已导出 ' + baseName + '.onnx（' + fmt(built.bytes.length / 1024, 0) + ' KB，'
        + built.summary.conv + ' 卷积 / ' + built.summary.dense + ' 全连接）');
    toast('已导出 ONNX 到 ' + where, 2800);
    return true;
  }

  /** 从库里保存的记录导出 ONNX：先还原成 tf 模型，再走同一个导出路径 */
  async function exportOnnxFromRecord(rec) {
    var m = null;
    try {
      m = await tf.loadLayersModel(tf.io.fromMemory({
        modelTopology: rec.modelTopology,
        weightSpecs: rec.weightSpecs,
        weightData: rec.weightData
      }));
      var desc = (rec.meta && rec.meta.desc) || '';
      exportOnnx(m, rec.size, rec.name, desc);
    } catch (e) {
      log('从记录导出 ONNX 失败：' + e.message);
      toast('导出失败：' + e.message);
    } finally {
      if (m) m.dispose();
    }
  }

  $('btnExportOnnx').addEventListener('click', function () {
    if (!model) { toast('还没有训练好的模型'); return; }
    var stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 13);
    var base = 'jieqi-cells-' + inSize + '-' + stamp;
    exportOnnx(model, inSize, base, currentMeta);
  });

  $('btnSaveModel').addEventListener('click', async function () {
    if (!model) { toast('还没有训练好的模型'); return; }
    $('btnSaveModel').disabled = true;
    try {
      var stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 13);
      var name = 'jieqi-cells-' + inSize + '-' + stamp;
      var rec = await saveModelToDb(name, { desc: currentMeta });
      await refreshSavedModels();
      exportModelRecord(rec);
      log('模型已存进应用：' + name + '（可在「模型」页随时载入回测）');
    } catch (e) {
      log('保存失败 ' + e.message);
      toast('保存失败：' + e.message);
    }
    $('btnSaveModel').disabled = false;
  });

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
    /** 清掉当前图的标定，用来测批量标定（仅供自动化测试） */
    dropLattice: function () {
      var s = currentSample();
      if (!s) return false;
      s.lattice = null; s.conf = 0;
      queueSave(s);
      renderStage();
      renderSamples();
      return true;
    },
    /** 标注数据，供自动化核对用 */
    cells: function () {
      var s = currentSample();
      return s ? {
        cells: s.cells ? Array.from(s.cells) : null,
        auto: s.auto ? Array.from(s.auto) : null
      } : null;
    },
    findKey: function (key) {
      for (var k = 0; k < samples.length; k++) if (samples[k].key === key) return k;
      return -1;
    },
    sampleKeys: function () { return samples.slice(0, 5).map(function (s) { return s.key; }); },
    /** 直接产出 ONNX 字节，供自动化验证使用 */
    onnxBytes: function () {
      if (!model || typeof OnnxExport === 'undefined') return null;
      var built = OnnxExport.buildOnnx(model, {
        size: inSize,
        numClasses: NC,
        meta: onnxMeta(inSize, currentMeta)
      });
      return { bytes: built.bytes, summary: built.summary };
    },
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
      // 模型记录和样本共用一个 store，靠 key 前缀区分
      samples = (all || []).filter(function (r) { return !isModelRecord(r); })
        .sort(function (a, b) { return a.key < b.key ? -1 : 1; });
      log('从本地读回 ' + samples.length + ' 张样本');
    } catch (e) {
      log('读取本地样本失败：' + e.message);
      samples = [];
    }
    current = samples.length ? 0 : -1;
    renderSamples();
    refreshTrainTab();
    refreshSavedModels();

    window.addEventListener('resize', function () { if ($('tab-annotate').classList.contains('on')) renderStage(); });
  }

  boot();
})();
