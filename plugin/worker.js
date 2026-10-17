// Worker of the Engine plugin: reads and changes the shared moteur_local mode.
// Same file as the adapter: ~/.paperclip/moteur/state.json.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";

const MODES = ["auto", "claude", "codex"];
// Anthropic's quota endpoint quickly answers 429: do not read it more often.
const USAGE_CACHE_MS = 5 * 60 * 1000;

function paperclipHome() {
  return process.env.PAPERCLIP_HOME || path.join(os.homedir(), ".paperclip");
}

// Adapters of the running Paperclip version, whichever it is.
async function importAdapter(name) {
  const file = path.join(paperclipHome(), "cli", "current", "node_modules", "@paperclipai", name, "dist", "server", "index.js");
  return import(pathToFileURL(file).href);
}

let usageCache = null;

async function readUsage(engine, adapterName) {
  try {
    const adapter = await importAdapter(adapterName);
    const result = await adapter.getQuotaWindows();
    return { engine, ok: result.ok !== false, windows: result.windows ?? [], error: result.error ?? null };
  } catch (err) {
    return { engine, ok: false, windows: [], error: err instanceof Error ? err.message : String(err) };
  }
}

/** Claude and Codex quotas, cached 5 minutes; keeps the previous read when a new one fails. */
async function usage(force = false) {
  if (!force && usageCache && Date.now() - usageCache.at < USAGE_CACHE_MS) return usageCache.value;
  const [claude, codex] = await Promise.all([
    readUsage("claude", "adapter-claude-local"),
    readUsage("codex", "adapter-codex-local"),
  ]);
  const previous = usageCache?.value;
  const value = {
    readAt: new Date().toISOString(),
    claude: claude.ok || !previous ? claude : { ...previous.claude, stale: true, error: claude.error },
    codex: codex.ok || !previous ? codex : { ...previous.codex, stale: true, error: codex.error },
  };
  usageCache = { at: Date.now(), value };
  return value;
}

function statePath() {
  return path.join(paperclipHome(), "moteur", "state.json");
}

function readState() {
  try {
    const raw = JSON.parse(fs.readFileSync(statePath(), "utf8"));
    return {
      mode: MODES.includes(raw.mode) ? raw.mode : "auto",
      claudeBlockedUntil: typeof raw.claudeBlockedUntil === "string" ? raw.claudeBlockedUntil : null,
    };
  } catch {
    return { mode: "auto", claudeBlockedUntil: null };
  }
}

function writeState(next) {
  const file = statePath();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** What the button shows: chosen mode, and the engine actually used now. */
function status() {
  const state = readState();
  const until = state.claudeBlockedUntil ? Date.parse(state.claudeBlockedUntil) : NaN;
  const blocked = Number.isFinite(until) && until > Date.now();
  const engine = state.mode === "auto" ? (blocked ? "codex" : "claude") : state.mode;
  return {
    mode: state.mode,
    engine,
    claudeBlockedUntil: blocked ? state.claudeBlockedUntil : null,
  };
}

const plugin = definePlugin({
  async setup(ctx) {
    ctx.data.register("status", async () => status());
    ctx.data.register("usage", async () => ({ ...(await usage()), status: status() }));

    ctx.actions.register("setMode", async (params) => {
      const mode = params?.mode;
      if (!MODES.includes(mode)) throw new Error(`unknown mode: ${mode}`);
      writeState({ ...readState(), mode });
      ctx.logger.info("Engine mode changed", { mode });
      return status();
    });

    // Clear the Claude block by hand, for instance after a subscription change.
    ctx.actions.register("clearClaudeBlock", async () => {
      writeState({ ...readState(), claudeBlockedUntil: null });
      return status();
    });
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
