#!/bin/bash
# A mutation check: break one thing on purpose and make sure a test notices.
# usage: scripts/mutate.sh <file> <exact text> <replacement> <test command>
# Replaces the first match, runs the command (150 s at most), puts the file back
# whatever happens, and reports. A non-zero exit means the tests caught it.
set -u
f="$1"; bak=$(mktemp); cp "$f" "$bak"
trap 'cp "$bak" "$f"; rm -f "$bak"' EXIT
python3 - "$f" "$2" "$3" <<'PY' || exit 2
import sys
p,a,b=sys.argv[1:4]
s=open(p).read()
if a not in s: sys.exit("pattern not found in "+p)
open(p,'w').write(s.replace(a,b,1))
PY
out=$(mktemp)
perl -e 'alarm 150; exec @ARGV' bash -c "$4" > "$out" 2>&1; code=$?
echo "exit $code (non-zero = mutation caught)"; grep "✗" "$out" | head -4; rm -f "$out"
exit 0
