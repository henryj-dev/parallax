#!/usr/bin/env bash
# What a range of commits changes that ends up in the image, and what does not.
#
# A deployment on the other end decides with this, and until now it came from
# somebody remembering which paths ship. That memory got worse rather than
# better: an earlier report listed `public/` as its own row, a later one for the
# same kind of range said "no server change -- src/ is untouched" and left
# `public/` out. `public/` is what the browser is served.
#
# So the list is read out of the Dockerfile rather than written here again. A
# third copy of that fact is what makes two copies drift.
#
#   scripts/what-ships.sh <range>        e.g. 7bea218..origin/main
set -euo pipefail

range="${1:-}"
[[ -n "$range" ]] || { echo "usage: scripts/what-ships.sh <git range>" >&2; exit 2; }

# The repository, not this file's neighbourhood. Resolving the root as "one up
# from wherever this script sits" makes the answer depend on where somebody put
# it -- and a tool whose whole purpose is to be copied into another checkout will
# be put somewhere else. Asking git works from any directory in any worktree.
root="$(git rev-parse --show-toplevel 2>/dev/null || true)"
[[ -n "$root" ]] || { echo "❌ git 저장소 안에서 실행해야 합니다" >&2; exit 1; }
cd "$root"
[[ -f Dockerfile ]] || { echo "❌ $root 에 Dockerfile 이 없습니다 — 여기서는 무엇이 실리는지 알 수 없습니다" >&2; exit 1; }

# What reaches the image, read from the Dockerfile rather than written here.
#
# Two kinds of COPY land in the final stage, and only counting the first kind is
# how this used to answer "nothing ships" for a release that changed `src/`:
#
#   COPY public ./public              -- a tracked path, straight in
#   COPY --from=build /app/dist ./dist -- the output of a stage, built from tracked paths
#
# Skipping the second was deliberate once: earlier stages copy the whole tree in
# to build it, so counting their COPYs called every file shipped. That rule
# stopped an over-report and started an under-report, which is the quieter of the
# two and the one that matters -- a deployment reading "nothing ships" decides
# nothing needs a human.
#
# So a stage is followed instead of skipped: whatever that stage copies in is an
# input to what it produces. Where a stage takes the whole tree (`COPY . .`), the
# tree is narrowed by what the build actually compiles -- `package.json` names
# the build command, the command names a tsconfig, the tsconfig names its inputs.
# Every step reads the fact where it already lives. If that chain cannot be
# followed the whole tree is used, which over-reports rather than under-reports.
stage_sources() {
  awk -v want="$1" '
    /^FROM /   { stage = ""; for (i = 2; i <= NF; i++) if (tolower($i) == "as") stage = $(i + 1) }
    /^COPY /   { if (stage != want) next
                 if ($0 ~ /--from=/) next
                 for (i = 2; i < NF; i++) if ($i !~ /^--/) print $i }
  ' Dockerfile | sed 's|/$||'
}

# The paths a `tsc -p …` build compiles, from the tsconfig the build script names.
#
# Read as JSON rather than with a line pattern: a pretty-printed config and a
# compact one carry the same fact, and a reader that only sees one of them
# reports "could not tell" for a repository that told it plainly.
#
# A tsconfig can name a parent, and this repository's does -- `tsconfig.build.json`
# extends `tsconfig.json`, which is where the options that shape `dist` actually
# live. Reading only the file the build names reads one link of a chain, and it
# cannot even tell that the child's `include` is the last word: the parent is
# where that would have come from had the child left it out. So the chain is
# walked to the end, the nearest `include` wins the way tsc merges them, and
# every file on the way counts as a file the answer was read out of. A link that
# cannot be followed is not guessed at -- the whole tree is used, which
# over-reports rather than under-reports.
build_inputs() {
  node -e '
    const fs = require("node:fs");
    const path = require("node:path");
    const read = [];
    const load = (file) => { read.push(file); return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\s*\/\/.*$/gm, "")); };
    // Where a parent named by a child lives: beside it, or in a package. tsc
    // lets the .json be left off, so a name that is not a file is tried again
    // with it before it is called unreadable.
    const locate = (spec, child) => {
      const dir = path.dirname(child);
      let file = spec.startsWith(".") || path.isAbsolute(spec)
        ? path.resolve(dir, spec)
        : require.resolve(spec, { paths: [path.resolve(dir)] });
      if (!fs.existsSync(file)) file += ".json";
      if (!fs.existsSync(file)) throw new Error("unreadable: " + spec);
      return path.relative(process.cwd(), file);
    };
    // A config compiles what it says it compiles, or else what its parents say.
    // A later parent beats an earlier one and the child beats both, which is the
    // order tsc reads them in. Every config on the way is recorded by load.
    const seen = new Set();
    const compiles = (file) => {
      if (seen.has(file)) throw new Error("cycle: " + file);
      seen.add(file);
      const config = load(file);
      let inherited;
      for (const parent of config.extends === undefined ? [] : [].concat(config.extends)) {
        const found = compiles(locate(parent, file));
        if (found) inherited = found;
      }
      const own = Array.isArray(config.include) && config.include.length > 0 ? config.include : undefined;
      return own ? { globs: own, base: path.dirname(file) } : inherited;
    };
    const pkg = load("package.json");
    const build = pkg.scripts && pkg.scripts.build;
    if (!build) process.exit(1);
    const named = /-p\s+(\S+)/.exec(build);
    if (!named) process.exit(1);
    let compiled;
    try { compiled = compiles(named[1]); } catch { process.exit(1); }
    if (!compiled) process.exit(1);
    // A relative path in a config is relative to that config, so a glob
    // inherited from a parent elsewhere is rooted where the parent sits.
    const roots = new Set(compiled.globs
      .map((glob) => glob.split("/*")[0].replace(/\/$/, ""))
      .filter(Boolean)
      .map((root) => path.relative(process.cwd(), path.resolve(compiled.base, root)))
      .filter((root) => root && !root.startsWith("..")));
    if (roots.size === 0) process.exit(1);
    // Which files this answer was read out of, so a change to one of them can
    // be reported as "the list itself moved" rather than classified against it.
    process.stdout.write([...roots].map((r) => "root:" + r).concat(read.map((f) => "from:" + f)).join("\n") + "\n");
  ' 2>/dev/null
}

