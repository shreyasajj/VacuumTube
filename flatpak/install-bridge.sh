#!/bin/sh
# User-only development installation. The system Flatpak remains available for rollback.
set -eu
archive="${1:?Pass the bridge app.asar built from the matching installed version}"
app_id=rocks.shy.VacuumTube
stage_root="$HOME/.cache/vacuumtube-bridge-build"
remote=bigscreen-vacuumtube
mkdir -p "$stage_root"
if [ ! -f "$stage_root/app/metadata" ]; then
    flatpak info --show-commit "$app_id" > "$stage_root/base-commit"
    flatpak build-init --base="$app_id" --base-version=stable "$stage_root/app" "$app_id" org.freedesktop.Sdk org.freedesktop.Platform 26.08
fi
cp "$archive" "$stage_root/app/files/bin/vacuumtube/resources/app.asar"
if ! grep -q '^command=startvacuumtube$' "$stage_root/app/metadata"; then
    flatpak build-finish "$stage_root/app" --command=startvacuumtube --share=ipc --share=network \
        --socket=wayland --socket=fallback-x11 --socket=pulseaudio --device=all \
        --filesystem=/run/udev:ro --filesystem=xdg-run/bigscreen-bridge:create \
        --talk-name=org.freedesktop.ScreenSaver --talk-name=org.gnome.ScreenSaver \
        --talk-name=org.mate.ScreenSaver --talk-name=org.cinnamon.ScreenSaver \
        --talk-name=org.xfce.ScreenSaver --own-name=org.mpris.MediaPlayer2.chromium.*
fi
flatpak build-export "$stage_root/repo" "$stage_root/app" stable
expected_url="file://$stage_root/repo"
remote_url=$(flatpak remotes --user --columns=name,url | awk '$1 == "bigscreen-vacuumtube" {print $2}')
if [ -n "$remote_url" ] && [ "$remote_url" != "$expected_url" ]; then
    printf '%s\n' 'The development remote already points elsewhere; leaving it unchanged.' >&2
    exit 1
fi
flatpak remote-add --user --no-gpg-verify --if-not-exists "$remote" "$expected_url"
flatpak install --user --reinstall -y --noninteractive "$remote" "$app_id//stable"
printf '%s\n' 'Installed the development build. Restart only the VacuumTube main process to load it.'
