#!/bin/bash

# Remove the direct symlink installed by after-install.tpl (see that file for
# why this target does not use electron-builder's stock script here).
#
# %postun runs with $1 = the number of copies of this package left installed
# AFTER the transaction: 1 on an upgrade (the new package's postinst already
# ran and recreated the symlink) and 0 on a real erase. Without this guard,
# every upgrade would delete the symlink the incoming package just installed.
if [ "$1" -eq 0 ]; then
    rm -f '/usr/bin/${executable}'
fi

if hash update-mime-database 2>/dev/null; then
    update-mime-database /usr/share/mime || true
fi

if hash update-desktop-database 2>/dev/null; then
    update-desktop-database /usr/share/applications || true
fi
