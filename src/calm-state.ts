import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

type CalmListener = (active: boolean) => void;

let active = false;
const listeners = new Set<CalmListener>();

export function isCalmActive(): boolean {
  return active;
}

export function setCalmActive(next: boolean): void {
  if (active === next) return;
  active = next;
  for (const listener of listeners) {
    listener(active);
  }
}

export function onCalmChange(listener: CalmListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function resolveCalmPreferencePath(): string {
  const override = process.env["YPI_CALM_FILE"]?.trim();
  if (override !== undefined && override.length > 0) {
    return resolve(override.replace(/^~(?=\/|$)/u, homedir()));
  }
  const agentDir = process.env["PI_CODING_AGENT_DIR"]?.trim();
  const baseDir =
    agentDir !== undefined && agentDir.length > 0
      ? resolve(agentDir.replace(/^~(?=\/|$)/u, homedir()))
      : join(homedir(), ".pi", "agent");
  return join(baseDir, "ypi-calm");
}

export function loadCalmPreference(filePath = resolveCalmPreferencePath()): boolean {
  if (!existsSync(filePath)) return false;
  try {
    return readFileSync(filePath, "utf8").trim().toLowerCase() === "on";
  } catch {
    return false;
  }
}

export function saveCalmPreference(next: boolean, filePath = resolveCalmPreferencePath()): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, next ? "on\n" : "off\n", "utf8");
}
