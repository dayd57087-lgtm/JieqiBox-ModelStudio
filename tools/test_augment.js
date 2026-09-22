/*
 * 数据增强的单元测试。
 *
 * 做法和 test_capture.js 一样：不复制代码，直接从 studio.js 里把要测的函数
 * 抠出来在 node 里跑 —— 测的是真代码，改坏了这里立刻会红。
 *
 * 为什么这块特别需要测：增强是在像素数组上就地改写，写错一个下标不会报错，
 * 只会让模型学到一堆噪声，而现象是"准确率莫名其妙变低"，极难反查。
 * 尤其是「关」档必须是**逐字节恒等** —— 不然连对照组都没有了。
 */
'use strict';
var fs = require('fs');
var path = require('path');
var vm = require('vm');

var SRC = path.join(__dirname, '..', 'app', 'src', 'main', 'assets', 'www', 'studio.js');
var src = fs.readFileSync(SRC, 'utf8');

/** 从源码里抠出一个函数定义（按大括号配对找结尾） */
function extractFn(source, name) {
  var i = source.indexOf('\n  function ' + name + '(');
  if (i < 0) throw new Error('找不到函数 ' + name);
  var depth = 0, started = false;
  for (var j = i + 3; j < source.length; j++) {
    var ch = source[j];
    if (ch === '{') { depth++; started = true; }
    else if (ch === '}') {
      depth--;
      if (started && depth === 0) return source.slice(i, j + 1);
    }
  }
  throw new Error('大括号不配对：' + name);
}

/** 抠出一个对象字面量变量定义 */
function extractObj(source, name) {
  var i = source.indexOf('\n  var ' + name + ' = {');
  if (i < 0) throw new Error('找不到变量 ' + name);
  var depth = 0, started = false;
  for (var j = i + 3; j < source.length; j++) {
    var ch = source[j];
    if (ch === '{') { depth++; started = true; }
    else if (ch === '}') {
      depth--;
      if (started && depth === 0) return source.slice(i, j + 2) + ';';
    }
  }
  throw new Error('大括号不配对：' + name);
}

var code = [
  'var NC = 16;',
  'var trainY = null;',
  extractObj(src, 'AUG_LEVELS'),
  extractFn(src, 'randn'),
  extractFn(src, 'augmentBatch'),
  extractFn(src, 'mixupBatch'),
  extractFn(src, 'fillSmoothed')
].join('\n');

var sandbox = { console: console };
vm.createContext(sandbox);
vm.runInContext(code, sandbox);

// ---------------------------------------------------------------- 测试框架
var pass = 0, fail = 0, group = '';
function G(name) { group = name; }
function ok(cond, msg) {
  if (cond) { pass++; }
  else { fail++; console.log('  ✗ [' + group + '] ' + msg); }
}
function near(a, b, tol, msg) {
  ok(Math.abs(a - b) <= tol, msg + '（实际 ' + a.toFixed(4) + '，期望 ' + b + '±' + tol + '）');
}

var AUG = sandbox.AUG_LEVELS;
var augmentBatch = sandbox.augmentBatch;

function mkXs(count, size, fill) {
  var px = size * size * 3;
  var a = new Float32Array(count * px);
  if (fill !== undefined) a.fill(fill);
  return a;
}
function mkYs(count) {
  return new Float32Array(count * 16);
}
function mean(arr) {
  var s = 0;
  for (var i = 0; i < arr.length; i++) s += arr[i];
  return s / arr.length;
}
function variance(arr) {
  var m = mean(arr), s = 0;
  for (var i = 0; i < arr.length; i++) s += (arr[i] - m) * (arr[i] - m);
  return s / arr.length;
}

