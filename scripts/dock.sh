#!/bin/sh
# Puts Conductor on the dock, with its own icon, or takes it off again.
#
#   scripts/dock.sh install     make dock   (make install runs it too)
#   scripts/dock.sh remove      make undock
#
# macOS: ~/Applications/Conductor.app, kept in the Dock.
# Linux: a desktop entry and hicolor icons under ~/.local/share, pinned to the GNOME
#        (Ubuntu) dock's favourites. Without GNOME, the entry still shows in the menu.
#
# Everything is installed for this user only, so nothing needs sudo. The icon runs
# scripts/launch.sh from this checkout, so a pull changes what it does without a
# reinstall; moving the checkout needs one.
set -eu

here=$(cd "$(dirname "$0")/.." && pwd)
icon="$here/assets/icon"
id=local.conductor.app

say() { echo "dock: $*"; }

# 'it'\''s' — a value safe to paste inside single quotes.
quote() { printf "'%s'" "$(printf %s "$1" | sed "s/'/'\\\\''/g")"; }

# Where node and friends are right now, for a launch whose shell sets none of it up.
recorded_path() {
  for tool in node pnpm claude git; do
    p=$(command -v "$tool" 2>/dev/null) || continue
    dirname "$p"
  done | awk '!seen[$0]++' | paste -sd: -
}

# The executable the icon runs. It stays small and points into the checkout.
write_stub() {
  cat >"$1" <<EOF
#!/bin/sh
# Written by scripts/dock.sh. If the checkout moves, run make dock again from there.
CONDUCTOR_HOME=$(quote "$here")
CONDUCTOR_PATH=$(quote "$(recorded_path)")
export CONDUCTOR_HOME CONDUCTOR_PATH
if [ ! -f "\$CONDUCTOR_HOME/scripts/launch.sh" ]; then
  msg="Conductor is no longer at \$CONDUCTOR_HOME. Run make dock from where it is now."
  if command -v osascript >/dev/null; then
    osascript -e 'on run argv' -e 'display alert "Conductor moved" message (item 1 of argv) as critical' -e 'end run' "\$msg"
  elif command -v zenity >/dev/null; then
    zenity --error --title=Conductor --text="\$msg"
  elif command -v notify-send >/dev/null; then
    notify-send -i conductor "Conductor moved" "\$msg"
  fi
  exit 1
fi
exec /bin/sh "\$CONDUCTOR_HOME/scripts/launch.sh"
EOF
  chmod +x "$1"
}

# ── macOS ───────────────────────────────────────────────────────────────────

app="$HOME/Applications/Conductor.app"
lsregister=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
# How the Dock spells the app in its plist.
tile_url="file://$(printf %s "$app" | sed 's/ /%20/g')/"

ours() {
  [ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$app/Contents/Info.plist" 2>/dev/null)" = "$id" ]
}

mac_install() {
  if [ -e "$app" ] && ! ours; then
    say "$app exists and isn't this one — leaving it alone"
    exit 1
  fi
  rm -rf "$app"
  mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"

  iconset=$(mktemp -d)/conductor.iconset
  mkdir -p "$iconset"
  for n in 16 32 128 256 512; do
    cp "$icon/png/conductor-$n.png" "$iconset/icon_${n}x${n}.png"
    cp "$icon/png/conductor-$((n * 2)).png" "$iconset/icon_${n}x${n}@2x.png"
  done
  iconutil -c icns -o "$app/Contents/Resources/conductor.icns" "$iconset"
  rm -rf "$(dirname "$iconset")"

  version=$(sed -n 's/^  "version": "\(.*\)",$/\1/p' "$here/package.json")
  # A script has no architecture, so without LSArchitecturePriority an Apple silicon
  # Mac runs it under Rosetta, where make (an arm64-only xcrun shim) can't load.

  cat >"$app/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key><string>en</string>
  <key>CFBundleDisplayName</key><string>Conductor</string>
  <key>CFBundleExecutable</key><string>conductor</string>
  <key>CFBundleIconFile</key><string>conductor</string>
  <key>CFBundleIdentifier</key><string>$id</string>
  <key>CFBundleName</key><string>Conductor</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${version:-0.0.0}</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.developer-tools</string>
  <key>LSArchitecturePriority</key><array><string>arm64</string><string>x86_64</string></array>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
EOF
  write_stub "$app/Contents/MacOS/conductor"
  # So Finder, Spotlight and the Dock pick up this icon, not a cached one.
  touch "$app"
  "$lsregister" -f "$app" 2>/dev/null || true
  say "built $app"

  if defaults read com.apple.dock persistent-apps 2>/dev/null | grep -qF "\"$tile_url\""; then
    say 'already in the Dock'
  else
    defaults write com.apple.dock persistent-apps -array-add \
      "<dict><key>tile-data</key><dict><key>file-data</key><dict><key>_CFURLString</key><string>$tile_url</string><key>_CFURLStringType</key><integer>15</integer></dict></dict></dict>"
    say 'added to the Dock'
  fi
  # Also when it was already there: the Dock caches the icon it last drew.
  killall Dock 2>/dev/null || true
}

