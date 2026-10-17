const manifest = {
  id: "julpel.moteur",
  apiVersion: 1,
  version: "0.1.0",
  displayName: "Engine",
  description: "Pick the engine of moteur_local agents (auto, Claude, Codex) and see both subscription quotas.",
  author: "Julien",
  categories: ["ui"],
  capabilities: ["ui.action.register", "ui.dashboardWidget.register", "ui.sidebar.register"],
  entrypoints: {
    worker: "./worker.js",
    ui: "./ui",
  },
  ui: {
    slots: [
      {
        type: "globalToolbarButton",
        id: "moteur-toolbar-button",
        displayName: "Engine",
        exportName: "MoteurToolbarButton",
      },
      {
        type: "dashboardWidget",
        id: "moteur-usage-widget",
        displayName: "Claude and Codex quotas",
        exportName: "MoteurUsageWidget",
      },
      {
        type: "sidebarPanel",
        id: "moteur-sidebar-usage",
        displayName: "Claude and Codex quotas",
        exportName: "MoteurSidebarUsage",
      },
    ],
  },
};

export default manifest;
