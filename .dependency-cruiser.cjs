module.exports = {
  forbidden: [
    {
      name: "no-circular",
      severity: "error",
      from: {},
      to: { circular: true },
    },
    {
      name: "no-unresolvable",
      severity: "error",
      from: {},
      to: { couldNotResolve: true },
    },
    {
      name: "pure-modules-never-import-extensions",
      severity: "error",
      from: {
        path: "^src/(activity|activity-renderer|calm-state|config|launch)\\.ts$",
      },
      to: {
        path: "^src/(tui|calm|optchat)\\.ts$",
      },
    },
    {
      name: "src-not-to-dev-dependencies",
      severity: "error",
      from: { path: "^src/" },
      to: { dependencyTypes: ["npm-dev"], dependencyTypesNot: ["type-only"] },
    },
  ],
  options: {
    includeOnly: "^(src|e2e)/",
    exclude: { path: "(^|/)(node_modules|dist|vendor)/" },
    doNotFollow: { path: "node_modules" },
    tsConfig: { fileName: "tsconfig.json" },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: { exportsFields: ["exports"], conditionNames: ["import", "default"] },
  },
};
