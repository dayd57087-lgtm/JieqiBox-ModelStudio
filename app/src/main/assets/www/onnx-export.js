/* 把 TF.js 序列模型导出成 ONNX。
 *
 * 为什么手写 protobuf，而不是用现成的转换器：
 * tf2onnx / onnx 那套依赖 Python 和完整的 TF 图，在 Android WebView 里根本跑不起来。
 * 本工坊的模型结构完全已知（就 Conv/Relu/MaxPool/Flatten/Dense 几种层），
 * 手写 protobuf 反而更可靠、体积也更小，还不用多带一个几十兆的依赖。
 *
 * 输入输出约定：
 *   输入  'input'  [N, H, W, 3]  —— NHWC，和训练时一致，应用侧不用改预处理
 *   输出  'logits' [N, classes]  —— 未过 softmax（与 TF.js 模型逐位对应，便于对拍）
 *
 * ONNX 的 Conv 规范要求 NCHW，所以图内部开头转一次、全连接之前再转回来。
 * 两次转置都在很小的张量上做，代价可以忽略。
 */
(function (root) {
  'use strict';

  // ------------------------------------------------------------ protobuf 写入
  // 只实现用到的那几种线格式：varint、length-delimited。

  function utf8(s) {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(s);
    var out = [];
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
      else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    }
    return new Uint8Array(out);
  }

  function PB() {
    this.buf = new Uint8Array(1 << 16);
    this.n = 0;
  }

  PB.prototype.grow = function (k) {
    if (this.n + k <= this.buf.length) return;
    var cap = this.buf.length;
    while (cap < this.n + k) cap <<= 1;
    var nb = new Uint8Array(cap);
    nb.set(this.buf.subarray(0, this.n));
    this.buf = nb;
  };

  PB.prototype.varint = function (v) {
    // 用取模而不是位运算：值可能超过 2^31，位运算会先截成 int32 而出错。
    this.grow(10);
    while (v >= 0x80) {
      this.buf[this.n++] = (v % 128) | 0x80;
      v = Math.floor(v / 128);
    }
    this.buf[this.n++] = v;
  };

  PB.prototype.tag = function (field, wire) { this.varint(field * 8 + wire); };
  PB.prototype.int = function (field, v) { this.tag(field, 0); this.varint(v); };

  PB.prototype.bytes = function (field, b) {
    this.tag(field, 2);
    this.varint(b.length);
    this.grow(b.length);
    this.buf.set(b, this.n);
    this.n += b.length;
  };

  PB.prototype.str = function (field, s) { this.bytes(field, utf8(s)); };

  /** packed varint 数组（proto3 默认形式） */
  PB.prototype.ints = function (field, arr) {
    var t = new PB();
    for (var i = 0; i < arr.length; i++) t.varint(arr[i]);
    this.bytes(field, t.done());
  };

  /** 嵌套消息 */
  PB.prototype.sub = function (field, fn) {
    var t = new PB();
    fn(t);
    this.bytes(field, t.done());
  };

  PB.prototype.done = function () { return this.buf.subarray(0, this.n); };

  /** float32 数组转小端字节（TensorProto.raw_data 要求小端） */
  function floatBytes(arr) {
    var out = new Uint8Array(arr.length * 4);
    var dv = new DataView(out.buffer);
    for (var i = 0; i < arr.length; i++) dv.setFloat32(i * 4, arr[i], true);
    return out;
  }

  // ------------------------------------------------------------ ONNX 元素
  // 字段编号取自 onnx.proto。

  var DT_FLOAT = 1;
  var DT_INT64 = 7;
  // AttributeProto.AttributeType
  var AT_INT = 2, AT_INTS = 7;

  function tensorFloat(name, dims, data) {
    var p = new PB();
    p.ints(1, dims);                 // dims
    p.int(2, DT_FLOAT);              // data_type
    p.str(8, name);                  // name
    p.bytes(9, floatBytes(data));    // raw_data
    return p.done();
  }

  function tensorInt64(name, values) {
    var p = new PB();
    p.ints(1, [values.length]);      // dims
    p.int(2, DT_INT64);              // data_type
    p.str(8, name);                  // name
    p.ints(7, values);               // int64_data
    return p.done();
  }

  function valueInfo(name, dims) {
    var p = new PB();
    p.str(1, name);
    p.sub(2, function (t) {          // TypeProto
      t.sub(1, function (tt) {       //   tensor_type
        tt.int(1, DT_FLOAT);         //     elem_type
        tt.sub(2, function (sh) {    //     shape
          dims.forEach(function (d) {
            sh.sub(1, function (dim) {
              // 数字是固定维，字符串是动态维（dim_param）
              if (typeof d === 'number') dim.int(1, d);
              else dim.str(2, String(d));
            });
          });
        });
      });
    });
    return p.done();
  }

  function node(op, inputs, outputs, attrs) {
    var p = new PB();
    inputs.forEach(function (s) { p.str(1, s); });
    outputs.forEach(function (s) { p.str(2, s); });
    p.str(3, outputs[0]);            // name：用输出名当节点名，便于调试
    p.str(4, op);
    (attrs || []).forEach(function (a) {
      p.sub(5, function (ap) {
        ap.str(1, a.name);
        if (a.ints) { ap.ints(8, a.ints); ap.int(20, AT_INTS); }
        else { ap.int(3, a.i); ap.int(20, AT_INT); }
      });
    });
    return p.done();
  }

  // ------------------------------------------------------------ 权重搬运

  /** TF.js 卷积核 [kh,kw,inC,outC] -> ONNX [outC,inC,kh,kw] */
  function convKernelToOnnx(shape, data) {
    var kh = shape[0], kw = shape[1], inC = shape[2], outC = shape[3];
    var out = new Float32Array(outC * inC * kh * kw);
    var p = 0;
    for (var o = 0; o < outC; o++) {
      for (var c = 0; c < inC; c++) {
        for (var i = 0; i < kh; i++) {
          for (var j = 0; j < kw; j++) {
            out[p++] = data[((i * kw + j) * inC + c) * outC + o];
          }
        }
      }
    }
    return out;
  }

  /** 'same' 填充换算成 ONNX 的 [top,left,bottom,right] */
  function samePads(kh, kw, strides, inSize) {
    var outH = Math.ceil(inSize / strides[0]);
    var outW = Math.ceil(inSize / strides[1]);
    var totalH = Math.max((outH - 1) * strides[0] + kh - inSize, 0);
    var totalW = Math.max((outW - 1) * strides[1] + kw - inSize, 0);
    var beginH = Math.floor(totalH / 2);
    var beginW = Math.floor(totalW / 2);
    return [beginH, beginW, totalH - beginH, totalW - beginW];
  }

  function activationOf(layer) {
    var a = layer && layer.activation;
    if (!a || typeof a.getClassName !== 'function') return 'linear';
    return String(a.getClassName()).toLowerCase();
  }

  function stringEntry(key, value) {
    var p = new PB();
    p.str(1, key);
    p.str(2, value);
    return p.done();
  }

  // ------------------------------------------------------------ 构图

  /**
   * @param {object} model tf.Sequential
   * @param {{size:number, numClasses:number}} opts
   * @returns {{bytes:Uint8Array, summary:object}}
   */
  function buildOnnx(model, opts) {
    if (!model || !model.layers) throw new Error('不是有效的 tf 模型');
    var size = opts.size | 0;
    var classes = opts.numClasses | 0;
    if (!size || !classes) throw new Error('size / numClasses 无效');

    var nodes = [];
    var inits = [];
    var seq = 0;
    function nm(p) { return p + '_' + (++seq); }

    var cur = 'input';
    var spatial = size;
    var channels = 3;

    // NHWC -> NCHW
    var t = nm('nchw');
    nodes.push(node('Transpose', [cur], [t], [{ name: 'perm', ints: [0, 3, 1, 2] }]));
    cur = t;

    var convCount = 0, poolCount = 0, denseCount = 0, skipped = [];

    for (var i = 0; i < model.layers.length; i++) {
      var L = model.layers[i];
      var cls = String(L.getClassName());
      var w = (typeof L.getWeights === 'function') ? L.getWeights() : [];

      if (cls === 'Conv2D') {
        var kd = w[0].shape;
        var kh = kd[0], kw = kd[1], inC = kd[2], outC = kd[3];
        var strides = L.strides || [1, 1];
        var Wn = nm('W' + (++convCount));
        var Bn = nm('B' + convCount);
        inits.push(tensorFloat(Wn, [outC, inC, kh, kw],
          convKernelToOnnx(kd, w[0].dataSync())));
        inits.push(tensorFloat(Bn, [outC], w[1].dataSync()));

        var pads = [0, 0, 0, 0];
        if (L.padding === 'same') pads = samePads(kh, kw, strides, spatial);

        var cn = nm('conv');
        nodes.push(node('Conv', [cur, Wn, Bn], [cn], [
          { name: 'kernel_shape', ints: [kh, kw] },
          { name: 'strides', ints: [strides[0], strides[1]] },
          { name: 'pads', ints: pads },
          { name: 'dilations', ints: [1, 1] },
          { name: 'group', i: 1 }
        ]));
        cur = cn;

        if (activationOf(L) === 'relu') {
          var rn = nm('relu');
          nodes.push(node('Relu', [cur], [rn]));
          cur = rn;
        }

        spatial = Math.ceil(spatial / strides[0]);
        channels = outC;

      } else if (cls === 'MaxPooling2D') {
        var ps = L.poolSize || [2, 2];
        var pst = L.strides || ps;
        var pn = nm('pool');
        nodes.push(node('MaxPool', [cur], [pn], [
          { name: 'kernel_shape', ints: [ps[0], ps[1]] },
          { name: 'strides', ints: [pst[0], pst[1]] },
          { name: 'pads', ints: [0, 0, 0, 0] }
        ]));
        cur = pn;
        spatial = Math.floor(spatial / pst[0]);
        poolCount++;

      } else if (cls === 'Flatten') {
        // NCHW 的展平顺序是 (c,h,w)，而 TF.js 训练时用的是 NHWC 的 (h,w,c)。
        // 两者元素顺序不同，直接展平会让全连接的权重全部错位，
        // 所以这里先转回 NHWC 再展平，跟训练时保持一致。
        var back = nm('nhwc');
        nodes.push(node('Transpose', [cur], [back], [
          { name: 'perm', ints: [0, 2, 3, 1] }
        ]));
        var flatSize = spatial * spatial * channels;
        var shapeName = 'flat_shape';
        inits.push(tensorInt64(shapeName, [0, flatSize]));
        var fn = nm('flat');
        nodes.push(node('Reshape', [back, shapeName], [fn]));
        cur = fn;

      } else if (cls === 'Dense') {
        var dkd = w[0].shape;             // [in, out]
        var ind = dkd[0], outd = dkd[1];
        var dW = nm('Wd' + (++denseCount));
        var dB = nm('Bd' + denseCount);
        inits.push(tensorFloat(dW, [ind, outd], w[0].dataSync()));
        inits.push(tensorFloat(dB, [outd], w[1].dataSync()));

        var m = nm('mm');
        // MatMul 而不是 Gemm：语义直白，没有 alpha/beta 那套容易搞错的约定
        nodes.push(node('MatMul', [cur, dW], [m]));
        var a = nm('add');
        nodes.push(node('Add', [m, dB], [a]));
        cur = a;

        if (activationOf(L) === 'relu') {
          var dr = nm('relu');
          nodes.push(node('Relu', [cur], [dr]));
          cur = dr;
        }

      } else if (cls === 'Dropout') {
        // 推理时是恒等映射，不产生节点
      } else if (cls === 'Activation' || cls === 'ReLU') {
        if (activationOf(L) === 'relu' || cls === 'ReLU') {
          var ar = nm('relu');
          nodes.push(node('Relu', [cur], [ar]));
          cur = ar;
        }
      } else {
        skipped.push(cls);
      }
    }

    if (skipped.length) {
      throw new Error('暂不支持的层：' + skipped.join('、'));
    }

    // 让图输出固定叫 logits，下游按名字取即可
    var outName = 'logits';
    if (cur !== outName) {
      nodes.push(node('Identity', [cur], [outName]));
      cur = outName;
    }

    // ---- GraphProto ----
    var g = new PB();
    nodes.forEach(function (n) { g.bytes(1, n); });            // node
    g.str(2, 'jieqibox_cell_classifier');                      // name
    inits.forEach(function (t2) { g.bytes(5, t2); });           // initializer
    g.bytes(11, valueInfo('input', ['N', size, size, 3]));      // input
    g.bytes(12, valueInfo(outName, ['N', classes]));            // output

    // ---- ModelProto ----
    // 字段号以 onnx.proto 为准：graph 是 7、opset_import 是 8。
    // 这两个很容易记反 —— 写错时 protobuf 不会报解析失败（wire type 一样），
    // 运行时只会说「找不到 graph」，排查起来很费劲。
    var mp = new PB();
    mp.int(1, 8);                                              // ir_version
    mp.str(2, 'JieqiBox Model Studio');                        // producer_name
    mp.str(3, '1.0');                                          // producer_version
    mp.str(4, 'com.jieqibox.modelstudio');                     // domain
    mp.bytes(7, g.done());                                     // graph
    mp.sub(8, function (o) { o.int(2, 13); });                 // opset_import: 默认域, v13

    // metadata_props（field 14）：把类别表和输入尺寸写进模型，
    // 这样谁拿到 .onnx 都知道输出第几维对应哪个棋子，不用再去翻源码。
    Object.keys(opts.meta || {}).forEach(function (k) {
      mp.bytes(14, stringEntry(k, String(opts.meta[k])));
    });

    return {
      bytes: mp.done().slice(),
      summary: {
        input: ['N', size, size, 3],
        output: [outName, ['N', classes]],
        conv: convCount,
        pool: poolCount,
        dense: denseCount,
        spatial: spatial,
        params: model.countParams ? model.countParams() : 0
      }
    };
  }

  var api = {
    buildOnnx: buildOnnx,
    _pb: PB,
    _valueInfo: valueInfo,
    _node: node,
    _tensorFloat: tensorFloat,
    _tensorInt64: tensorInt64
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.OnnxExport = api;
})(typeof window !== 'undefined' ? window : globalThis);
