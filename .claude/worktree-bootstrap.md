# 새 워크트리에서 먼저 할 것

`node_modules` 는 `.claude/settings.json` 의 `symlinkDirectories` 가 걸어 준다. **눈으로
확인할 것** — 없으면 손으로 건다. `.env` 는 추적되지 않으므로 항상 손으로 가져와야 한다.

```bash
MAIN=/Users/henry/github/mack-erel/parallax

[ -e node_modules ] || ln -s "$MAIN/node_modules" node_modules   # 심링크가 안 걸렸을 때만
cp "$MAIN/.env" .env                                             # 추적 안 됨 — 항상 필요
```

`.env` 없이도 `pnpm check` 와 `pnpm test` 는 돈다. `pnpm cli`·`pnpm dev` 와 실계정 검증
(`pnpm verify:cloudflare` 등)은 `.env` 가 있어야 한다.

확인:

```bash
pnpm check && pnpm test
```
