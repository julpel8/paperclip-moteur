// Paperclip adapter `moteur_local`.
//
// Each run goes through Paperclip's `claude_local` or `codex_local` adapter,
// picked from the shared mode stored in ~/.paperclip/moteur/state.json:
//   auto   : Claude, except while its quota is blocked; then Codex.
//   claude : always Claude.
//   codex  : always Codex.
// The conversation is kept per engine: switching engine starts a fresh one.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const ADAPTER_TYPE = "moteur_local";
const ENGINES = ["claude", "codex"];
const MODES = ["auto", "claude", "codex"];
// Default block when Claude gives no retry time.
const DEFAULT_CLAUDE_BLOCK_MS = 60 * 60 * 1000;

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

// ---------------------------------------------------------------------------
// Paperclip's own adapters, found from the server that loads us.
// ---------------------------------------------------------------------------

// Package folder, looked up in the node_modules above the server.
function paperclipPackageDir(name) {
  const entry = process.argv[1] ? fs.realpathSync(process.argv[1]) : null;
  if (!entry) throw new Error("moteur_local: cannot locate the Paperclip server");
  for (let dir = path.dirname(entry); ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, "node_modules", name);
    if (fs.existsSync(path.join(candidate, "package.json"))) return candidate;
    if (path.dirname(dir) === dir) break;
  }
  throw new Error(`moteur_local: package ${name} not found next to the Paperclip server`);
}

// These packages only export the `import` condition: read `exports` by hand.
function exportTarget(entry) {
  if (typeof entry === "string") return entry;
  const value = asObject(entry);
  return exportTarget(value.import ?? value.default ?? value.node);
}

async function importFromPaperclip(name, subpath = ".") {
  const dir = paperclipPackageDir(name);
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
  const target = exportTarget(asObject(pkg.exports)[subpath]) ?? (subpath === "." ? pkg.main : null);
  if (!target) throw new Error(`moteur_local: ${name} does not export ${subpath}`);
  return import(pathToFileURL(path.join(dir, target)).href);
}

const [claudeServer, claudeRoot, codexServer, codexRoot] = await Promise.all([
  importFromPaperclip("@paperclipai/adapter-claude-local", "./server"),
  importFromPaperclip("@paperclipai/adapter-claude-local"),
  importFromPaperclip("@paperclipai/adapter-codex-local", "./server"),
  importFromPaperclip("@paperclipai/adapter-codex-local"),
]);

const engines = {
  claude: { type: "claude_local", server: claudeServer, root: claudeRoot },
  codex: { type: "codex_local", server: codexServer, root: codexRoot },
};

// ---------------------------------------------------------------------------
// Shared state: mode and Claude block.
// ---------------------------------------------------------------------------

function stateDir() {
  const home = process.env.PAPERCLIP_HOME || path.join(os.homedir(), ".paperclip");
  return path.join(home, "moteur");
}

function statePath() {
  return path.join(stateDir(), "state.json");
}

