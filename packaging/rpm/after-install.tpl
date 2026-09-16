#!/bin/bash

# Link the launcher into PATH directly with a plain symlink. (electron-builder's
# stock rpm after-install script indirects this through a Linux distro
# mechanism that Fedora's rpmlint requires additional scriptlet-dependency and
# file-list declarations for, which the fpm 1.17 rpm backend used by this
# project's build pipeline has no CLI option to emit -- see
# packaging/electron-builder.base.json's rpm.afterInstall/rpm.afterRemove.)
ln -sf '/opt/${sanitizedProductName}/${executable}' '/usr/bin/${executable}'

# Check if user namespaces are supported by the kernel and working with a quick test:
if ! { [[ -L /proc/self/ns/user ]] && unshare --user true; }; then
    # Use SUID chrome-sandbox only on systems without user namespaces:
    chmod 4755 '/opt/${sanitizedProductName}/chrome-sandbox' || true
else
    chmod 0755 '/opt/${sanitizedProductName}/chrome-sandbox' || true
fi

if hash update-mime-database 2>/dev/null; then
    update-mime-database /usr/share/mime || true
fi

if hash update-desktop-database 2>/dev/null; then
    update-desktop-database /usr/share/applications || true
fi
