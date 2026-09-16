#!/usr/bin/env bash
# Runs inside a distro container: installs the package for <format>, asserts the install, runs the smoke test, uninstalls.
# Usage: bash /tests/install/install-and-smoke.sh <deb|rpm|appimage>
set -euo pipefail
FORMAT="${1:?format required: deb|rpm|appimage}"
DIST="${DIST_DIR:-/dist}"
TESTS="${TESTS_DIR:-/tests}"
# shellcheck source=/dev/null
. /etc/os-release
echo "== distro: $ID $VERSION_ID, format: $FORMAT"

# Runtime library lists mirroring packaging/electron-builder.base.json's deb.depends/rpm.depends.
# These are used ONLY for the AppImage leg: an AppImage carries no dependency metadata of its own,
# so this simulates the runtime libraries already present on a real desktop host running deb/rpm
# packages. The deb/rpm legs below resolve their own dependencies from the package metadata via
# `apt-get install ./*.deb` / `dnf install ./*.rpm` and never consult these lists.
# libasound2 is deliberately excluded here: on Ubuntu 24.04 it is a pure virtual package with two
# providers (libasound2t64, the real ALSA library, and liboss4-salsa-asound2, an OSS-compat shim
# missing symbols electron needs), and unlike the electron-builder.base.json deb.depends field --
# which can express the preference as the alternation "libasound2t64 | libasound2" -- a plain
# `apt-get install` package list has no alternation syntax, so it is installed separately below.
DEB_RUNTIME="libgtk-3-0 libnotify4 libnss3 libxss1 libxtst6 xdg-utils libatspi2.0-0 libuuid1 libsecret-1-0 libdrm2 libgbm1 libxkbcommon0 libatk-bridge2.0-0 libatk1.0-0 libcups2 libdbus-1-3 libexpat1 libx11-6 libxcomposite1 libxdamage1 libxext6 libxfixes3 libxrandr2 libpango-1.0-0 libcairo2 libglib2.0-0 libnspr4 libxcb1"
RPM_RUNTIME="gtk3 libnotify nss libXScrnSaver libXtst xdg-utils at-spi2-core libuuid libsecret alsa-lib libdrm mesa-libgbm libxkbcommon at-spi2-atk atk cups-libs dbus-libs expat libX11 libXcomposite libXdamage libXext libXfixes libXrandr pango cairo glib2 nspr libxcb"

case "$ID" in
  ubuntu|debian)
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq
    apt-get install -y -qq xvfb xauth curl ca-certificates procps desktop-file-utils >/dev/null
    if [ "$FORMAT" = "appimage" ]; then
      # shellcheck disable=SC2086 # intentional word-splitting of a package name list
      apt-get install -y -qq $DEB_RUNTIME >/dev/null
      apt-get install -y -qq libasound2t64 >/dev/null 2>&1 || apt-get install -y -qq libasound2 >/dev/null
    fi
    ;;
  fedora)
    # Do NOT `dnf install curl` plainly here: it conflicts with curl-minimal, which ships in the
    # base fedora image and already provides /usr/bin/curl, so curl is simply omitted below.
    dnf install -y -q xorg-x11-server-Xvfb xorg-x11-xauth ca-certificates procps-ng desktop-file-utils >/dev/null
    if [ "$FORMAT" = "appimage" ]; then
      # shellcheck disable=SC2086 # intentional word-splitting of a package name list
      dnf install -y -q $RPM_RUNTIME >/dev/null
    fi
    ;;
  *) echo "unsupported distro $ID" >&2; exit 1 ;;
esac

WORK="$(mktemp -d)"; cd "$WORK"

assert_installed_layout() {
  echo "== install assertions"
  local target; target="$(readlink -f /usr/bin/qwen-studio)"
  [ "$target" = "/opt/Qwen Studio/qwen-studio" ] || { echo "/usr/bin/qwen-studio -> $target (expected /opt/Qwen Studio/qwen-studio)"; exit 1; }
  local st; st="$(stat -c '%U %a' '/opt/Qwen Studio/chrome-sandbox')"
  case "$st" in "root 4755"|"root 755") ;; *) echo "chrome-sandbox owner/mode: $st"; exit 1;; esac
  desktop-file-validate /usr/share/applications/qwen-studio.desktop
  update-desktop-database /usr/share/applications >/dev/null 2>&1 || true
  local handler; handler="$(xdg-mime query default x-scheme-handler/qwen || true)"
  [ "$handler" = "qwen-studio.desktop" ] || { echo "xdg-mime handler for qwen:// is '$handler'"; exit 1; }
  echo "layout ok"
}

case "$FORMAT" in
  deb)
    apt-get install -y -qq "$DIST"/qwen-studio_*.deb >/dev/null
    assert_installed_layout
    bash "$TESTS/smoke/smoke.sh" "/opt/Qwen Studio/qwen-studio" "/opt/Qwen Studio/resources"
    apt-get remove -y -qq qwen-studio >/dev/null
    [ ! -e "/opt/Qwen Studio" ] || { echo "/opt/Qwen Studio still present after removal"; ls -la "/opt/Qwen Studio"; exit 1; }
    [ ! -e /usr/bin/qwen-studio ] || { echo "/usr/bin/qwen-studio symlink still present after removal"; exit 1; }
    ;;
  rpm)
    dnf install -y -q "$DIST"/qwen-studio-*.rpm >/dev/null
    assert_installed_layout
    bash "$TESTS/smoke/smoke.sh" "/opt/Qwen Studio/qwen-studio" "/opt/Qwen Studio/resources"
    dnf remove -y -q qwen-studio >/dev/null
    [ ! -e "/opt/Qwen Studio" ] || { echo "/opt/Qwen Studio still present after removal"; exit 1; }
    [ ! -e /usr/bin/qwen-studio ] || { echo "/usr/bin/qwen-studio symlink still present after removal"; exit 1; }
    ;;
  appimage)
    cp "$DIST"/qwen-studio-*.AppImage ./app.AppImage && chmod +x ./app.AppImage
    ./app.AppImage --appimage-extract >/dev/null
    [ ! -e squashfs-root/resources/package-type ] || { echo "package-type must not exist in the AppImage"; exit 1; }
    bash "$TESTS/smoke/smoke.sh" "$WORK/squashfs-root/qwen-studio" "$WORK/squashfs-root/resources"
    ;;
  *) echo "unknown format $FORMAT" >&2; exit 1 ;;
esac
echo "INSTALL+SMOKE PASS ($ID $VERSION_ID, $FORMAT)"
