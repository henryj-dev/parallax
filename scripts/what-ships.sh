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
build_inputs() {
  node -e '
    const fs = require("node:fs");
    const read = [];
    const load = (file) => { read.push(file); return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\s*\/\/.*$/gm, "")); };
    const pkg = load("package.json");
    const build = pkg.scripts && pkg.scripts.build;
    if (!build) process.exit(1);
    const named = /-p\s+(\S+)/.exec(build);
    if (!named) process.exit(1);
    const config = load(named[1]);
    const globs = config.include;
    if (!Array.isArray(globs) || globs.length === 0) process.exit(1);
    const roots = new Set(globs.map((glob) => glob.split("/*")[0].replace(/\/$/, "")).filter(Boolean));
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
# that may predate it. If the Dockerfile moved inside that range, what ships was
# not the same at both ends and this classification is only true of one.
moved=()
for source in "${derived_from[@]}"; do
  grep -qx "$source" <<< "$changed" && moved+=("$source")
done
if (( ${#moved[@]} > 0 )); then
  echo "⚠️ 이 범위 안에서 ${moved[*]} 이(가) 바뀌었습니다 — 무엇이 실리는지가 범위 내내 같지 않습니다."
  echo "   아래 분류는 **지금의** 그 파일들 기준입니다. 사람이 읽어야 합니다."
  echo
fi

shipped=""
rest=""
while IFS= read -r file; do
  [[ -n "$file" ]] || continue
  hit=""
  for path in "${ships[@]}"; do
    # `.` is the whole tree -- the fallback for a stage whose inputs could not be
    # narrowed. Matching it literally matched nothing, so the over-report it was
    # supposed to be was silently no report at all.
    if [[ "$path" == "." || "$file" == "$path" || "$file" == "$path"/* ]]; then hit=1; break; fi
  done
  if [[ -n "$hit" ]]; then shipped+="  $file"$'\n'; else rest+="  $file"$'\n'; fi
done <<< "$changed"

if [[ -n "$shipped" ]]; then
  echo "🔴 실립니다 — 배포되면 동작이 바뀝니다"
  printf '%s' "$shipped"
else
  echo "✅ 실리는 변경 없음"
fi
echo
echo "실리지 않습니다"
printf '%s' "${rest:-  (없음)$'\n'}"
