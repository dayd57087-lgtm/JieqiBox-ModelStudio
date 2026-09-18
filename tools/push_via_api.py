#!/usr/bin/env python3
"""用 GitHub REST API 推送本地改动。

github.com:443 不通、但 api.github.com 通的时候用这个。
只更新相对 base 有变化的文件，做成一次原子提交。
"""
import base64
import json
import os
import subprocess
import sys
import urllib.request

REPO = "dayd57087-lgtm/JieqiBox-ModelStudio"
BRANCH = "main"
API = "https://api.github.com"


def token():
    t = os.environ.get("GITHUB_PAT", "").strip()
    if not t:
        sys.exit("GITHUB_PAT 未设置")
    return t


def call(method, path, body=None):
    url = path if path.startswith("http") else API + path
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Authorization", "token " + token())
    req.add_header("Accept", "application/vnd.github+json")
    if data:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            raw = r.read()
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        detail = e.read().decode(errors="replace")[:400]
        sys.exit(f"{method} {path} -> {e.code}\n{detail}")


def git(*args):
    return subprocess.run(["git"] + list(args), cwd=ROOT, check=True,
                          capture_output=True, text=True).stdout.strip()


ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

if __name__ == "__main__":
    msg = sys.argv[1] if len(sys.argv) > 1 else "更新"

    # 1) 远端当前状态
    ref = call("GET", f"/repos/{REPO}/git/ref/heads/{BRANCH}")
    parent = ref["object"]["sha"]
    base_tree = call("GET", f"/repos/{REPO}/git/commits/{parent}")["tree"]["sha"]
    print("远端 HEAD:", parent[:8])

    # 2) 本地相对远端 HEAD 改了哪些文件
    changed = subprocess.run(
        ["git", "diff", "--name-status", parent, "HEAD"],
        cwd=ROOT, capture_output=True, text=True).stdout.strip().splitlines()
    if not changed:
        print("没有改动，退出")
        sys.exit(0)

    entries = []
    for line in changed:
        parts = line.split("\t")
        status, path = parts[0], parts[-1]
        full = os.path.join(ROOT, path)
        if status == "D":
            entries.append({"path": path, "mode": "100644", "type": "blob", "sha": None})
            print("  删除", path)
            continue
        with open(full, "rb") as f:
            blob = call("POST", f"/repos/{REPO}/git/blobs", {
                "content": base64.b64encode(f.read()).decode(),
                "encoding": "base64",
            })
        mode = "100755" if os.access(full, os.X_OK) else "100644"
        entries.append({"path": path, "mode": mode, "type": "blob", "sha": blob["sha"]})
        print("  更新", path, os.path.getsize(full), "字节")

    # 3) 建 tree / commit / 移动分支
    tree = call("POST", f"/repos/{REPO}/git/trees",
                {"base_tree": base_tree, "tree": entries})
    commit = call("POST", f"/repos/{REPO}/git/commits",
                  {"message": msg, "tree": tree["sha"], "parents": [parent]})
    call("PATCH", f"/repos/{REPO}/git/refs/heads/{BRANCH}",
         {"sha": commit["sha"], "force": False})

    print("已推送:", commit["sha"][:8])
    print(f"https://github.com/{REPO}/commit/{commit['sha']}")
