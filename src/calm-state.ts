import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const CALM_EVENT = "ypi:calm";
export const LEGACY_CALM_EVENT = "firstmate:calm-presentation";

export interface CalmEventPayload {
  readonly active: boolean;
  readonly stockExportRendering: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function parseCalmEvent(data: unknown): CalmEventPayload | undefined {
  if (!isRecord(data)) return undefined;
  if (typeof data["active"] !== "boolean") return undefined;
  return {
    active: data["active"],
    stockExportRendering: data["stockExportRendering"] === true,
  };
}

function resolveCalmPreferencePath(): string {
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
