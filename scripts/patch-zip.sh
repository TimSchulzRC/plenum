#!/bin/sh
# Packt eine fertig signierte App ohne Contents/Frameworks/*.framework in ein ZIP.
# Die Frameworks ändern sich nur mit der Electron-Version. Der Updater übernimmt sie aus
# der installierten App und prüft danach die Signatur des ganzen Bundles.
# Aufruf: scripts/patch-zip.sh "release/mac-arm64/Teams Everywhere.app" release/…-patch.zip
set -eu
app="$1"
out="$2"
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
name="$(basename "$app")"
ditto "$app" "$stage/$name"
rm -rf "$stage/$name/Contents/Frameworks/"*.framework
ditto -c -k --keepParent "$stage/$name" "$out"
