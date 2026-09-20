#!/usr/bin/env python3
"""把 studio.js 里「悬浮窗采集」那一段切出来，单独喂给 node 做单测。

为什么这么切：整份 studio.js 是个 IIFE，加载时就要 IndexedDB、WebView 桥、
tf.min.js……在沙箱里跑不动。而这段逻辑（按钮语义、状态文案、两步开拍）
恰恰是最容易写错又最该验的部分。
"""
import io
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'app', 'src', 'main', 'assets', 'www', 'studio.js')
OUT = os.path.join(ROOT, 'tools', '_capture_block.js')

START = '// ---------------------------------------------------------------- 悬浮窗采集'
END = '// ---------------------------------------------------------------- 演示局面'

src = io.open(SRC, encoding='utf-8').read()
a = src.index(START)
b = src.index(END)
block = src[a:b]

io.open(OUT, 'w', encoding='utf-8').write(
    '// 由 tools/extract_capture.py 生成，勿手改\n' + block)
print('切出 %d 行 -> %s' % (block.count('\n'), OUT))
sys.exit(0)
