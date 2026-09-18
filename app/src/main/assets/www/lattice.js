/* 棋盘晶格拟合
 *
 * 输入：一张截图（灰度）+ 用户粗略框出的棋盘范围。
 * 输出：9 条竖线 / 10 条横线的精确像素坐标 —— 也就是 9×10 个交叉点。
 *
 * 做法是 1D 的一维投影拟合，不是检测框。原因：检测框给出的棋盘边界每边能差
 * 半格到一格，边路的棋子会切到隔壁列。木纹棋盘上格子线是稳定的深色细线，
 * 沿一整行/一整列求平均后它们会露出来，而棋子的深色质量恰好落在交叉点上，
 * 是加强信号而不是干扰。
 *
 * 每根轴独立做：先做 (起点, 间距) 的粗搜索，再用线性插值做局部精修到亚像素。
 */
(function (root) {
  'use strict';

  var COLS = 9;
  var ROWS = 10;

  /** 沿 x 方向求列投影：每个 x 上，一定 y 范围内的平均暗度。 */
  function columnProfile(gray, W, H, x0, x1, y0, y1) {
    var n = x1 - x0 + 1;
    var P = new Float64Array(n);
    var top = Math.round(y0 + (y1 - y0) * 0.10);
    var bot = Math.round(y0 + (y1 - y0) * 0.90);
    for (var x = x0; x <= x1; x++) {
      var s = 0, c = 0;
      for (var y = top; y <= bot; y += 2) {
        s += 255 - gray[y * W + x];
        c++;
      }
      P[x - x0] = c ? s / c : 0;
    }
    return P;
  }

  /** 沿 y 方向求行投影。 */
  function rowProfile(gray, W, H, x0, x1, y0, y1) {
    var n = y1 - y0 + 1;
    var P = new Float64Array(n);
    var left = Math.round(x0 + (x1 - x0) * 0.10);
    var right = Math.round(x0 + (x1 - x0) * 0.90);
    for (var y = y0; y <= y1; y++) {
      var s = 0, c = 0;
      for (var x = left; x <= right; x += 2) {
        s += 255 - gray[y * W + x];
        c++;
      }
      P[y - y0] = c ? s / c : 0;
    }
    return P;
  }

  /** 去掉低频趋势（木纹明暗、光照渐变），只留细线的高频成分。 */
  function detrend(P, win) {
    var n = P.length;
    var half = Math.max(1, Math.round(win / 2));
    var out = new Float64Array(n);
    for (var i = 0; i < n; i++) {
      var a = Math.max(0, i - half), b = Math.min(n - 1, i + half);
      var s = 0;
      for (var j = a; j <= b; j++) s += P[j];
      out[i] = P[i] - s / (b - a + 1);
    }
    return out;
  }

  function sampleLinear(P, pos) {
    if (pos <= 0 || pos >= P.length - 1) return 0;
    var i = Math.floor(pos);
    var t = pos - i;
    return P[i] * (1 - t) + P[i + 1] * t;
  }

  /** (起点, 间距) 的评分：把所有线位置上的暗度加起来，越深越好。 */
  function score(P, start, spacing, count) {
    var s = 0;
    for (var k = 0; k < count; k++) s += sampleLinear(P, start + k * spacing);
    return s / count;
  }

  /**
   * 拟合单根轴。
   *
   * 关键约束：**整段跨度必须接近用户框选的宽度**。
   * 否则会出现退化解 —— 9 条线挤进一小块深色区域时，平均暗度反而更高，
   * 于是拟合出一组毫无意义的密集线（实测框选偏小 12% 就会塌缩成 0.67 倍间距）。
   *
   * @param {Float64Array} P 去趋势后的投影
   * @param {number} count 线的条数
   * @param {number} roughSpan 期望跨度（用户框选的长度），像素
   */
  function fitAxis(P, count, roughSpan) {
    var n = P.length;
    var spanLo = roughSpan * 0.70;
    var spanHi = roughSpan * 1.30;
    var best = { start: 0.5, spacing: spanLo / (count - 1), score: -Infinity };

    // --- 粗搜索：(跨度, 起点) ---
    var spanSteps = 160;
    for (var si = 0; si <= spanSteps; si++) {
      var span = spanLo + (spanHi - spanLo) * (si / spanSteps);
      var sp = span / (count - 1);
      var maxStart = n - 1.5 - span;
      if (maxStart < 0.5) continue;
      for (var st = 0.5; st <= maxStart; st += 1) {
        var sc = score(P, st, sp, count);
        if (sc > best.score) best = { start: st, spacing: sp, score: sc };
      }
    }
    if (!isFinite(best.score)) {
      return { start: 0, spacing: roughSpan / (count - 1), score: 0, confidence: 0 };
    }

    // --- 局部精修（插值让目标函数连续，逐次缩小步长到亚像素） ---
    var step = Math.max(0.5, best.spacing / 24);
    for (var round = 0; round < 6; round++) {
      var improved = true;
      while (improved) {
        improved = false;
        var cands = [
          [best.start + step, best.spacing],
          [best.start - step, best.spacing],
          [best.start, best.spacing + step],
          [best.start, best.spacing - step]
        ];
        for (var c = 0; c < cands.length; c++) {
          var cs = cands[c][0], cp = cands[c][1];
          var cspan = cp * (count - 1);
          if (cspan < spanLo * 0.9 || cspan > spanHi * 1.1) continue;
          if (cs < 0.2 || cs + cspan > n - 1.2) continue;
          var v = score(P, cs, cp, count);
          if (v > best.score + 1e-9) {
            best = { start: cs, spacing: cp, score: v };
            improved = true;
          }
        }
      }
      step /= 4;
    }

    return {
      start: best.start,
      spacing: best.spacing,
      span: best.spacing * (count - 1),
      score: best.score,
      confidence: confidenceOf(P, best.score)
    };
  }

  /** 置信度：拟合位置的暗度 / 剖面自身的高频起伏强度。
   *  注意不能拿剖面均值做分母 —— 去趋势后均值恒为 0，会得到无意义的巨大值。 */
  function confidenceOf(P, fitScore) {
    var n = P.length, mean = 0, i;
    for (i = 0; i < n; i++) mean += P[i];
    mean /= n;
    var v = 0;
    for (i = 0; i < n; i++) {
      var d = P[i] - mean;
      v += d * d;
    }
    var std = Math.sqrt(v / n);
    return std > 1e-6 ? fitScore / std : 0;
  }

  /**
   * 主入口。
   * @param {Uint8ClampedArray|Uint8Array} gray 灰度图，长度 W*H
   * @param {number} W
   * @param {number} H
   * @param {{x:number,y:number,w:number,h:number}} rough 用户框选的粗略范围（像素）
   * @returns {{ok:boolean, x0:number,y0:number,dx:number,dy:number,confidence:number,reason?:string}}
   *          x0/y0 是左上交叉点，dx/dy 是列/行间距
   */
  function fitBoard(gray, W, H, rough) {
    if (rough.w < 60 || rough.h < 60) {
      return { ok: false, confidence: 0, reason: '框选范围太小' };
    }

    // 向外扩 25% 再采样：用户框得偏小时，真实晶格会落在框外，
    // 若只在框内采样，边缘那几条线的得分会被当作"框外无信号"而拖垮。
    var padX = rough.w * 0.25, padY = rough.h * 0.25;
    var rx0 = Math.max(0, Math.floor(rough.x - padX));
    var ry0 = Math.max(0, Math.floor(rough.y - padY));
    var rx1 = Math.min(W - 1, Math.ceil(rough.x + rough.w + padX));
    var ry1 = Math.min(H - 1, Math.ceil(rough.y + rough.h + padY));
    if (rx1 - rx0 < 60 || ry1 - ry0 < 60) {
      return { ok: false, confidence: 0, reason: '框选范围太小' };
    }

    var Pc = detrend(columnProfile(gray, W, H, rx0, rx1, ry0, ry1), (rx1 - rx0) / 17);
    var Pr = detrend(rowProfile(gray, W, H, rx0, rx1, ry0, ry1), (ry1 - ry0) / 19);

    var cx = fitAxis(Pc, COLS, rough.w);
    var cy = fitAxis(Pr, ROWS, rough.h);

    var x0 = rx0 + cx.start;
    var y0 = ry0 + cy.start;

    // 越界保护
    var xEnd = x0 + cx.spacing * (COLS - 1);
    var yEnd = y0 + cy.spacing * (ROWS - 1);
    if (x0 < -5 || y0 < -5 || xEnd > W + 5 || yEnd > H + 5) {
      return { ok: false, confidence: Math.min(cx.confidence, cy.confidence), reason: '拟合结果超出画面' };
    }

    return {
      ok: true,
      x0: x0,
      y0: y0,
      dx: cx.spacing,
      dy: cy.spacing,
      confidence: Math.min(cx.confidence, cy.confidence)
    };
  }

  var api = { fitBoard: fitBoard, fitAxis: fitAxis, detrend: detrend, COLS: COLS, ROWS: ROWS };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.Lattice = api;
})(typeof window !== 'undefined' ? window : globalThis);
