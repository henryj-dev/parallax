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

# Sources named by a COPY in the **final** stage. Earlier stages copy the whole
# tree in to build it, so reading every COPY would call every file shipped --
# true of the builder, false of the image. `--from=` lines carry build output
# rather than tracked paths, so they are not something a reader of a diff checks.
ships=()
while IFS= read -r path; do
  [[ -n "$path" ]] && ships+=("$path")
done < <(awk '
  /^FROM /   { copies = "" }
  /^COPY /   { if ($0 ~ /--from=/) next
               for (i = 2; i < NF; i++) copies = copies $i "\n" }
  END        { printf "%s", copies }' Dockerfile | sed 's|/$||' | sort -u)

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
if grep -qx "Dockerfile" <<< "$changed"; then
  echo "⚠️ 이 범위 안에서 Dockerfile 이 바뀌었습니다 — 무엇이 실리는지가 범위 내내 같지 않습니다."
  echo "   아래 분류는 **지금의** Dockerfile 기준입니다. 사람이 읽어야 합니다."
  echo
fi

shipped=""
rest=""
while IFS= read -r file; do
  [[ -n "$file" ]] || continue
  hit=""
  for path in "${ships[@]}"; do
    if [[ "$file" == "$path" || "$file" == "$path"/* ]]; then hit=1; break; fi
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
