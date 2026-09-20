#!/usr/bin/env python3
"""按文件列表直接推送到 GitHub（不需要本地 git 历史）。

为什么不用 tools/push_via_api.py：
那个脚本靠 `git diff <远端HEAD> HEAD` 找出改了什么，前提是本地有远端
那个 commit 的对象。而这个沙箱里 git 走 HTTPS 很不稳 —— clone 能成，
fetch 十次有九次断在半路。于是：
  本地改完 → 推到远端（API）→ 远端 HEAD 变了，本地却没有那个对象
  → 下次推送直接卡在「本地没有对象 xxxx」

这个脚本把依赖反过来：改哪些文件由命令行说，远端状态现查。
不碰本地 git，也就不会再有「本地和远端对不上」这回事。

用法：
    python3 tools/push_files.py "提交说明" 文件1 文件2 ...
    python3 tools/push_files.py --text "说明文件.md" 文件1 文件2 ...
"""
import base64
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request

REPO = "dayd57087-lgtm/JieqiBox-ModelStudio"
BRANCH = "main"
API = "https://api.github.com"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def token():
    t = os.environ.get("GITHUB_PAT", "").strip()
    if not t:
        sys.exit("GITHUB_PAT 未设置")
    return t


def call(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(API + path, data=data, method=method)
    req.add_header("Authorization", "token " + token())
    req.add_header("Accept", "application/vnd.github+json")
    if data:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=90) as r:
            raw = r.read()
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        sys.exit("%s %s -> %s\n%s" % (method, path, e.code,
                                      e.read().decode(errors="replace")[:500]))


def git(*args):
    return subprocess.run(["git"] + list(args), cwd=ROOT, check=True,
                          capture_output=True, text=True).stdout.strip()


def main():
    args = sys.argv[1:]
    if not args:
        sys.exit(__doc__)

    msg_file = None
    if args[0] == "--text":
        msg_file = args[1]
        args = args[2:]
    if len(args) < 2:
        sys.exit(__doc__)

    message = args[0]
    paths = args[1:]
    if msg_file:
        with open(msg_file, encoding="utf-8") as f:
            message = f.read().strip()

    parent = call("GET", "/repos/%s/git/ref/heads/%s" % (REPO, BRANCH))["object"]["sha"]
    base_tree = call("GET", "/repos/%s/git/commits/%s" % (REPO, parent))["tree"]["sha"]
    print("远端 HEAD:", parent[:8])

    entries = []
    for path in paths:
        full = os.path.join(ROOT, path)
        if not os.path.exists(full):
            sys.exit("找不到文件: " + path)
        with open(full, "rb") as f:
            blob = call("POST", "/repos/%s/git/blobs" % REPO, {
                "content": base64.b64encode(f.read()).decode(),
                "encoding": "base64",
            })
        entries.append({"path": path, "mode": "100644", "type": "blob",
                        "sha": blob["sha"]})
        print("  更新 %s (%d 字节)" % (path, os.path.getsize(full)))

    tree = call("POST", "/repos/%s/git/trees" % REPO,
                {"base_tree": base_tree, "tree": entries})
    commit = call("POST", "/repos/%s/git/commits" % REPO,
                  {"message": message, "tree": tree["sha"], "parents": [parent]})
    call("PATCH", "/repos/%s/git/refs/heads/%s" % (REPO, BRANCH),
         {"sha": commit["sha"], "force": False})

    print("已推送:", commit["sha"][:8])
    print("https://github.com/%s/commit/%s" % (REPO, commit["sha"]))

    # 顺手把本地 git 也对齐，免得下次又出现「本地没有对象」
    try:
        git("fetch", "origin", BRANCH)
        git("reset", "--soft", "origin/" + BRANCH)
        print("本地已对齐到远端")
    except Exception:
        print("（本地 git 没跟上，不影响远端；下次推送用这个脚本就绕开了）")


if __name__ == "__main__":
    main()
