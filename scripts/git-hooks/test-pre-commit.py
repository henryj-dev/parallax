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

    # ⑤ **메인이 feature 브랜치에 있을 때 시키는 것이 맞는가.**
    #    막는 것은 브랜치와 무관하게 맞았지만, 예전 로직은 기준을 `origin/HEAD` 에서만
    #    읽어 「그 작업을 버리고 기본 브랜치에서 새로 따서 기본 브랜치로 push 하라」고
    #    인쇄했다(2026-08-17 barycenter: 그 브랜치에만 177 커밋, origin 에 아직 없음).
    #    거부보다 조언이 더 위험하다 — 거부는 다시 생각하게 만들지만 조언은 복사된다.
    main3, _ = build(src)
    git(main3, "checkout", "-q", "-b", "design/feature-x")
    rc, out = touch_and_commit(main3, "f1.txt")
    check("feature 브랜치에서도 막는다", rc != 0)
    check("push 대상이 그 브랜치다", "HEAD:design/feature-x" in out)
    check("업스트림이 없으면 로컬 팁을 기준으로 준다",
          "-b <브랜치> design/feature-x" in out)

    # ⑥ 업스트림이 있으면 기준은 **원격 쪽**이어야 한다(로컬 팁이 아니라).
    #    🔴 `remote set-head` 를 **반드시** 세운다. 없으면 예전 로직도 자기 `@{u}` 폴백으로
    #    같은 답을 내서 이 검사가 **공허해진다** — 2026-08-17 실측으로 확인했다(옛/새 출력이
    #    바이트 동일). 옛것과 갈라지는 모양은 「업스트림 **과** origin/HEAD 가 함께 있는」
    #    것뿐이고, 그것이 바로 이 수정을 부른 barycenter 의 모양이다.
    bare = tempfile.mkdtemp(prefix="bare-", dir=TMP)
    subprocess.run(["git", "init", "-q", "--bare", bare], check=True)
    git(main3, "remote", "add", "origin", bare)
    git(main3, "push", "-q", "-u", "origin", "design/feature-x")
    git(main3, "push", "-q", "origin", "HEAD:refs/heads/trunk")
    git(main3, "remote", "set-head", "origin", "trunk")
    rc, out = touch_and_commit(main3, "f2.txt")
    check("origin/HEAD 가 있어도 기본 브랜치로 끌려가지 않는다", "HEAD:trunk" not in out)
    check("업스트림이 있으면 기준은 origin/<그 브랜치>", "origin/design/feature-x" in out)
    check("push 대상은 여전히 그 브랜치", "HEAD:design/feature-x" in out)

    # ⑦ push 대상은 **원격 쪽 이름**이다. 로컬과 다를 수 있고, 로컬 이름으로 적으면
    #    추적하던 ref 대신 원격에 갈라진 브랜치를 만든다.
    git(main3, "checkout", "-q", "-b", "feat")
    git(main3, "push", "-q", "-u", "origin", "feat:feat-remote")
    rc, out = touch_and_commit(main3, "f4.txt")
    check("push 대상은 원격 쪽 이름(로컬 이름이 아니라)",
          "HEAD:feat-remote" in out and "HEAD:feat " not in out)

    # ⑧ 브랜치를 모를 때(detached)만 `origin/HEAD` 로 폴백한다. 기본 브랜치 이름은
    #    **픽스처가 정한다**(⑥ 에서 `trunk` 로 세웠다) — `init.defaultBranch` 에 기대면
    #    머신마다 master/main 으로 갈려 검사가 흔들린다.
    git(main3, "checkout", "-q", "--detach")
    rc, out = touch_and_commit(main3, "f3.txt")
    check("detached 면 origin/HEAD 로 폴백한다", "origin/trunk" in out)

    # ⑨ 커밋이 없는 저장소(unborn HEAD). `symbolic-ref` 는 **성공하므로** 이름을 그대로
    #    믿으면 존재하지 않는 ref 를 기준으로 준다(`fatal: invalid reference`). 모른다고
    #    말하는 것이 맞다 — 이 훅의 원칙이다.
    root5 = tempfile.mkdtemp(prefix="unborn-", dir=TMP)
    subprocess.run(["git", "init", "-q", root5], check=True)
    hooks5 = os.path.join(root5, "scripts", "git-hooks")
    os.makedirs(hooks5, exist_ok=True)
    open(os.path.join(hooks5, "pre-commit"), "w", encoding="utf-8").write(src)
    os.chmod(os.path.join(hooks5, "pre-commit"), 0o755)
    git(root5, "config", "core.hooksPath", "scripts/git-hooks")
    for k, v in (("user.email", "t@t"), ("user.name", "t")):
        git(root5, "config", k, v)
    unborn = git(root5, "symbolic-ref", "--short", "HEAD")[1]      # 이름은 있으나 ref 는 없다
    rc, out = touch_and_commit(root5, "u1.txt")
    check("커밋 없는 저장소도 막는다", rc != 0)
    #    이름을 문구로 넣지 않는 것 자체를 잰다 — 자리표시자 문구가 바뀌어도 성립하도록.
    check("unborn HEAD 에서는 없는 ref 를 기준으로 주지 않는다",
          bool(unborn) and f" {unborn}\n" not in out and f"rebase {unborn} " not in out)

    # ⑧ 변이 — 메인 판정을 무력화하면 정말 통과하는가(검사가 공허하지 않다는 증거)
    mut = src.replace("if os.path.realpath(gd) != os.path.realpath(gc):",
                      "if True:")
    assert mut != src, "변이가 안 심겼다 — 이 검사는 무의미하다"
    main2, _ = build(mut)
    rc, out = touch_and_commit(main2, "x.txt")
    check("변이본은 메인 커밋을 통과시킨다(검사가 공허하지 않음)", rc == 0)

    # ⑨ 변이 — 기준을 예전처럼 `origin/HEAD` 에서만 읽으면 feature 브랜치를 놓치는가.
    #    ⑤⑥ 이 공허하지 않다는 증거다. 놓친 결과가 「조용한 무응답」이 아니라 **다른
    #    브랜치로 push 하라는 문장**이므로, 그것이 실제로 되살아나는지 본다.
    mut2 = src.replace('rc, branch = git("symbolic-ref", "--short", "HEAD")',
                       'rc, branch = git("symbolic-ref", "--short", "refs/remotes/origin/HEAD")')
    assert mut2 != src, "변이가 안 심겼다 — 이 검사는 무의미하다"
    main4, _ = build(mut2)
    git(main4, "checkout", "-q", "-b", "design/feature-y")
    rc, out = touch_and_commit(main4, "y.txt")
    check("변이본은 feature 브랜치를 놓친다(기준 검사가 공허하지 않음)",
          "HEAD:design/feature-y" not in out)
finally:
    shutil.rmtree(TMP, ignore_errors=True)

print("\n실패", fail, "건")
sys.exit(1 if fail else 0)
