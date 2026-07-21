export const runtimePackages = Object.freeze([
  Object.freeze({ name: "@blackbox/protocol", directory: "packages/protocol" }),
  Object.freeze({ name: "@blackbox/storage", directory: "packages/storage" }),
  Object.freeze({
    name: "@blackbox/normalizers",
    directory: "packages/normalizers",
  }),
  Object.freeze({ name: "@blackbox/context", directory: "packages/context" }),
  Object.freeze({
    name: "@blackbox/analysis",
    directory: "packages/analysis",
  }),
  Object.freeze({ name: "@blackbox/daemon", directory: "apps/daemon" }),
  Object.freeze({ name: "@blackbox/cli", directory: "apps/cli" }),
]);
