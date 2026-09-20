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
  // c = 标记色。
  //
  // 配色原则：**靠色相区分，不靠明度**。
  // 之前红子用暗红、黑子用浅灰、暗子用中灰 —— 后两者只差明度，
  // 压在木色棋盘上（本身是中间调）就更分不清了。
  // 现在三方色相彻底拉开：红 / 青 / 琥珀，任何底色上都能一眼分辨。
  var COLOR_RED = '#ff3b5c';    // 红方
  var COLOR_BLACK = '#3ddcff';  // 黑方（用青色，和红、和木色都拉得很开）
  var COLOR_DARK = '#ffb020';   // 暗子
  var COLOR_EMPTY = '#6b7684';

  var CLASSES = [
    { id: 'empty', g: '空', k: 'e', c: COLOR_EMPTY },
    { id: 'r_general', g: '帅', k: 'r', c: COLOR_RED }, { id: 'r_advisor', g: '仕', k: 'r', c: COLOR_RED },
    { id: 'r_elephant', g: '相', k: 'r', c: COLOR_RED }, { id: 'r_horse', g: '马', k: 'r', c: COLOR_RED },
    { id: 'r_chariot', g: '车', k: 'r', c: COLOR_RED }, { id: 'r_cannon', g: '炮', k: 'r', c: COLOR_RED },
    { id: 'r_soldier', g: '兵', k: 'r', c: COLOR_RED },
    { id: 'b_general', g: '将', k: 'b', c: COLOR_BLACK }, { id: 'b_advisor', g: '士', k: 'b', c: COLOR_BLACK },
    { id: 'b_elephant', g: '象', k: 'b', c: COLOR_BLACK }, { id: 'b_horse', g: '马', k: 'b', c: COLOR_BLACK },
    { id: 'b_chariot', g: '车', k: 'b', c: COLOR_BLACK }, { id: 'b_cannon', g: '炮', k: 'b', c: COLOR_BLACK },
    { id: 'b_soldier', g: '卒', k: 'b', c: COLOR_BLACK },
    { id: 'dark', g: '暗', k: 'd', c: COLOR_DARK }
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

  /**
   * 确保有一个可用的模型。
   *
   * 模型就存在库里，没必要让用户先手动载入 ——
   * 凡是需要推理的地方（预标注、对比模型、回测）都先调它，
   * 行为一致，用户不用记「哪个功能需要先载入模型」。
   * @returns true 表示 model 已就绪
   */
  /**
   * 当前「首选」模型。
   *
   * 默认是最新训练的那个，但如果新版在验证集上明显更差，就把旧的留作首选 ——
   * 不然一次失败的训练会悄悄把能用的模型顶掉，而你只会在下次用时才发现。
   */
  var PREF_KEY = 'evolve.preferredModel.v1';

  function preferredModel() {
    if (!savedModels.length) return null;
    var want = null;
    try { want = localStorage.getItem(PREF_KEY); } catch (e) { }
    if (want) {
      for (var i = 0; i < savedModels.length; i++) {
        if (savedModels[i].name === want) return savedModels[i];
      }
    }
    return savedModels[0];
  }

  function setPreferred(name) {
    try { localStorage.setItem(PREF_KEY, name); } catch (e) { }
  }

  /** 从模型记录的描述里抠出验证准确率 */
  function accOf(rec) {
    if (!rec || !rec.meta) return 0;
    var m = /验证集\s*([\d.]+)%/.exec(rec.meta.desc || '');
    return m ? parseFloat(m[1]) : 0;
  }

  /**
   * 训练完之后决定要不要把这个模型设为首选。
   * @returns {{action:'promote'|'keep'|'block', best:number, prev:number}}
   */
  function guardPromotion(rec) {
    var acc = accOf(rec);
    if (!acc) return { action: 'promote', best: 0, prev: 0 };   // 没数字，无从比较

    // 找现存最好的（不含刚训的这个）
    var prev = 0, prevName = '';
    savedModels.forEach(function (m) {
      if (m.name === rec.name) return;
      var a = accOf(m);
      if (a > prev) { prev = a; prevName = m.name; }
    });
    if (!prev) { setPreferred(rec.name); return { action: 'promote', best: acc, prev: 0 }; }

    var P = Evolve.loadParams();
    // 差到阈值以上才认为是退化 —— 小波动是正常的，不该来回横跳
    if (acc < prev - P.promoteDrop) {
      if (typeof Evolve !== 'undefined' && Evolve.isAuto('promote')) {
        setPreferred(prevName);
        log('择优：新模型 ' + fmt(acc, 1) + '% 低于已有的 ' + fmt(prev, 1) + '%，保留「' + prevName + '」为首选');
        pushEvLog('新模型 ' + fmt(acc, 1) + '% 不如旧的 ' + fmt(prev, 1) + '%，已保留旧模型为首选');
        return { action: 'block', best: acc, prev: prev };
      }
      pushEvLog('提醒：新模型 ' + fmt(acc, 1) + '% 低于旧的 ' + fmt(prev, 1) + '%，建议先别换');
      return { action: 'keep', best: acc, prev: prev };
    }

    // 提升门槛：验证集本身有噪声，好一点点不能算真进步 ——
    // 不设门槛的话模型会在同一水平上来回横跳
    if (prev && acc < prev + P.promoteGain) {
      setPreferred(rec.name);
      log('择优：新模型 ' + fmt(acc, 1) + '% 与旧模型 ' + fmt(prev, 1) +
          '% 的差距小于提升门槛 ' + P.promoteGain + '，视为同一水平');
      return { action: 'promote', best: acc, prev: prev };
    }

    setPreferred(rec.name);
    if (acc > prev) {
      pushEvLog('升级：新模型 ' + fmt(acc, 1) + '% 优于旧的 ' + fmt(prev, 1) + '%，已设为首选');
    }
    return { action: 'promote', best: acc, prev: prev };
  }

  async function ensureModel() {
    if (model) return true;
    if (!savedModels.length) {
      toast('还没有模型 —— 先到「训练」页跑一次', 3400);
      return false;
    }
    var rec = preferredModel() || savedModels[0];
    setBusy(true, '载入模型', rec.name);
    try {
      await loadModelFromRecord(rec);
      setBusy(false);
      refreshFinetunePanel();
      log('已自动载入模型「' + rec.name + '」');
      return true;
    } catch (e) {
      setBusy(false);
      toast('载入模型失败：' + e.message, 3600);
      return false;
    }
  }

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
  var brush = 0;            // 标注笔刷的类别索引
  /*
   * 改错笔刷。有值时表示用户正在用「改错」这一行：
   * 点格子会把该格改成这个子，并列入待学清单。
   *
   * 和标注分开的理由：用户真正的痛点是「改一个棋子太麻烦、还容易和标注搞混」。
   * 给它一个独立的笔刷行，改错就变成一个明确的动作 ——
   * 选错行了他自己看得见。
   */
  var fixBrush = null;
  var drawStart = null, drawNow = null, nudgeRef = null;
  // 「取空位」模式：让用户直接指定哪几处是干净木板，作为生成模板的贴图来源
  var pinMode = false;
  var grayCache = { key: null, gray: null, w: 0, h: 0 };
  var model = null, inSize = 32, stopFlag = false;

  var stage = null, sctx = null, dpr = window.devicePixelRatio || 1;
  // 取景状态：把图片的某一块映射到舞台盒子里
  var view = { key: null, boxW: 0, boxH: 0, imgW: 0, imgH: 0, fit: 1, zoom: 1, panX: 0, panY: 0 };

  // ---------------------------------------------------------------- 屏幕路由
  //
  // 结构：首页（待办）是根，其余都是下钻。
  // 原来四个并列标签的问题是把"该做的事"和"已有的数据"混在一起，
  // 界面从来不回答"我现在该做什么" —— 现在由首页统一回答。
  var SCREENS = ['home', 'samples', 'train', 'annotate', 'collect', 'about', 'evolve'];
  var currentScreen = 'home';
  var navStack = [];

  function go(name, opts) {
    opts = opts || {};
    if (name === currentScreen) {
      // 已经在目标页：只刷新，不压栈（避免反复点同一个待办把栈撑满）
      refreshScreen(name);
      return;
    }
    if (!opts.back) navStack.push(currentScreen);

    SCREENS.forEach(function (sc) {
      var el = $('sc-' + sc);
      if (el) el.classList.toggle('on', sc === name);
    });
    currentScreen = name;
    closeSheet();
    refreshScreen(name);
  }

  function refreshScreen(name) {
    if (name === 'home') renderHome();
    else if (name === 'samples') { renderStats(); renderSamples(); }
    else if (name === 'train') { refreshTrainTab(); refreshFinetunePanel(); refreshBacktest(); }
    else if (name === 'annotate') renderStage();
    else if (name === 'collect') refreshCollect();
    else if (name === 'about') renderAbout();
    else if (name === 'evolve') renderEvolve();
  }

  function goBack() {
    var prev = navStack.pop() || 'home';
    go(prev, { back: true });
  }

  window.onAndroidBack = function () {
    if ($('sheet').classList.contains('on')) { closeSheet(); return true; }
    if (currentScreen !== 'home') { goBack(); return true; }
    return false;
  };

  Array.prototype.forEach.call(
    document.querySelectorAll('#btnBackFromSamples,#btnBackFromTrain,#btnBackFromAnnotate,#btnBackFromCollect,#btnBackFromAbout,#btnBackFromEvolve'),
    function (b) { b.addEventListener('click', goBack); }
  );
  $('btnCollectTop').addEventListener('click', function () { go('collect'); });
  $('btnGoSamples').addEventListener('click', function () { go('samples'); });

  // 训练台的两个页面：训练 / 纠错
  function trainTab(which) {
    $('pane-train').classList.toggle('on', which === 'train');
    $('pane-fix').classList.toggle('on', which === 'fix');
    $('tabTrain').classList.toggle('on', which === 'train');
    $('tabFix').classList.toggle('on', which === 'fix');
    if (which === 'fix') { refreshBacktest(); refreshFinetunePanel(); }
  }
  $('tabTrain').addEventListener('click', function () { trainTab('train'); });
  $('tabFix').addEventListener('click', function () { trainTab('fix'); });
  $('btnBacktest2').addEventListener('click', function () { runBacktest(); });
  $('btnGotoTrain').addEventListener('click', function () { trainTab('train'); });
  $('btnJumpFilter').addEventListener('click', function () {
    sampleFilter = 'all';
    go('samples');
  });

  // ---------------------------------------------------------------- 样本状态
  //
  // 把「这张图处于流程的哪一步」变成一个明确的值 ——
  // 首页的待办、样本库的筛选、卡片上的色标，全都由它驱动，
  // 三处显示的状态永远一致。
  function sampleState(s) {
    if (!s.lattice) return 'uncalibrated';
    if (!s.cells || annotatedCount(s) === 0) return 'pending';
    if (s.auto) {
      for (var i = 0; i < CELLS; i++) if (s.auto[i]) return 'review';
    }
    return 'ready';
  }

  var STATE_LABEL = {
    uncalibrated: '待标定', pending: '待标注', review: '待核对', ready: '已就绪'
  };
  var STATE_COLOR = {
    uncalibrated: '#e0a33a', pending: '#e0a33a', review: '#7b5cff', ready: '#3fbf74'
  };

  function sampleCounts() {
    var c = { total: 0, uncalibrated: 0, pending: 0, review: 0, ready: 0,
              fixes: 0, fixImgs: 0 };
    samples.forEach(function (s) {
      c.total++;
      c[sampleState(s)]++;
      var f = fixedCount(s);
      if (f) { c.fixes += f; c.fixImgs++; }
    });
    return c;
  }

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

  // ---------------------------------------------------------------- 样本库
  var sampleFilter = 'all';      // all | uncalibrated | pending | review | ready | fix
  var picked = {};               // key -> true，多选状态
  var sheetSample = null;        // 抽屉里正在看的样本

  function filteredSamples() {
    if (sampleFilter === 'all') return samples;
    if (sampleFilter === 'fix') {
      return samples.filter(function (s) { return fixedCount(s) > 0; });
    }
    return samples.filter(function (s) { return sampleState(s) === sampleFilter; });
  }

  /** 顶部统计条：既是统计也是筛选，点一下就筛 */
  function renderStats() {
    var c = sampleCounts();
    var items = [
      { k: '样本', v: c.total, f: 'all' },
      { k: '待标定', v: c.uncalibrated, f: 'uncalibrated', hot: true },
      { k: '待标注', v: c.pending, f: 'pending', hot: true },
      { k: '待核对', v: c.review, f: 'review', hot: true },
      { k: '修正', v: c.fixes, f: 'fix', fix: true }
    ];
    $('statsBar').innerHTML = items.map(function (it) {
      return '<div class="it' + (it.hot ? ' hot' : '') + (it.fix ? ' fix' : '') +
        (sampleFilter === it.f ? ' on' : '') +
        '" data-f="' + it.f + '"><div class="v">' + it.v +
        '</div><div class="k">' + it.k + '</div></div>';
    }).join('');
    Array.prototype.forEach.call($('statsBar').children, function (el) {
      el.addEventListener('click', function () {
        sampleFilter = el.dataset.f;
        picked = {};
        renderStats();
        renderSamples();
      });
    });

    var n = Object.keys(picked).length;
    $('bulkBar').classList.toggle('on', n > 0);
    $('bulkText').textContent = '已选 ' + n + ' 张';
  }

  function renderSamples() {
    var grid = $('sampleGrid');
    var arr = filteredSamples();
    grid.innerHTML = '';

    arr.forEach(function (s) {
      var i = samples.indexOf(s);
      var st = sampleState(s);
      var f = fixedCount(s);
      var el = document.createElement('button');
      el.className = 'smp' + (picked[s.key] ? ' picked' : '');
      el.innerHTML =
        '<img src="' + s.thumb + '" alt="">' +
        '<span class="st" style="background:' + STATE_COLOR[st] + '">' +
          STATE_LABEL[st] + '</span>' +
        (f ? '<span class="fx">' + f + '</span>' : '') +
        '<span class="tick">✓</span>' +
        '<div class="bar"><span class="nm">' + escapeHtml(s.name) + '</span>' +
        '<span>' + annotatedCount(s) + '子</span></div>';

      el.addEventListener('click', function () { tapSample(s, i); });
      grid.appendChild(el);
    });

    $('samplesEmpty').hidden = samples.length > 0;
    $('sampleSummary').innerHTML = samples.length
      ? '共 <b>' + samples.length + '</b> 张截图。已标注的非空格子会用于训练。'
      : '还没有样本。';
    updateBatchInfo();
  }

  /**
   * 点样本：
   *   没有多选时 → 弹出抽屉，看这张图的详情与操作
   *   有多选时   → 切换选中状态（连续多选，不必先按「多选」按钮）
   */
  function tapSample(s, i) {
    if (Object.keys(picked).length > 0) {
      if (picked[s.key]) delete picked[s.key]; else picked[s.key] = true;
      renderStats();
      renderSamples();
      if (Object.keys(picked).length) openBulkSheet(); else closeSheet();
      return;
    }
    sheetSample = s;
    openSampleSheet(s, i);
  }

  function closeSheet() { $('sheet').classList.remove('on'); }

  function openSampleSheet(s, i) {
    var st = sampleState(s);
    var f = fixedCount(s);
    $('sheet').innerHTML =
      '<div class="hnd"></div>' +
      '<div class="info">' +
      '<img src="' + s.thumb + '">' +
      '<div class="t"><b>' + escapeHtml(s.name) + '</b>' +
      '<span class="tiny">' + STATE_LABEL[st] + ' · ' + annotatedCount(s) + ' 子' +
      (f ? ' · <span style="color:#7b5cff">' + f + ' 处修正</span>' : '') +
      '</span></div></div>' +
      '<div class="acts">' +
      '<button class="ab pri" data-a="annotate"><span class="ic">✎</span>标注</button>' +
      '<button class="ab" data-a="compare"><span class="ic">◑</span>对比模型</button>' +
      '<button class="ab" data-a="pick"><span class="ic">☑</span>多选</button>' +
      '<button class="ab" data-a="del"><span class="ic">✕</span>删除</button>' +
      '</div>';

    // 把「当前筛选出来的这批」作为翻页范围 —— 从哪筛进来的就在哪一类里翻
    var ctx = filteredSamples();
    var ctxLabel = sampleFilter === 'all' ? '全部样本'
      : (sampleFilter === 'fix' ? '有修正的' : STATE_LABEL[sampleFilter]);

    $('sheet').querySelector('[data-a="annotate"]').addEventListener('click', function () {
      openAnnotate(i, false, ctx, ctxLabel);
    });
    $('sheet').querySelector('[data-a="compare"]').addEventListener('click', function () {
      openAnnotate(i, true, ctx, ctxLabel);
    });
    $('sheet').querySelector('[data-a="pick"]').addEventListener('click', function () {
      picked[s.key] = true;
      renderStats(); renderSamples(); openBulkSheet();
    });
    $('sheet').querySelector('[data-a="del"]').addEventListener('click', function () {
      closeSheet();
      removeSample(s.key);
    });

    $('sheet').classList.add('on');
  }

  function openBulkSheet() {
    var n = Object.keys(picked).length;
    $('sheet').innerHTML =
      '<div class="hnd"></div>' +
      '<div class="info"><div class="t"><b>已选 ' + n + ' 张</b>' +
      '<span class="tiny">可以对它们批量操作</span></div></div>' +
      '<div class="acts c3">' +
      '<button class="ab pri" data-b="accept"><span class="ic">✓</span>确认预标注</button>' +
      '<button class="ab" data-b="calib"><span class="ic">▦</span>自动标定</button>' +
      '<button class="ab" data-b="prelabel"><span class="ic">◑</span>模型预标注</button>' +
      '</div>' +
      '<div class="acts c3 mt8">' +
      '<button class="ab" data-b="del"><span class="ic">✕</span>删除</button>' +
      '</div>';
    $('sheet').querySelector('[data-b="accept"]').addEventListener('click', function () {
      var sel = samples.filter(function (s) { return picked[s.key]; });
      closeSheet();
      picked = {};
      renderStats();
      renderSamples();
      acceptMany(sel);
    });
    $('sheet').querySelector('[data-b="calib"]').addEventListener('click', function () {
      var keys = Object.keys(picked); closeSheet();
      batchCalibrate(samples.filter(function (s) { return picked[s.key]; }));
    });
    $('sheet').querySelector('[data-b="prelabel"]').addEventListener('click', function () {
      closeSheet(); preLabelAll();
    });
    $('sheet').querySelector('[data-b="del"]').addEventListener('click', function () {
      var keys = Object.keys(picked);
      if (!confirm('删除选中的 ' + keys.length + ' 张？')) return;
      closeSheet();
      Promise.all(keys.map(function (k) { return removeSample(k); })).then(function () {
        picked = {}; renderStats(); renderSamples(); renderHome();
      });
    });
    $('sheet').classList.add('on');
  }

  $('btnSelAll').addEventListener('click', function () {
    filteredSamples().forEach(function (s) { picked[s.key] = true; });
    renderStats(); renderSamples(); openBulkSheet();
  });
  $('btnSelNone').addEventListener('click', function () {
    picked = {}; renderStats(); renderSamples(); closeSheet();
  });

  /**
   * 打开某张图进入标注（专注模式）。
   * @param ctxList  翻页要依据的集合；不传就用当前筛选结果
   * @param ctxLabel 那个集合叫什么（显示在标题上）
   */
  function openAnnotate(i, compare, ctxList, ctxLabel) {
    if (i < 0 || i >= samples.length) return;
    if (ctxList) setNavContext(ctxList, ctxLabel);
    current = i;
    var s = samples[i];
    mode = s.lattice ? 'paint' : 'draw';
    showPred = false;
    lastPred = null;
    updateModeButtons();
    updateCompareBar();     // 提示栏必须跟着状态走，否则会留着上一张的显示
    closeSheet();
    go('annotate');
    if (compare) {
      $('btnCheckModel').click();   // 复用已有的推理入口，避免重复实现
    }
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

  // ---------------------------------------------------------------- 首页（待办）
  //
  // 首页不堆数据，只回答一个问题：现在该做什么。
  // 每一项都直接下钻到对应的位置，处理完回来它自己就消失了 ——
  // 因为待办是从样本状态实时算出来的，不是手动维护的列表。

  function renderHome() {
    var c = sampleCounts();
    var hasModel = savedModels.length > 0;
    var todo = [];

    if (c.uncalibrated) {
      todo.push({
        cls: 't-calib', num: c.uncalibrated,
        title: '标定棋盘',
        desc: '这 ' + c.uncalibrated + ' 张还没定位棋盘，标定后才能标注',
        act: function () { sampleFilter = 'uncalibrated'; go('samples'); }
      });
    }
    if (c.pending) {
      todo.push({
        cls: 't-review', num: c.pending,
        title: '标注棋子',
        desc: '这 ' + c.pending + ' 张标定好了，还没标棋子。可以用「模型预标注」先猜一遍',
        act: function () { sampleFilter = 'pending'; go('samples'); }
      });
    }
    if (c.review) {
      todo.push({
        cls: 't-review', num: c.review,
        title: '核对预标注',
        desc: '模型已经猜过一遍，你只需要改错的地方',
        act: function () { sampleFilter = 'review'; go('samples'); }
      });
    }
    if (c.ready && !hasModel) {
      todo.push({
        cls: 't-train', num: '训',
        title: '训练第一个模型',
        desc: '已有 ' + c.ready + ' 张可用的图，训练约 30 秒',
        act: function () { go('train'); trainTab('train'); }
      });
    }
    if (c.fixes) {
      todo.push({
        cls: 't-fix', num: c.fixes,
        title: '修正 ' + c.fixes + ' 处判错',
        desc: '分布在 ' + c.fixImgs + ' 张图上 —— 改对后让模型重点学这些地方',
        act: function () { go('train'); trainTab('fix'); }
      });
    }

    $('homeSubtitle').textContent = todo.length
      ? '还有 ' + todo.length + ' 件事要做'
      : (hasModel ? '都做完了 · 模型准确率 ' + fmt(lastAcc(), 1) + '%'
                  : '还没有样本，先采集一些截图');

    var h = todo.map(function (t, i) {
      return '<div class="todo ' + t.cls + '" data-i="' + i + '">' +
        '<div class="num">' + t.num + '</div>' +
        '<div class="body"><b>' + t.title + '</b><span>' + t.desc + '</span></div>' +
        '<div class="go">去处理 ›</div></div>';
    }).join('');

    // 模型状态常驻显示：它是"成果"不是"待办"
    if (hasModel) {
      var m = savedModels[0];
      var d = m.meta || {};
      h += '<div class="todo done" id="todoModel">' +
        '<div class="num">✓</div>' +
        '<div class="body"><b>' + escapeHtml(m.name) + '</b>' +
        '<span>' + (d.desc ? escapeHtml(d.desc) + ' · ' : '') +
        new Date(m.at).toLocaleString() + '</span></div>' +
        '<div class="go">详情 ›</div></div>';
    }

    h += '<div class="addbtn" id="btnCollectHome">＋ 采集新样本</div>';
    // 体检发现违规时在这里也提醒一声 —— 那是最值得先处理的事
    var badN = 0;
    if (typeof Evolve !== 'undefined') {
      samples.forEach(function (sm) {
        if (sm.cells && Evolve.validate(sm.cells).length) badN++;
      });
    }
    if (badN) {
      h += '<div class="todo t-fix" id="btnEvolveHome">' +
        '<div class="num">' + badN + '</div>' +
        '<div class="body"><b>标注可能有问题</b>' +
        '<span>有 ' + badN + ' 张违反了棋规（棋子超编、帅出九宫、将帅照面）</span></div>' +
        '<div class="go">去复核 ›</div></div>';
    }
    h += '<div class="addbtn" id="btnEvolveHome2">⚙ 自进化与体检</div>';
    h += '<div class="hintline"><div class="dot"></div><div>' +
      '用手机自带的截图功能在对局里截图，回到这里点「采集」就能把新图捞进来。' +
      '授权一次截图文件夹之后，之后每次都不用再手动翻相册。</div></div>';

    $('todoList').innerHTML = h;

    Array.prototype.forEach.call($('todoList').querySelectorAll('.todo[data-i]'),
      function (el) {
        el.addEventListener('click', function () { todo[Number(el.dataset.i)].act(); });
      });
    var cm = $('todoModel');
    if (cm) cm.addEventListener('click', function () { go('about'); });
    var ch = $('btnCollectHome');
    if (ch) ch.addEventListener('click', function () { go('collect'); });
    var eh = $('btnEvolveHome');
    if (eh) eh.addEventListener('click', function () { go('evolve'); });
    var eh2 = $('btnEvolveHome2');
    if (eh2) eh2.addEventListener('click', function () { go('evolve'); });
  }

  function lastAcc() {
    if (!savedModels.length) return 0;
    var d = savedModels[0].meta || {};
    var m = /验证集\s*([\d.]+)%/.exec(d.desc || '');
    return m ? parseFloat(m[1]) : 0;
  }

  // ---------------------------------------------------------------- 自进化
  //
  // 核心是**规则校验**：象棋的局面有硬约束（棋子定编、帅仕相的活动范围、
  // 将帅不能照面）。违反这些的局面在真实对局里不可能出现，
  // 所以一旦违反，几乎必然是标注错了 —— 不需要人告诉答案就能发现错误。
  //
  // 剩下三个自动动作都建立在这个信号之上，并按「按动作授权」的策略决定
  // 是自动执行还是等你确认。

  var EV_KEY = 'evolve.activity.v1';
  var evLog = [];
  var scanResults = [];       // [{key, name, thumb, issues, fixed}]

  function loadEvLog() {
    try { evLog = JSON.parse(localStorage.getItem(EV_KEY) || '[]'); } catch (e) { evLog = []; }
  }
  function pushEvLog(text) {
    evLog.unshift({ at: Date.now(), text: text });
    if (evLog.length > 60) evLog.length = 60;
    try { localStorage.setItem(EV_KEY, JSON.stringify(evLog)); } catch (e) { }
    renderEvLog();
  }
  function renderEvLog() {
    var el = $('evolveLog');
    if (!el) return;
    if (!evLog.length) { el.innerHTML = '还没有自动动作。'; return; }
    el.innerHTML = evLog.slice(0, 20).map(function (e) {
      return '<div class="elog"><div class="t">' +
        new Date(e.at).toLocaleString() + '</div>' + escapeHtml(e.text) + '</div>';
    }).join('');
  }

  /** 策略面板：每个动作一行，三档按钮 */
  function renderPolicy() {
    var el = $('policyList');
    if (!el || typeof Evolve === 'undefined') return;
    var pol = Evolve.snapshotPolicy();
    var riskText = { low: '低风险', medium: '中风险', high: '高风险' };

    el.innerHTML = Evolve.ACTIONS.map(function (a) {
      var cur = pol[a.key];
      return '<div class="policy">' +
        '<div class="policy__hd"><b>' + a.label + '</b>' +
        '<span class="policy__risk ' + a.risk + '">' + riskText[a.risk] + '</span></div>' +
        '<div class="policy__hint">' + a.hint + '</div>' +
        '<div class="policy__tiers">' +
        Evolve.TIERS.map(function (t) {
          return '<button data-a="' + a.key + '" data-t="' + t.v + '"' +
            (cur === t.v ? ' class="on"' : '') + '>' + t.label + '</button>';
        }).join('') +
        '</div></div>';
    }).join('');

    Array.prototype.forEach.call(el.querySelectorAll('.policy__tiers button'), function (b) {
      b.addEventListener('click', function () {
        Evolve.setTier(b.dataset.a, Number(b.dataset.t));
        renderPolicy();
        var act = Evolve.ACTIONS.filter(function (x) { return x.key === b.dataset.a; })[0];
        var tier = Evolve.TIERS[Number(b.dataset.t)];
        toast('「' + act.label + '」→ ' + tier.label + '：' + tier.desc, 2400);
      });
    });
  }

  function renderEvolve() {
    renderPresets();
    renderPolicy();
    renderParamPanel();
    renderEvLog();
    renderScanList();
    // 进这个页面时顺便算一次，让用户立刻看到"它在等什么"
    if (typeof Evolve !== 'undefined') renderAutoStatus(autoReadiness());
  }

  /** 预设档 */
  function renderPresets() {
    var el = $('presetRow');
    if (!el || typeof Evolve === 'undefined') return;
    var cur = Evolve.currentPreset();
    el.innerHTML = Evolve.PRESETS.map(function (p) {
      return '<button data-k="' + p.key + '"' + (cur === p.key ? ' class="on"' : '') +
        '>' + p.label + '</button>';
    }).join('');
    Array.prototype.forEach.call(el.children, function (b) {
      b.addEventListener('click', function () {
        var pre = Evolve.PRESETS.filter(function (x) { return x.key === b.dataset.k; })[0];
        if (!confirm('切换到「' + pre.label + '」档？\n\n' + pre.desc)) return;
        Evolve.applyPreset(b.dataset.k);
        renderPresets();
        renderPolicy();
        renderParamPanel();
        pushEvLog('切换到「' + pre.label + '」档');
        toast('已切到「' + pre.label + '」档', 2600);
      });
    });

    var c = Evolve.PRESETS.filter(function (x) { return x.key === cur; })[0];
    $('presetDesc').textContent = c ? c.desc : '还没有选择档位 —— 当前是自定义设置。';
  }

  /**
   * 参数面板。
   *
   * 按用途分组，每组标题说明这一组在管什么 ——
   * 一堆数字堆在一起是没法用的，得让人知道每个数字是为了防什么。
   */
  function renderParamPanel() {
    var el = $('paramPanel');
    if (!el || typeof Evolve === 'undefined') return;
    var P = Evolve.snapshotParams();

    var groups = {};
    Evolve.PARAMS.forEach(function (d) {
      (groups[d.group] = groups[d.group] || []).push(d);
    });

    var groupHint = {
      '触发': '决定什么时候动手',
      '评估': '决定动了算不算数 —— 这一类最容易被忽略',
      '数据': '决定拿什么数据训',
      '修改': '决定单次改多少'
    };

    el.innerHTML = Object.keys(groups).map(function (g) {
      return '<div class="pgroup"><div class="pgroup__t">' + g +
        '　' + (groupHint[g] || '') + '</div>' +
        groups[g].map(function (d) {
          var v = P[d.key];
          var ctl;
          if (d.toggle) {
            ctl = '<button class="tg' + (v ? ' on' : '') + '" data-k="' + d.key +
              '" data-t="1"></button>';
          } else {
            ctl = '<input type="number" data-k="' + d.key + '" value="' + v +
              '" min="' + d.min + '" max="' + d.max + '" step="' + d.step + '">' +
              '<span class="u">' + d.unit + '</span>';
          }
          return '<div class="param"><div class="param__i">' +
            '<div class="param__l">' + d.label + '</div>' +
            '<div class="param__h">' + d.hint + '</div></div>' +
            '<div class="param__v">' + ctl + '</div></div>';
        }).join('') + '</div>';
    }).join('');

    // 数字输入：失焦时写回（不要在每次按键时写，否则输到一半就被夹断）
    Array.prototype.forEach.call(el.querySelectorAll('input[type=number]'), function (inp) {
      inp.addEventListener('change', function () {
        var nv = Evolve.setParam(inp.dataset.k, parseFloat(inp.value));
        if (nv !== null) inp.value = nv;
      });
    });
    // 开关：点一下切换
    Array.prototype.forEach.call(el.querySelectorAll('.tg'), function (b) {
      b.addEventListener('click', function () {
        var cur = Evolve.loadParams()[b.dataset.k] ? 1 : 0;
        Evolve.setParam(b.dataset.k, cur ? 0 : 1);
        b.classList.toggle('on', !cur);
      });
    });
  }

  $('btnResetParams').addEventListener('click', function () {
    if (!confirm('把所有参数恢复成默认值？')) return;
    Evolve.resetParams();
    renderParamPanel();
    renderAutoStatus(autoReadiness());
    toast('参数已恢复默认');
  });

  // ---------------------------------------------------------------- 体检

  /**
   * 对全部已标注样本跑一遍规则校验。
   * 只查「这一帧自不自洽」，不需要历史局面，所以在标注场景也适用。
   */
  function scanSamples() {
    var u = usable();
    scanResults = [];
    var withIssues = 0, totalIssues = 0;

    u.forEach(function (sm) {
      var issues = Evolve.validate(sm.cells);
      if (!issues.length) return;
      withIssues++;
      totalIssues += issues.length;
      scanResults.push({
        key: sm.key, name: sm.name, thumb: sm.thumb,
        issues: issues.map(function (x) { return x.msg; }),
        fixed: !!sm.autoTouched
      });
    });

    // 违规多的排前面 —— 越可能标错
    scanResults.sort(function (a, b) { return b.issues.length - a.issues.length; });

    $('scanSummary').innerHTML = u.length
      ? ('检查了 <b>' + u.length + '</b> 张已标注样本，' +
         (withIssues
           ? ('<span style="color:#ff3b5c">' + withIssues + ' 张有问题（共 ' +
              totalIssues + ' 处）</span>')
           : '<span style="color:#3fbf74">全部符合棋规 ✓</span>'))
      : '还没有已标注的样本。';
    $('scanWhen').textContent = '刚刚';

    if (typeof Evolve !== 'undefined' && Evolve.isAuto('collect') && withIssues) {
      pushEvLog('体检发现 ' + withIssues + ' 张违规样本，已列出待复核');
    }
    renderScanList();
    return { withIssues: withIssues, total: u.length };
  }

  function renderScanList() {
    var el = $('scanList');
    if (!el) return;
    if (!scanResults.length) { el.innerHTML = ''; return; }
    el.innerHTML = scanResults.map(function (r, i) {
      return '<div class="scanrow' + (r.fixed ? ' fixed' : '') + '" data-i="' + i + '">' +
        '<img src="' + r.thumb + '">' +
        '<div class="t"><div class="nm">' + escapeHtml(r.name) + '</div>' +
        '<div class="msg">' + r.issues.slice(0, 2).map(escapeHtml).join('；') +
        (r.issues.length > 2 ? ' 等 ' + r.issues.length + ' 处' : '') + '</div></div>' +
        '<span class="tiny" style="color:var(--dim)">' + r.issues.length + ' ›</span>' +
        '</div>';
    }).join('');
    Array.prototype.forEach.call(el.children, function (row) {
      row.addEventListener('click', function () {
        var r = scanResults[Number(row.dataset.i)];
        var i = samples.findIndex(function (x) { return x.key === r.key; });
        if (i >= 0) openAnnotate(i, false);
      });
    });
  }

  $('btnScan').addEventListener('click', function () {
    setBusy(true, '体检中', '');
    var r = scanSamples();
    setBusy(false);
    toast(r.withIssues
      ? ('发现 ' + r.withIssues + ' 张有问题，点进去看看')
      : ('全部 ' + r.total + ' 张都符合棋规'), 3000);
  });

  // ---------------------------------------------------------------- 按规则自动修

  /**
   * 规则门控的自动修改。
   *
   * 只改「违反棋规」的那些格子，而且**改完要再验一遍** ——
   * 违规数必须真的减少才采用。这是关键：模型也可能输出违规的结果，
   * 不做这一步就是拿错误覆盖错误。
   *
   * 改过的格子记入待学清单，下次微调时模型会重点学；
   * 样本打上 autoTouched 标记，让人一眼看出哪些是机器动过的。
   */
  async function autoFixSample(sm, pred) {
    var before = sm.cells;
    var issuesBefore = Evolve.validate(before);
    if (!issuesBefore.length) return 0;
    if (!pred) return 0;                       // 没有模型意见，无从改起

    // 只动「违规涉及的格子」；像"三个车"这种全局性违规没有具体格子，跳过
    var touched = {};
    issuesBefore.forEach(function (is) {
      (is.cells || []).forEach(function (i) { touched[i] = 1; });
    });
    var keys = Object.keys(touched);
    if (!keys.length) return 0;

    var cand = before.slice();
    keys.forEach(function (k) { cand[Number(k)] = pred[Number(k)]; });

    // 规则门控：改完必须真的变好
    var after = Evolve.validate(cand);
    if (after.length >= issuesBefore.length) return 0;

    sm.cells = cand;
    sm.fixed = sm.fixed || new Array(CELLS).fill(0);
    keys.forEach(function (k) {
      var i = Number(k);
      if (cand[i] !== before[i]) sm.fixed[i] = 1;
    });
    sm.autoTouched = true;
    await dbPut(toRecord(sm));
    return issuesBefore.length - after.length;
  }

  /** 批量按规则自动修：需要模型对每张图的预测 */
  async function autoFixAll() {
    var P = Evolve.loadParams();
    var all = usable().filter(function (sm) {
      return Evolve.validate(sm.cells).length > 0;
    });
    if (!all.length) { toast('没有发现违反棋规的样本'); return; }

    // 单次动作的规模要有上限 —— 一次改太多，出了问题难回退
    var targets = all.slice(0, P.maxFixImgs);
    if (all.length > targets.length) {
      log('违规样本 ' + all.length + ' 张，本次先处理前 ' + targets.length +
          ' 张（「单次最多改几张图」限制）');
    }
    if (!(await ensureModel())) return;

    setBusy(true, '按规则自动修', '0 / ' + targets.length);
    if (native()) native().keepAwake(true);

    var changed = 0, gained = 0, cellsUsed = 0;
    for (var i = 0; i < targets.length; i++) {
      if (cellsUsed >= P.maxFixCells) {
        log('已达「单次最多改几格」上限（' + P.maxFixCells + '），本次停止');
        break;
      }
      var sm = targets[i];
      try {
        var pred = backtest[sm.key] ? backtest[sm.key].pred : await predictCells(sm, inSize);
        var d = await autoFixSample(sm, pred);
        if (d > 0) { changed++; gained += d; cellsUsed += d; }
      } catch (e) {
        log('自动修失败 ' + sm.name + '：' + e.message);
      }
      $('busySub').textContent = (i + 1) + ' / ' + targets.length;
      if (i % 3 === 2) await yieldTick();
    }

    if (native()) native().keepAwake(false);
    setBusy(false);
    renderStats();
    renderSamples();
    scanSamples();
    renderHome();

    if (changed) {
      pushEvLog('按规则自动修正 ' + changed + ' 张样本，消除 ' + gained + ' 处棋规冲突');
      log('自动修：' + changed + ' 张，消除 ' + gained + ' 处违规');
      toast('修正了 ' + changed + ' 张，消除 ' + gained + ' 处违规', 3200);
    } else {
      toast('这些问题模型也修不了（改了反而更差），需要你人工判断', 3600);
      pushEvLog('自动修：' + targets.length + ' 张问题样本里，规则门控没有放行任何一处');
    }
  }

  $('btnAutoFixAll').addEventListener('click', function () { autoFixAll(); });

  /**
   * 一条龙：按规则修 → 重建数据集 → 微调 → 评估 → 择优。
   *
   * 每一步都是已有的能力，这里只是把它们串起来，省掉来回点。
   * 「自动触发训练」这个策略决定它要不要在体检之后自己跑。
   */
  async function runAutoCycle(opts) {
    opts = opts || {};
    if (!(await ensureModel())) return;
    if (opts.auto) {
      log('自动循环启动（' + (autoReadiness().reason || '') + '）');
      pushEvLog('自动循环启动：' + (autoReadiness().reason || ''));
    }

    setBusy(true, '自动循环', '按规则修');
    try {
      await autoFixAll();
      $('busyText').textContent = '自动循环';
      $('busySub').textContent = '重建数据集';
      setBusy(false);
      go('train');
      trainTab('train');
      $('btnBuild').click();
      await new Promise(function (r) { setTimeout(r, 800); });
      // 等数据集就绪（按钮复位即表示完成）
      for (var w = 0; w < 60; w++) {
        await new Promise(function (r) { setTimeout(r, 500); });
        if (!$('btnBuild').disabled) break;
      }
      $('busyText').textContent = '自动循环';
      $('busySub').textContent = '微调';
      setBusy(true);
      trainTab('fix');
      $('btnFinetune').click();
      pushEvLog('自动循环：规则修 → 重建数据集 → 微调，已发起');
    } catch (e) {
      setBusy(false);
      log('自动循环失败：' + e.message);
      toast('自动循环失败：' + e.message, 3600);
      return;
    }
    setBusy(false);
  }

  $('btnAutoCycle').addEventListener('click', function () { runAutoCycle(); });
  $('btnClearEvolveLog').addEventListener('click', function () {
    evLog = [];
    try { localStorage.removeItem(EV_KEY); } catch (e) { }
    renderEvLog();
    toast('已清空活动记录');
  });

  // ---------------------------------------------------------------- 空闲检测
  //
  // 训练会占住 CPU 十几秒，那期间界面是卡的。如果它在你正标注到一半时
  // 自己启动，你只会以为应用坏了。所以先等一段空闲时间再动。

  var lastActive = Date.now();
  var busyDepth = 0;          // 有正在进行的用户操作时不启动
  var autoTickTimer = null;

  function markActive() { lastActive = Date.now(); }

  /** 用户停手多久了（分钟） */
  function idleMinutes() { return (Date.now() - lastActive) / 60000; }

  function bindIdleWatch() {
    // 只监听真正表示"人在操作"的事件，不算 scroll —— 页面自己滚动不该算活动
    ['pointerdown', 'pointerup', 'keydown', 'touchstart'].forEach(function (ev) {
      document.addEventListener(ev, markActive, { passive: true });
    });
  }

  /**
   * 熔断记录。
   *
   * 数据本身有问题时（比如标定歪了），自动训练会反复跑、反复不提升。
   * 没有熔断的话它会一直烧时间，而你只会在事后查记录时才发现。
   */
  var FAIL_KEY = 'evolve.failStreak.v1';
  function failStreak() {
    try { return parseInt(localStorage.getItem(FAIL_KEY) || '0', 10) || 0; } catch (e) { return 0; }
  }
  function bumpFailStreak(n) {
    try { localStorage.setItem(FAIL_KEY, String(n)); } catch (e) { }
  }
  function resetFailStreak() { bumpFailStreak(0); }

  var LAST_TRAIN_KEY = 'evolve.lastTrain.v1';
  function lastTrainAt() {
    try { return parseInt(localStorage.getItem(LAST_TRAIN_KEY) || '0', 10) || 0; } catch (e) { return 0; }
  }
  function markTrainedNow() {
    try { localStorage.setItem(LAST_TRAIN_KEY, String(Date.now())); } catch (e) { }
    resetFailStreak();
  }

  /** 当前有多少处「待学」修正 */
  function pendingFixCount() {
    var n = 0;
    samples.forEach(function (sm) {
      if (sm.fixed) for (var i = 0; i < CELLS; i++) if (sm.fixed[i]) n++;
    });
    return n;
  }

  /**
   * 自动循环现在该不该启动。
   *
   * 返回的 reason 是给界面用的 —— 全自动最怕的就是用户完全不知道它在等什么。
   */
  function autoReadiness() {
    var P = Evolve.loadParams();
    var u = usable();

    if (!Evolve.isAuto('train')) {
      return { ready: false, reason: '「自动触发训练」是关闭的' };
    }

    var streak = failStreak();
    if (streak >= P.maxFailStreak) {
      return { ready: false, halted: true,
               reason: '已连续 ' + streak + ' 次没有提升，自动训练暂停（排查数据后可手工恢复）' };
    }

    // 用户刚拒绝过：暂缓一段时间再问。
    // 单靠 minInterval 不够 —— 那个参数是给"训练频率"用的，
    // 用户把它调小是为了跑得勤，不该因此变成被反复询问。
    if (snoozeUntil > Date.now()) {
      var left = (snoozeUntil - Date.now()) / 60000;
      return { ready: false, snoozed: true,
               reason: '你刚跳过了一次，' + fmt(left, 0) + ' 分钟后再问' };
    }

    if (idleMinutes() < P.idleMinutes) {
      return { ready: false, reason: '等空闲 ' + P.idleMinutes + ' 分钟再启动（还差 ' +
               fmt(Math.max(0, P.idleMinutes - idleMinutes()), 1) + ' 分钟）' };
    }
    if (busyDepth > 0) return { ready: false, reason: '当前有操作在进行' };

    if (u.length < P.minSamples) {
      return { ready: false, reason: '可用样本 ' + u.length + ' 张，少于设定的 ' + P.minSamples + ' 张' };
    }

    var last = lastTrainAt();
    if (last) {
      var mins = (Date.now() - last) / 60000;
      if (mins < P.minInterval) {
        return { ready: false, reason: '距上次训练 ' + fmt(mins, 0) + ' 分钟，需满 ' + P.minInterval + ' 分钟' };
      }
    }

    var n = pendingFixCount();
    if (n < P.minFixes) {
      return { ready: false, reason: '待学修正 ' + n + ' 处，需攒够 ' + P.minFixes + ' 处' };
    }

    return { ready: true, reason: '待学 ' + n + ' 处、样本 ' + u.length + ' 张，条件已满足', fixes: n };
  }

  /** 定时检查：到条件就按档位处理 */
  function startAutoTick() {
    if (autoTickTimer) clearInterval(autoTickTimer);
    autoTickTimer = setInterval(function () {
      if (typeof Evolve === 'undefined') return;
      var r = autoReadiness();
      renderAutoStatus(r);
      if (!r.ready) return;

      if (Evolve.isFullAuto('train')) {
        runAutoCycle({ auto: true });
      } else if (Evolve.needsConfirm('train') && !autoCycleAsking) {
        autoCycleAsking = true;
        askAutoCycle(r);
      }
    }, 15000);
  }

  var autoCycleAsking = false;
  /** 用户拒绝后的暂缓截止时间（内存态，重启即失效） */
  var autoSnoozeMs = 10 * 60 * 1000;
  var snoozeUntil = 0;

  function askAutoCycle(r) {
    var el = $('autoAsk');
    if (!el) return;
    el.hidden = false;
    $('autoAskText').textContent = r.reason + '。现在跑一次自动循环？';
    $('btnAutoAskGo').onclick = function () {
      el.hidden = true;
      autoCycleAsking = false;
      runAutoCycle({ auto: true });
    };
    $('btnAutoAskNo').onclick = function () {
      el.hidden = true;
      autoCycleAsking = false;
      // 暂缓一段时间，而不是记成"训练过了" ——
      // 拒绝不等于训练成功，不该把失败熔断的计数清掉
      snoozeUntil = Date.now() + autoSnoozeMs;
      pushEvLog('你跳过了这次自动循环，' + (autoSnoozeMs / 60000) + ' 分钟内不再问');
      renderAutoStatus(autoReadiness());
    };
  }

  /** 顶部状态条：让它随时知道自动化在等什么 */
  function renderAutoStatus(r) {
    var el = $('autoStatus');
    if (!el) return;
    if (typeof Evolve === 'undefined' || !Evolve.isAuto('train')) { el.hidden = true; return; }
    el.hidden = false;
    el.innerHTML = (r.ready
      ? '<span style="color:#3fbf74">● 条件已满足，可以自动训练</span>'
      : '<span style="color:#66707c">○ ' + escapeHtml(r.reason) + '</span>') +
      (failStreak() ? '　<span style="color:#e0a33a">连续失败 ' + failStreak() + ' 次</span>' : '');
  }

  // ---------------------------------------------------------------- 关于
  function renderAbout() {
    var nat = native();
    var backend = '—';
    try { backend = tf.getBackend(); } catch (e) { /* 未就绪 */ }
    $('aboutBox').innerHTML =
      'tfjs <b>' + tf.version.tfjs + '</b> · 后端 <b>' + backend + '</b><br>' +
      (nat ? ('原生外壳 <b>' + nat.appVersion() + '</b> · ' + nat.platform())
           : '浏览器预览模式') + '<br>' +
      '样本 ' + samples.length + ' 张 · 模型 ' + savedModels.length + ' 个';
    $('classList').innerHTML = CLASSES.map(function (c) {
      return '<span style="color:' + c.c + '">' + c.g + '</span>';
    }).join(' ') + '<br>共 ' + NC + ' 个类别（含空格）';
  }

  // ---------------------------------------------------------------- 采集
  //
  // 利用手机自带的截图功能：截图会落到固定文件夹，授权一次之后
  // 每次回来点「扫描」就能把新图捞进来，不必每次手动翻相册。
  //
  // 用 SAF 的目录授权（ACTION_OPEN_DOCUMENT_TREE）而不是读媒体库权限 ——
  // 用户自己指定哪个文件夹，应用不需要任何权限。

  var shotBridge = null;
  var scanned = [];
  var scanPicked = {};

  function shotFolder() {
    if (shotBridge === null) {
      shotBridge = (typeof window.ShotFolder !== 'undefined') ? window.ShotFolder : false;
    }
    return shotBridge || null;
  }

  function refreshCollect() {
    var b = shotFolder();
    if (!b) {
      $('folderInfo').innerHTML = '浏览器预览模式下不可用（需要 Android）。';
      $('btnPickFolder').disabled = true;
      $('btnScanFolder').disabled = true;
    } else {
      var has = b.hasFolder();
      $('btnScanFolder').disabled = !has;
      $('folderInfo').innerHTML = has
        ? ('已授权：<b>' + escapeHtml(b.folderName() || '截图文件夹') + '</b>')
        : '还没有授权文件夹。点上面的按钮选一次，之后不用再选。';
    }
    updateBatchInfo();
  }

  $('btnPickFolder').addEventListener('click', function () {
    var b = shotFolder();
    if (!b) { toast('此功能需要 Android 应用'); return; }
    b.pickFolder();
  });

  $('btnScanFolder').addEventListener('click', function () {
    var b = shotFolder();
    if (!b) return;
    setBusy(true, '扫描截图', '');
    try {
      var raw = b.listImages();
      var arr = JSON.parse(raw || '[]');
      var known = {};
      samples.forEach(function (s) { known[s.key] = 1; });
      scanned = arr.filter(function (it) { return !known[shotKey(it)]; });
      scanned.sort(function (a, b2) { return (b2.date || 0) - (a.date || 0); });
      scanPicked = {};
      log('扫描到 ' + arr.length + ' 张截图，其中新的 ' + scanned.length + ' 张');
    } catch (e) {
      log('扫描失败：' + e.message);
      scanned = [];
    }
    setBusy(false);
    renderScan();
    toast(scanned.length ? ('发现 ' + scanned.length + ' 张新截图') : '没有新截图', 2200);
  });

  window.onShotFolderPicked = function (ok, name, reason) {
    refreshCollect();
    toast(ok ? ('已授权：' + name) : ('选择文件夹失败：' + (reason || '')), 2600);
  };

  function shotKey(it) {
    return [it.name || 'shot', it.size || 0, it.date || 0].join('|');
  }

  function renderScan() {
    $('scanCard').hidden = !scanned.length;
    if (!scanned.length) return;
    $('scanGrid').innerHTML = scanned.map(function (it, i) {
      return '<button class="smp' + (scanPicked[it.uri] ? ' picked' : '') +
        '" data-i="' + i + '">' +
        '<div style="width:100%;aspect-ratio:9/16;background:#12151a;display:flex;' +
        'align-items:center;justify-content:center;font-size:11px;color:#66707c">' +
        '截图</div>' +
        '<span class="tick">✓</span>' +
        '<div class="bar"><span class="nm">' + escapeHtml(it.name || '') + '</span></div>' +
        '</button>';
    }).join('');
    Array.prototype.forEach.call($('scanGrid').children, function (el) {
      el.addEventListener('click', function () {
        var it = scanned[Number(el.dataset.i)];
        if (scanPicked[it.uri]) delete scanPicked[it.uri]; else scanPicked[it.uri] = 1;
        renderScan();
      });
    });
  }

  $('btnScanAll').addEventListener('click', function () {
    scanned.forEach(function (it) { scanPicked[it.uri] = 1; });
    renderScan();
  });
  $('btnCancelScan').addEventListener('click', function () {
    scanned = []; scanPicked = {}; renderScan();
  });

  $('btnImportScanned').addEventListener('click', async function () {
    var b = shotFolder();
    if (!b) return;
    var picks = scanned.filter(function (it) { return scanPicked[it.uri]; });
    if (!picks.length) { toast('先选几张'); return; }

    setBusy(true, '导入截图', '0 / ' + picks.length);
    if (native()) native().keepAwake(true);
    var added = 0, failed = 0;
    try {
      for (var i = 0; i < picks.length; i++) {
        try {
          // 原生侧已经压到 MAX_EDGE 并转成 JPEG，这里直接当普通图片用
          var b64 = b.readImage(picks[i].uri);
          if (!b64) { failed++; } else {
            var ok = await importFromBase64(b64, picks[i].name || ('截图 ' + (i + 1)),
                                           picks[i].size || 0, picks[i].date || 0);
            if (ok) added++; else failed++;
          }
        } catch (e) {
          failed++;
          log('导入失败 ' + picks[i].name + '：' + e.message);
        }
        $('busySub').textContent = (i + 1) + ' / ' + picks.length;
        if (i % 2 === 1) await yieldTick();
      }
    } catch (e) {
      log('导入中断：' + e.message);
    }
    if (native()) native().keepAwake(false);
    setBusy(false);
    scanned = scanned.filter(function (it) { return !scanPicked[it.uri]; });
    scanPicked = {};
    renderScan();
    renderSamples();
    renderHome();
    updateBatchInfo();
    log('从截图文件夹导入 ' + added + ' 张' + (failed ? '，失败 ' + failed + ' 张' : ''));
    toast('导入 ' + added + ' 张' + (failed ? '，失败 ' + failed : ''), 2600);
  });

  /** 把一张 base64 JPEG 变成样本存进库 */
  async function importFromBase64(b64, name, size, date) {
    var key = [name || 'shot', size || 0, date || 0].join('|');
    if (samples.some(function (s) { return s.key === key; })) return false;

    var blob = await (await fetch('data:image/jpeg;base64,' + b64)).blob();
    var url = URL.createObjectURL(blob);
    var im = await loadImage(url);
    URL.revokeObjectURL(url);

    var cv = document.createElement('canvas');
    cv.width = im.naturalWidth; cv.height = im.naturalHeight;
    cv.getContext('2d').drawImage(im, 0, 0);
    var rec = {
      key: key, name: name, w: cv.width, h: cv.height,
      thumb: makeThumb(cv, cv.width, cv.height, null),
      blob: await canvasToBlob(cv, 'image/jpeg', 0.88),
      lattice: null, cells: null, auto: null, conf: 0
    };
    await dbPut(rec);
    samples.push(rec);
    return true;
  }

  // ---------------------------------------------------------------- 悬浮窗采集
  //
  // 采集本身在原生侧完成（判据是像素级的，不依赖 WebView），
  // 这里只做两件事：
  //   1. 显示状态、启停
  //   2. 把采到的候选图**筛选**后导入样本库

  function captureBridge() {
    return (typeof window.Capture !== 'undefined') ? window.Capture : null;
  }

  function refreshCapture() {
    var b = captureBridge();
    var card = $('capCard');
    if (!card) return;

    if (!b) {
      $('capBadge').textContent = '需要 Android';
      $('capStatus').textContent = '浏览器预览模式下不可用。';
      $('btnCapPermission').disabled = true;
      $('btnCapStart').disabled = true;
      $('candCard').hidden = true;
      return;
    }

    var running = b.isCapturing();
    var hasPerm = b.hasPermission();
    var count = b.capturedCount ? b.capturedCount() : 0;

    $('btnCapPermission').disabled = running;
    $('btnCapPermission').textContent = hasPerm ? '已授权' : '申请截屏权限';
    $('btnCapStart').disabled = running || !hasPerm;
    $('btnCapStart').hidden = running;
    $('btnCapStop').hidden = !running;

    // 悬浮窗是可选的 —— 采集不依赖它，它只是让你知道它在工作
    var ovOk = b.canDrawOverlays();
    $('btnCapOverlay').hidden = ovOk;
    $('capOverlayState').textContent = ovOk
      ? (running ? '已显示' : '已授权')
      : '未授权（不影响采集）';

    if (running) {
      var phase = '等待走子';
      $('capStatus').innerHTML = '<span style="color:#3fbf74">● 采集中</span>　已采 <b>' +
        count + '</b> 张　<span style="color:var(--faint)">切到对局应用下棋即可</span>';
    } else if (count) {
      $('capStatus').innerHTML = '已停止　候选里有 <b>' + count + '</b> 张待处理';
    } else {
      $('capStatus').textContent = hasPerm ? '未开始（已授权，可以直接开始）' : '未开始';
    }

    // 候选卡片
    var candN = b.candidateCount ? b.candidateCount() : 0;
    $('candCard').hidden = !candN;
    if (candN) $('candCount').textContent = candN + ' 张';
  }

  $('btnCapPermission').addEventListener('click', function () {
    var b = captureBridge();
    if (!b) return;
    b.requestPermission();
  });

  $('btnCapStart').addEventListener('click', function () {
    var b = captureBridge();
    if (!b) return;
    var P = Evolve.snapshotParams();
    // 间隔用参数里的秒数；稳定帧数也来自参数
    var ok = b.start(0.5, P.capIntervalSec * 1000, P.capStableFrames);
    if (ok) {
      toast('开始采集。切到对局应用下棋，回来点「停止」', 3600);
    }
    refreshCapture();
  });

  $('btnCapStop').addEventListener('click', function () {
    var b = captureBridge();
    if (!b) return;
    b.stop();
    refreshCapture();
    toast('已停止采集');
  });

  $('btnCapOverlay').addEventListener('click', function () {
    var b = captureBridge();
    if (!b) return;
    b.openOverlaySettings();
    toast('请打开「显示在其他应用上层」，回来点一下刷新', 3600);
  });

  $('btnCandClear').addEventListener('click', function () {
    var b = captureBridge();
    if (!b) return;
    if (!confirm('丢弃全部候选图？')) return;
    b.clearCandidates();
    refreshCapture();
    toast('候选已清空');
  });

  /**
   * 棋盘区域的图片指纹：把棋盘压成 16×16 灰度。
   *
   * 用作**第一道去重** —— 比跑识别便宜得多（一次裁切 vs 一次推理），
   * 而且没有模型时也能用。同局面的两次截图，棋盘区域几乎一样；
   * 不同局面则差得很明显。
   */
  function boardFingerprint(img, lat) {
    var N = 16;
    var cv = document.createElement('canvas');
    cv.width = N; cv.height = N;
    var c = cv.getContext('2d', { willReadFrequently: true });
    var IW = img.naturalWidth, IH = img.naturalHeight;
    var x = (lat.x0 - lat.dx * 0.5) * IW;
    var y = (lat.y0 - lat.dy * 0.5) * IH;
    var w = lat.dx * COLS * IW;
    var h = lat.dy * ROWS * IH;
    c.drawImage(img, x, y, w, h, 0, 0, N, N);
    var d = c.getImageData(0, 0, N, N).data;
    var out = new Uint8Array(N * N);
    for (var i = 0; i < N * N; i++) {
      out[i] = (d[i * 4] * 0.299 + d[i * 4 + 1] * 0.587 + d[i * 4 + 2] * 0.114) | 0;
    }
    return out;
  }

  /** 两个指纹的平均绝对差。同局面通常 <3，不同局面 >10 */
  function fingerprintDiff(a, b2) {
    var sum = 0;
    for (var i = 0; i < a.length; i++) sum += Math.abs(a[i] - b2[i]);
    return sum / a.length;
  }

  /** 两次识别结果是否算同一个局面（识别有噪声，允许差几格） */
  function samePosition(a, b2, tol) {
    var d = 0;
    for (var i = 0; i < CELLS; i++) {
      if (a[i] !== b2[i]) {
        d++;
        if (d > tol) return false;
      }
    }
    return true;
  }

  /**
   * 筛选候选并导入。
   *
   * 候选是按时间存下来的，但「画面变了」不等于「局面变了」——
   * 计时器跳动、走子动画都会让画面变化。这里用识别结果做第二道过滤：
   * 同一局面只保留一张。
   *
   * 按**时间正序**处理很关键：判重是拿新的一张和已保留的比，
   * 顺序反了会保留最后一张而不是第一张（两者都算对，但正序更符合直觉）。
   */
  $('btnCandImport').addEventListener('click', async function () {
    var b = captureBridge();
    if (!b) return;

    var list;
    try { list = JSON.parse(b.listCandidates() || '[]'); } catch (e) { list = []; }
    if (!list.length) { toast('候选里没有图'); return; }
    list.sort(function (x, y) { return x.date - y.date; });

    var P = Evolve.snapshotParams();
    var tol = P.capDupTolerance;

    // 有模型就顺带识别，标成「待核对」；没有模型就只导图，标成「待标注」
    var willRecognize = false;
    if (!model && savedModels.length) {
      try {
        await loadModelFromRecord(savedModels[0]);
        willRecognize = true;
      } catch (e) { willRecognize = false; }
    } else {
      willRecognize = !!model;
    }

    var btn = $('btnCandImport');
    btn.disabled = true;
    setBusy(true, '筛选候选', '0 / ' + list.length);
    if (native()) native().keepAwake(true);

    var kept = [], keptCells = [], keptFps = [];
    var dup = 0, failed = 0, noBoard = 0;

    try {
      for (var i = 0; i < list.length; i++) {
        $('busySub').textContent = (i + 1) + ' / ' + list.length;

        var b64 = b.readCandidate(list[i].name);
        if (!b64) { failed++; continue; }

        var rec = null;
        try {
          var blob = await (await fetch('data:image/jpeg;base64,' + b64)).blob();
          var url = URL.createObjectURL(blob);
          var img = await loadImage(url);
          URL.revokeObjectURL(url);

          rec = {
            key: 'cap-' + list[i].date + '-' + i,
            name: '悬浮采集 ' + (i + 1),
            w: img.naturalWidth, h: img.naturalHeight,
            thumb: makeThumb(img, img.naturalWidth, img.naturalHeight, null),
            blob: blob, lattice: null, cells: null, auto: null, conf: 0
          };
          rec.__img = img;

          // 自动找棋盘。找不到就丢弃 —— 没有棋盘位置的图对训练没用
          var lat = await calibrateAuto(rec);
          if (!lat) { noBoard++; continue; }

          // 第一道去重：图片指纹。比识别便宜得多，而且没有模型时也能用
          var fp = boardFingerprint(img, lat);
          var imgDup = false;
          for (var q = 0; q < keptFps.length; q++) {
            if (fingerprintDiff(fp, keptFps[q]) <= 4) { imgDup = true; break; }
          }
          if (imgDup) { dup++; continue; }
          keptFps.push(fp);

          if (willRecognize && model) {
            var cells = await predictCells(rec, inSize);
            var isDup = false;
            for (var k = 0; k < keptCells.length; k++) {
              if (samePosition(cells, keptCells[k], tol)) { isDup = true; break; }
            }
            if (isDup) { dup++; continue; }

            keptCells.push(cells);
            rec.cells = Array.prototype.slice.call(cells);
            // 标成 auto：这是模型猜的，需要你核对
            rec.auto = rec.cells.map(function (v) { return v > 0 ? 1 : 0; });
          }
          kept.push(rec);
        } catch (e) {
          failed++;
          log('候选处理失败 ' + list[i].name + '：' + e.message);
        }
        if (i % 2 === 1) await yieldTick();
      }
    } catch (e) {
      log('筛选中断：' + e.message);
    }

    // 入库
    for (var m = 0; m < kept.length; m++) {
      try {
        delete kept[m].__img;
        await dbPut(toRecord(kept[m]));
        samples.push(kept[m]);
      } catch (e) {
        log('写入失败 ' + kept[m].name + '：' + e.message);
      }
    }

    if (native()) native().keepAwake(false);
    setBusy(false);
    btn.disabled = false;

    if (kept.length) b.clearCandidates();

    var msg = '导入 ' + kept.length + ' 张';
    if (dup) msg += ' · 跳过重复 ' + dup;
    if (noBoard) msg += ' · 找不到棋盘 ' + noBoard;
    if (failed) msg += ' · 失败 ' + failed;

    $('candProgress').innerHTML = escapeHtml(msg) +
      (willRecognize
        ? '<br>识别结果已标为「待核对」—— 到样本库里核对一下'
        : '<br>还没有模型，这些图标记为「待标注」');

    renderStats();
    renderSamples();
    renderHome();
    refreshCapture();
    log('悬浮采集导入：' + msg);
    toast(msg, 3600);
  });

  // 原生侧的回调
  window.onCapturePermission = function (ok, reason) {
    refreshCapture();
    toast(ok ? '已获得截屏授权，可以开始采集了' : ('授权失败：' + reason), 3000);
  };
  window.onCaptureState = function (running, reason) {
    refreshCapture();
    if (!running && reason) toast(reason, 3000);
  };

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

  var SPR = 96;    // 棋子图样的边长
  var SPR_K = 1.16; // 取图样/贴图样的范围 = 格子间距 × 这个系数

  /**
   * 得到一块没有棋子的棋盘底。
   *
   * 之前的做法是「用最近空格子的图块盖住有子的格子」，有两个毛病：
   *   1. 图块只有一格宽，而真实对局里棋子往往和格子间距差不多大、还带投影，
   *      边缘会留下一圈残影；
   *   2. 木纹被切成一格一格的补丁，接缝是硬的，看上去就是花的。
   *
   * 现在改成：以有子的交叉点为中心，把另一处**整片干净区域**贴上去，
   * 贴的范围比棋子大、边缘做径向羽化，所以既盖得干净也看不出接缝。
   * 来源只从「周围一格内没有棋子、且不在最外圈」的交叉点里挑 ——
   * 最外圈的交叉点带着棋盘边框，复制到中间会很突兀。
   */
  function makeCleanBoard(img, lat, cells, pins) {
    var dx = lat.dx, dy = lat.dy;
    // 四周各留一格余量。
    // 之前画布正好等于棋盘范围，于是边角格子的中心正好落在画布角上 ——
    // 补丁被裁掉一半，那块棋子的残留就成了四分之一圆弧（实测四个角都有）。
    // 留一格余量之后，任何格子的补丁都有完整空间。
    var MARGIN = 1;
    /*
     * 画布范围：从「左上交叉点再往左上 MARGIN 个格距」开始，
     * 到「右下交叉点再往右下 MARGIN 个格距」结束。
     *
     * 之前这里写成 `x0 - (0.5 + MARGIN) * dx`，却用 `(col + MARGIN) * dx`
     * 去定位格子 —— 两者差了半个格距，所有补丁都偏了半格，等于没盖上。
     * 现在两边统一用 MARGIN，格子中心就是 (col + MARGIN) * dx。
     */
    var spanX = (COLS - 1 + MARGIN * 2) * dx;
    var spanY = (ROWS - 1 + MARGIN * 2) * dy;
    var ox0 = lat.x0 - MARGIN * dx;
    var oy0 = lat.y0 - MARGIN * dy;
    var bw = Math.round(spanX), bh = Math.round(spanY);
    var out = document.createElement('canvas');
    out.width = bw; out.height = bh;
    var c = out.getContext('2d');
    c.drawImage(img, ox0, oy0, spanX, spanY, 0, 0, bw, bh);

    // 格子中心在画布上的位置
    function gx(col) { return (col + MARGIN) * dx; }
    function gy(r) { return (r + MARGIN) * dy; }

    /*
     * 找「干净来源」。
     *
     * clear = 到最近棋子的棋盘距离（按格数，切比雪夫距离）。
     * 关键：**来源要按补丁半径来筛**。补丁半径是 1.05 格，
     * 如果只要求「周围 1 格内没子」，补丁伸进隔壁格时就会把那颗子复制过来 ——
     * 结果就是棋子"清不掉"，甚至越清越多（实测就是这个原因）。
     * 所以至少要 clear >= 2，让补丁的覆盖范围整个落在干净区里。
     */
    var cands = [], wide = [], fallback = [];

    /*
     * 用户手工指定的空位优先。
     *
     * 自动筛选在这件事上先天不稳：它只能靠「标注说这格是空的」来推断，
     * 而标注一旦有一处错漏，那枚棋子就会被当作干净木板复制到整块盘上。
     * 换成一个按钮让用户点一下「这里确实是空木板」，问题就消失了 ——
     * 机器不擅长的事，交给眼睛。
     */
    if (pins && pins.length) {
      for (var pi = 0; pi < pins.length; pi++) {
        var pIdx = pins[pi];
        var pr = Math.floor(pIdx / COLS), pc = pIdx % COLS;
        if (cells[pIdx]) continue;   // 用户标的是有子的格，忽略
        // 只用指定格本身，并**真正算一遍**它周围有多干净。
        // 之前图省事给个 clear=9，还把周围 3×3 一起收了进来 ——
        // 那些邻格贴着棋子，补丁一伸过去就把棋子复制开了。
        var pclear = 99;
        for (var r2 = 0; r2 < ROWS; r2++) {
          for (var c2 = 0; c2 < COLS; c2++) {
            if (!cells[r2 * COLS + c2]) continue;
            var pd = Math.max(Math.abs(r2 - pr), Math.abs(c2 - pc));
            if (pd < pclear) pclear = pd;
          }
        }
        // 只要紧邻一圈没有子就可用：补丁半径会按「到最近棋子的距离」收紧，
        // 不硬性要求两格（那样在密集局面里几乎找不到位置）。
        if (pclear >= 1) cands.push({ r: pr, c: pc, clear: pclear, fromPin: true });
        else log('空位 (' + pr + ',' + pc + ') 紧邻就有棋子，跳过');
      }
    }
    if (pins && pins.length && !cands.length) {
      out.__needPins = true;
      return out;
    }
    if (cands.length) {
      // 有可用的手工空位就不再自动推断
    } else
    for (var r = 0; r < ROWS; r++) {
      for (var col = 0; col < COLS; col++) {
        if (cells[r * COLS + col]) continue;
        var item = { r: r, c: col, clear: 99 };
        fallback.push(item);

        var clear = 99;
        for (var r2 = 0; r2 < ROWS; r2++) {
          for (var c2 = 0; c2 < COLS; c2++) {
            if (!cells[r2 * COLS + c2]) continue;
            var d = Math.max(Math.abs(r2 - r), Math.abs(c2 - col));
            if (d < clear) clear = d;
          }
        }
        item.clear = clear;
        // 排除最外圈：贴近棋盘边缘的格子往往混进了「棋盘外的背景」，
        // 拿它当来源会把深色背景复制到整块盘上（表现为大片黑色弧形）。
        var inner = r > 0 && r < ROWS - 1 && col > 0 && col < COLS - 1;
        if (clear >= 2 && inner) cands.push(item);
        else if (clear >= 1 && inner) wide.push(item);
        else if (clear >= 1) wide.push(item);
      }
    }
    /*
     * 只有「周围两格都干净」的格子才能当来源。
     *
     * 原因是几何上绕不开的：棋子直径≈一个格距，补丁又必须盖住整颗棋子，
     * 所以补丁半径必然接近一格 —— 只要来源旁边一格有子，补丁就会把那颗子复制过来。
     *
     * 以前找不到干净来源时会退回用 wide / fallback，结果是**静默地产出脏棋盘底**，
     * 用户看到的是"棋盘上到处是鬼影"却不知道哪里错了。
     * 现在宁可不做：返回一个标记，让上层提示用户手工指定空位。
     */
    if (!cands.length) {
      out.__needPins = true;
      return out;
    }

    /*
     * 再校验一遍来源：把「图块里其实有棋子」的剔掉。
     *
     * 为什么需要：来源是按标注筛的，而标注可能有错漏 ——
     * 某个格子标成空、实际却有子，那枚棋子就会被当成干净的木板
     * 复制到整块棋盘上（表现为到处是同样的圆弧）。
     * 判据用「图块自身的明暗起伏」：纯木板很平，带棋子就有圆盘边缘。
     * 取所有候选中位数，明显高于中位数的剔掉 —— 不用拍脑袋定阈值。
     */
    (function rejectDirtySources() {
      var probe = document.createElement('canvas');
      var PS = 24;
      probe.width = PS; probe.height = PS;
      var pcx = probe.getContext('2d', { willReadFrequently: true });
      var scores = [];
      for (var i = 0; i < cands.length; i++) {
        var cd = cands[i];
        var qx = lat.x0 + cd.c * dx, qy = lat.y0 + cd.r * dy;
        var half = Math.max(dx, dy) * 0.42;
        pcx.clearRect(0, 0, PS, PS);
        pcx.drawImage(img, qx - half, qy - half, half * 2, half * 2, 0, 0, PS, PS);
        var dd = pcx.getImageData(0, 0, PS, PS).data;
        var sum = 0, sum2 = 0, n = 0;
        for (var k = 0; k < dd.length; k += 4) {
          var lu = dd[k] * 0.299 + dd[k + 1] * 0.587 + dd[k + 2] * 0.114;
          sum += lu; sum2 += lu * lu; n++;
        }
        var mean = sum / n;
        cd.spread = Math.sqrt(Math.max(0, sum2 / n - mean * mean));
        scores.push(cd.spread);
      }
      scores.sort(function (a, b) { return a - b; });
      var med = scores[Math.floor(scores.length / 2)] || 0;
      if (med <= 0.5) return;                    // 整片都很平，不折腾
      var limit = med * 1.8;
      var kept = cands.filter(function (cd) { return cd.spread <= limit; });
      if (kept.length >= 4) cands = kept;        // 别把候选取空了
    })();

    /*
     * 补丁大小与羽化。
     *
     * 只贴一格大小会留下两个明显痕迹：网格线接不上、木纹有硬接缝，
     * 整块棋盘看上去是「花的」。
     * 这里用比一格更大的范围，并且内圈不透明区留得小、羽化区留得宽，
     * 相邻补丁之间是渐变过渡而不是硬边。
     */
    /*
     * 半径与实心区 —— 这里有个绕不开的几何约束。
     *
     * 棋子直径≈一个格距（实测 0.94 格），所以补丁的实心半径至少 0.5 格才盖得住；
     * 而补丁不能伸到隔壁格子的棋子上去，隔壁棋子的边缘在 1.0−0.47=0.53 格处。
     * 两个条件夹出的窗口很窄：实心区只能取 0.50~0.53 格。
     *
     * 所以：实心区固定 0.50 格，外面留一点点羽化（0.50→0.62）把接缝糊掉。
     * 再大就会吃到邻格的棋子 —— 之前设 0.74 时，棋盘底上全是半透明的棋子残影，
     * 就是这个原因。
     */
    var R = Math.max(dx, dy) * 0.56;
    var RIN = R * 0.89;   // 实心 0.50 格，羽化只留 0.06 格
    var SIDE = Math.ceil(R * 2) + 2;

    var patch = document.createElement('canvas');
    patch.width = SIDE; patch.height = SIDE;
    var pctx = patch.getContext('2d');

    /* 取每行的空格子，用来优先选「同一行」的来源 ——
       同一行里木纹走向连续，比跨行取自然得多。 */
    var emptyByRow = [];
    for (var rr = 0; rr < ROWS; rr++) {
      emptyByRow.push(cands.filter(function (cd) { return cd.r === rr; }));
    }

    for (var r4 = 0; r4 < ROWS; r4++) {
      for (var c4 = 0; c4 < COLS; c4++) {
        if (!cells[r4 * COLS + c4]) continue;

        // 来源排序：同行优先，其次看周围有多干净，最后取近的
        var pool = emptyByRow[r4] && emptyByRow[r4].length ? emptyByRow[r4] : cands;
        var ranked = pool.slice().sort(function (a, b) {
          var da = Math.abs(a.r - r4) + Math.abs(a.c - c4);
          var db = Math.abs(b.r - r4) + Math.abs(b.c - c4);
          return (b.clear * 8 - db) - (a.clear * 8 - da);
        });
        // 取最靠前的几个做混合，单个来源会带进它自己的木纹特征
        var picks = ranked.slice(0, 4);

        pctx.setTransform(1, 0, 0, 1, 0, 0);
        pctx.globalCompositeOperation = 'source-over';
        pctx.globalAlpha = 1;
        pctx.clearRect(0, 0, SIDE, SIDE);

        // 第一个铺满，其余的以低透明度叠上去 —— 相当于把几处木纹平均一下，
        // 接缝处就不会各说各话
        for (var q = 0; q < picks.length; q++) {
          var srcQ = picks[q];
          var qx = lat.x0 + srcQ.c * dx, qy = lat.y0 + srcQ.r * dy;
          pctx.globalAlpha = q === 0 ? 1 : 0.34;
          pctx.drawImage(img, qx - R, qy - R, R * 2, R * 2, 0, 0, SIDE, SIDE);
        }
        pctx.globalAlpha = 1;

        // 径向羽化：中心实、边缘虚
        var g = pctx.createRadialGradient(SIDE / 2, SIDE / 2, RIN, SIDE / 2, SIDE / 2, R);
        g.addColorStop(0, 'rgba(0,0,0,1)');
        g.addColorStop(0.7, 'rgba(0,0,0,0.92)');
        g.addColorStop(1, 'rgba(0,0,0,0)');
        pctx.globalCompositeOperation = 'destination-in';
        pctx.fillStyle = g;
        pctx.fillRect(0, 0, SIDE, SIDE);
        pctx.globalCompositeOperation = 'source-over';

        c.drawImage(patch, Math.round(gx(c4) - SIDE / 2), Math.round(gy(r4) - SIDE / 2));
      }
    }

    out.__margin = MARGIN;   // 调用方要知道余量才能摆对位置
    out.__dbg = { cands: cands.length, fallback: fallback.length,
                  pieces: (function(){var n=0;for(var i=0;i<CELLS;i++)if(cells[i])n++;return n;})() };
    return out;
  }

  /**
   * 从模板里抠出每种棋子的图样；模板里没有的类别用内置画法补上。
   *
   * 取的范围比一格间距大一点：真实棋子常见和间距差不多大，
   * 按一格取会把棋子的边缘切掉。外圈径向羽化到透明，
   * 所以取进来的邻居棋子/背景在角落处已经被淡掉了。
   */
  function extractSprites(img, lat, cells) {
    var sprites = new Array(NC).fill(null);
    var K = SPR_K;                      // 取图范围 = 间距 × K
    var side = Math.max(lat.dx, lat.dy) * K;

    for (var i = 0; i < CELLS; i++) {
      var cls = cells[i];
      if (!cls || sprites[cls]) continue;
      var r = Math.floor(i / COLS), col = i % COLS;
      var cx = lat.x0 + col * lat.dx;
      var cy = lat.y0 + r * lat.dy;

      var sc = document.createElement('canvas');
      sc.width = SPR; sc.height = SPR;
      var sctx2 = sc.getContext('2d');

      // 先按圆形羽化铺一层遮罩，再把棋子画进去（source-in 只保留重叠部分）
      var g = sctx2.createRadialGradient(
        SPR / 2, SPR / 2, SPR * 0.42,
        SPR / 2, SPR / 2, SPR * 0.53
      );
      g.addColorStop(0, 'rgba(0,0,0,1)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      sctx2.fillStyle = g;
      sctx2.fillRect(0, 0, SPR, SPR);
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
      // 内置画法的直径按同样的比例：SPR * (1/K) * 0.94
      drawPieceDemo(cv.getContext('2d'), SPR / 2, SPR / 2, (SPR / K) * 0.94, k);
      sprites[k] = cv;
    }
    return sprites;
  }

  async function generateFromTemplate(s, n) {
    if (!s || !s.lattice) throw new Error('这张图还没标定 —— 先到「标注」页框选棋盘');

    // 模板的标定准不准，直接决定棋盘底重建得干不干净：偏一两个像素，
    // 补丁就会错位，棋子残影会留在棋盘上。自动标定（置信度通常 4~6）不够准，
    // 所以这里先自动精修一遍 —— 与其只提醒用户去手动校正，不如直接做掉。
    if (s.conf < 20) {
      log('模板置信度偏低（' + fmt(s.conf, 1) + '），先自动精修一次…');
      if (await refineLattice(s)) {
        log('精修完成，置信度 ' + fmt(s.conf, 1));
        await dbPut(toRecord(s));
      } else {
        log('精修失败，沿用原标定');
      }
    }

    var img = await imageOf(s);

    var lat = {
      x0: s.lattice.x0 * s.w, y0: s.lattice.y0 * s.h,
      dx: s.lattice.dx * s.w, dy: s.lattice.dy * s.h
    };
    var srcCells = s.cells && s.cells.some(function (v) { return v > 0; })
      ? s.cells.slice()
      : null;

    var clean = null, sprites = null;
    var pins = s.pins && s.pins.length ? s.pins.slice() : null;
    if (pins) log('使用手工指定的 ' + pins.length + ' 处空位作为贴图来源');
    if (srcCells) {
      clean = makeCleanBoard(img, lat, srcCells, pins);
      if (clean.__needPins) {
        var msg = pins
          ? '指定的空位周围还有棋子，没法当作干净木板。换几处再试（要选周围一圈都没子的地方）。'
          : '这张图里找不到「周围两格都没有棋子」的位置，自动重建棋盘底做不了。' +
            '请点「取空位」，在确定没子的地方点几处，再生成。';
        log('棋盘底重建中止：' + msg);
        toast(msg, 5200);
        return 0;
      }
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
        // 干净底的左上角是「左上交叉点往左上 MARGIN 格」，
        // 而 ox/oy 指的就是左上交叉点，所以整体往左上挪 MARGIN 格。
        /*
         * 只取棋盘本体，丢掉那圈余量。
         *
         * 余量是给补丁留完整空间的，本身是「棋盘外的深色背景 + 补丁的圆弧边」，
         * 直接贴上去会在棋盘四周留下一圈扇贝形花边。
         * 干净底里，棋盘木面从 (m-0.5) 格开始、宽 (COLS-1+1) 格。
         */
        var m = clean.__margin || 1;
        // 干净底的建库尺度：一格 = 干净底宽 / (COLS - 1 + 2m)
        var cdx = clean.width / (COLS - 1 + m * 2);
        var cdy = clean.height / (ROWS - 1 + m * 2);
        var scx = (m - 0.5) * cdx, scy = (m - 0.5) * cdy;
        var scw = COLS * cdx, sch = ROWS * cdy;
        c.drawImage(clean, scx, scy, scw, sch,
                    ox, oy, dx2 * COLS, dy2 * ROWS);
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
          // 图样是按「间距 × K」的范围抠出来的，贴回去也要用同一个 K，
          // 否则棋子会被缩放，和模板里的实际大小对不上。
          var sp = sprites[cls];
          var side = Math.max(dx2, dy2) * SPR_K;
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

    var IW = stageImg.naturalWidth, IH = stageImg.naturalHeight;
    var pad = 0.35;   // 棋盘四周留出的余量（单位：格）

    // 棋盘在图片里的实际范围（含余量）
    var fr = s.lattice
      ? {
        x: (s.lattice.x0 - s.lattice.dx * pad) * IW,
        y: (s.lattice.y0 - s.lattice.dy * pad) * IH,
        w: s.lattice.dx * (COLS - 1 + pad * 2) * IW,
        h: s.lattice.dy * (ROWS - 1 + pad * 2) * IH
      }
      : { x: 0, y: 0, w: IW, h: IH };

    /*
     * 舞台盒子按棋盘的长宽比来定，而不是固定成「视口高度的一半」。
     *
     * 棋盘本身是竖长的（10 行 × 9 列）再加余量，塞进一个比例不匹配的盒子里，
     * 短边会把整块棋盘压小，另一边留一大片空白 —— 格子只有 34px，点起来费劲。
     * 这里让盒子贴合棋盘比例：优先铺满宽度，高度不够就退回按高度定宽。
     */
    // 滚动区左右各 12px padding，再留一点边
    var body = $('annotateBody');
    var wrapW = (body ? body.clientWidth : window.innerWidth) - 26;
    if (wrapW < 80) wrapW = window.innerWidth - 26;
    var maxW = Math.min(wrapW, 620);

    /*
     * 高度按**实际剩下的空间**算，不再用「视口高度的 56%」这种拍脑袋的比例。
     *
     * 底部那条固定区（工具条 + 两行笔刷 + 提示）高度是会变的 ——
     * 拍脑袋的比例一遇上它变高，棋盘就被挤出屏幕，
     * 表现是「棋盘显示不完整」。
     *
     * 所以直接量：视口高 - 顶栏 - 图例 - 底部固定区 - 一点余量。
     */
    var vh = window.innerHeight;
    function outerH(sel) {
      var e = document.querySelector(sel);
      if (!e) return 0;
      var r = e.getBoundingClientRect();
      var cs = getComputedStyle(e);
      return r.height + parseFloat(cs.marginTop) + parseFloat(cs.marginBottom);
    }
    var used = outerH('.bar-hd') + outerH('.legendbar') + outerH('.brushbar') +
               outerH('.stagehint');
    var avail = vh - used - 16;      // 再留 16px 呼吸空间
    var maxH = Math.round(clamp(avail, 220, 900));

    var aspect = fr.h / fr.w;
    var boxW, boxH;
    if (maxW * aspect <= maxH) {
      boxW = Math.round(maxW);
      boxH = Math.round(maxW * aspect);
    } else {
      boxH = Math.round(maxH);
      boxW = Math.round(maxH / aspect);
    }
    boxW = Math.max(160, boxW);
    boxH = Math.max(160, boxH);
    view.debug = {
      frW: Math.round(fr.w), frH: Math.round(fr.h),
      aspect: aspect.toFixed(3), maxW: maxW, maxH: maxH
    };

    dpr = window.devicePixelRatio || 1;
    stage.style.width = boxW + 'px';
    stage.style.height = boxH + 'px';
    stage.width = Math.round(boxW * dpr);
    stage.height = Math.round(boxH * dpr);
    sctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    sctx.clearRect(0, 0, boxW, boxH);

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
      if (showPred && lastPred) {
        // 核对模式：只画「模型预测 vs 你的标注」的差异。
        // 不画阵营色圈，也不画修正痕迹 —— 三种标记叠在一起就没法看了。
        drawPredMarks(s, lastPred, S);
      } else {
        drawMarkers(s, S);
        drawFixed(s, S);
      }
      drawPins(s, S);
    }
    if (mode === 'draw' && drawStart && drawNow) drawRough(drawStart, drawNow, S);
    sctx.restore();

    // 标题带上「在当前这一类里的位置」—— 只显示文件名的话，
    // 用户不知道自己在哪一类里翻到第几张了
    var list = navList();
    var at = -1;
    for (var li = 0; li < list.length; li++) if (list[li] === s) { at = li; break; }
    if (at >= 0 && list.length > 1) {
      $('imgName').textContent = s.name + '　·　' + navLabel() +
        ' ' + (at + 1) + '/' + list.length;
    } else {
      $('imgName').textContent = s.name;
    }
    $('calibInfo').textContent = s.lattice
      ? ('已标定 · 置信度 ' + fmt(s.conf, 1) + ' · 格子 ' +
         fmt(Math.max(s.lattice.dx * s.w, s.lattice.dy * s.h) * S, 0) + 'px 显示')
      : '未标定 — 拖动框住棋盘';
    if (showPred && lastPred) {
      var dd = diffOf(s, lastPred);
      hint.textContent = dd.diff.length === 0
        ? '这张图模型全对 ✓　点上面的「改标注」可以继续编辑'
        : ('只显示判错的 ' + dd.diff.length + ' 处 · 紫圈=要让它重点学，'
           + '点一下可点掉；要改标注请点上面的「改标注」');
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
   * 分三层，保证压在任何棋盘底色、任何棋子上都清晰：
   *   1. 半透明暗底 —— 把底下的棋子压暗，标记本身成为视觉主体
   *   2. 阵营色粗环 —— 颜色即阵营，不用读字也能分辨
   *   3. 阵营色字符 —— 具体是哪个子
   *
   * 模型预标注的格子（auto）画虚线环，人手确认过的是实线。
   */
  function drawMarkers(s, S) {
    if (!s.lattice || !s.cells) return;
    var IW = view.imgW, IH = view.imgH;
    var x0 = s.lattice.x0 * IW, y0 = s.lattice.y0 * IH;
    var dx = s.lattice.dx * IW, dy = s.lattice.dy * IH;
    var R = Math.min(dx, dy) * 0.33;

    for (var r = 0; r < ROWS; r++) {
      for (var c = 0; c < COLS; c++) {
        var i = r * COLS + c;
        var v = s.cells[i];
        if (!v) continue;
        var auto = s.auto && s.auto[i];
        var col = CLASSES[v].c;
        var cx = x0 + c * dx, cy = y0 + r * dy;

        // 1) 暗底衬
        sctx.beginPath();
        sctx.arc(cx, cy, R, 0, Math.PI * 2);
        sctx.fillStyle = 'rgba(8,10,14,' + (auto ? 0.52 : 0.62) + ')';
        sctx.fill();

        // 2) 阵营色环
        sctx.lineWidth = 3 / S;
        if (auto) sctx.setLineDash([3.5 / S, 2.5 / S]);
        sctx.strokeStyle = col;
        sctx.stroke();
        sctx.setLineDash([]);

        // 3) 字符
        sctx.fillStyle = col;
        sctx.font = 'bold ' + Math.round(R * 1.12) + 'px "PingFang SC",serif';
        sctx.textAlign = 'center'; sctx.textBaseline = 'middle';
        sctx.fillText(CLASSES[v].g, cx, cy);
      }
    }
  }

  /**
   * 标注模式下，给「已列入待学清单」的格子做个小记号。
   *
   * 画成右上角一个很小的紫点 —— 不能再用大圈或大菱形，
   * 那会盖住棋子本身，看起来就像「标注和修正混在一起」。
   */
  function drawFixed(s, S) {
    if (!s.lattice || !s.fixed) return;
    var IW = view.imgW, IH = view.imgH;
    var x0 = s.lattice.x0 * IW, y0 = s.lattice.y0 * IH;
    var dx = s.lattice.dx * IW, dy = s.lattice.dy * IH;
    var R = Math.min(dx, dy) * 0.34;
    var dot = Math.max(2.2, Math.min(dx, dy) * 0.09);
    for (var r = 0; r < ROWS; r++) {
      for (var c = 0; c < COLS; c++) {
        var i = r * COLS + c;
        if (!s.fixed[i]) continue;
        // 右上角，压在格子边缘上，不碰中间的棋子
        var px = x0 + c * dx + R * 0.86;
        var py = y0 + r * dy - R * 0.86;
        sctx.beginPath();
        sctx.arc(px, py, dot, 0, Math.PI * 2);
        sctx.fillStyle = '#7b5cff';
        sctx.fill();
        sctx.lineWidth = 1.4 / S;
        sctx.strokeStyle = 'rgba(10,12,15,.85)';
        sctx.stroke();
      }
    }
  }

  /** 「取空位」模式下手工指定的干净木板，画成白色菱形 */
  function drawPins(s, S) {
    if (!s.lattice || !s.pins || !s.pins.length) return;
    var IW = view.imgW, IH = view.imgH;
    var x0 = s.lattice.x0 * IW, y0 = s.lattice.y0 * IH;
    var dx = s.lattice.dx * IW, dy = s.lattice.dy * IH;
    var R = Math.min(dx, dy) * 0.3;
    for (var k = 0; k < s.pins.length; k++) {
      var idx = s.pins[k];
      var r = Math.floor(idx / COLS), c = idx % COLS;
      var cx = x0 + c * dx, cy = y0 + r * dy;
      sctx.save();
      sctx.translate(cx, cy);
      sctx.rotate(Math.PI / 4);
      sctx.beginPath();
      sctx.rect(-R * 0.62, -R * 0.62, R * 1.24, R * 1.24);
      sctx.fillStyle = 'rgba(255,255,255,.9)';
      sctx.fill();
      sctx.restore();
    }
  }

  /** #rrggbb + alpha -> rgba() */
  function hexA(hex, a) {
    var h = hex.replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var n = parseInt(h, 16);
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
  }

  /**
   * 对比模式：叠加显示模型的预测，并标出判错的格子。
   *
   * **只画判错的格子。**
   *
   * 判对的也画上圈的话，整块棋盘都是圈 —— 和标注模式的阵营色圈看起来一样花，
   * 用户仍然会觉得"混在一起"。核对的目的是找到错处，那就只显示错处。
   *
   * 配色用紫，刻意避开阵营色（红/青/琥珀），一眼就能和棋子本身区分开：
   *   亮紫实线 = 模型判错，已列入待学清单
   *   暗紫虚线 = 模型判错，但你已点掉（不学这处）
   */
  function drawPredMarks(s, pred, S) {
    var IW = view.imgW, IH = view.imgH;
    var x0 = s.lattice.x0 * IW, y0 = s.lattice.y0 * IH;
    var dx = s.lattice.dx * IW, dy = s.lattice.dy * IH;
    var R = Math.min(dx, dy) * 0.33;

    for (var r = 0; r < ROWS; r++) {
      for (var c = 0; c < COLS; c++) {
        var i = r * COLS + c;
        var truth = s.cells ? s.cells[i] : 0;
        var p = pred[i];
        if (p === truth) continue;            // 判对了就不画 —— 只显示错处
        var wrong = true;

        var cx = x0 + c * dx, cy = y0 + r * dy;
        // 判错的格再看它有没有被列入待学清单：
        // 列入 = 亮紫实线（要学的），点掉的 = 暗灰虚线（跳过）
        var inList = s.fixed && s.fixed[i];
        sctx.beginPath();
        sctx.arc(cx, cy, R, 0, Math.PI * 2);
        sctx.fillStyle = 'rgba(8,10,14,' +
          (wrong ? (inList ? 0.62 : 0.45) : 0.42) + ')';
        sctx.fill();
        if (wrong && !inList) {
          sctx.setLineDash([3.5 / S, 3 / S]);
        }
        sctx.lineWidth = (wrong ? (inList ? 3 : 2) : 1.6) / S;
        sctx.strokeStyle = wrong ? (inList ? '#7b5cff' : '#5a5570') : '#3fbf74';
        sctx.stroke();
        sctx.setLineDash([]);
        sctx.fillStyle = wrong ? (inList ? '#b9a6ff' : '#8b86a0') : '#6cdc93';
        sctx.font = 'bold ' + Math.round(R * 1.12) + 'px "PingFang SC",serif';
        sctx.textAlign = 'center'; sctx.textBaseline = 'middle';
        sctx.fillText(p === 0 ? '空' : CLASSES[p].g, cx, cy);
      }
    }
  }

  /** 阵营图例（放在画布下方，不遮棋盘） */
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
    // 核对模式下先说明差异是什么，避免和标注混淆
    if (showPred && lastPred) {
      var dd0 = diffOf(s, lastPred);
      var fx = fixedCount(s);
      // 数字统一口径：diffOf 是当前实际的差异数，fx 是其中被列入清单的。
      // 之前图例用 fixedCount（历史遗留的清单），提示条用 diffOf，
      // 两处会显示不同的数 —— 用户看到的两个数字必须是一回事。
      if (!dd0.diff.length) {
        el.innerHTML = '<span class="lg" style="border-color:#3fbf74;color:#3fbf74">' +
          '没有判错的地方 ✓</span>';
        return;
      }
      el.innerHTML =
        '<span class="lg warn"><i style="background:#7b5cff"></i>待学 ' + fx +
        ' / ' + dd0.diff.length + ' 处</span>' +
        (dd0.diff.length - fx > 0
          ? '<span class="lg"><i style="background:#5a5570"></i>已跳过 ' +
            (dd0.diff.length - fx) + ' 处</span>' : '');
      return;
    }
    var parts = [];
    if (counts.r) parts.push('<span class="lg"><i style="background:' + COLOR_RED +
      '"></i>红方 ' + counts.r + '</span>');
    if (counts.b) parts.push('<span class="lg"><i style="background:' + COLOR_BLACK +
      '"></i>黑方 ' + counts.b + '</span>');
    if (counts.d) parts.push('<span class="lg"><i style="background:' + COLOR_DARK +
      '"></i>暗子 ' + counts.d + '</span>');
    if (counts.auto) parts.push('<span class="lg warn"><i style="background:' + COLOR_DARK +
      '"></i>模型猜 ' + counts.auto + ' · 待核对</span>');
    var fx2 = fixedCount(s);
    if (fx2) parts.push('<span class="lg"><i style="background:#7b5cff"></i>待学 ' +
      fx2 + ' 处</span>');
    if (!parts.length) parts.push('<span class="lg">还没有标注</span>');
    el.innerHTML = parts.join('');
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

  /**
   * 批量标定。
   * @param targets 指定要处理哪些样本；不传就处理全部「还没标定」的。
   */
  async function batchCalibrate(targets) {
    if (!targets) {
      targets = samples.filter(function (s) { return !s.lattice; });
    }
    targets = targets.filter(function (s) { return !s.lattice; });
    if (!targets.length) { toast('这些图都已经标定过了'); return; }

    setBusy(true, '自动标定', '0 / ' + targets.length);
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
    picked = {};
    renderStats();
    renderSamples();
    refreshTrainTab();
    renderHome();
    log('批量标定：成功 ' + ok + ' 张，失败 ' + fail + ' 张');
    toast('标定完成：成功 ' + ok + (fail ? '，失败 ' + fail + '（可逐张手动框选）' : ''), 2800);
  }

  $('btnBatchCalib').addEventListener('click', function () { batchCalibrate(null); });

  /** 采集页那张卡片上的统计 */
  function updateBatchInfo() {
    var el = $('batchInfo');
    if (!el) return;
    var c = sampleCounts();
    el.innerHTML = '共 <b>' + c.total + '</b> 张 · 已就绪 <b>' + c.ready + '</b>' +
      (c.uncalibrated ? ' · <span style="color:#e0a33a">待标定 ' + c.uncalibrated + '</span>' : '') +
      (c.pending ? ' · <span style="color:#e0a33a">待标注 ' + c.pending + '</span>' : '') +
      (c.review ? ' · <span style="color:#7b5cff">待核对 ' + c.review + '</span>' : '');
    var btn = $('btnBatchCalib');
    if (btn) btn.disabled = !c.uncalibrated;
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

    // 「取空位」模式下，点格子是标记/取消一处干净木板，不改标注
    if (pinMode) {
      s.pins = s.pins || [];
      var at = s.pins.indexOf(idx);
      if (at >= 0) s.pins.splice(at, 1); else s.pins.push(idx);
      queueSave(s);
      renderStage();
      renderSamples();
      return idx;
    }
    /*
     * 改错行：把这一格改成对的，并记入「待模型重点学」。
     *
     * 这一行是给「模型认错了，我直接改过来」用的。改完这一格同时做两件事：
     *   · 更新标注（反正这一格确实该是这个子）
     *   · 列入待学（下次微调时模型会重点看这里）
     * 所以它天然属于纠错闭环，不需要用户再切模式。
     */
    if (fixBrush !== null) {
      s.cells = s.cells || new Array(CELLS).fill(0);
      s.fixed = s.fixed || new Array(CELLS).fill(0);
      s.skip = s.skip || new Array(CELLS).fill(0);
      s.cells[idx] = fixBrush;
      s.fixed[idx] = 1;
      s.skip[idx] = 0;
      if (s.auto) s.auto[idx] = 0;   // 人工改过，不再是「模型猜的」
      lastCell = idx;
      queueSave(s);
      renderStage();
      renderSamples();
      return idx;
    }

    /*
     * 核对模式（正在看模型预测）：点格子只是切换「这处要不要让模型重点学」，
     * **绝不改标注**。
     *
     * 以前这里跟标注模式走同一条路径，于是核对时点一下格子，实际改掉的是
     * 自己的标注 —— 这正是「我修改的棋子会影响标注的棋子」的原因。
     * 修正和标注是两件事，必须分开。
     */
    if (showPred && lastPred) {
      toggleFixTarget(s, idx);
      return idx;
    }

    s.cells = s.cells || new Array(CELLS).fill(0);
    s.cells[idx] = (s.cells[idx] === brush) ? 0 : brush;   // 同笔刷再点 = 擦掉
    // 人手点过这一格，就不再是「模型猜的」，虚线环随之变成实线
    if (s.auto) s.auto[idx] = 0;
    lastCell = idx;
    queueSave(s);
    renderStage();
    return idx;
  }

  /**
   * 切换某一格的「重点学」状态。只动 s.fixed，不碰 s.cells。
   */
  function toggleFixTarget(s, idx) {
    s.fixed = s.fixed || new Array(CELLS).fill(0);
    s.skip = s.skip || new Array(CELLS).fill(0);
    var on = !s.fixed[idx];
    s.fixed[idx] = on ? 1 : 0;
    // 记下「用户主动跳过」—— 下次进入核对重算清单时不该再自动选上
    s.skip[idx] = on ? 0 : 1;
    queueSave(s);
    renderStage();
    renderSamples();
  }

  /**
   * 进入核对模式时，把所有差异自动纳入待学清单。
   *
   * 默认全选是为了省事 —— 差异本来就是「模型判错的地方」，
   * 用户只需要把其中「其实是自己标错了」的那几格点掉。
   * 已经有清单时不动，避免覆盖用户刚做的调整。
   */
  function buildFixList(s) {
    if (!lastPred) return 0;
    /*
     * 每次进入核对都按**当前模型**重算清单。
     *
     * 不能沿用旧清单：它是模型还是上一版时生成的，模型一换就过期了 ——
     * 实测出现过「清单里 6 条，其中 2 条其实已经不是错误」，
     * 用户看到两个不一致的数字，也不知道该信哪个。
     *
     * 但用户手动点掉的选择要保留（记录在 s.skip 里），
     * 否则每次进来都得重新点掉同一批。
     */
    s.skip = s.skip || new Array(CELLS).fill(0);
    s.fixed = new Array(CELLS).fill(0);
    var n = 0;
    for (var i = 0; i < CELLS; i++) {
      var truth = s.cells ? s.cells[i] : 0;
      if (lastPred[i] === truth) { s.skip[i] = 0; continue; }  // 不再是错误，清掉跳过记录
      if (!s.skip[i]) { s.fixed[i] = 1; n++; }
    }
    return n;
  }

  /**
   * 记录「这一格我改过，而且和模型的判断不一样」。
   *
   * 这是纠错闭环的信号来源。只在**正在对比模型预测**时记录 ——
   * 那个界面的语义就是"我在核对模型错在哪"，此时改动基本都是在改错。
   * 普通标注（没有预测可对比）不算修正，只算人工标注。
   */

  /** 一张图上有多少格是人工修正过的 */
  function fixedCount(s) {
    if (!s || !s.fixed) return 0;
    var n = 0;
    for (var i = 0; i < CELLS; i++) if (s.fixed[i]) n++;
    return n;
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
      lattice: s.lattice, cells: s.cells, conf: s.conf,
      auto: s.auto, src: s.src, pins: s.pins,
      fixed: s.fixed, skip: s.skip, autoTouched: s.autoTouched
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
    if ($('btnPinMode')) $('btnPinMode').classList.toggle('on', pinMode);
  }

  // ---------------------------------------------------------------- 笔刷
  function renderPalette() {
    var p = $('palette');
    p.innerHTML = '';

    /*
     * 两行：一行标注、一行改错。每行横向滑动，不折行。
     *
     * 之前每类排成 8×2 的网格，两组就是四行 —— 底部占了半屏，棋盘被挤没了。
     * 现在每组只占一行高度（约 50px），两行加起来 110px 左右。
     */
    var ROWS = [
      { key: 'annotate', label: '标注' },
      { key: 'fix', label: '改错' }
    ];

    ROWS.forEach(function (row) {
      var wrap = document.createElement('div');
      wrap.className = 'brushrow brushrow--' + row.key;

      var lab = document.createElement('span');
      lab.className = 'brushrow__label';
      lab.textContent = row.label;
      wrap.appendChild(lab);

      var strip = document.createElement('div');
      strip.className = 'brushstrip';

      CLASSES.forEach(function (c, i) {
        var b = document.createElement('button');
        var on = (row.key === 'fix') ? (fixBrush === i) : (fixBrush === null && brush === i);
        b.className = 'brush ' + c.k + (on ? ' on' : '');
        b.dataset.idx = i;
        b.dataset.row = row.key;
        b.innerHTML = '<span class="g">' + c.g + '</span><span class="cnt"></span>';
        strip.appendChild(b);
      });

      wrap.appendChild(strip);
      p.appendChild(wrap);
    });

    p.addEventListener('click', function (ev) {
      var b = ev.target.closest ? ev.target.closest('.brush') : null;
      if (!b) return;
      var i = Number(b.dataset.idx);
      if (b.dataset.row === 'fix') {
        fixBrush = (fixBrush === i) ? null : i;   // 再点一次退出改错行
      } else {
        brush = i;
        fixBrush = null;                          // 切回标注行
      }
      syncBrushUI();
    });

    renderPaletteCounts();
    syncBrushUI();
  }

  /** 把选中态与提示文字同步到界面 */
  function syncBrushUI() {
    var p = $('palette');
    if (!p) return;
    Array.prototype.forEach.call(p.querySelectorAll('.brush'), function (x) {
      var i = Number(x.dataset.idx);
      var on = (x.dataset.row === 'fix') ? (fixBrush === i) : (fixBrush === null && brush === i);
      x.classList.toggle('on', on);
      // 选中项滚进可视区，方便连续改同一个子
      if (on) {
        try { x.scrollIntoView({ block: 'nearest', inline: 'center' }); } catch (e) { }
      }
    });
    p.classList.toggle('fix-mode', fixBrush !== null);

    var hint = $('brushHint');
    if (!hint) return;
    if (fixBrush !== null) {
      hint.innerHTML = '<b style="color:#ffb020">改错</b>：点格子改成「' +
        CLASSES[fixBrush].g + '」并列入待学 · 再点同一笔刷退出';
    } else {
      hint.textContent = '点格子落子 · 同笔刷再点擦除 · 双指缩放';
    }
  }

  $('btnCalib').addEventListener('click', function () {
    mode = 'draw';
    updateModeButtons();
    var s = currentSample();
    if (s) { s.lattice = null; s.conf = 0; }
    renderStage();
    toast('在棋盘上拖一个框');
  });
  $('btnPinMode').addEventListener('click', function () {
    var s = currentSample();
    if (!s || !s.lattice) { toast('先框选标定棋盘'); return; }
    pinMode = !pinMode;
    updateModeButtons();
    renderStage();
    toast(pinMode
      ? '取空位：点几处确定没有棋子的地方（白色菱形）。生成时只用这些地方当干净木板。再点一次退出。'
      : '已退出取空位模式', pinMode ? 4200 : 1600);
  });

  $('btnPinClear').addEventListener('click', function () {
    var s = currentSample();
    if (!s) return;
    s.pins = [];
    queueSave(s);
    renderStage();
    toast('已清除手工空位，改回自动推断');
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
  /**
   * 以现有晶格为种子再拟合一次。
   * 自动标定出来的格子常有 1~2 像素偏差，这一步能把它收紧到亚像素。
   */
  async function refineLattice(s) {
    if (!s || !s.lattice) return false;
    await imageOf(s);
    var gc = grayOf(s);
    if (!gc) return false;
    var rough = {
      x: (s.lattice.x0 - s.lattice.dx * 0.4) * s.w,
      y: (s.lattice.y0 - s.lattice.dy * 0.4) * s.h,
      w: (s.lattice.dx * 8.8) * s.w,
      h: (s.lattice.dy * 9.8) * s.h
    };
    var r = Lattice.fitBoard(gc.gray, gc.w, gc.h, rough);
    if (!r.ok) return false;
    s.lattice = { x0: r.x0 / s.w, y0: r.y0 / s.h, dx: r.dx / s.w, dy: r.dy / s.h };
    s.conf = r.confidence;
    s.edgeRatio = r.edgeRatio;
    refreshThumb(s);
    return true;
  }

  $('btnAuto').addEventListener('click', async function () {
    var s = currentSample();
    if (!s) return;
    if (!s.lattice) { toast('先框选棋盘'); return; }
    if (await refineLattice(s)) {
      queueSave(s);
      renderStage();
      renderSamples();
      toast('已重新校正 · 置信度 ' + fmt(s.conf, 1));
    } else {
      toast('校正失败，试试手动框选');
    }
  });
  // 用模型检查当前这张图：把预测叠加到棋盘上，错的格子标红
  $('btnCheckModel').addEventListener('click', async function () {
    var s = currentSample();
    if (!s || !s.lattice) { toast('先框选标定棋盘'); return; }

    if (showPred) {
      showPred = false;
      updateCompareBar();
      renderStage();
      return;
    }

    if (!(await ensureModel())) return;

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
    // 进入核对就自动生成待学清单（已有清单则保留用户的选择）
    var n = buildFixList(s);
    queueSave(s);
    updateCompareBar();
    renderStage();
    renderSamples();
    log('核对「' + s.name + '」：' + n + ' 处与标注不一致，已列入待学清单');
    toast('发现 ' + n + ' 处判错。点紫色格子可以点掉（表示这处不用学）', 3200);
  });

  /**
   * 一键确认：这张图的预标注全对，不用再核对。
   *
   * 用户做模型辅助标注的初衷就是减轻负担 —— 模型猜对的那一大堆图，
   * 逐格点一遍纯属浪费。确认一下就把「待核对」这个状态清掉。
   *
   * 注意只清 auto（模型猜的标记）与待学清单，**不动标注本身**。
   */
  function acceptSample(s) {
    if (!s) return 0;
    var n = 0;
    if (s.auto) {
      for (var i = 0; i < CELLS; i++) if (s.auto[i]) { s.auto[i] = 0; n++; }
    }
    // 确认全对，就没有「待学」可言了
    if (s.fixed) for (var j = 0; j < CELLS; j++) s.fixed[j] = 0;
    if (s.skip) for (var k = 0; k < CELLS; k++) s.skip[k] = 0;
    return n;
  }

  $('btnAcceptAll').addEventListener('click', async function () {
    var s = currentSample();
    if (!s) return;
    var n = acceptSample(s);
    showPred = false;
    lastPred = null;
    updateCompareBar();
    await dbPut(toRecord(s));
    renderStage();
    renderSamples();
    renderHome();
    log('已确认「' + s.name + '」：清掉 ' + n + ' 处模型预标注标记');
    toast(n ? ('已确认，' + n + ' 处预标注转为人工确认') : '已确认', 2200);
  });

  /** 批量确认：一次把多张图的预标注都确认掉 */
  async function acceptMany(list) {
    var arr = (list || []).filter(function (s) { return s.auto && s.auto.some(function (v) { return v; }); });
    if (!arr.length) { toast('这些图没有待确认的预标注'); return; }

    setBusy(true, '确认预标注', '0 / ' + arr.length);
    var total = 0;
    for (var i = 0; i < arr.length; i++) {
      total += acceptSample(arr[i]);
      await dbPut(toRecord(arr[i]));
      $('busySub').textContent = (i + 1) + ' / ' + arr.length;
      if (i % 5 === 4) await yieldTick();
    }
    setBusy(false);
    renderStats();
    renderSamples();
    renderHome();
    log('批量确认 ' + arr.length + ' 张，共清掉 ' + total + ' 处预标注标记');
    toast('已确认 ' + arr.length + ' 张', 2600);
  }

  /** 核对模式下才显示那条「改标注」提示栏 */
  function updateCompareBar() {
    var bar = $('compareBar');
    if (bar) bar.hidden = !showPred;
    $('btnCheckModel').classList.toggle('on', showPred);
  }

  $('btnExitCompare').addEventListener('click', function () {
    showPred = false;
    updateCompareBar();
    renderStage();
    toast('已切到标注模式 —— 现在点格子才是改标注', 2600);
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
  /**
   * 在**当前筛选**内翻页，而不是在全部样本里翻。
   *
   * 场景：筛出「待核对 8 张」，点进第一张核对，按下一个应该到第二张待核对的；
   * 以前会走到「全部样本」里的下一张 —— 可能是个已经就绪的图，
   * 于是核对到一半就被甩出这个类别，还得回样本库重新找。
   */
  /**
   * 当前翻页所依据的集合。
   *
   * 进标注页的入口不止一个 —— 样本库（带筛选）、回测列表（可只看有错的）。
   * 从哪进来就该在哪一类里翻：筛出「待核对 8 张」，点进去后按下一个
   * 应该到下一张待核对的，而不是跳到一张已经就绪的图。
   */
  var navContext = null;   // { list: [样本], label: '待核对' }

  function navList() {
    if (navContext && navContext.list && navContext.list.length) return navContext.list;
    return filteredSamples();
  }

  function navLabel() {
    if (navContext && navContext.label) return navContext.label;
    var f = sampleFilter;
    if (f === 'all') return '全部样本';
    if (f === 'fix') return '有修正的';
    return STATE_LABEL[f] || '样本';
  }

  function setNavContext(list, label) {
    navContext = (list && list.length) ? { list: list.slice(), label: label } : null;
  }

  function stepSample(dir) {
    var list = navList();
    if (!list.length) return;

    var cur = samples[current];
    var at = -1;
    for (var i = 0; i < list.length; i++) {
      if (list[i] === cur || list[i].key === (cur && cur.key)) { at = i; break; }
    }
    if (at < 0) at = dir > 0 ? -1 : 0;

    var next = at + dir;
    if (next < 0 || next >= list.length) {
      toast((dir > 0 ? '「' + navLabel() + '」的最后一张了' : '「' + navLabel() + '」的第一张了'), 1800);
      return;
    }
    var target = list[next];
    // 正在核对时翻页，下一张也直接进核对 ——
    // 否则按「下一个」会悄悄退出核对模式，用户还得再点一次「对比模型」
    var keepCompare = !!showPred;
    openAnnotate(samples.indexOf(target), keepCompare);
  }

  $('btnPrev').addEventListener('click', function () { stepSample(-1); });
  $('btnNext').addEventListener('click', function () { stepSample(1); });

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
  // 每个训练样本是不是「人工修正过」的。纠错微调靠它加权。
  var trainFixed = null;
  var valKeys = {};      // 上一轮训练用到的验证图，回测时用来分开统计

  /**
   * 按**图片**划分训练/验证，避免同一局面的格子同时出现在两边（那是数据泄漏）。
   *
   * 抽成独立函数是因为回测也要用它：以前只在「构建数据集」时算一次，
   * 于是重启后直接点回测的话 valKeys 是空的 —— 所有图都被算成训练图，
   * 「验证图准确率」显示成 —。回测应当自己保证有这个划分。
   */
  function splitValKeys(list) {
    var ratio = clamp(parseInt($('pVal').value, 10) / 100, 0.05, 0.5);
    var n = Math.max(1, Math.round(list.length * ratio));
    var shuffled = list.slice();
    for (var i = shuffled.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = shuffled[i]; shuffled[i] = shuffled[j]; shuffled[j] = t;
    }
    var set = {};
    for (var k = 0; k < n && k < shuffled.length; k++) set[shuffled[k].key] = 1;
    return set;
  }

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

    try {
      return await buildDatasetInner(u);
    } catch (e) {
      // 不接住的话按钮会永远停在「构建中…」——
      // 用户看到的就是"点了没反应 / 卡住了"，而不是一个明确的失败
      log('构建数据集失败：' + (e && e.message ? e.message : e));
      console.error(e);
      toast('构建失败：' + (e && e.message ? e.message : e), 4200);
      return false;
    } finally {
      $('btnBuild').disabled = false;
      $('btnBuild').textContent = '构建数据集';
    }
  }

  /** 构建数据集的主体。拆出来是为了让外层统一管错误与按钮状态 */
  async function buildDatasetInner(u) {
    valKeys = splitValKeys(u);

    var keepEmpty = clamp(parseInt($('pEmpty').value, 10) / 100, 0, 1);

    var trSlices = [], vaSlices = [];
    var trLab = [], vaLab = [];
    var trFix = [], vaFix = [];
    var px = inSize * inSize * 3;

    /*
     * 内存预估。切片先按 Uint8 收着，最后才转成 float32 ——
     * float32 是 Uint8 的 4 倍，这一步是峰值。
     * 样本多的时候提前说一声，比中途崩掉好。
     */
    var estBytes = u.length * CELLS * px * 5;   // 4 倍 float + 1 倍 Uint8 缓冲
    log('预计需要约 ' + fmt(estBytes / 1048576, 0) + ' MB 内存（' + u.length +
        ' 张 × ' + CELLS + ' 格 × ' + inSize + '×' + inSize + '）');

    for (var n = 0; n < u.length; n++) {
      var s = u[n];
      var img = await imageOf(s);
      var slice = cropCells(img, s.lattice, s.w, s.h, inSize);
      var isVal = !!valKeys[s.key];
      for (var c = 0; c < CELLS; c++) {
        var lab = s.cells[c];
        if (lab === 0 && Math.random() > keepEmpty) continue;
        var src = new Uint8Array(px);
        src.set(slice.subarray(c * px, c * px + px));
        var isFix = s.fixed && s.fixed[c] ? 1 : 0;
        if (isVal) { vaSlices.push(src); vaLab.push(lab); vaFix.push(isFix); }
        else { trSlices.push(src); trLab.push(lab); trFix.push(isFix); }
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
    trainFixed = new Uint8Array(trFix);

    var nFix = 0;
    for (var fi = 0; fi < trainFixed.length; fi++) if (trainFixed[fi]) nFix++;

    var mb = (trainX.byteLength + valX.byteLength) / 1048576;
    log('训练切片 ' + nTrain + ' · 验证切片 ' + nVal + ' · 共 ' + fmt(mb, 1) + ' MB' +
        (nFix ? ' · 其中人工修正 ' + nFix + ' 格' : ''));
    $('dataSummary').innerHTML += '<br>训练切片 <b>' + nTrain + '</b> · 验证切片 <b>' +
      nVal + '</b> · ' + fmt(mb, 1) + ' MB' +
      (nFix ? '<br><span style="color:#7b5cff">人工修正 <b>' + nFix +
        '</b> 格 —— 可用「纠错微调」让模型从这里学</span>' : '');

    $('btnTrain').disabled = false;
    $('btnPreviewCells').disabled = false;
    refreshFinetunePanel();
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
  function makeBatch(order, from, to, size, weights) {
    var px = size * size * 3;
    var count = to - from;
    var xsArr = new Float32Array(count * px);
    var ysArr = new Float32Array(count * NC);
    var wArr = weights ? new Float32Array(count) : null;
    for (var i = 0; i < count; i++) {
      var src = order[from + i];
      xsArr.set(trainX.subarray(src * px, src * px + px), i * px);
      ysArr.set(trainY.subarray(src * NC, src * NC + NC), i * NC);
      if (wArr) wArr[i] = weights[src];
    }
    return {
      xs: tf.tensor4d(xsArr, [count, size, size, 3]),
      ys: tf.tensor2d(ysArr, [count, NC]),
      w: wArr ? tf.tensor1d(wArr) : null
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
    // 用 dataSync 而不是 await data()：
    // 后者在页面不可见时会走定时器并被节流到 1 秒 —— 回测 40 张图就要等 40 秒，
    // 表现像卡死。逐图回测、预标注这些循环里都必须用同步读回。
    var d = t.dataSync();
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

  // busyDepth 有两个含义：一是遮罩层数，二是"用户正忙别来打扰"
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
    if (!(await ensureModel())) return;

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
    if (!(await ensureModel())) return;
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

  /**
   * 自动保存的模型名。
   *
   * 以前用固定的「最近一次训练」—— 但那样每次训练都会**覆盖上一个**，
   * 择优守卫就没有比较对象了（永远只有一个模型，无从判断好坏）。
   * 改成带时间戳，保留最近几个，守卫才能真正比较。
   */
  function autoModelName() {
    var d = new Date();
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    return '训练-' + (d.getMonth() + 1) + p(d.getDate()) + '-' +
      p(d.getHours()) + p(d.getMinutes());
  }

  /** 只保留最近 N 个模型，避免把存储撑满（每个约 370KB） */
  var KEEP_MODELS = 6;

  async function pruneModels() {
    var all = await dbAll();
    var ms = (all || []).filter(isModelRecord).sort(function (a, b) { return b.at - a.at; });
    // 首选的那个必须留着，哪怕它已经很旧
    var keep = {};
    try { keep[localStorage.getItem(PREF_KEY)] = 1; } catch (e) { }
    var toDrop = [];
    var keptCount = 0;
    ms.forEach(function (m) {
      if (keep[m.name]) return;
      if (keptCount < KEEP_MODELS) { keptCount++; return; }
      toDrop.push(m.key);
    });
    for (var i = 0; i < toDrop.length; i++) await dbDel(toDrop[i]);
    if (toDrop.length) log('清理了 ' + toDrop.length + ' 个旧模型');
  }

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
      refreshFinetunePanel();
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

  /**
   * 从回测列表点进某张图。
   *
   * 翻页范围是**当前回测列表里显示的那些** —— 开了「只看有错的」就是那几张，
   * 于是可以一直在错的图之间来回改，不会翻着翻着跳到一张全对的图上。
   */
  function gotoBacktest(key) {
    var list = displayedBacktestKeys();
    var target = null;
    for (var i = 0; i < samples.length; i++) if (samples[i].key === key) { target = samples[i]; break; }
    if (!target) return;

    var listSamples = list.map(function (k) {
      for (var j = 0; j < samples.length; j++) if (samples[j].key === k) return samples[j];
      return null;
    }).filter(Boolean);

    openAnnotate(samples.indexOf(target), !!backtest[key],
                 listSamples, backtestOnlyWrong ? '有判错的图' : '回测列表');
  }

  /** 回测列表当前显示哪些（受「只看有错的」影响） */
  var backtestOnlyWrong = false;
  function displayedBacktestKeys() {
    return backtestRows
      .filter(function (r) { return !backtestOnlyWrong || r.wrong > 0; })
      .map(function (r) { return r.key; });
  }

  /** 只是把已有回测结果画出来，不跑推理 */
  function refreshBacktest() {
    if (backtestRows.length) {
      renderBacktest(backtestRows, backtestGroups, backtestConf);
      return;
    }
    // 还没回测过：把「点哪里开始」说清楚，别让用户对着空面板发呆
    var u = usable();
    var hasModel = model || savedModels.length;
    var el = $('backtestSummary');
    if (!u.length) {
      el.innerHTML = '还没有可回测的图 —— 先标定并标注一些样本。';
    } else if (!hasModel) {
      el.innerHTML = '还没有模型。点上面的「重新回测」会先让你去训练，' +
        '或者直接到「训练」页跑一次。';
    } else {
      el.innerHTML = '已有 <b>' + u.length + '</b> 张可回测的图' +
        (model ? '' : '，模型「' + escapeHtml(savedModels[0].name) + '」会自动载入') +
        '。<br>点右上角「重新回测」开始。';
    }
    var acts = $('backtestEmptyActions');
    if (acts) acts.hidden = !!hasModel;
  }

  var backtestRows = [], backtestGroups = null, backtestConf = null;

  async function runBacktest() {
    var u = usable();
    if (!u.length) { toast('先标定并标注一些图'); return; }

    // 没有划分过（比如重启后直接回测）就现算一份，
    // 否则「验证图准确率」会永远是 —（所有图都被算成训练图）
    if (!Object.keys(valKeys).length) {
      valKeys = splitValKeys(u);
      log('回测：现场划分验证集 ' + Object.keys(valKeys).length + ' 张');
    }

    /*
     * 没载入模型时自动取最新保存的那个。
     *
     * 回测依赖的是**已保存的模型**，跟「这次开应用有没有训练过」没关系。
     * 以前重启应用后 model 是空的，点回测只会弹一句「先训练一次」——
     * 但用户明明昨天就训好了，模型还躺在库里。
     */
    if (!model) {
      if (!savedModels.length) {
        toast('还没有模型 —— 先到「训练」页跑一次', 3200);
        return;
      }
      setBusy(true, '载入模型', savedModels[0].name);
      try {
        await loadModelFromRecord(savedModels[0]);
        log('回测：自动载入模型「' + savedModels[0].name + '」');
      } catch (e) {
        setBusy(false);
        toast('载入模型失败：' + e.message, 3600);
        return;
      }
      setBusy(false);
      refreshFinetunePanel();
    }

    var btn = $('btnBacktest');
    if (btn) btn.disabled = true;
    var btn2 = $('btnBacktest2');
    if (btn2) btn2.disabled = true;
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
      if (btn) btn.disabled = false;
      if (btn2) btn2.disabled = false;
      if (native()) native().keepAwake(false);
      return;
    }

    if (native()) native().keepAwake(false);
    if (btn) { btn.disabled = false; btn.textContent = '逐图回测'; }
    if (btn2) btn2.disabled = false;

    backtestRows = rows;
    backtestGroups = g;
    backtestConf = conf;
    renderBacktest(rows, g, conf);
    refreshFinetunePanel();
    refreshTrainTab();
  }

  /** 回测列表顶部的筛选：全部 / 只看有错的 */
  function refreshBacktestFilter(rows) {
    var el = $('btFilter');
    if (!el) return;
    var total = rows.length;
    var bad = rows.filter(function (r) { return r.wrong > 0; }).length;
    el.innerHTML =
      '<button class="chip' + (backtestOnlyWrong ? '' : ' on') + '" data-only="0">' +
      '全部 <b>' + total + '</b></button>' +
      '<button class="chip' + (backtestOnlyWrong ? ' on' : '') + '" data-only="1">' +
      '只看有错的 <b>' + bad + '</b></button>';
    Array.prototype.forEach.call(el.querySelectorAll('.chip'), function (b) {
      b.addEventListener('click', function () {
        backtestOnlyWrong = b.dataset.only === '1';
        renderBacktest(backtestRows, backtestGroups, backtestConf);
      });
    });
  }

  function renderBacktest(rows, g, conf) {
    rows.sort(function (a, b) { return b.wrong - a.wrong || b.wrongNE - a.wrongNE; });
    refreshBacktestFilter(rows);

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
      '<div class="statline"><span>回测范围</span><b>' + rows.length + ' 张已标注图</b></div>' +
      '<div class="mt8 tiny"><span class="' + vclass + '">' + verdict + '</span></div>' +
      (conf ? matrixHtml(conf) : '');

    var shown = rows.filter(function (r) { return !backtestOnlyWrong || r.wrong > 0; });
    $('backtestList').innerHTML = shown.map(function (r) {
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
  }

  $('btnBacktest').addEventListener('click', function () { runBacktest(); });

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
        var rec = await saveModelToDb(autoModelName(), { desc: currentMeta });
        await pruneModels();
        await refreshSavedModels();
        // 刚存的那个不一定在 [0]（同分钟内可能有更新的），按名字找回来
        var justSaved = null;
        for (var mi = 0; mi < savedModels.length; mi++) {
          if (savedModels[mi].name === rec.name) { justSaved = savedModels[mi]; break; }
        }
        var verdict = guardPromotion(justSaved || savedModels[0]);
        if (verdict.action === 'promote') {
          log('已自动保存本次训练结果，并设为首选');
        } else if (verdict.action === 'block') {
          toast('新模型比旧模型差，已保留旧模型为首选', 3600);
        }

        // 熔断计数：没提升就累加，提升了就清零
        if (verdict.action === 'promote' && verdict.best > verdict.prev) {
          markTrainedNow();
        } else {
          bumpFailStreak(failStreak() + 1);
          var P2 = Evolve.loadParams();
          if (failStreak() >= P2.maxFailStreak) {
            pushEvLog('已连续 ' + failStreak() + ' 次没有提升，自动训练暂停');
            toast('连续 ' + failStreak() + ' 次没提升，自动训练已暂停', 4200);
          }
        }
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

  // ---------------------------------------------------------------- 纠错微调
  //
  // 解决的是这样一个循环：回测发现模型错了几格 → 改对 → 但重新从头训练后
  // 那几格的改动被 2691 个训练样本稀释掉，等于没改。
  //
  // 这里做三件事：
  //   1. 以现有模型为起点（不从头学），学习率调低
  //   2. 人工修正过的格子加权，让梯度里看得见
  //   3. 从旧数据里回放一批，防止「改对了 A、B 全忘了」

  /** 只把权重读出来，不动全局 model */
  async function loadModelWeights(rec) {
    var m = await tf.loadLayersModel(tf.io.fromMemory({
      modelTopology: rec.modelTopology,
      weightSpecs: rec.weightSpecs,
      weightData: rec.weightData
    }));
    return m;
  }

  function refreshFinetunePanel() {
    var sel = $('ftBase');
    if (!sel) return;
    var prev = sel.value;
    sel.innerHTML = savedModels.map(function (m, i) {
      var d = m.meta || {};
      return '<option value="' + i + '">' + escapeHtml(m.name) +
        (d.desc ? '（' + escapeHtml(d.desc) + '）' : '') + '</option>';
    }).join('');
    if (prev && sel.querySelector('option[value="' + prev + '"]')) sel.value = prev;

    // 统计有多少修正样本可用
    var u = usable();
    var nFix = 0, imgsWithFix = 0;
    u.forEach(function (s) {
      var c = fixedCount(s);
      if (c) { nFix += c; imgsWithFix++; }
    });

    var el = $('ftSummary');
    if (!savedModels.length) {
      el.innerHTML = '还没有可用的起点模型 —— 先在下面「开始训练」跑一次。';
      $('btnFinetune').disabled = true;
    } else if (!nFix) {
      el.innerHTML = '还没有人工修正的格子。<br>' +
        '到「训练 → 逐图回测」跑一遍，再回到「标注」页点「对比模型」，' +
        '把模型判错的格子改对 —— 那些改动会被记下来，这里就能用。';
      $('btnFinetune').disabled = true;
    } else {
      el.innerHTML = '待学习的修正：<b style="color:#7b5cff">' + nFix +
        '</b> 格，分布在 <b>' + imgsWithFix + '</b> 张图上。<br>' +
        '<span class="muted">这些格子会在训练中被加权，其余数据按「回放比例」混入，' +
        '避免把已经学会的东西忘掉。</span>';
      $('btnFinetune').disabled = false;
    }
  }

  $('btnFinetune').addEventListener('click', async function () {
    if (!trainX || !trainFixed) { toast('先在下面「构建数据集」'); return; }
    var fixIdx = [];
    for (var i = 0; i < trainFixed.length; i++) if (trainFixed[i]) fixIdx.push(i);
    if (!fixIdx.length) { toast('还没有人工修正的格子'); return; }

    var rec = savedModels[parseInt($('ftBase').value, 10)];
    if (!rec) { toast('请选择起点模型'); return; }

    // 起点模型的输入尺寸必须和当前一致，否则权重对不上
    if (rec.size !== inSize) {
      toast('起点模型的输入是 ' + rec.size + '×' + rec.size +
            '，当前数据集是 ' + inSize + '×' + inSize +
            '。请把「输入尺寸」改回 ' + rec.size + ' 再构建数据集。', 5200);
      return;
    }

    // 微调面板上的值优先（可临时调），但它默认来自全局参数 ——
    // 这样"自动循环"跑的时候用的是参数里的设置，而不是面板上的陈旧值
    var fixW = clamp(parseInt($('ftWeight').value, 10) || 6, 1, 50);
    var replayPct = clamp(parseInt($('ftReplay').value, 10) || 0, 0, 100);
    var epochs = clamp(parseInt($('ftEpochs').value, 10) || 12, 1, 100);
    var lr = clamp(parseInt($('ftLr').value, 10) || 1, 1, 100) * 1e-4;
    Evolve.setParam('fixWeight', fixW);
    Evolve.setParam('replayPct', replayPct);
    var headOnly = $('ftHeadOnly').checked;

    $('btnFinetune').disabled = true;
    $('ftCompare').innerHTML = '';
    if (native()) native().keepAwake(true);

    try {
      // ---- 1) 组装训练子集：修正样本 + 回放 ----
      var order = fixIdx.slice();
      var rest = [];
      for (var r2 = 0; r2 < trainFixed.length; r2++) {
        if (!trainFixed[r2]) rest.push(r2);
      }
      // 打乱后按比例抽回放样本
      for (var q = rest.length - 1; q > 0; q--) {
        var j = Math.floor(Math.random() * (q + 1));
        var t = rest[q]; rest[q] = rest[j]; rest[j] = t;
      }
      var nReplay = Math.round(rest.length * replayPct / 100);
      var replay = rest.slice(0, nReplay);

      var weights = new Float32Array(trainFixed.length);
      order.forEach(function (ix) { weights[ix] = fixW; });
      replay.forEach(function (ix) { weights[ix] = 1; });

      var trainOrder = order.concat(replay);
      // 整体打乱，避免「先全是修正、后全是回放」影响每轮的批内分布
      for (var z = trainOrder.length - 1; z > 0; z--) {
        var k = Math.floor(Math.random() * (z + 1));
        var tmp = trainOrder[z]; trainOrder[z] = trainOrder[k]; trainOrder[k] = tmp;
      }

      log('纠错微调：修正 ' + order.length + ' 格（权重 ×' + fixW + '） + 回放 ' +
          replay.length + ' 格 · ' + epochs + ' 轮 · lr ' + lr.toExponential(0) +
          (headOnly ? ' · 只训最后一层' : ''));

      // ---- 2) 以现有模型为起点 ----
      var base = await loadModelWeights(rec);
      var fresh = buildModel(inSize);
      var bw = base.getWeights();
      var fw = fresh.getWeights();
      if (bw.length !== fw.length) {
        base.dispose(); fresh.dispose();
        toast('起点模型的层结构与当前不匹配，无法继续训。请重新训练一个。', 4600);
        return;
      }
      for (var g = 0; g < bw.length; g++) {
        var shapeA = bw[g].shape.join(',');
        var shapeB = fw[g].shape.join(',');
        if (shapeA !== shapeB) {
          base.dispose(); fresh.dispose();
          toast('起点模型的权重形状不一致（' + shapeA + ' vs ' + shapeB + '）', 4600);
          return;
        }
      }
      fresh.setWeights(bw);
      base.dispose();
      log('已载入起点模型「' + rec.name + '」的权重');

      // ---- 3) 只训最后一层：冻结前面全部 ----
      if (headOnly) {
        fresh.layers.forEach(function (l, i) {
          l.trainable = (i === fresh.layers.length - 1);
        });
      }

      var opt = tf.train.adam(lr);
      // 显式收集可训练变量。
      // 光设 layer.trainable 不够保险 —— optimizer 默认走 tf.trainableVariables()，
      // 而这套全局收集在动态改 trainable 后不一定立刻反映。直接给列表最稳。
      var trainVars = [];
      fresh.layers.forEach(function (l) {
        if (l.trainable === false) return;
        l.trainableWeights.forEach(function (w) { trainVars.push(w.val); });
      });
      fresh.compile({ optimizer: opt, loss: 'meanSquaredError' });
      log('本次参与更新的参数：' + trainVars.reduce(function (a, v) { return a + v.size; }, 0) +
          (headOnly ? '（仅输出层）' : '（全部）'));

      // ---- 4) 训练：加权损失 ----
      var oldModel = model;          // 留着做前后对比
      model = fresh;
      var batchSize = clamp(parseInt($('pBatch').value, 10) || 64, 8, 512);
      var t0 = performance.now();
      var lossHist = [], valHist = [];

      for (var ep = 0; ep < epochs; ep++) {
        // 每轮重新打乱
        for (var y = trainOrder.length - 1; y > 0; y--) {
          var m2 = Math.floor(Math.random() * (y + 1));
          var tm = trainOrder[y]; trainOrder[y] = trainOrder[m2]; trainOrder[m2] = tm;
        }
        var epStart = performance.now();
        var lossSum = 0, nb = 0;

        for (var b = 0; b < trainOrder.length; b += batchSize) {
          var to = Math.min(trainOrder.length, b + batchSize);
          var bt = makeBatch(trainOrder, b, to, inSize, weights);
          var lv = opt.minimize(function () {
            var logits = model.apply(bt.xs, { training: true });
            // 逐样本损失再按权重平均 —— 这是「让模型重点学我改过的地方」
            // 的实现方式。注意必须显式传 Reduction.NONE：
            // softmaxCrossEntropy 默认会直接归约成标量，那样就没法逐样本加权了。
            var perSample = tf.losses.softmaxCrossEntropy(
              bt.ys, logits, undefined, 0, tf.Reduction.NONE
            );
            return perSample.mul(bt.w).mean();
          }, true, trainVars);
          lossSum += lv.dataSync()[0];
          lv.dispose();
          bt.xs.dispose(); bt.ys.dispose();
          if (bt.w) bt.w.dispose();
          nb++;
        }

        var epMs = performance.now() - epStart;
        var vAcc = await quickValAcc();
        lossHist.push(lossSum / Math.max(1, nb));
        valHist.push(vAcc);
        var el = (performance.now() - t0) / 1000;
        var remain = (epochs - ep - 1) * (el / (ep + 1));

        $('ftProg').style.width = ((ep + 1) / epochs * 100) + '%';
        $('ftStat').innerHTML = '第 ' + (ep + 1) + '/' + epochs + ' 轮 · loss <b>' +
          fmt(lossSum / Math.max(1, nb), 4) + '</b> · 验证 <b>' +
          fmt(vAcc * 100, 1) + '%</b><br><span class="muted">已用 ' +
          fmt(el, 0) + 's' + (remain > 1 ? ' · 预计还需 ' + fmt(remain, 0) + 's' : '') + '</span>';
        if (ep % 2 === 1) await yieldTick();
      }

      var total = (performance.now() - t0) / 1000;

      // ---- 5) 前后对比：修正的格子现在学对了没有 ----
      var before = 0, after = 0;
      var bt2 = makeBatch(fixIdx, 0, fixIdx.length, inSize, null);
      function argmaxAll(m) {
        var t = tf.tidy(function () {
          return tf.argMax(m.apply(bt2.xs, { training: false }), -1);
        });
        var d = t.dataSync();
        t.dispose();
        return d;
      }
      var predsAfter = argmaxAll(model);
      var predsBefore = oldModel ? argmaxAll(oldModel) : null;
      var truth = [];
      for (var fi2 = 0; fi2 < fixIdx.length; fi2++) {
        var row = trainY.subarray(fixIdx[fi2] * NC, fixIdx[fi2] * NC + NC);
        var best = 0;
        for (var cc = 1; cc < NC; cc++) if (row[cc] > row[best]) best = cc;
        truth.push(best);
        if (predsBefore && predsBefore[fi2] === best) before++;
        if (predsAfter[fi2] === best) after++;
      }
      bt2.xs.dispose(); if (bt2.ys) bt2.ys.dispose();

      // ---- 6) 保留旧模型，方便对比后决定留不留 ----
      var stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 13);
      // desc 里带上验证准确率 —— 首页要显示它，格式与训练保存的保持一致
      await saveModelToDb('微调-' + stamp, {
        desc: '修正 ' + fixIdx.length + ' 格 · ' + epochs + ' 轮 · lr ' +
              lr.toExponential(0) + (headOnly ? ' · 仅输出层' : '') +
              ' · 验证集 ' + fmt(valHist[valHist.length - 1] * 100, 1) + '%'
      });
      await pruneModels();
      await refreshSavedModels();

      $('ftStat').innerHTML += '<br><span class="muted">完成，共 ' + fmt(total, 0) + 's</span>';
      $('ftCompare').innerHTML =
        '<div class="statline"><span>修正的 ' + fixIdx.length + ' 格，现在学对了</span>' +
        '<b class="big">' + after + '/' + fixIdx.length + '</b></div>' +
        (predsBefore
          ? '<div class="statline"><span>微调前就对了</span><b>' + before + '/' + fixIdx.length + '</b></div>'
          : '') +
        '<div class="statline"><span>验证集准确率</span><b>' + fmt(valHist[valHist.length - 1] * 100, 2) + '%</b></div>' +
        '<div class="statline"><span>耗时</span><b>' + fmt(total, 0) + 's</b></div>';

      log('微调完成：修正 ' + fixIdx.length + ' 格中，学对 ' + after + ' 格' +
          (predsBefore ? '（微调前 ' + before + ' 格）' : '') +
          ' · 验证 ' + fmt(valHist[valHist.length - 1] * 100, 2) + '%');

      /*
       * 学完就把修正标记清掉。
       *
       * fixed 的语义是「改了但还没学」—— 是个待办，不是历史台账。
       * 不清的话首页会永远挂着一句「修正 N 处判错」，
       * 用户明明已经处理完了却不知道还能做什么。
       */
      var cleared = 0;
      samples.forEach(function (sm) {
        if (!sm.fixed) return;
        for (var i = 0; i < CELLS; i++) {
          if (sm.fixed[i]) { sm.fixed[i] = 0; cleared++; }
        }
        // 跳过记录也一并清掉：这轮已经学完了，下一轮该重新看一遍
        if (sm.skip) for (var j = 0; j < CELLS; j++) sm.skip[j] = 0;
        // 「机器改过」表示"有待验证的自动修改"；已经学进模型，这个状态就结束了
        sm.autoTouched = false;
      });
      if (cleared) {
        await Promise.all(samples.map(function (sm) { return dbPut(toRecord(sm)); }));
        log('已重置 ' + cleared + ' 处待学标记（它们已经学进模型了）');
      }

      drawLossCurve(lossHist, valHist);
      $('resultCard').hidden = false;
      renderStats();
      renderSamples();
      refreshFinetunePanel();
      renderHome();
      toast('微调完成：' + after + '/' + fixIdx.length + ' 格学对。'
            + '待学清单已重置，下次核对会重新列出模型的判错。', 4200);
    } catch (e) {
      log('微调失败：' + e.message);
      toast('微调失败：' + e.message);
    }

    if (native()) native().keepAwake(false);
    $('btnFinetune').disabled = false;
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
    /** 导出重建出的棋盘底，供自动化核对用 */
    cleanBoard: async function () {
      var s = currentSample();
      if (!s || !s.lattice) return null;
      var img = await imageOf(s);
      var lat = {
        x0: s.lattice.x0 * s.w, y0: s.lattice.y0 * s.h,
        dx: s.lattice.dx * s.w, dy: s.lattice.dy * s.h
      };
      var clean = makeCleanBoard(img, lat, s.cells, s.pins);
      return { dataUrl: clean.toDataURL('image/png'), margin: clean.__margin,
               dbg: clean.__dbg,
               w: clean.width, h: clean.height, conf: s.conf,
               lattice: s.lattice, cells: s.cells };
    },
    /** 直接触发回测，供自动化核对用 */
    backtest: function () { return runBacktest(); },
    /** 采集：刷新界面 / 触发候选导入，供自动化核对用 */
    refreshCapture: function () { refreshCapture(); return true; },
    importCandidates: function () {
      var btn = $('btnCandImport');
      if (btn) btn.click();
      return true;
    },
    /** 自进化：手动触发一轮检查，供自动化核对用 */
    readiness: function () { return autoReadiness(); },
    pendingFixes: function () { return pendingFixCount(); },
    /** 制造若干修正标记，供自动化核对触发逻辑用 */
    forceFixes: function (n) {
      var left = n;
      for (var i = 0; i < samples.length && left > 0; i++) {
        var sm = samples[i];
        if (!sm.cells) continue;
        sm.fixed = sm.fixed || new Array(CELLS).fill(0);
        for (var j = 0; j < CELLS && left > 0; j++) {
          if (!sm.cells[j]) continue;
          if (sm.fixed[j]) continue;
          sm.fixed[j] = 1;
          left--;
        }
      }
      return n - left;
    },
    /** 自进化：手动触发体检 / 自动修，供自动化核对用 */
    scan: function () {
      try {
        var r = scanSamples();
        return { ok: true, result: r, rows: document.querySelectorAll('#scanList .scanrow').length };
      } catch (e) {
        return { ok: false, error: e.message, stack: (e.stack || '').split('\n').slice(0, 3) };
      }
    },
    policy: function () { return Evolve.loadPolicy(); },
    setTier: function (k, t) { return Evolve.setTier(k, t); },
    evLog: function () { return evLog.slice(0, 10); },
    /** 导航，供自动化核对用 */
    go: function (name) { go(name); return currentScreen; },
    screen: function () { return currentScreen; },
    /** 首页待办列表，供自动化核对用 */
    todos: function () {
      // 只返回真正的待办（.done 那个是模型卡片，属于成果展示）
      return Array.prototype.filter.call(
        document.querySelectorAll('#todoList .todo'),
        function (t) { return !t.classList.contains('done'); }
      ).map(function (t) { return t.querySelector('b').textContent; });
    },
    /** 纠错闭环的内部状态，供自动化核对用 */
    ft: function () {
      var s = currentSample();
      var nFix = 0, nAuto = 0;
      samples.forEach(function (x) {
        if (x.fixed) for (var i = 0; i < CELLS; i++) if (x.fixed[i]) nFix++;
        if (x.auto) for (var j = 0; j < CELLS; j++) if (x.auto[j]) nAuto++;
      });
      return {
        hasModel: !!model,
        modelParams: model && model.countParams ? model.countParams() : 0,
        inSize: inSize,
        backtestCount: Object.keys(backtest).length,
        showPred: showPred,
        lastPredIsSet: !!lastPred,
        trainSamples: trainX ? trainX.length / (inSize * inSize * 3) : 0,
        trainFixedCount: trainFixed ? trainFixed.reduce(function (a, v) { return a + v; }, 0) : 0,
        savedModels: savedModels.length,
        currentFixed: s && s.fixed ? s.fixed.reduce(function (a, v) { return a + v; }, 0) : 0,
        samplesWithFix: samples.filter(function (x) {
          return x.fixed && x.fixed.some(function (v) { return v; });
        }).length,
        totalFixed: nFix,
        totalAuto: nAuto
      };
    },
    /**
     * 模拟人工核对：当前 s.cells 就是真值，把与模型预测不同的格子标成「修正」。
     * 语义上等价于"用户看了模型预测，不同意，把这几格改成对的"。
     */
    applyTruth: function () {
      var s = currentSample();
      if (!s || !s.lattice || !lastPred) return -1;
      s.cells = s.cells || new Array(CELLS).fill(0);
      s.fixed = s.fixed || new Array(CELLS).fill(0);
      var n = 0;
      for (var i = 0; i < CELLS; i++) {
        s.fixed[i] = (s.cells[i] === lastPred[i]) ? 0 : 1;
        if (s.fixed[i]) n++;
      }
      queueSave(s);
      renderStage();
      renderSamples();
      return n;
    },
    /** 标注数据，供自动化核对用 */
    cells: function () {
      var s = currentSample();
      return s ? {
        cells: s.cells ? Array.from(s.cells) : null,
        auto: s.auto ? Array.from(s.auto) : null,
        fixed: s.fixed ? Array.from(s.fixed) : null,
        skip: s.skip ? Array.from(s.skip) : null,
        pred: lastPred ? Array.from(lastPred) : null
      } : null;
    },
    /** 测试用：模拟点一下某一格（走真实的命中与落子路径） */
    tapCell: function (idx) {
      var s = currentSample();
      if (!s || !s.lattice) return -1;
      var r = Math.floor(idx / COLS), c = idx % COLS;
      var IW = view.imgW, IH = view.imgH;
      var S = view.fit * view.zoom;
      var cx = (s.lattice.x0 + c * s.lattice.dx) * IW * S + view.panX;
      var cy = (s.lattice.y0 + r * s.lattice.dy) * IH * S + view.panY;
      return paintAt(toImage({ x: cx, y: cy }));
    },
    /** 测试用：直接调用 toggleFixTarget */
    toggleFix: function (idx) {
      var s = currentSample();
      if (!s) return -1;
      toggleFixTarget(s, idx);
      return s.fixed[idx];
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
    refreshSavedModels();
    renderStats();
    renderSamples();
    refreshTrainTab();
    refreshFinetunePanel();
    renderAbout();
    refreshCollect();
    refreshCapture();
    loadEvLog();
    renderPolicy();
    renderParamPanel();
    bindIdleWatch();
    startAutoTick();
    renderHome();
    go('home');

    window.addEventListener('resize', function () {
      if (currentScreen === 'annotate') renderStage();
    });
  }

  boot();
})();
