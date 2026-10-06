#!/usr/bin/env bash
# Scratch repo for Track C (workspace) and Track D (preview) to work against.
#
# W0 OWNS THIS FILE.
#   bash fixtures/make-scratch-repo.sh
#
# Creates fixtures/scratch-repo — a small git repo with a dirty worktree, a
# markdown file worth rendering, and a trivial vite app on a real port. It is
# gitignored; regenerate it freely.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$HERE/scratch-repo"

rm -rf "$REPO"
mkdir -p "$REPO/docs" "$REPO/src"
cd "$REPO"

git init -q
git symbolic-ref HEAD refs/heads/main
git config user.email "conductor@example.invalid"
git config user.name "Conductor Fixture"

cat > docs/PLAN.md <<'MD'
# Auth refresh rotation

Refresh tokens are single-use but never rotated, so a replayed token stays
valid until natural expiry. Rotate on every exchange and revoke the ancestor
chain on reuse detection.

## Decision log

> 2026-09-21 — hard-revoke the entire token family on reuse, log at `warn`
> with the family id. Accepts that a flaky mobile client can log itself out.

## Tasks

- [x] Extract `decodeToken()` into `auth/token.ts`
- [x] Inject `clock` so tests can skew time
- [ ] Rotate refresh token on exchange, revoke ancestors
- [ ] Backfill `token_family_id` migration
- [ ] Rate-limit `POST /auth/refresh` to 10/min/subject
MD

cat > README.md <<'MD'
# scratch-repo

Fixture repository. Track C exercises the file tree, markdown rendering and
diff view against this. Track D serves `src/app.js` through the preview proxy.
MD

cat > src/token.js <<'JS'
export function decodeToken(raw) {
  return verify(raw, KEY);
}
JS

cat > src/app.js <<'JS'
document.body.innerHTML = '<h1>scratch app</h1><p>served through the preview proxy</p>';
console.error('GET /api/sessions 500 — token_family_id does not exist');
console.warn('prop `rotatedAt` is undefined in <SessionRow>');
JS

cat > index.html <<'HTML'
<!doctype html>
<html>
  <head><title>scratch app</title></head>
  <body><script type="module" src="/src/app.js"></script></body>
</html>
HTML

git add -A
git commit -qm "initial fixture commit"

# Leave the worktree dirty so `git diff` and the change badges have something
# real to show. Track C should see: one modified file, one untracked file.
cat > src/token.js <<'JS'
export function decodeToken(raw, opts = {}) {
  const clock = opts.clock ?? Date.now;
  return verify(raw, KEY, { clockTimestamp: clock() / 1000 });
}

export function rotate(prev, clock = Date.now) {
  return { ...mint(prev.subject, clock), familyId: prev.familyId, ancestorId: prev.id };
}
JS

cat > src/refresh.js <<'JS'
// untracked on purpose — exercises the "created" badge
export function exchange() {}
JS

echo "scratch repo ready at $REPO"
echo "  branch : $(git branch --show-current)"
echo "  dirty  : $(git status --porcelain | wc -l | tr -d ' ') entries"
