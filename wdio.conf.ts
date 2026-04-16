import path from "node:path";

const app = path.resolve(
  "src-tauri/target/release/bundle/macos/VaultCore.app/Contents/MacOS/VaultCore",
);

export const config: WebdriverIO.Config = {
  runner: "local",
  autoCompileOpts: {
    tsNodeOpts: { project: "./e2e/tsconfig.json" },
  },

  specs: ["./e2e/specs/**/*.ts"],

  maxInstances: 1,

  capabilities: [
    {
      "tauri:options": {
        application: app,
      },
    } as WebdriverIO.Capabilities,
  ],

  logLevel: "warn",

  waitforTimeout: 10_000,
  connectionRetryTimeout: 120_000,
  connectionRetryCount: 0,

  framework: "mocha",
  mochaOpts: {
    ui: "bdd",
    timeout: 60_000,
  },

  reporters: ["spec"],

  port: 4444,
};
