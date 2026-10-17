# paperclip-moteur

Runs Paperclip agents on Claude Code or Codex, and switches to Codex when the
Claude quota is used up.

- `adapter/`: the `moteur_local` adapter. Each run goes through Paperclip's
  `claude_local` or `codex_local`. The shared mode (`auto`, `claude`, `codex`)
  lives in `~/.paperclip/moteur/state.json`.
- `plugin/`: the Engine plugin. Auto / Claude / Codex button in the top bar,
  quota of both subscriptions in the sidebar and on the dashboard. Plain
  JavaScript, no build step.

## Install

Paperclip must be installed and running (`paperclipai`, unit `paperclipai`).

```sh
git clone git@github.com:julpel8/paperclip-moteur.git ~/src/paperclip-moteur
~/src/paperclip-moteur/install.sh
```

Run `install.sh` again after any change: it reloads the adapter and restarts
the plugin. Paperclip keeps the absolute path of both folders, so do not move
the clone without rerunning it.

A new permission in `plugin/manifest.js` needs a full reinstall:

```sh
paperclipai plugin uninstall julpel.moteur && ~/src/paperclip-moteur/install.sh
```

## Move agents to moteur_local

```sh
node adapter/migrate.js --dry-run         # show the new configs
node adapter/migrate.js                   # migrate, old configs saved first
node adapter/migrate.js --restore FILE    # put back the configs in FILE
```

Old configs are saved in `~/.paperclip/moteur/backup-<date>.json`.