ships=()
# Every file this answer was read out of. A change to one of them is not a
# change to classify -- it is a change to what the classification means.
derived_from=("Dockerfile")
# And the one that decides what those paths actually contain, which this tool
# does not read at all.
#
# `.dockerignore` is applied to the build context before any COPY runs, so a
# path listed above ships whatever survives it. Adding `public/vendor/` to it
# takes those files out of the image while every path in the list, and every
# file in the range, stays exactly where it was -- and the answer came out
# `✅ 실리는 변경 없음` with `.dockerignore` filed under what does not ship. That is
# the same wrong answer the two configs used to get, in the same quiet
# direction: not "could not classify" but "classified as harmless".
#
# It is listed separately from the files above because the honest sentence
# differs. Those were opened; this one was not. Narrowing the list by its
# patterns would be the other half of the job and is deliberately not done here
# -- a pattern parsed wrong would drop a path from the list, which is the quiet
# direction again. Not narrowing over-reports, and over-reporting is the side
# this tool takes everywhere else.
decides_context=(".dockerignore")
# And the sentence for a range this tool did not classify at all.
#
# When a whole-tree stage cannot be narrowed the list widens to `.`, every file
# lands on the shipping side, and until now the only thing that said why went to
# stderr. That is the shape `c2fb95d` already fixed once for the files above: the
# one consumer greps stdout for the two verdicts, so a reason aimed past them
# reaches nobody -- and here it is worse than a missing note, because the verdict
# is not an over-report of a classification, it is the absence of one. A human
# reading `🔴 실립니다 tsconfig.test.json` with nothing beside it goes looking for
# how that file reaches the image. It does not; the chain to the build broke.
#
# Empty unless the fallback fired. A final stage that genuinely does `COPY . .`
# also puts `.` on the list, and for that one "everything ships" is the answer
# rather than the failure to reach one -- so it keeps the bare line.
widened_why=""
add_path() {
  local candidate="$1"
  [[ -n "$candidate" ]] || return 0
  for existing in "${ships[@]:-}"; do [[ "$existing" == "$candidate" ]] && return 0; done
  ships+=("$candidate")
}

while IFS= read -r line; do
  case "$line" in
    *--from=*)
      stage="$(sed -n 's/.*--from=\([A-Za-z0-9_.-]*\).*/\1/p' <<< "$line")"
      while IFS= read -r source; do
        if [[ "$source" == "." ]]; then
          if narrowed="$(build_inputs)" && [[ -n "$narrowed" ]]; then
            while IFS= read -r input; do
              case "$input" in
                root:*) add_path "${input#root:}" ;;
                from:*) derived_from+=("${input#from:}") ;;
              esac
            done <<< "$narrowed"
          else
            echo "⚠️ 스테이지 '$stage' 가 트리 전체를 가져가는데 빌드 입력을 못 읽었습니다 — 전부 실린다고 봅니다." >&2
            widened_why="빌드 입력을 못 읽어 트리 전체를 실린다고 봤습니다: 이 줄은 분류가 아니라 분류 실패입니다"
            add_path "."
          fi
        else
          add_path "$source"
        fi
      done < <(stage_sources "$stage")
      ;;
    *)
      for token in $line; do
        case "$token" in COPY|--*|*/) continue;; esac
        add_path "$token"
      done
      ;;
  esac
done < <(awk '/^FROM /{ copies = "" } /^COPY /{ copies = copies $0 "\n" } END { printf "%s", copies }' Dockerfile |
  sed '/^$/d' | sed 's/\(.*\) [^ ]*$/\1/')

