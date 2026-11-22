import { device } from "@shared/device";
import manifest from "./appmeta/manifest.json";

/** Fonts offered for the latency value; mirrors the options of "value_font" in appmeta/settings.json. */
export const VALUE_FONTS = ["tiny", "small", "condensed", "normal", "bold"] as const;
export type ValueFont = (typeof VALUE_FONTS)[number];

export type Settings = {
  /** What the user typed: an IP, a host name or a full http:// URL. */
  host: string;
  intervalMs: number;
  warnMs: number;
  badMs: number;
  valueFont: ValueFont;
};

/** Must match "version" in appmeta/settings.json. */
const VERSION = 1;

/** Must mirror the "default" of every field in appmeta/settings.json. */
export const DEFAULTS: Settings = {
  host: "1.1.1.1",
  intervalMs: 500,
  warnMs: 60,
  badMs: 150,
  valueFont: "small",
};

function int(values: Record<string, unknown>, key: string, min: number, max: number, fallback: number): number {
  const v = values[key];
  return typeof v === "number" && v >= min && v <= max ? Math.round(v) : fallback;
}

/** A failure or a version mismatch falls back to the defaults, so the app still works. */
export async function loadSettings(): Promise<Settings> {
  try {
    const doc = await device.AppsSettingsGet({ app_id: manifest.id });
    if (doc.version !== VERSION) return DEFAULTS;
    const values = (doc.values ?? {}) as Record<string, unknown>;
    const host = typeof values["host"] === "string" ? values["host"].trim() : "";
    const font = VALUE_FONTS.find((f) => f === values["value_font"]) ?? DEFAULTS.valueFont;
    const warnMs = int(values, "warn_ms", 10, 2000, DEFAULTS.warnMs);
    return {
      host: host || DEFAULTS.host,
      intervalMs: int(values, "interval_ms", 200, 60000, DEFAULTS.intervalMs),
      warnMs,
      badMs: Math.max(warnMs + 1, int(values, "bad_ms", 20, 5000, DEFAULTS.badMs)),
      valueFont: font,
    };
  } catch (err) {
    console.error(`${manifest.id}: settings unavailable (${String(err)}), using defaults`);
    return DEFAULTS;
  }
}
