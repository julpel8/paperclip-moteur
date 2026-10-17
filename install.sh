#!/bin/sh
# Install the moteur_local adapter and the Engine plugin into Paperclip.
# Safe to run again: it reloads what is already installed from this folder,
# and moves the registration here if it points somewhere else.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
PATH="$HOME/.local/bin:$PATH"
sdk="$HOME/.paperclip/cli/current/node_modules/@paperclipai/plugin-sdk"

json_field() { # json_field <key>   reads JSON on stdin, prints the first value
    grep -o "\"$1\": *\"[^\"]*\"" | head -1 | sed 's/.*: *"\(.*\)"/\1/'
}

command -v paperclipai >/dev/null || { echo "paperclipai not found" >&2; exit 1; }
[ -d "$sdk" ] || { echo "Paperclip plugin SDK not found: $sdk" >&2; exit 1; }

# The plugin imports @paperclipai/plugin-sdk. Point it at the SDK of the
# installed Paperclip, so it follows Paperclip updates (cli/current).
mkdir -p "$here/plugin/node_modules/@paperclipai"
ln -sfn "$sdk" "$here/plugin/node_modules/@paperclipai/plugin-sdk"

# Adapter
adapter="$here/adapter"
current=$(paperclipai adapter get moteur_local --json 2>/dev/null | json_field packageName || true)
if [ "$current" = "$adapter" ]; then
    echo "adapter: reload"
    paperclipai adapter reload moteur_local
else
    if [ -n "$current" ]; then
        echo "adapter: moving from $current"
        paperclipai adapter delete moteur_local
    fi
    echo "adapter: install $adapter"
    paperclipai adapter install \
        --payload-json "{\"packageName\":\"$adapter\",\"isLocalPath\":true}"
fi

# Plugin. Uninstall without --force keeps its state and settings.
plugin="$here/plugin"
current=$(paperclipai plugin inspect julpel.moteur --json 2>/dev/null | json_field packagePath || true)
if [ "$current" = "$plugin" ]; then
    # A new permission in manifest.js needs a reinstall: uninstall, then rerun.
    echo "plugin: already installed from $plugin, restart it"
    paperclipai plugin disable julpel.moteur
    paperclipai plugin enable julpel.moteur
else
    if [ -n "$current" ]; then
        echo "plugin: moving from $current"
        paperclipai plugin uninstall julpel.moteur
    fi
    echo "plugin: install $plugin"
    paperclipai plugin install --local "$plugin"
fi

paperclipai adapter get moteur_local --json | grep -E '"(loaded|packageName)"'
paperclipai plugin inspect julpel.moteur --json | grep -E '"(status|packagePath)"' | head -2