// ---------------------------------------------------------------- 1. 关闭档
G('关闭档');
(function () {
  var size = 8, count = 4;
  var xs = mkXs(count, size);
  for (var i = 0; i < xs.length; i++) xs[i] = (i % 97) / 97;   // 确定性的伪随机填充
  var before = xs.slice();
  augmentBatch(xs, mkYs(count), count, size, AUG.off);
  var same = true;
  for (var k = 0; k < xs.length; k++) if (xs[k] !== before[k]) { same = false; break; }
  ok(same, '「关」档必须逐字节恒等 —— 否则对照组就没了');
  ok(!!AUG.off, 'AUG_LEVELS 里要有 off 档');
})();

// ---------------------------------------------------------------- 2. 值域
G('值域');
(function () {
  var size = 8, count = 6;
  ['light', 'normal', 'strong'].forEach(function (lv) {
    var xs = mkXs(count, size);
    for (var i = 0; i < xs.length; i++) xs[i] = Math.random();
    augmentBatch(xs, mkYs(count), count, size, AUG[lv]);
    var lo = Infinity, hi = -Infinity;
    for (var k = 0; k < xs.length; k++) {
      if (xs[k] < lo) lo = xs[k];
      if (xs[k] > hi) hi = xs[k];
    }
    ok(lo >= 0 && hi <= 1, lv + ' 档输出必须仍在 [0,1]（实际 ' +
       lo.toFixed(3) + '~' + hi.toFixed(3) + '）');
  });
})();

// ---------------------------------------------------------------- 3. 越界写入
G('越界写入');
(function () {
  var size = 8, count = 4;
  var px = size * size * 3;
  var xs = new Float32Array(count * px + 300);   // 尾巴留一块哨兵区
  xs.fill(0.5);
  for (var i = count * px; i < xs.length; i++) xs[i] = -1;   // 哨兵
  augmentBatch(xs, mkYs(count), count, size, AUG.strong);
  var touched = 0;
  for (var k = count * px; k < xs.length; k++) if (xs[k] !== -1) touched++;
  ok(touched === 0, '增强不能写到 count×px 之外（哨兵被改了 ' + touched + ' 个）');
})();

// ---------------------------------------------------------------- 4. 亮度
G('亮度');
(function () {
  // 注意不能用「一批图的均值」来测：亮度是**逐样本**随机的，
  // 一批里有的变亮有的变暗，平均下来正好抵消 —— 那测的是个假象。
  // 必须看单个样本，并且多看几次，顺带确认偏移是对称的（没有系统性倾向）。
  var size = 8;
  var cfg = { bright: 0.3, contrast: 0, chroma: 0, noise: 0, shift: 0, cutout: 0, mixup: 0 };
  var moved = 0, sum = 0, N = 40;
  for (var t = 0; t < N; t++) {
    var xs = mkXs(1, size, 0.5);
    augmentBatch(xs, mkYs(1), 1, size, cfg);
    var m = mean(xs);
    sum += m;
    if (Math.abs(m - 0.5) > 0.02) moved++;
  }
  // |offset| > 0.02 的概率约 93%，40 次里期望 37 次
  ok(moved >= 30, '单个样本的亮度要真的被平移（' + N + ' 次里 ' + moved + ' 次偏移超过 0.02）');
  near(sum / N, 0.5, 0.05, '亮度偏移应双向对称，不该整体偏亮或偏暗');
})();

// ---------------------------------------------------------------- 5. 噪声
G('噪声');
(function () {
  var size = 8, count = 16;
  var cfg = { bright: 0, contrast: 0, chroma: 0, noise: 0.05, shift: 0, cutout: 0, mixup: 0 };
  var xs = mkXs(count, size, 0.5);
  augmentBatch(xs, mkYs(count), count, size, cfg);
  var v = variance(xs), m = mean(xs);
  ok(v > 1e-4, '噪声档必须真的引入方差（实际 ' + v.toExponential(2) + '）');
  near(m, 0.5, 0.02, '噪声应零均值，不该整体偏移');
  // 0.05 的标准差对应方差 2.5e-3，允许较宽的范围（randn 是近似）
  ok(v > 5e-4 && v < 1e-2, '噪声方差量级应贴近设定值（实际 ' + v.toExponential(2) + '）');
})();

