#!/usr/bin/env python3
"""检查「碰窗口/视图的代码」有没有自己包住主线程。

为什么单独写这么一条：这条规矩被违反过一次，代价是应用直接闪退，
而且**崩溃点和肇事点隔了半秒、还不在同一个函数里** —— 光看代码基本查不出来。

事情的经过：MainActivity 里那些 @JavascriptInterface 方法跑在 WebView 的
JavaBridge 线程上（不是主线程）。有一次在那个线程上执行了 wm.addView，
这个悬浮窗的 ViewRootImpl 就被认领给了 JavaBridge 线程 ——
此刻一切正常、窗口照常显示、不报任何错。半秒后主线程更新一次
「已采 N 张」→ checkThread() 发现线程对不上 →
CalledFromWrongThreadException，没人接，应用退出。

规矩只有一条：

    碰窗口/视图的函数，函数体里必须出现 onMain / runOnUiThread
    （不依赖调用方在主线程，因为这个类会被 JavaBridge 线程调到）

两个例外，都写死在下面并且各自说清了理由。
用法：python3 tools/check_threading.py [目录]
"""
import io
import os
import re
import sys

GUARD = re.compile(r'\b(?:onMain|runOnUiThread)\s*[({]|\b(?:main|webView)\.post\b')

# 窗口级操作：碰的是已经挂上去的窗口，一定受 ViewRootImpl 的线程检查
WINDOW_OP = re.compile(
    r'\b(?:windowManager|wm|window)\s*[?!]?\s*\.\s*'
    r'(?:addView|removeView|updateViewLayout)\s*\('
    r'|setContentView\s*\('
)

# 视图属性写入：视图一旦附着到窗口上，setText/setBackground 都会 requestLayout
VIEW_WRITE = re.compile(
    r'\.\s*(?:visibility|text|background)\s*=(?!=)'
)

# ---- 例外 1：只组装**还没有父窗口**的视图树 ----
# 游离的层级碰不到 ViewRootImpl，所以不存在线程约束
# （约束是从 addView 那一刻才开始的）。往这里加名字之前先确认这一点。
DETACHED_BUILDERS = {'buildView', 'button'}

# ---- 例外 2：Activity/Service 的生命周期回调 ----
# 框架保证这些方法在主线程调用，不是"我们猜它应该在主线程"。
LIFECYCLE = {
    'onCreate', 'onDestroy', 'onStart', 'onStop', 'onResume', 'onPause',
    'onRestart', 'onNewIntent', 'onActivityResult', 'onBackPressed',
    'onPostResume', 'onSaveInstanceState',
}


def strip_comments(src):
    out = re.sub(r'/\*.*?\*/', '', src, flags=re.S)
    out = re.sub(r'//[^\n]*', '', out)
    return out


def functions(src):
    """yield (名字, 方法体)。方法体用花括号配对切，不靠"到行尾为止"。"""
    pat = re.compile(
        r'^[ \t]*(?:@\w+(?:\([^)]*\))?[ \t]*\n[ \t]*)*'
        r'(?:override[ \t]+|private[ \t]+|public[ \t]+|internal[ \t]+|inline[ \t]+)*'
        r'fun[ \t]+(\w+)[ \t]*\([^)]*\)[^{=]*',
        re.M)
    for m in pat.finditer(src):
        name = m.group(1)
        i = m.end()
        while i < len(src) and src[i] in ' \t':
            i += 1
        if i >= len(src) or src[i] != '{':
            eol = src.find('\n', m.end())
            yield name, src[m.end():eol if eol > 0 else len(src)]
            continue
        depth, j = 0, i
        while j < len(src):
            if src[j] == '{':
                depth += 1
            elif src[j] == '}':
                depth -= 1
                if depth == 0:
                    break
            j += 1
        yield name, src[i:j + 1]


def check(path):
    src = strip_comments(io.open(path, encoding='utf-8').read())
    problems = []
    for name, body in functions(src):
        if name in LIFECYCLE:
            continue
        guarded = bool(GUARD.search(body))

        m = WINDOW_OP.search(body)
        if m and not guarded:
            problems.append(
                f'{name}() 里有窗口操作没被 onMain/runOnUiThread 包住：'
                f'「{m.group(0).strip()}」'
                f'\n          → 从 JavaBridge 线程调到它，ViewRootImpl 就会认领错'
                f'线程，半秒后闪退')

        if name in DETACHED_BUILDERS:
            continue
        m = VIEW_WRITE.search(body)
        if m and not guarded:
            problems.append(
                f'{name}() 里有视图属性写入没被 onMain/runOnUiThread 包住：'
                f'「{m.group(0).strip()}」'
                f'\n          → 视图一旦附着到窗口上，setText/setBackground 就会'
                f'requestLayout，线程错了照样闪退')
    return problems


def main():
    root = sys.argv[1] if len(sys.argv) > 1 else '.'
    files = sorted(os.path.join(root, f) for f in os.listdir(root)
                   if f.endswith('.kt'))
    bad = 0
    for f in files:
        problems = check(f)
        name = os.path.basename(f)
        if problems:
            bad += 1
            print(f'  ✗ {name}')
            for p in problems:
                print('      ' + p)
        else:
            print(f'  ✓ {name}')
    if bad:
        print(f'\n{bad} 个文件有线程问题。')
        return 1
    print('\n全部通过')
    return 0


if __name__ == '__main__':
    sys.exit(main())
