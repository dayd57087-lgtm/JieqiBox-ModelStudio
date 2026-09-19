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

  /**
   * 找出剖面里「有纹理」的那一段。
   *
   * 棋盘内部有等距格子线，投影会明显起伏；棋盘外是均匀背景（通常是深色），
   * 投影几乎是一条平线。返回起伏持续超过阈值的最长区间。
   *
   * 为什么必须做这一步：棋盘外的深色背景「暗度」极高，任何延伸到棋盘外的
   * 候选晶格都会白捡一条最强的「线」。实测这会稳定地把晶格整体推偏整整一格，
   * 而两组线在平均暗度上几乎打平，光靠打分分不出来。
   */
  function texturedRange(P, win) {
    var n = P.length;
    if (n < 8) return { lo: 0, hi: n - 1 };
    var w = Math.max(2, Math.round(win));
    var st = new Float64Array(n);
    var mx = 0;
    for (var i = 0; i < n; i++) {
      var a = Math.max(0, i - w), b = Math.min(n - 1, i + w);
      var s = 0;
      for (var j = a; j <= b; j++) s += P[j];
      var m = s / (b - a + 1);
      var v = 0;
      for (var k = a; k <= b; k++) {
        var d = P[k] - m;
        v += d * d;
      }
      st[i] = Math.sqrt(v / (b - a + 1));
      if (st[i] > mx) mx = st[i];
    }
    if (mx <= 1e-6) return { lo: 0, hi: n - 1 };

    var thr = mx * 0.3;
    var lo = 0;
    while (lo < n && st[lo] < thr) lo++;
    var hi = n - 1;
    while (hi > lo && st[hi] < thr) hi--;
    if (hi - lo < n * 0.2) return { lo: 0, hi: n - 1 };
    return { lo: lo, hi: hi };
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
   * 拟合单根轴。
   *
   * 关键约束：**整段跨度必须接近用户框选的宽度**。
   * 否则会出现退化解 —— 9 条线挤进一小块深色区域时，平均暗度反而更高，
   * 于是拟合出一组毫无意义的密集线（实测框选偏小 12% 就会塌缩成 0.67 倍间距）。
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
      return { start: 0, spacing: roughSpan / (count - 1), score: 0, confidence: 0, edgeRatio: 1 };
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

    /*
     * 八度校正。
     *
     * 一维周期信号的搜索有个经典陷阱：真实周期 T 和它的半周期 T/2 都会得分很高，
     * 因为半周期恰好穿过所有真实峰（外加它们的中点）。棋盘上这一点尤其明显 ——
     * 棋子的上下边缘在格线两侧各约半格处形成暗带，于是「格距的一半」在投影里
     * 也有很强的周期性。一旦拟合落到半周期上，10 条"线"只覆盖棋盘的一半，
     * 整块棋盘就废了（实测批量标定时真的发生了：dx=99.8px / dy=50.0px）。
     *
     * 判据：把间距翻倍再试一次，若得分接近（>= 92%），说明 2× 才是真周期 ——
     * 取大的那个。反过来不必试半周期，因为我们的搜索起点已经是目标间距附近。
     */
    (function fixOctave() {
      // 只在「拟合出来的总跨度明显小于预期」时才怀疑是八度错误。
      // 正常标定时拟合跨度本来就该接近 roughSpan，不该动。
      var fittedSpan = best.spacing * (count - 1);
      if (fittedSpan > roughSpan * 0.75) return;

      var dbl = best.spacing * 2;
      var span2 = dbl * (count - 1);
      if (span2 > n - 1.5) return;                     // 放不下，跳过
      var best2 = { start: best.start, spacing: dbl, score: -Infinity };
      for (var st2 = 0.2; st2 <= n - 1.5 - span2; st2 += 1) {
        var v2 = score(P, st2, dbl, count);
        if (v2 > best2.score) best2 = { start: st2, spacing: dbl, score: v2 };
      }
      // 在得分最好的起点附近再做一次局部精修
      var step2 = Math.max(0.5, dbl / 24);
      for (var rd = 0; rd < 5; rd++) {
        var imp = true;
        while (imp) {
          imp = false;
          var cands2 = [
            [best2.start + step2, dbl], [best2.start - step2, dbl],
            [best2.start, dbl + step2], [best2.start, dbl - step2]
          ];
          for (var q = 0; q < cands2.length; q++) {
            var cs2 = cands2[q][0], cp2 = cands2[q][1];
            var sp2 = cp2 * (count - 1);
            if (sp2 > n - 1.2 || cs2 < 0.2 || cs2 + sp2 > n - 1.2) continue;
            var s2 = score(P, cs2, cp2, count);
            if (s2 > best2.score + 1e-9) {
              best2 = { start: cs2, spacing: cp2, score: s2 };
              imp = true;
            }
          }
        }
        step2 /= 4;
      }
      // 2× 的得分只要接近，就认为它才是真周期
      if (best2.score > best.score * 0.92) {
        best = { start: best2.start, spacing: best2.spacing, score: best2.score };
      }
    })();

    // 边缘判据：真实晶格的两端之外是棋盘外的木边，不该再有格子线。
    // 若往外一格的位置上仍压着同样强的线，说明这组线只是棋盘内部的一段 ——
    // 相位错了一格。棋盘横线等距，错相位与正确相位在平均暗度上几乎一样，
    // 只有靠这个判据才能分开。
    var end = best.start + best.spacing * (count - 1);
    var outside = Math.max(
      sampleLinear(P, best.start - best.spacing),
      sampleLinear(P, end + best.spacing)
    );
    var edgeRatio = best.score > 1e-6 ? Math.max(0, outside) / best.score : 1;

    return {
      start: best.start,
      spacing: best.spacing,
      score: best.score,
      confidence: confidenceOf(P, best.score),
      edgeRatio: edgeRatio
    };
  }

  /**
   * 主入口。
   * @param {Uint8ClampedArray|Uint8Array} gray 灰度图，长度 W*H
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

    // 先按「有纹理」把范围收紧到棋盘本身，把外面的均匀背景排除掉
    var trimC = texturedRange(
      columnProfile(gray, W, H, rx0, rx1, ry0, ry1),
      (rx1 - rx0) / 34
    );
    var trimR = texturedRange(
      rowProfile(gray, W, H, rx0, rx1, ry0, ry1),
      (ry1 - ry0) / 38
    );
    var cc0 = rx0 + trimC.lo, cc1 = rx0 + trimC.hi;
    var rr0 = ry0 + trimR.lo, rr1 = ry0 + trimR.hi;
    if (cc1 - cc0 < 60 || rr1 - rr0 < 60) {
      return { ok: false, confidence: 0, reason: '框内没有找到棋盘纹理' };
    }

    var Pc = detrend(columnProfile(gray, W, H, cc0, cc1, rr0, rr1), (cc1 - cc0) / 17);
    var Pr = detrend(rowProfile(gray, W, H, cc0, cc1, rr0, rr1), (rr1 - rr0) / 19);

    // 跨度约束仍然用用户框选的尺寸 —— 它是独立于裁剪的可靠信息
    var cx = fitAxis(Pc, COLS, rough.w);
    var cy = fitAxis(Pr, ROWS, rough.h);

    var x0 = cc0 + cx.start;
    var y0 = rr0 + cy.start;

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
      confidence: Math.min(cx.confidence, cy.confidence),
      edgeRatio: Math.max(cx.edgeRatio, cy.edgeRatio)
    };
  }

  /**
   * 没有框选时的兜底：扫几档「棋盘占画面多大、放在哪」，取最好的那个。
   *
   * 批量标定靠这个 —— 用户不想为几十张图一张张拖框。
   * 精度不如人工框选，但足够让整批图有个起点，之后可以逐张微调。
   */
  function fitBoardAuto(gray, W, H) {
    var fractions = [0.98, 0.9, 0.82, 0.72, 0.62, 0.52];
    var offsets = [
      [0.5, 0.5], [0.5, 0.42], [0.5, 0.34], [0.5, 0.26],
      [0.5, 0.58], [0.5, 0.66]
    ];

    var best = null;
    for (var fi = 0; fi < fractions.length; fi++) {
      var f = fractions[fi];
      for (var oi = 0; oi < offsets.length; oi++) {
        var w = W * f;
        // 棋盘是 9:10，高度按宽度的比例推，避免用满屏高度把 UI 栏也圈进来
        var h = Math.min(H, w * (10 / 9));
        var x = Math.max(0, W * offsets[oi][0] - w / 2);
        var y = Math.max(0, H * offsets[oi][1] - h / 2);
        var fit = fitBoard(gray, W, H, {
          x: x, y: y,
          w: Math.min(w, W - x),
          h: Math.min(h, H - y)
        });
        // 相位错的候选线数一样多、置信度接近，靠 edgeRatio 压下去
        if (fit && fit.ok && fit.edgeRatio < 0.6) {
          if (!best || fit.confidence > best.confidence) best = fit;
        }
      }
    }
    return best;
  }

  var api = {
    fitBoard: fitBoard,
    fitBoardAuto: fitBoardAuto,
    fitAxis: fitAxis,
    detrend: detrend,
    COLS: COLS,
    ROWS: ROWS
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.Lattice = api;
})(typeof window !== 'undefined' ? window : globalThis);