export function readState() {
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

export function writeState(next) {
  fs.mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
  const tmp = `${statePath()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, statePath());
}

function claudeBlocked(state, now = Date.now()) {
  const until = state.claudeBlockedUntil ? Date.parse(state.claudeBlockedUntil) : NaN;
  return Number.isFinite(until) && until > now;
}

/** Engine for this run, from the shared mode. */
export function chooseEngine(_config, state) {
  if (state.mode === "claude" || state.mode === "codex") return state.mode;
  return claudeBlocked(state) ? "codex" : "claude";
}

// ---------------------------------------------------------------------------
// Settings: shared part + engine-specific part.
// ---------------------------------------------------------------------------

/** Config handed to claude_local or codex_local. */
export function engineConfig(config, engine) {
  const { claude, codex, claudeModel, claudeEffort, codexModel, codexEffort, ...common } = asObject(config);
  const own = asObject(engine === "claude" ? claude : codex);
  // The form fields (top-level keys) win over the engine block.
  const picked = engine === "claude"
    ? {
        ...(claudeModel ? { model: claudeModel } : {}),
        ...(claudeEffort ? { effort: claudeEffort } : {}),
      }
    : {
        ...(codexModel ? { model: codexModel } : {}),
        ...(codexEffort ? { modelReasoningEffort: codexEffort } : {}),
      };
  return {
    ...common,
    ...own,
    ...picked,
    env: { ...asObject(common.env), ...asObject(own.env) },
  };
}

// The conversation is stored per engine: { engine, params }.
function unwrapSession(runtime, engine) {
  const stored = asObject(runtime?.sessionParams);
  if (stored.engine !== engine) {
    return { ...runtime, sessionId: null, sessionParams: null, sessionDisplayId: null };
  }
  const params = asObject(stored.params);
  return {
    ...runtime,
    sessionParams: Object.keys(params).length ? params : null,
    sessionId: typeof stored.sessionId === "string" ? stored.sessionId : runtime?.sessionId ?? null,
  };
}

function wrapResult(result, engine) {
  if (!result || typeof result !== "object") return result;
  const hasSession = result.sessionParams !== undefined || result.sessionId !== undefined;
  return {
    ...result,
    ...(hasSession
      ? {
          sessionParams: result.sessionParams || result.sessionId
            ? { engine, params: result.sessionParams ?? null, sessionId: result.sessionId ?? null }
            : null,
        }
      : {}),
  };
}

function isQuotaFailure(result) {
  return result?.errorFamily === "provider_quota" || result?.errorCode === "provider_quota";
}

// ---------------------------------------------------------------------------
// Run.
// ---------------------------------------------------------------------------

async function runEngine(ctx, engine) {
  const target = engines[engine];
  const config = engineConfig(ctx.config, engine);
  const runtime = unwrapSession(ctx.runtime, engine);
  await ctx.onLog("stderr", `[moteur_local] engine: ${engine}\n`);
  const result = await target.server.execute({ ...ctx, config, runtime });
  return wrapResult(result, engine);
}

async function execute(ctx) {
  const state = readState();
  const engine = chooseEngine(asObject(ctx.config), state);
  const result = await runEngine(ctx, engine);

  if (engine !== "claude" || !isQuotaFailure(result)) return result;

  // Claude quota exhausted: record the block.
  const retry = Date.parse(result.retryNotBefore ?? "");
  const until = Number.isFinite(retry) && retry > Date.now() ? retry : Date.now() + DEFAULT_CLAUDE_BLOCK_MS;
  writeState({ ...readState(), claudeBlockedUntil: new Date(until).toISOString() });
  await ctx.onLog("stderr", `[moteur_local] Claude quota exhausted until ${new Date(until).toISOString()}\n`);

  // In auto mode, redo the work with Codex right away.
  if (chooseEngine(asObject(ctx.config), readState()) !== "codex") return result;
  if (ctx.signal?.aborted) return result;
  await ctx.onLog("stderr", "[moteur_local] switching to Codex\n");
  return runEngine(ctx, "codex");
}

async function testEnvironment(ctx) {
  const state = readState();
  const engine = chooseEngine(asObject(ctx.config), state);
  const result = await engines[engine].server.testEnvironment({
    ...ctx,
    config: engineConfig(ctx.config, engine),
  });
  return { ...result, adapterType: ADAPTER_TYPE };
}

// ---------------------------------------------------------------------------
// Conversation, skills, models.
// ---------------------------------------------------------------------------

const sessionCodec = {
  deserialize(raw) {
    const value = asObject(raw);
    if (!ENGINES.includes(value.engine)) return null;
    const codec = engines[value.engine].server.sessionCodec;
    const params = codec ? codec.deserialize(value.params) : asObject(value.params);
    return { engine: value.engine, params, sessionId: value.sessionId ?? null };
  },
  serialize(params) {
    const value = asObject(params);
    if (!ENGINES.includes(value.engine)) return null;
    const codec = engines[value.engine].server.sessionCodec;
    return {
      engine: value.engine,
      params: codec ? codec.serialize(value.params ?? null) : value.params ?? null,
      sessionId: value.sessionId ?? null,
    };
  },
  getDisplayId(params) {
    const value = asObject(params);
    if (!ENGINES.includes(value.engine)) return null;
    const codec = engines[value.engine].server.sessionCodec;
    const inner = codec?.getDisplayId?.(value.params ?? null) ?? value.sessionId ?? null;
    return inner ? `${value.engine}:${inner}` : null;
  },
};

// Skills are installed for both engines, so a switch finds them.
async function listSkills(ctx) {
  const engine = chooseEngine(asObject(ctx.config), readState());
  const list = engine === "claude" ? claudeServer.listClaudeSkills : codexServer.listCodexSkills;
  return list({ ...ctx, config: engineConfig(ctx.config, engine) });
}

async function syncSkills(ctx, desiredSkills) {
  const codexSnapshot = await codexServer.syncCodexSkills(
    { ...ctx, config: engineConfig(ctx.config, "codex") },
    desiredSkills,
  );
  const claudeSnapshot = await claudeServer.syncClaudeSkills(
    { ...ctx, config: engineConfig(ctx.config, "claude") },
    desiredSkills,
  );
  return chooseEngine(asObject(ctx.config), readState()) === "claude" ? claudeSnapshot : codexSnapshot;
}

const agentConfigurationDoc = `# moteur_local

Runs Claude Code or Codex from the shared mode in ~/.paperclip/moteur/state.json
(\`auto\`, \`claude\`, \`codex\`). In \`auto\`, an exhausted Claude quota moves
runs to Codex until the retry time.

Settings:
- \`claudeModel\`, \`claudeEffort\`, \`codexModel\`, \`codexEffort\`: form fields; they win over the blocks below
- \`claude\`: claude_local settings (model, command, extraArgs, effort, env…)
- \`codex\`: codex_local settings (model, command, extraArgs, env…)
- everything else (instructionsFilePath, cwd, timeoutSec, env…) is shared by both engines
`;

// Form shown on the agent configuration page.
function modelOptions(list) {
  return (list ?? []).map((m) => ({ value: m.id, label: m.label ?? m.id }));
}

function getConfigSchema() {
  return {
    fields: [
      {
        key: "claudeModel",
        label: "Claude model",
        type: "combobox",
        options: modelOptions(claudeRoot.models),
        hint: "Model used when the agent runs on Claude.",
      },
      {
        key: "claudeEffort",
        label: "Claude effort",
        type: "select",
        options: [
          { value: "", label: "Default" },
          ...["low", "medium", "high", "xhigh", "max"].map((value) => ({ value, label: value })),
        ],
        default: "",
        hint: "Opus and Sonnet accept it; Haiku ignores it. Default lets Claude Code decide.",
      },
      {
        key: "codexModel",
        label: "Codex model",
        type: "combobox",
        options: modelOptions(codexRoot.models),
        hint: "Model used when the agent runs on Codex.",
      },
      {
        key: "codexEffort",
        label: "Codex reasoning effort",
        type: "select",
        options: ["low", "medium", "high", "xhigh", "max", "ultra"].map((value) => ({ value, label: value })),
        default: "medium",
        hint: "Some models stop at max; ultra is only accepted by the largest ones.",
      },
    ],
  };
}

export function createServerAdapter() {
  return {
    type: ADAPTER_TYPE,
    runtimeToolDelivery: "native_mcp",
    execute,
    testEnvironment,
    listSkills,
    syncSkills,
    sessionCodec,
    supportsToolRefreshOnResume: true,
    // No shared model list: the form picks one model per engine.
    models: [],
    supportsLocalAgentJwt: true,
    supportsInstructionsBundle: true,
    instructionsPathKey: "instructionsFilePath",
    requiresMaterializedRuntimeSkills: false,
    agentConfigurationDoc,
    getConfigSchema,
  };
}