// ---------------------------------------------------------------- 6. 色偏
G('色偏');
(function () {
  var size = 8, count = 24;
  var cfg = { bright: 0, contrast: 0, chroma: 0.3, noise: 0, shift: 0, cutout: 0, mixup: 0 };
  var xs = mkXs(count, size, 0.5);
  augmentBatch(xs, mkYs(count), count, size, cfg);
  var sr = 0, sg = 0, sb = 0, n = xs.length / 3;
  for (var i = 0; i < xs.length; i += 3) { sr += xs[i]; sg += xs[i + 1]; sb += xs[i + 2]; }
  sr /= n; sg /= n; sb /= n;
  var spread = Math.max(sr, sg, sb) - Math.min(sr, sg, sb);
  ok(spread > 0.002, '每个通道要有独立增益（通道均值差 ' + spread.toFixed(4) + '）');
})();

// ---------------------------------------------------------------- 7. 平移
G('平移');
(function () {
  var size = 12, count = 1;
  // 左半亮右半暗：平移后分界线的位置会动
  var px = size * size * 3;
  var base = new Float32Array(px);
  for (var y = 0; y < size; y++) {
    for (var x = 0; x < size; x++) {
      var v = x < size / 2 ? 0.9 : 0.1;
      var o = (y * size + x) * 3;
      base[o] = base[o + 1] = base[o + 2] = v;
    }
  }
  var cfg = { bright: 0, contrast: 0, chroma: 0, noise: 0, shift: 3, cutout: 0, mixup: 0 };
  // 列平均亮度：分界线在哪，从剖面就能看出来
  function profile(arr) {
    var p = [];
    for (var x = 0; x < size; x++) {
      var s = 0;
      for (var y = 0; y < size; y++) s += arr[(y * size + x) * 3];
      p.push(s / size);
    }
    return p;
  }
  var orig = profile(base);
  var moved = 0;
  for (var t = 0; t < 30; t++) {
    var xs = base.slice();
    augmentBatch(xs, mkYs(count), count, size, cfg);
    var now = profile(xs);
    var diff = 0;
    for (var k = 0; k < size; k++) diff += Math.abs(now[k] - orig[k]);
    if (diff > 0.5) moved++;
  }
  ok(moved >= 25, '平移档要真的移动画面（30 次里 ' + moved + ' 次剖面有明显变化）');
  // 位移不能超过设定幅度：取极值验证边界补黑确实发生了
  var xs2 = base.slice();
  augmentBatch(xs2, mkYs(count), count, size, cfg);
  var hasZero = false;
  for (var q = 0; q < xs2.length; q++) if (xs2[q] === 0) { hasZero = true; break; }
  ok(hasZero, '位移出界的部分应补黑（0），与真实裁切越界的样子一致');
})();

// ---------------------------------------------------------------- 8. 遮挡
G('遮挡');
(function () {
  var size = 16, count = 1;
  var cfg = { bright: 0, contrast: 0, chroma: 0, noise: 0, shift: 0, cutout: 1, mixup: 0 };
  var zeros = [];
  for (var t = 0; t < 10; t++) {
    var xs = mkXs(count, size, 1);          // 全白，被挖掉的地方必然是 0
    augmentBatch(xs, mkYs(count), count, size, cfg);
    var z = 0;
    for (var i = 0; i < xs.length; i++) if (xs[i] === 0) z++;
    zeros.push(z / 3);
  }
  var minZ = Math.min.apply(null, zeros), maxZ = Math.max.apply(null, zeros);
  ok(minZ > 0, 'cutout=1 时必须每次都挖掉一块（最少一次挖了 ' + minZ + ' 像素）');
  // 边长取 15%~35% 再取整：size=16 时约 2~6 像素 → 面积 4~36
  ok(minZ >= 4 && maxZ <= 36, '挖掉面积应在设定范围内（实际 ' +
     minZ + '~' + maxZ + '）');
})();

