// UI of the Engine plugin.
// No JSX: Paperclip loads this file as is and rewrites the `react` and
// `@paperclipai/plugin-sdk/ui` imports itself.
// Only classes already present in Paperclip's stylesheet are used, so the
// plugin follows its theme (light and dark).

import React, { useEffect, useRef, useState } from "react";
import { usePluginAction, usePluginData } from "@paperclipai/plugin-sdk/ui";

const h = React.createElement;

const ENGINE_LABELS = { claude: "Claude", codex: "Codex" };

// Labels of the quota windows returned by Paperclip.
const WINDOW_LABELS = {
  "Current session": { long: "Session (5h)", short: "5h" },
  "5h limit": { long: "Session (5h)", short: "5h" },
  "Current week (all models)": { long: "Week", short: "wk" },
  "Weekly limit": { long: "Week", short: "wk" },
};

function clockTime(iso) {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function when(iso) {
  if (!iso) return "";
  const date = new Date(iso);
  return date.toDateString() === new Date().toDateString()
    ? `at ${clockTime(iso)}`
    : `on ${date.toLocaleDateString([], { weekday: "short", day: "numeric" })} at ${clockTime(iso)}`;
}

function quotaWindows(usage) {
  return (usage?.windows ?? []).filter((w) => typeof w.usedPercent === "number");
}

function percentOf(window) {
  return Math.max(0, Math.min(100, Math.round(window.usedPercent)));
}

// Fill colour: muted text colour, then amber and red as the quota fills up.
function fillClass(percent) {
  if (percent >= 90) return "bg-destructive";
  if (percent >= 70) return "bg-amber-500";
  return "bg-muted-foreground";
}

function Bar({ percent, className = "h-1.5" }) {
  return h(
    "div",
    { className: `${className} w-full rounded-full bg-muted overflow-hidden` },
    h("div", { className: `h-full rounded-full ${fillClass(percent)}`, style: { width: `${percent}%` } }),
  );
}

function useAutoRefresh(refresh, ms) {
  useEffect(() => {
    const timer = setInterval(() => refresh(), ms);
    return () => clearInterval(timer);
  }, [refresh, ms]);
}

// ---------------------------------------------------------------------------
// Top bar: Auto / Claude / Codex.
// ---------------------------------------------------------------------------

const CHOICES = [
  { mode: "auto", label: "Auto" },
  { mode: "claude", label: "Claude" },
  { mode: "codex", label: "Codex" },
];

export function MoteurToolbarButton() {
  const { data, refresh } = usePluginData("status");
  const setMode = usePluginAction("setMode");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  // Auto mode can switch on its own: re-read the state every 30 seconds.
  useAutoRefresh(refresh, 30_000);

  async function choose(mode) {
    if (busy || data?.mode === mode) return;
    setBusy(true);
    setError(null);
    try {
      await setMode({ mode });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const title = error
    ?? (!data
      ? "Agent engine"
      : data.claudeBlockedUntil
        ? `Claude quota exhausted until ${when(data.claudeBlockedUntil).replace(/^(at|on) /, "")}: agents in auto mode run on Codex.`
        : `Engine in use now: ${ENGINE_LABELS[data.engine]}.`);

  return h(
    "div",
    {
      title,
      role: "radiogroup",
      "aria-label": "Agent engine",
      className: `inline-flex h-8 items-center rounded-lg border border-border p-0.5 gap-0.5 text-xs font-medium${busy ? " opacity-60" : ""}`,
    },
    CHOICES.map(({ mode, label }) => {
      const active = data?.mode === mode;
      const text = mode === "auto" && active && data?.engine ? `Auto · ${ENGINE_LABELS[data.engine]}` : label;
      return h(
        "button",
        {
          key: mode,
          type: "button",
          role: "radio",
          "aria-checked": active,
          disabled: busy,
          onClick: () => void choose(mode),
          className: `h-full rounded-md px-2 transition-colors ${
            active ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
          }`,
        },
        text,
        mode === "auto" && active && data?.claudeBlockedUntil
          ? h("span", { className: "ml-1 text-amber-600", "aria-label": "Claude blocked" }, "●")
          : null,
      );
    }),
  );
}

// ---------------------------------------------------------------------------
// Bottom of the left sidebar: one row per engine, inside Paperclip's panel frame.
// ---------------------------------------------------------------------------

function SidebarEngineRow({ engine, usage, current }) {
  const windows = quotaWindows(usage);
  const session = windows[0];
  const percent = session ? percentOf(session) : null;
  const detail = windows
    .map((w) => `${(WINDOW_LABELS[w.label] ?? { short: w.label }).short} ${percentOf(w)}%`)
    .join(" · ");
  const tooltip = windows.length
    ? windows
      .map((w) => `${(WINDOW_LABELS[w.label] ?? { long: w.label }).long}: ${percentOf(w)}%, resets ${when(w.resetsAt)}`)
      .join("\n")
    : usage?.error ?? "Quota unavailable";

  return h(
    "div",
    {
      title: tooltip,
      className: "py-0.5 text-(length:--text-compact) font-medium text-foreground/80",
    },
    h(
      "div",
      { className: "flex items-center justify-between gap-2" },
      h(
        "span",
        { className: "flex items-center gap-1.5" },
        h("span", {
          className: `h-1.5 w-1.5 rounded-full ${current ? "bg-foreground" : "bg-muted"}`,
          "aria-hidden": "true",
        }),
        ENGINE_LABELS[engine],
      ),
      h("span", { className: "text-xs text-muted-foreground" }, detail || "—"),
    ),
    percent !== null ? h("div", { className: "mt-1" }, h(Bar, { percent, className: "h-1" })) : null,
  );
}

export function MoteurSidebarUsage() {
  const { data, refresh } = usePluginData("usage");
  useAutoRefresh(refresh, 5 * 60_000);
  if (!data) return null;
  const engine = data.status?.engine;
  return h(
    "div",
    { className: "flex flex-col gap-1", "aria-label": "Subscription quotas" },
    h("span", { className: "text-xs font-medium text-muted-foreground" }, "Quotas"),
    h(SidebarEngineRow, { engine: "claude", usage: data.claude, current: engine === "claude" }),
    h(SidebarEngineRow, { engine: "codex", usage: data.codex, current: engine === "codex" }),
  );
}

// ---------------------------------------------------------------------------
// Dashboard: quota details.
// ---------------------------------------------------------------------------

function WindowRow({ window }) {
  const percent = percentOf(window);
  return h(
    "div",
    { className: "flex flex-col gap-1" },
    h(
      "div",
      { className: "flex justify-between gap-2 text-xs" },
      h("span", { className: "text-foreground/80" }, (WINDOW_LABELS[window.label] ?? { long: window.label }).long),
      h("span", { className: "text-muted-foreground" }, `${percent}% · resets ${when(window.resetsAt)}`),
    ),
    h(Bar, { percent }),
  );
}

function EngineCard({ engine, usage, current }) {
  const windows = quotaWindows(usage);
  return h(
    "div",
    { className: "flex flex-col gap-3 rounded-lg border border-border p-3" },
    h(
      "div",
      { className: "flex items-baseline justify-between" },
      h("span", { className: "text-sm font-medium" }, ENGINE_LABELS[engine]),
      current ? h("span", { className: "text-xs text-muted-foreground" }, "in use now") : null,
    ),
    windows.length
      ? windows.map((w) => h(WindowRow, { key: w.label, window: w }))
      : h("div", { className: "text-xs text-muted-foreground" }, usage?.error ? `Quota unavailable: ${usage.error}` : "No data"),
    usage?.stale
      ? h("div", { className: "text-xs text-muted-foreground" }, "Showing the last successful read; the latest one failed.")
      : null,
  );
}

// Paperclip puts every widget in a two-column grid with no width option:
// ask the wrapper it gives us to span the whole row.
function useFullGridRow(ref) {
  useEffect(() => {
    for (let el = ref.current; el?.parentElement; el = el.parentElement) {
      if (getComputedStyle(el.parentElement).display === "grid") {
        el.style.gridColumn = "1 / -1";
        return () => {
          el.style.gridColumn = "";
        };
      }
    }
    return undefined;
  }, [ref]);
}

export function MoteurUsageWidget() {
  const { data, loading, refresh } = usePluginData("usage");
  const rootRef = useRef(null);
  useAutoRefresh(refresh, 5 * 60_000);
  useFullGridRow(rootRef);

  if (loading && !data) {
    return h("div", { ref: rootRef, className: "text-sm text-muted-foreground" }, "Reading quotas…");
  }

  const engine = data?.status?.engine;
  const blocked = data?.status?.claudeBlockedUntil;
  return h(
    "div",
    { ref: rootRef, className: "flex flex-col gap-3" },
    h(
      "div",
      { className: "flex items-baseline justify-between" },
      h("span", { className: "text-sm font-medium" }, "Subscription quotas"),
      h("span", { className: "text-xs text-muted-foreground" }, data?.readAt ? `read ${when(data.readAt)}` : ""),
    ),
    blocked
      ? h(
        "div",
        { className: "text-xs text-amber-600" },
        `Claude blocked until ${when(blocked).replace(/^(at|on) /, "")}: agents in auto mode run on Codex.`,
      )
      : null,
    h(
      "div",
      { className: "grid gap-3", style: { gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" } },
      h(EngineCard, { engine: "claude", usage: data?.claude, current: engine === "claude" }),
      h(EngineCard, { engine: "codex", usage: data?.codex, current: engine === "codex" }),
    ),
  );
}
