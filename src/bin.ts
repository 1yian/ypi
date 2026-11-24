#!/usr/bin/env node
import { spawn } from "node:child_process";
import { buildPiLaunchPlan, formatYpiHelp } from "./launch.ts";

const plan = buildPiLaunchPlan(process.argv.slice(2));

if (plan.kind === "help") {
  process.stdout.write(`${formatYpiHelp()}\n`);
  process.exit(0);
}

const child = spawn(plan.piBin, [...plan.args], {
  stdio: "inherit",
  env: plan.env !== undefined ? { ...process.env, ...plan.env } : process.env,
});

process.on("SIGINT", () => undefined);
process.on("SIGTERM", () => {
  child.kill("SIGTERM");
});

child.on("error", (error) => {
  process.stderr.write(`ypi: failed to launch ${plan.piBin}: ${error.message}\n`);
  process.exit(127);
});

child.on("exit", (code, signal) => {
  if (signal !== null) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
