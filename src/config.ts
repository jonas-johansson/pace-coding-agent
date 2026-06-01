/**
 * Pace configuration loading and validation.
 *
 * Supports global config at ~/.config/pace/config.json
 */

import { readFile } from "fs/promises";
import { homedir } from "os";
import { join } from "path";
import { z } from "zod";

// ── Types ────────────────────────────────────────────────────────────────────

export type CostDisplayConfig = {
  conversionRate: number;
  format: string;
  fractionDigits?: number;
};

export type PaceConfig = {
  cost: CostDisplayConfig;
};

// ── Defaults ─────────────────────────────────────────────────────────────────

export const DEFAULT_COST_DISPLAY_CONFIG: CostDisplayConfig = {
  conversionRate: 1,
  format: "${amount}",
};

export const DEFAULT_PACE_CONFIG: PaceConfig = {
  cost: DEFAULT_COST_DISPLAY_CONFIG,
};

// ── Schema ───────────────────────────────────────────────────────────────────

const costDisplayConfigSchema = z.object({
  conversionRate: z.number().positive().finite().default(DEFAULT_COST_DISPLAY_CONFIG.conversionRate),
  format: z.string().refine((value) => value.includes("{amount}"), {
    message: "Cost format must include {amount}",
  }).default(DEFAULT_COST_DISPLAY_CONFIG.format),
  fractionDigits: z.number().int().min(0).max(20).optional(),
});

const paceConfigSchema = z.object({
  cost: costDisplayConfigSchema.optional(),
}).transform((config) => ({
  cost: config.cost ?? DEFAULT_COST_DISPLAY_CONFIG,
}));

// ── Loading ──────────────────────────────────────────────────────────────────

const CONFIG_PATH = join(homedir(), ".config", "pace", "config.json");

export async function loadPaceConfig(): Promise<PaceConfig> {
  try {
    const raw = await readFile(CONFIG_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    return paceConfigSchema.parse(parsed);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return DEFAULT_PACE_CONFIG;
    }
    throw error;
  }
}
