#!/usr/bin/env node
// Move Paperclip agents from claude_local to moteur_local.
//
//     node migrate.js --dry-run          show the new configs, change nothing
//     node migrate.js                    migrate, after saving the old configs
//     node migrate.js --restore FILE     put back the configs saved in FILE
//
// Models per agent come from pc-moteur (JUJ-13). The old configs are saved in
// ~/.paperclip/moteur/backup-<date>.json before anything changes.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = process.env.PAPERCLIP_HOME ?? path.join(os.homedir(), ".paperclip");
const API_BASE = "https://rpi5.tailf6e052.ts.net:8445";
const CODEX_COMMAND = "/home/julien/.local/bin/codex";

const AGENTS = [
  { name: "Jim", id: "cffa8e35-7adc-40b5-8e44-87abcd694243",
    claudeModel: "claude-opus-5-5", chrome: true,
    codexModel: "gpt-6.1-sol", codexEffort: "high" },
  { name: "Dave señor", id: "fcf989fa-dc99-4653-9c90-9a923a3099e6",
    claudeModel: "claude-opus-5-5", chrome: true,
    codexModel: "gpt-6.1-sol", codexEffort: "high" },
  { name: "Pam", id: "82b83fe1-0f70-4c9b-a496-66501706f61f",
    claudeModel: "claude-sonnet-5-5", chrome: false,
    codexModel: "gpt-6.1-sol", codexEffort: "medium" },
  { name: "Dave confirmé", id: "3d96ebe3-0ff5-4ef9-bb3d-5260dc081f7f",
    claudeModel: "claude-sonnet-5-5", chrome: true,
    codexModel: "gpt-6.1-sol", codexEffort: "medium" },
  { name: "Mickael", id: "ddcbd80a-f8a2-4eab-9f91-eacd234efe58",
    claudeModel: "claude-haiku-5-5", chrome: false,
    codexModel: "gpt-6-luna", codexEffort: "medium" },
  { name: "Dave Junior", id: "4df41be8-9926-4e32-b215-a544d0b4db90",
    claudeModel: "claude-haiku-5-5", chrome: false,
    codexModel: "gpt-6-luna", codexEffort: "medium" },
];

// Keys kept from the current config; they serve both engines.
const SHARED_KEYS = ["instructionsFilePath", "instructionsRootPath", "instructionsEntryFile",
  "instructionsBundleMode", "cwd", "paperclipSkillSync", "env"];

async function api(method, route, body) {
  const auth = JSON.parse(fs.readFileSync(path.join(HOME, "auth.json"), "utf8"));
  const { token } = auth.credentials[API_BASE];
  const res = await fetch(API_BASE + route, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    const text = (await res.text()).slice(0, 400);
    throw new Error(`${method} ${route}: ${res.status} ${text}`);
  }
  return res.json();
}

function newAdapterConfig(row, current) {
  const config = { graceSec: 15, timeoutSec: 0, maxTurnsPerRun: 1000 };
  for (const key of SHARED_KEYS) {
    if (key in current) config[key] = structuredClone(current[key]);
  }
  config.claudeModel = row.claudeModel;
  config.codexModel = row.codexModel;
  config.codexEffort = row.codexEffort;
  const claude = { engine: "cli", extraArgs: ["--permission-mode", "auto"], dangerouslySkipPermissions: false };
  if (row.chrome) claude.chrome = true;
  // engine "cli" + command: the system Codex, which knows gpt-6.1-sol.
  const codex = { engine: "cli", command: CODEX_COMMAND, search: true,
    fastMode: false, dangerouslyBypassApprovalsAndSandbox: false };
  config.claude = claude;
  config.codex = codex;
  return config;
}

function newRuntimeConfig(current) {
  const runtime = structuredClone(current ?? {});
  // moteur_local brings its own logins; a managed AI connection would be refused.
  delete runtime.aiConnection;
  return runtime;
}

async function migrate(dryRun) {
  const plans = [];
  const backup = [];
  for (const row of AGENTS) {
    const agent = await api("GET", `/api/agents/${row.id}`);
    backup.push({ id: row.id, name: row.name, adapterType: agent.adapterType,
      adapterConfig: agent.adapterConfig ?? {}, runtimeConfig: agent.runtimeConfig ?? {} });
    if (agent.adapterType === "moteur_local") {
      console.log(`${row.name}: already on moteur_local, skipped`);
      continue;
    }
    plans.push([row, {
      adapterType: "moteur_local",
      adapterConfig: newAdapterConfig(row, agent.adapterConfig ?? {}),
      runtimeConfig: newRuntimeConfig(agent.runtimeConfig),
    }]);
  }

  if (dryRun) {
    for (const [row, body] of plans) {
      console.log(`--- ${row.name}`);
      console.log(JSON.stringify(body.adapterConfig, null, 2));
    }
    return;
  }

  const dir = path.join(HOME, "moteur");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  const file = path.join(dir, `backup-${stamp}.json`);
  fs.writeFileSync(file, JSON.stringify(backup, null, 2), { flag: "wx", mode: 0o600 });
  console.log(`old configs saved: ${file}`);

  for (const [row, body] of plans) {
    const result = await api("PATCH", `/api/agents/${row.id}`, body);
    console.log(`${row.name}: ${result.adapterType}`);
  }
}

async function restore(file) {
  for (const item of JSON.parse(fs.readFileSync(file, "utf8"))) {
    await api("PATCH", `/api/agents/${item.id}`, {
      adapterType: item.adapterType,
      adapterConfig: item.adapterConfig,
      runtimeConfig: item.runtimeConfig,
    });
    console.log(`${item.name}: back to ${item.adapterType}`);
  }
}

const args = process.argv.slice(2);
try {
  if (args.length === 2 && args[0] === "--restore") await restore(args[1]);
  else await migrate(args.includes("--dry-run"));
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
