#!/usr/bin/env python3
"""pre-commit 훅 검사 — 메인은 막고 워크트리는 통과시키는가.

**격리 저장소를 세워 실제로 `git commit` 을 돌린다.** 훅을 직접 실행해 보는 것으로는
부족하다 — git 이 어느 cwd 에서 어떻게 부르는지가 이 훅 판정의 전부이기 때문이다.

⚠️ 실제 레포를 건드리지 않는다. 임시 디렉토리에 저장소를 새로 만든다.
⚠️ 「막는 쪽」과 「통과하는 쪽」을 함께 잰다 — 전부 막는 훅도 막는 검사만으론 통과한다.
"""
import os, shutil, subprocess, sys, tempfile, time

HERE = os.path.dirname(os.path.abspath(__file__))
HOOK = os.path.join(HERE, "pre-commit")
TMP = tempfile.mkdtemp(prefix="precommit-")
fail = 0


def check(label, ok):
    global fail
    fail += not ok
    print(f"{'✓' if ok else '✗'} {label}")


def git(cwd, *a, **kw):
    r = subprocess.run(("git", "-C", cwd) + a, capture_output=True, text=True, **kw)
    return r.returncode, (r.stdout + r.stderr).strip()


def build(hook_src):
    """저장소 + 워크트리를 세우고 훅을 심는다."""
    root = tempfile.mkdtemp(prefix="repo-", dir=TMP)
    main = os.path.join(root, "main")
    subprocess.run(["git", "init", "-q", main], check=True)
    for k, v in (("user.email", "t@t"), ("user.name", "t")):
        git(main, "config", k, v)
    open(os.path.join(main, "A.md"), "w").write("v1\n")
    git(main, "add", "A.md")
    git(main, "commit", "-qm", "init", "--no-verify")     # 훅 심기 전이지만 명시해 둔다

    hooks = os.path.join(main, "scripts", "git-hooks")
    os.makedirs(hooks, exist_ok=True)
    p = os.path.join(hooks, "pre-commit")
    open(p, "w", encoding="utf-8").write(hook_src)
    os.chmod(p, 0o755)
    git(main, "config", "core.hooksPath", "scripts/git-hooks")

    wt = os.path.join(root, "wt")
    git(main, "worktree", "add", "-q", wt, "-b", "side")
    return main, wt


def touch_and_commit(cwd, name, *extra):
    open(os.path.join(cwd, name), "w").write("x\n")
    git(cwd, "add", name)
    return git(cwd, "commit", "-m", f"probe {name}", *extra)


try:
    src = open(HOOK, encoding="utf-8").read()
    main, wt = build(src)

    # ① 메인 트리 커밋 → 막힌다
    rc, out = touch_and_commit(main, "m1.txt")
    check("메인 트리 커밋은 막힌다", rc != 0)
    check("막은 이유를 사람이 읽을 수 있다", "워크트리" in out)

    # ② 워크트리 커밋 → 통과한다 (전부 막는 훅이 아니라는 증거)
    rc, out = touch_and_commit(wt, "w1.txt")
    check("워크트리 커밋은 통과한다", rc == 0)

    # ③ --no-verify 는 우회된다 — 알려진 한계이므로 **성질로 고정**해 둔다.
    #    (막을 수 없는 것을 막힌 척하면 다음 사람이 이 훅을 경계로 오해한다.)
    rc, out = touch_and_commit(main, "m2.txt", "--no-verify")
    check("--no-verify 는 우회된다(알려진 한계)", rc == 0)

    # ④ 구제 파일 → 통과, 만료되면 다시 막힌다
    common = git(main, "rev-parse", "--path-format=absolute", "--git-common-dir")[1]
    rescue = os.path.join(common, "claude-main-tree-rescue")
    open(rescue, "w").close()
    rc, out = touch_and_commit(main, "m3.txt")
    check("구제 파일이 있으면 통과한다", rc == 0)
    open(rescue, "w").close()
    os.utime(rescue, (0, 0))                       # 30분보다 훨씬 오래된 것으로
    rc, out = touch_and_commit(main, "m4.txt")
    check("만료된 구제 파일은 통과시키지 않는다", rc != 0)
    check("만료된 구제 파일은 치워진다", not os.path.exists(rescue))

    # ⑤ 변이 — 메인 판정을 무력화하면 정말 통과하는가(검사가 공허하지 않다는 증거)
    mut = src.replace("if os.path.realpath(gd) != os.path.realpath(gc):",
                      "if True:")
    assert mut != src, "변이가 안 심겼다 — 이 검사는 무의미하다"
    main2, _ = build(mut)
    rc, out = touch_and_commit(main2, "x.txt")
    check("변이본은 메인 커밋을 통과시킨다(검사가 공허하지 않음)", rc == 0)
finally:
    shutil.rmtree(TMP, ignore_errors=True)

print("\n실패", fail, "건")
sys.exit(1 if fail else 0)
