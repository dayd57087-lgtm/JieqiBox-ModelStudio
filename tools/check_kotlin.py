#!/usr/bin/env python3
"""检查 Kotlin 文件里的「裸调用」是否有对应 import。

为什么需要它：这个沙箱里 JVM 起不来，Kotlin 编译不了，
只能靠 CI 报错。而「用了某个类但忘了 import」是最常见的一类编译错误 ——
写的时候顺手，改的时候容易漏。本地静态查一遍能省一次 CI 往返。

用法：
    python3 tools/check_kotlin.py app/src/main/java/com/jieqibox/modelstudio
"""
import io
import os
import re
import sys

# Kotlin / Java 内置，不需要 import
BUILTIN = {
    'Math', 'System', 'Thread', 'String', 'Int', 'Long', 'Double', 'Float',
    'Boolean', 'Byte', 'Short', 'Char', 'Any', 'Unit', 'Nothing', 'List',
    'Map', 'Set', 'Pair', 'Triple', 'Array', 'Exception', 'RuntimeException',
    'IllegalStateException', 'IllegalArgumentException', 'Error',
    'StringBuilder', 'CharSequence', 'Comparable', 'Iterable',
    'Runnable', 'ThreadLocal', 'Class', 'Object', 'Enum', 'Number',
    'Integer', 'Double', 'Float',
}

# Android 自动生成的，不需要 import
GENERATED = {'R', 'BuildConfig'}


def imports_of(src):
    """返回这个文件 import 的简单类名"""
    out = set()
    for m in re.finditer(r'^import\s+([\w.]+)', src, re.M):
        out.add(m.group(1).split('.')[-1])
    return out


def declared_in_file(src):
    """文件里自己定义的类型"""
    out = set()
    for m in re.finditer(r'\b(?:class|interface|object|enum class)\s+(\w+)', src):
        out.add(m.group(1))
    for m in re.finditer(r'\b(?:val|var|fun)\s+(\w+)', src):
        out.add(m.group(1))
    return out


def check(path):
    src = io.open(path, encoding='utf-8').read()
    # 去掉注释和字符串，避免把注释里提到的类名算进来
    body = re.sub(r'/\*.*?\*/', '', src, flags=re.S)
    body = re.sub(r'//[^\n]*', '', body)
    body = re.sub(r'"""(?:.|\n)*?"""', '""', body)
    body = re.sub(r'"(?:[^"\\]|\\.)*"', '""', body)

    imported = imports_of(src)
    declared = declared_in_file(src)
    samepkg = os.path.basename(path)

    # 找出所有「大写开头标识符 . 成员」的用法。
    #
    # 前面的负向后顾是关键：`Bitmap.CompressFormat.create()` 里的 CompressFormat
    # 前面是点号，说明它是嵌套类访问，不需要 import。
    # 只有出现在行首/空格后的类名才是「裸引用」。
    used = set()
    for m in re.finditer(r'(?<![.\w])([A-Z]\w*)\s*\.', body):
        used.add(m.group(1))

    problems = []
    for name in sorted(used):
        if name in BUILTIN or name in GENERATED or name in imported:
            continue
        if name in declared:
            continue
        problems.append(name)

    return problems, imported


# 只在 androidx.activity.ComponentActivity / AppCompatActivity 上才有的 API。
# 继承 android.app.Activity 的类用了它们就是编译错误。
COMPONENT_ONLY = {
    'registerForActivityResult': 'androidx.activity.ComponentActivity',
    'onBackPressedDispatcher': 'androidx.activity.ComponentActivity',
    'activityResultRegistry': 'androidx.activity.ComponentActivity',
}


def check_base_class_api(path):
    """检查是否在不支持某个 API 的基类上用了它"""
    src = io.open(path, encoding='utf-8').read()
    m = re.search(r'class\s+(\w+)\s*:\s*(\w+)', src)
    if not m:
        return []
    base = m.group(2)
    if base not in ('Activity', 'Service', 'Application'):
        return []
    problems = []
    for api, owner in COMPONENT_ONLY.items():
        # 只看代码，不看注释
        body = re.sub(r'/\*.*?\*/', '', src, flags=re.S)
        body = re.sub(r'//[^\n]*', '', body)
        if re.search(r'\b' + api + r'\b', body):
            problems.append(f'{api} 需要 {owner}，但基类是 {base}')
    return problems


def main():
    root = sys.argv[1] if len(sys.argv) > 1 else '.'
    files = sorted(
        os.path.join(root, f) for f in os.listdir(root) if f.endswith('.kt')
    )
    if not files:
        print('没找到 .kt 文件')
        return 1

    # 收集所有文件里定义的类型（同包互访不需要 import）
    all_declared = set()
    for f in files:
        all_declared |= declared_in_file(io.open(f, encoding='utf-8').read())

    bad = 0
    for f in files:
        problems, imported = check(f)
        problems = [p for p in problems if p not in all_declared]
        problems += check_base_class_api(f)
        name = os.path.basename(f)
        if problems:
            bad += 1
            print(f'  ✗ {name}: 可能缺少 import → {", ".join(problems)}')
        else:
            print(f'  ✓ {name}')

    if bad:
        print(f'\n{bad} 个文件有可疑引用。若确认是同包里定义的类型，可忽略。')
        return 1
    print('\n全部通过')
    return 0


if __name__ == '__main__':
    sys.exit(main())