// ---------------------------------------------------------------- 9. Mixup
G('Mixup');
(function () {
  var size = 8, count = 8;
  var cfg = { bright: 0, contrast: 0, chroma: 0, noise: 0, shift: 0, cutout: 0, mixup: 0.2 };
  var xs = mkXs(count, size, 0.8);
  var ys = mkYs(count);
  for (var i = 0; i < count; i++) ys[i * 16 + (i % 16)] = 1;   // 各不相同的一批 one-hot
  augmentBatch(xs, ys, count, size, cfg);

  var sumOk = true, badRow = -1;
  for (var r = 0; r < count; r++) {
    var s = 0;
    for (var c = 0; c < 16; c++) s += ys[r * 16 + c];
    if (Math.abs(s - 1) > 1e-4) { sumOk = false; badRow = r; }
  }
  ok(sumOk, 'Mixup 后每行标签之和仍应为 1（第 ' + badRow + ' 行不对）');

  var anyMixed = false;
  for (var q = 0; q < ys.length; q++) if (ys[q] > 1e-6 && ys[q] < 1 - 1e-6) { anyMixed = true; break; }
  ok(anyMixed, 'Mixup 后标签应有非 0/1 的中间值');

  // λ 偏向 1：均值必须明显高于 0.5，否则就是把图糊烂
  var m = mean(xs);
  ok(m > 0.5, 'λ 应偏向 1（像素均值 ' + m.toFixed(3) + ' 应高于 0.5）');
})();

G('Mixup 边界');
(function () {
  var size = 8;
  var xs = mkXs(1, size, 0.5), ys = mkYs(1);
  ys[0] = 1;
  var before = xs.slice();
  augmentBatch(xs, ys, 1, size, { bright: 0, contrast: 0, chroma: 0, noise: 0,
                                  shift: 0, cutout: 0, mixup: 0.3 });
  var same = true;
  for (var i = 0; i < xs.length; i++) if (xs[i] !== before[i]) { same = false; break; }
  ok(same, '样本数为 1 时 Mixup 应当直接跳过，不能自己配自己');
})();

// ---------------------------------------------------------------- 10. 标签平滑
G('标签平滑');
(function () {
  var fillSmoothed = sandbox.fillSmoothed;
  var NC = 16;
  var trainY = new Float32Array(NC * 3);
  trainY[0 * NC + 5] = 1;
  trainY[1 * NC + 0] = 1;      // 空格
  trainY[2 * NC + 15] = 1;
  sandbox.trainY = trainY;

  var ys = new Float32Array(3 * NC);
  fillSmoothed(ys, 0, 0, 0.1);
  fillSmoothed(ys, 1, 1, 0.1);
  fillSmoothed(ys, 2, 2, 0.1);

  var s = 0;
  for (var c = 0; c < NC; c++) s += ys[c];
  ok(Math.abs(s - 1) < 1e-4, '平滑后每行之和应为 1（实际 ' + s.toFixed(6) + '）');
  ok(ys[5] > ys[4], '正确类应远大于背景类');
  near(ys[4], 0.1 / 16, 1e-6, '背景类应为 ε/C');
  near(ys[5], 1 - 0.1 + 0.1 / 16, 1e-6, '正确类应为 1-ε+ε/C');
  ok(ys[0 * NC] < ys[5], '平滑不能大到把正确类压成背景类');
  ok(Math.abs(ys[NC + 0] - (1 - 0.1 + 0.1 / 16)) < 1e-6, '空格子也要一视同仁地平滑');

  // ε=0 时应退化成标准 one-hot，这样「标签平滑」关掉就等于旧行为
  var y0 = new Float32Array(NC);
  fillSmoothed(y0, 0, 2, 0);
  ok(y0[15] === 1 && y0[14] === 0, 'ε=0 时必须退化成 one-hot');
})();

// ---------------------------------------------------------------- 汇总
console.log('');
console.log('数据增强：' + pass + ' 条通过，' + fail + ' 条失败');
if (fail) process.exit(1);
