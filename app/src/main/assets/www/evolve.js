/* 自进化：象棋规则校验 + 按动作授权的策略
 *
 * 这里做两件事：
 *
 * 1. **规则校验** —— 用象棋本身的硬规则去检查一份标注是否自洽。
 *    棋子总数、帅仕相的位置限制、将帅照面…… 这些违反了的局面在真实对局里
 *    根本不可能出现，所以一旦违反，几乎必然是标注错了。
 *    这是「自动发现错误」唯一可靠的来源：不需要人告诉答案，机器自己知道。
 *
 * 2. **按动作授权** —— 不同动作的风险差得远，用一个总开关会让该保守的地方
 *    也变得激进。所以按动作分别设档：只建议 / 半自动 / 全自动。
 *
 * 唯一不给开关的红线：验证集永远不参与自动修改（见 studio.js 的 usableForAuto）。
 */
(function (root) {
  'use strict';

  var COLS = 9, ROWS = 10, CELLS = 90;

  // 类别索引，必须与 studio.js 的 CLASSES 顺序一致
  var EMPTY = 0;
  var R_GENERAL = 1, R_ADVISOR = 2, R_ELEPHANT = 3, R_HORSE = 4;
  var R_CHARIOT = 5, R_CANNON = 6, R_SOLDIER = 7;
  var B_GENERAL = 8, B_ADVISOR = 9, B_ELEPHANT = 10, B_HORSE = 11;
  var B_CHARIOT = 12, B_CANNON = 13, B_SOLDIER = 14;
  var DARK = 15;

  var NAME = {};
  NAME[R_GENERAL] = '红帅'; NAME[R_ADVISOR] = '红仕'; NAME[R_ELEPHANT] = '红相';
  NAME[R_HORSE] = '红马'; NAME[R_CHARIOT] = '红车'; NAME[R_CANNON] = '红炮';
  NAME[R_SOLDIER] = '红兵';
  NAME[B_GENERAL] = '黑将'; NAME[B_ADVISOR] = '黑士'; NAME[B_ELEPHANT] = '黑象';
  NAME[B_HORSE] = '黑马'; NAME[B_CHARIOT] = '黑车'; NAME[B_CANNON] = '黑炮';
  NAME[B_SOLDIER] = '黑卒'; NAME[DARK] = '暗子';

  /** 每方各子的数量上限（象棋是定编的） */
  var LIMIT = {};
  LIMIT[R_GENERAL] = 1; LIMIT[R_ADVISOR] = 2; LIMIT[R_ELEPHANT] = 2;
  LIMIT[R_HORSE] = 2; LIMIT[R_CHARIOT] = 2; LIMIT[R_CANNON] = 2; LIMIT[R_SOLDIER] = 5;
  LIMIT[B_GENERAL] = 1; LIMIT[B_ADVISOR] = 2; LIMIT[B_ELEPHANT] = 2;
  LIMIT[B_HORSE] = 2; LIMIT[B_CHARIOT] = 2; LIMIT[B_CANNON] = 2; LIMIT[B_SOLDIER] = 5;

  function isRed(v) { return v >= 1 && v <= 7; }
  function isBlack(v) { return v >= 8 && v <= 14; }

  function inRedPalace(r, c) { return r >= 7 && r <= 9 && c >= 3 && c <= 5; }
  function inBlackPalace(r, c) { return r >= 0 && r <= 2 && c >= 3 && c <= 5; }

  function posText(r, c) { return '第' + (r + 1) + '行第' + (c + 1) + '列'; }

  /**
   * 判断棋盘朝向。
   *
   * 标准摆法是红方在下（红帅在 7~9 行）。如果识别出来是反的，
   * 后面的位置校验必须先把坐标翻过来，否则会把正常的局面判成违规。
   */
  function detectFlipped(cells) {
    var rg = -1, bg = -1;
    for (var i = 0; i < CELLS; i++) {
      if (cells[i] === R_GENERAL) rg = Math.floor(i / COLS);
      if (cells[i] === B_GENERAL) bg = Math.floor(i / COLS);
    }
    if (rg >= 0 && bg >= 0) return rg < bg;   // 红帅在上 = 翻转了
    if (rg >= 0) return rg < 5;
    if (bg >= 0) return bg > 4;
    return false;
  }

  /** 把「翻转棋盘」的坐标翻回标准摆法 */
  function normalize(cells) {
    var flipped = detectFlipped(cells);
    if (!flipped) return { cells: cells, flipped: false };
    var out = new Array(CELLS).fill(0);
    for (var i = 0; i < CELLS; i++) {
      var r = Math.floor(i / COLS), c = i % COLS;
      out[(ROWS - 1 - r) * COLS + c] = cells[i];
    }
    return { cells: out, flipped: true };
  }

  /**
   * 单帧规则校验。
   *
   * 只做「一帧之内就能判定」的检查 —— 不需要历史局面，所以在标注场景也适用。
   * 需要前后两帧的走法合法性（马走日之类）不在这里做。
   *
   * @returns {Array<{level, msg, cells:number[]}>}
   */
  function validate(rawCells) {
    var issues = [];
    var n = normalize(rawCells);
    var cells = n.cells;

    // ---- 1) 各子数量不得超过定编 ----
    var count = {};
    for (var i = 0; i < CELLS; i++) {
      if (!cells[i]) continue;
      count[cells[i]] = (count[cells[i]] || 0) + 1;
    }
    Object.keys(LIMIT).forEach(function (k) {
      var v = +k;
      var c = count[v] || 0;
      if (c > LIMIT[v]) {
        issues.push({
          level: 'error', cells: [],
          msg: (NAME[v] || v) + ' 有 ' + c + ' 个，象棋里最多 ' + LIMIT[v] + ' 个'
        });
      }
    });

    // ---- 2) 位置限制 ----
    for (i = 0; i < CELLS; i++) {
      var val = cells[i];
      if (!val) continue;
      var r = Math.floor(i / COLS), c = i % COLS;
      var bad = null;

      if (val === R_GENERAL && !inRedPalace(r, c)) bad = '红帅跑到九宫外了';
      else if (val === B_GENERAL && !inBlackPalace(r, c)) bad = '黑将跑到九宫外了';
      else if (val === R_ADVISOR && !inRedPalace(r, c)) bad = '红仕跑到九宫外了';
      else if (val === B_ADVISOR && !inBlackPalace(r, c)) bad = '黑士跑到九宫外了';
      else if (val === R_ELEPHANT && r < 5) bad = '红相过河了';
      else if (val === B_ELEPHANT && r > 4) bad = '黑象过河了';
      // 兵只能向前：红兵起始在第 7 行，走不到第 8、9 行
      else if (val === R_SOLDIER && r > 6) bad = '红兵退到起始线之后了';
      else if (val === B_SOLDIER && r < 3) bad = '黑卒退到起始线之前了';

      if (bad) {
        issues.push({
          level: 'error', cells: [i],
          msg: bad + '（' + posText(r, c) + '）'
        });
      }
    }

    // ---- 3) 将帅照面 ----
    var rg = -1, bg = -1;
    for (i = 0; i < CELLS; i++) {
      if (cells[i] === R_GENERAL) rg = i;
      if (cells[i] === B_GENERAL) bg = i;
    }
    if (rg >= 0 && bg >= 0 && (rg % COLS) === (bg % COLS)) {
      var lo = Math.min(rg, bg) + COLS, hi = Math.max(rg, bg);
      var blocked = false;
      for (var k = lo; k < hi; k += COLS) {
        if (cells[k]) { blocked = true; break; }
      }
      if (!blocked) {
        issues.push({
          level: 'error', cells: [rg, bg],
          msg: '将帅照面（同一列且中间无子）'
        });
      }
    }

    // ---- 4) 暗子数量（揭棋上限：双方各 16 子）----
    var darkN = count[DARK] || 0;
    if (darkN > 32) {
      issues.push({ level: 'error', cells: [], msg: '暗子 ' + darkN + ' 个，超过棋盘总子数' });
    }

    return issues;
  }

  /**
   * 可疑度评分。0 = 没发现问题，越大越可疑。
   *
   * 三个信号按可靠程度加权：
   *   违反棋规      —— 最硬，几乎必然是标注错
   *   与模型不一致  —— 中等，可能是标注错也可能是模型错
   *   置信度低      —— 最弱，只是提示
   */
  function anomaly(rawCells, opts) {
    opts = opts || {};
    var score = 0;
    var reasons = [];

    var issues = validate(rawCells);
    var errs = 0;
    for (var i = 0; i < issues.length; i++) if (issues[i].level === 'error') errs++;
    if (errs) {
      score += 100 * errs;
      reasons.push(errs + ' 处违反棋规');
    }

    if (opts.pred) {
      var pred = opts.pred;
      var diffNE = 0;
      for (var j = 0; j < CELLS; j++) {
        if (pred[j] !== rawCells[j] && rawCells[j] !== EMPTY) diffNE++;
      }
      if (diffNE) {
        score += 12 * diffNE;
        reasons.push(diffNE + ' 格与模型不一致');
      }
    }

    if (opts.confidence) {
      var low = 0;
      for (var k = 0; k < CELLS; k++) {
        if (opts.confidence[k] < 0.6) low++;
      }
      if (low >= 5) {
        score += 2 * low;
        reasons.push(low + ' 格模型没把握');
      }
    }

    return { score: score, reasons: reasons, issues: issues };
  }

  // ---------------------------------------------------------------- 策略

  /**
   * 可以授权的动作。风险不同，默认档位也不同 ——
   * 低风险的默认自动，高风险的默认只建议。
   */
  var ACTIONS = [
    { key: 'collect', label: '采集可疑样本', risk: 'low',
      hint: '把规则校验发现问题的样本标记出来待复核', def: 2 },
    { key: 'train', label: '自动触发训练', risk: 'medium',
      hint: '攒够新的修正后自动跑一次，不用手工点', def: 1 },
    { key: 'fixLabel', label: '自动修改标注', risk: 'high',
      hint: '把「只违反棋规、且模型也不认同」的格子直接改掉', def: 0 },
    { key: 'promote', label: '自动替换模型', risk: 'high',
      hint: '新模型在验证集上更好就自动换掉旧的', def: 0 }
  ];

  var TIERS = [
    { v: 0, label: '只建议', desc: '只提示，不自己动手' },
    { v: 1, label: '半自动', desc: '满足硬条件才自动，否则问你' },
    { v: 2, label: '全自动', desc: '不打断你，直接做' }
  ];

  var STORE_KEY = 'evolve.policy.v1';

  var policy = null;

  function defaults() {
    var p = {};
    ACTIONS.forEach(function (a) { p[a.key] = a.def; });
    return p;
  }

  function loadPolicy() {
    if (policy) return policy;
    policy = defaults();
    try {
      var raw = localStorage.getItem(STORE_KEY);
      if (raw) {
        var saved = JSON.parse(raw);
        // 只接受已知的键，避免旧版本残留的脏数据影响判断
        ACTIONS.forEach(function (a) {
          if (typeof saved[a.key] === 'number' && saved[a.key] >= 0 && saved[a.key] <= 2) {
            policy[a.key] = saved[a.key];
          }
        });
      }
    } catch (e) {
      /* 读不出来就用默认值，不影响使用 */
    }
    return policy;
  }

  function setTier(key, tier) {
    var p = loadPolicy();
    p[key] = Math.max(0, Math.min(2, tier | 0));
    try { localStorage.setItem(STORE_KEY, JSON.stringify(p)); } catch (e) { }
    return p[key];
  }

  function tierOf(key) { return loadPolicy()[key]; }

  /** 某个动作是否达到「至少半自动」 */
  function isAuto(key) { return tierOf(key) >= 1; }
  /** 是否全自动（不打断用户） */
  function isFullAuto(key) { return tierOf(key) >= 2; }

  var api = {
    COLS: COLS, ROWS: ROWS, CELLS: CELLS,
    NAME: NAME, LIMIT: LIMIT,
    isRed: isRed, isBlack: isBlack,
    detectFlipped: detectFlipped,
    normalize: normalize,
    validate: validate,
    anomaly: anomaly,
    ACTIONS: ACTIONS,
    TIERS: TIERS,
    loadPolicy: loadPolicy,
    setTier: setTier,
    tierOf: tierOf,
    isAuto: isAuto,
    isFullAuto: isFullAuto
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.Evolve = api;
})(typeof window !== 'undefined' ? window : globalThis);