mac_remove() {
  # defaults can't delete one array item, so edit an export and import it back —
  # through cfprefsd, which would overwrite a direct edit of the plist.
  plist=$(mktemp)
  defaults export com.apple.dock "$plist"
  removed=0
  i=0
  while url=$(/usr/libexec/PlistBuddy -c "Print :persistent-apps:$i:tile-data:file-data:_CFURLString" "$plist" 2>/dev/null) ||
    /usr/libexec/PlistBuddy -c "Print :persistent-apps:$i" "$plist" >/dev/null 2>&1; do
    if [ "$url" = "$tile_url" ]; then
      /usr/libexec/PlistBuddy -c "Delete :persistent-apps:$i" "$plist"
      removed=$((removed + 1))
    else
      i=$((i + 1))
    fi
    url=
  done
  if [ "$removed" -gt 0 ]; then
    defaults import com.apple.dock "$plist"
    killall Dock 2>/dev/null || true
    say 'taken out of the Dock'
  else
    say 'not in the Dock'
  fi
  rm -f "$plist"

  if [ -e "$app" ] && ours; then
    "$lsregister" -u "$app" 2>/dev/null || true
    rm -rf "$app"
    say "deleted $app"
  elif [ -e "$app" ]; then
    say "$app isn't this one — leaving it alone"
  fi
}

# ── Linux ───────────────────────────────────────────────────────────────────

data=${XDG_DATA_HOME:-$HOME/.local/share}
entry="$data/applications/conductor.desktop"
stub="$data/conductor/launch"
hicolor="$data/icons/hicolor"
sizes='16 24 32 48 64 128 256 512'

# The dock is GNOME Shell's, on stock Ubuntu and on plain GNOME alike.
gnome() {
  command -v gsettings >/dev/null && gsettings get org.gnome.shell favorite-apps >/dev/null 2>&1
}

refresh() {
  command -v update-desktop-database >/dev/null && update-desktop-database "$data/applications" 2>/dev/null
  # Only an existing cache needs updating; a stale one would hide the new icon.
  [ -f "$hicolor/icon-theme.cache" ] && command -v gtk-update-icon-cache >/dev/null &&
    gtk-update-icon-cache -f -t "$hicolor" 2>/dev/null
  return 0
}

linux_install() {
  for n in $sizes; do
    mkdir -p "$hicolor/${n}x$n/apps"
    cp "$icon/png/conductor-$n.png" "$hicolor/${n}x$n/apps/conductor.png"
  done
  mkdir -p "$hicolor/scalable/apps"
  cp "$icon/conductor.svg" "$hicolor/scalable/apps/conductor.svg"

  mkdir -p "$(dirname "$stub")" "$(dirname "$entry")"
  write_stub "$stub"
  # StartupNotify is off: the page opens in the browser, so no window of ours ever
  # arrives to end the spinner.
  cat >"$entry" <<EOF
[Desktop Entry]
Type=Application
Name=Conductor
GenericName=Agent orchestrator
Comment=Run many Claude Code agents across many projects
Exec="$stub"
TryExec=$stub
Icon=conductor
Terminal=false
Categories=Development;
StartupNotify=false
EOF
  refresh
  say "wrote $entry"

  if ! gnome; then
    say 'no GNOME dock here — Conductor is in the app menu, pin it from there'
    return
  fi
  now=$(gsettings get org.gnome.shell favorite-apps)
  case "$now" in
    *"'conductor.desktop'"*) say 'already on the dock' ;;
    '@as []' | '[]') gsettings set org.gnome.shell favorite-apps "['conductor.desktop']" && say 'pinned to the dock' ;;
    *) gsettings set org.gnome.shell favorite-apps "${now%]}, 'conductor.desktop']" && say 'pinned to the dock' ;;
  esac
}

linux_remove() {
  if gnome; then
    now=$(gsettings get org.gnome.shell favorite-apps)
    case "$now" in
      *"'conductor.desktop'"*)
        gsettings set org.gnome.shell favorite-apps "$(printf %s "$now" |
          sed -e "s/, 'conductor\.desktop'//g" -e "s/'conductor\.desktop', //g" -e "s/'conductor\.desktop'//g")"
        say 'unpinned from the dock' ;;
      *) say 'not on the dock' ;;
    esac
  fi
  if [ ! -e "$entry" ] && [ ! -e "$stub" ]; then
    say 'not installed'
    return
  fi
  rm -f "$entry" "$stub" "$hicolor/scalable/apps/conductor.svg"
  rmdir "$(dirname "$stub")" 2>/dev/null || true
  for n in $sizes; do rm -f "$hicolor/${n}x$n/apps/conductor.png"; done
  refresh
  say "deleted $entry and its icons"
}

# ─────────────────────────────────────────────────────────────────────────────

case "$(uname -s)-${1:-}" in
  Darwin-install) mac_install ;;
  Darwin-remove) mac_remove ;;
  Linux-install) linux_install ;;
  Linux-remove) linux_remove ;;
  *-install | *-remove) say "nothing to do on $(uname -s)" ;;
  *) echo 'usage: scripts/dock.sh install|remove' >&2; exit 2 ;;
esac
