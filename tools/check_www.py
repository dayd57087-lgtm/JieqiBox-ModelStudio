#!/usr/bin/env python3
"""改完 JS / HTML 之后跑一遍。

两条检查都是踩过坑的：
1. 重复函数名 —— 后声明的会覆盖前者，而且不报错，只表现为"某个功能莫名失效"
2. JS 里 $('id') 引用的 id，HTML 里必须存在 —— 少一个就是
   `addEventListener of null`，整个脚本加载即失败，应用完全起不来
"""
import io
import os
import re
import sys

WWW = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                   'app', 'src', 'main', 'assets', 'www')


def dup_functions(src):
    seen = {}
    for m in re.finditer(r'^\s*function\s+(\w+)', src, re.M):
        seen.setdefault(m.group(1), 0)
        seen[m.group(1)] += 1
    return [k for k, v in seen.items() if v > 1]


def js_ids(files):
    out = {}
    for f in files:
        src = io.open(os.path.join(WWW, f), encoding='utf-8').read()
        for m in re.finditer(r"\$\(\s*'([^']+)'\s*\)", src):
            out.setdefault(m.group(1), set()).add(f)
        # getElementById 也要看：index.html 里有些是动态创建后再取的
        for m in re.finditer(r"getElementById\(\s*'([^']+)'", src):
            out.setdefault(m.group(1), set()).add(f)
    return out


def html_ids(path):
    src = io.open(path, encoding='utf-8').read()
    return set(re.findall(r'id="([^"]+)"', src))


def main():
    html = os.path.join(WWW, 'index.html')
    js_files = [f for f in sorted(os.listdir(WWW)) if f.endswith('.js')]

    bad = 0

    for f in js_files:
        src = io.open(os.path.join(WWW, f), encoding='utf-8').read()
        dups = dup_functions(src)
        if dups:
            bad += 1
            print(f'  ✗ {f}: 重复函数名 {", ".join(dups)}')
        else:
            print(f'  ✓ {f} 无重复函数名')

    ids_in_html = html_ids(html)
    # 动态创建的节点：JS 用 innerHTML 拼出来的，id 出现在 JS 字符串里
    dynamic = set()
    for f in js_files:
        src = io.open(os.path.join(WWW, f), encoding='utf-8').read()
        dynamic |= set(re.findall(r"""id=["']([A-Za-z][\w-]*)""", src))
        dynamic |= set(re.findall(r"""id=\\?["']([A-Za-z][\w-]*)""", src))

    missing = []
    for ident, where in sorted(js_ids(js_files).items()):
        if ident in ids_in_html or ident in dynamic:
            continue
        missing.append(f'{ident} (被 {",".join(sorted(where))} 引用)')

    if missing:
        bad += 1
        print('  ✗ HTML 里找不到这些 id：')
        for m in missing:
            print('      ' + m)
    else:
        print(f'  ✓ JS 引用的 {len(js_ids(js_files))} 个 id 在 HTML 里都有')

    return 1 if bad else 0


if __name__ == '__main__':
    sys.exit(main())
