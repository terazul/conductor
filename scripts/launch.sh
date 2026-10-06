#!/bin/sh
# What the Conductor dock icon runs: start Conductor if it isn't up, then open it.
#
# A dock launch arrives with almost none of a terminal's environment, and an nvm-style
# install puts node on PATH only from the shell's rc files. So the starting is handed
# to your own login shell: make start gets the PATH and variables a terminal would give
# it, and so do the agents the daemon launches (an ANTHROPIC_API_KEY exported in
# .zshrc, a proxy). CONDUCTOR_PATH, recorded by scripts/dock.sh at install, is the
# fallback for a shell that sets nothing up without a terminal.
#
# Everything goes to .conductor/run/dock.log. A failure is said in a dialog: an icon
# that bounces and then does nothing is the one outcome worse than an error.
set -u

# Under Rosetta (an app bundle from before LSArchitecturePriority), come back native:
# make is an xcrun shim that only loads as arm64.
if [ "$(sysctl -n sysctl.proc_translated 2>/dev/null)" = 1 ]; then
  exec arch -arm64 /bin/sh "$0" "$@"
fi

home=${CONDUCTOR_HOME:-$(cd "$(dirname "$0")/.." && pwd)}
run="$home/.conductor/run"
mkdir -p "$run"
exec >>"$run/dock.log" 2>&1
echo "── $(date '+%Y-%m-%d %H:%M:%S') dock launch"

# The Makefile's defaults, and localhost for the same reason: Vite binds ::1 only.
url="http://localhost:${WEB_PORT:-5173}"
health="http://127.0.0.1:${DAEMON_PORT:-7777}/api/health"
PATH="${CONDUCTOR_PATH:+$CONDUCTOR_PATH:}$PATH:/usr/bin:/bin"
export PATH

up() {
  curl -fsS -o /dev/null --max-time 1 "$health" 2>/dev/null &&
    curl -fsS -o /dev/null --max-time 1 "$url" 2>/dev/null
}

tell() {
  title="Conductor didn't start"
  case "$(uname -s)" in
    Darwin)
      osascript -e 'on run argv' \
        -e 'display alert (item 1 of argv) message (item 2 of argv) as critical' \
        -e 'end run' "$title" "$1" ;;
    *)
      if command -v zenity >/dev/null; then
        zenity --error --title=Conductor --text="$title. $1"
      elif command -v notify-send >/dev/null; then
        notify-send -i conductor "$title" "$1"
      fi ;;
  esac
}

# A dock may not pass SHELL on; the account's own shell is the one its rc files are for.
login_shell() {
  if [ -n "${SHELL:-}" ]; then echo "$SHELL"; return; fi
  case "$(uname -s)" in
    Darwin) dscl . -read "/Users/$(id -un)" UserShell 2>/dev/null | awk '{ print $2 }' ;;
    *) getent passwd "$(id -un)" 2>/dev/null | cut -d: -f7 ;;
  esac
}

if up; then
  echo 'already up'
else
  sh=$(login_shell)
  case "${sh##*/}" in
    bash | zsh | ksh)
      echo "starting through $sh"
      # shellcheck disable=SC2016 # $1 is the login shell's, not this one's.
      "$sh" -lic 'cd "$1" && make start' conductor "$home" </dev/null ;;
  esac
  # A shell whose rc files need a terminal (one that execs tmux, say) starts nothing,
  # so try once more without them, on the PATH recorded at install.
  if ! up; then
    echo 'starting with the recorded PATH'
    (cd "$home" && make start) </dev/null
  fi
  if ! up; then
    tell "Nothing answered at $url. What make start said is in $run/dock.log."
    exit 1
  fi
fi

case "$(uname -s)" in
  Darwin) open "$url" ;;
  *) xdg-open "$url" ;;
esac