# The control. A parse that finds nothing would report every change as harmless,
# which is the one direction that matters -- so it has to find something, and it
# has to find the portal, which is the path this got wrong.
(( ${#ships[@]} > 0 )) || { echo "❌ Dockerfile 에서 COPY 대상을 못 읽었습니다" >&2; exit 1; }
printf '%s\n' "${ships[@]}" | grep -qx "public" ||
  { echo "❌ 읽어낸 목록에 public 이 없습니다 — 파싱이 어긋났습니다: ${ships[*]}" >&2; exit 1; }

echo "이미지에 실리는 경로(Dockerfile 에서 읽음): ${ships[*]}"
echo

changed="$(git -c core.quotepath=false diff --name-only "$range")"
[[ -n "$changed" ]] || { echo "변경 없음"; exit 0; }

# The list above is read from the Dockerfile as it is now, and applied to a range
# that may predate it. If one of the files the answer was read out of moved
# inside that range, what ships was not the same at both ends and this
# classification is only true of one end.
#
# Those files are counted on the shipping side rather than classified against the
# list. Saying so in a warning alone left the verdict line reading
# `✅ 실리는 변경 없음` with the file listed under "does not ship" -- and the verdict
# line is the part a machine reads. The one consumer of this output greps for the
# two verdicts, so a warning aimed past them reached nobody, and the range where
# it fires is exactly the range where the verdict is least trustworthy.
#
# It was not merely unclassified, either. A `target` in `tsconfig.json` changes
# every file in `dist`, so "does not ship" was wrong -- and wrong in the quiet
# direction, which is the one that matters.
#
# Counting them as shipping keeps the answer inside the interface that already
# exists rather than adding a third verdict nothing greps for. It says what the
# warning was already asking for -- that a human decides -- in the words that
# reach the thing which has to stop.
#
# Each one carries the sentence it is reported with. A file this tool opened and
# one it never looked at are both reasons the classification does not hold, but
# they are not the same reason, and this line is read at the place a release
# stopped -- a wrong reason there sends the next person to the wrong file.
moved=()
moved_why=()
note_moved() {
  local source="$1" why="$2" already
  grep -qx "$source" <<< "$changed" || return 0
  for already in ${moved[@]+"${moved[@]}"}; do [[ "$already" == "$source" ]] && return 0; done
  moved+=("$source")
  moved_why+=("$why")
}
for source in "${derived_from[@]}"; do
  note_moved "$source" "이 답을 읽어 낸 파일입니다: 무엇이 어떻게 실리는지를 정합니다"
done
for source in ${decides_context[@]+"${decides_context[@]}"}; do
  note_moved "$source" "이 도구가 안 읽는 파일입니다: 위 목록의 경로가 실제로 무엇을 담는지를 정합니다"
done
if (( ${#moved[@]} > 0 )); then
  echo "⚠️ 이 범위 안에서 ${moved[*]} 이(가) 바뀌었습니다 — 무엇이 실리는지가 범위 내내 같지 않습니다."
  echo "   그 파일들은 아래에서 **실리는 쪽**으로 셉니다. 나머지 분류는 **지금의** 그 파일들 기준입니다 — 사람이 읽어야 합니다."
  echo
fi

shipped=""
rest=""
while IFS= read -r file; do
  [[ -n "$file" ]] || continue
  hit=""
  why=""
  # A file the answer came from is decided before the list is consulted: the list
  # is what that file decides, so its absence from the list says nothing.
  #
  # Indexed rather than `for … in "${!moved[@]}"`: this runs under `set -u` on
  # bash 3.2, where expanding an empty array's indices is an unbound variable.
  index=0
  while (( index < ${#moved[@]} )); do
    [[ "$file" == "${moved[$index]}" ]] && { hit="basis"; why="${moved_why[$index]}"; break; }
    index=$(( index + 1 ))
  done
  if [[ -z "$hit" ]]; then
    for path in "${ships[@]}"; do
      # `.` is the whole tree -- the fallback for a stage whose inputs could not be
      # narrowed. Matching it literally matched nothing, so the over-report it was
      # supposed to be was silently no report at all.
      if [[ "$path" == "." ]]; then
        if [[ -n "$widened_why" ]]; then hit="basis"; why="$widened_why"; else hit=1; fi
        break
      fi
      if [[ "$file" == "$path" || "$file" == "$path"/* ]]; then hit=1; break; fi
    done
  fi
  case "$hit" in
    basis) shipped+="  $file — $why"$'\n' ;;
    "")    rest+="  $file"$'\n' ;;
    *)     shipped+="  $file"$'\n' ;;
  esac
done <<< "$changed"

if [[ -n "$shipped" ]]; then
  echo "🔴 실립니다 — 배포되면 동작이 바뀝니다"
  printf '%s' "$shipped"
else
  echo "✅ 실리는 변경 없음"
fi
echo
echo "실리지 않습니다"
printf '%s' "${rest:-  (없음)
}"
