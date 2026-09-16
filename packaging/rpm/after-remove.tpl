#!/bin/bash

# Remove the direct symlink installed by after-install.tpl (see that file for
# why this target does not use electron-builder's stock script here).
rm -f '/usr/bin/${executable}'

if hash update-mime-database 2>/dev/null; then
    update-mime-database /usr/share/mime || true
fi

if hash update-desktop-database 2>/dev/null; then
    update-desktop-database /usr/share/applications || true
fi
