#!/usr/bin/env bash
# Scratch repo for Track C (workspace) and Track D (preview) to work against.
#
# W0 OWNS THIS FILE.
#   bash fixtures/make-scratch-repo.sh
#
# Creates fixtures/scratch-repo — a small git repo with a dirty worktree, a
# markdown file worth rendering, and a trivial vite app on a real port, plus a
# nested clone (`inner/`) and an initialised submodule (`vendor-lib/`) for
# Amendment 90. It is gitignored; regenerate it freely.

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

# Nested repo (Amendment 90): a separate clone living inside the scratch repo,
# with its own commit and its own branch, plus a node_modules dir that must
# stay hidden exactly the way the outer repo's does. Built from a throwaway
# source repo so `git clone` has something real to clone, then thrown away —
# the fixture only needs the clone that's left behind in scratch-repo.
NESTED_SRC="$HERE/.scratch-nested-src"
rm -rf "$NESTED_SRC"
mkdir -p "$NESTED_SRC"
(
  cd "$NESTED_SRC"
  git init -q
  git symbolic-ref HEAD refs/heads/main
  git config user.email "conductor@example.invalid"
  git config user.name "Conductor Fixture"
  cat > README.md <<'MD'
# scratch-nested

Standalone clone nested inside scratch-repo, exercising Amendment 90.
MD
  git add -A
  git commit -qm "nested fixture commit"
)
git clone -q "$NESTED_SRC" inner
(
  cd inner
  git checkout -qb feature/nested
  cat > app.js <<'JS'
console.log('nested clone app');
JS
  git add -A
  git commit -qm "nested clone's own commit"

  # Committed, not left untracked: an outer `git status` treats a gitlink's
  # worktree having ANY untracked content as the gitlink itself being dirty
  # ("M inner"), which would wrongly inflate the outer repo's own change count.
  # The deny-list hides this on name alone (NEVER_LISTED), tracked or not, so
  # committing it costs the test nothing.
  mkdir -p node_modules/some-pkg
  cat > node_modules/some-pkg/index.js <<'JS'
module.exports = {};
JS

  # A symlink to the parent directory: must not be followed, or walking back
  # up through it would loop forever.
  ln -s .. loopback

  git add -A
  git commit -qm "node_modules and a symlink back up, both committed to stay clean"
)
rm -rf "$NESTED_SRC"

# Submodule (Amendment 90): initialised, so its .git is a file (a gitlink
# pointer) rather than a directory — the other half of the nested-repo test
# matrix. `protocol.file.allow=always` because git 2.38+ refuses a local-path
# submodule by default (CVE-2022-39253); this fixture's "remote" is always
# local, and always ours.
SUB_SRC="$HERE/.scratch-sub-src"
rm -rf "$SUB_SRC"
mkdir -p "$SUB_SRC"
(
  cd "$SUB_SRC"
  git init -q
  git symbolic-ref HEAD refs/heads/main
  git config user.email "conductor@example.invalid"
  git config user.name "Conductor Fixture"
  cat > lib.js <<'JS'
export const VERSION = 1;
JS
  git add -A
  git commit -qm "submodule fixture commit"
)
git -c protocol.file.allow=always submodule add -q "$SUB_SRC" vendor-lib
rm -rf "$SUB_SRC"

git add inner vendor-lib .gitmodules
git commit -qm "add nested repo and submodule fixtures"

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
echo "  nested : inner/ (branch $(git -C inner branch --show-current)), vendor-lib/ (submodule)"
