import type { PluginTheme } from "@getpaseo/plugin";

/**
 * Paseo's own design scale, mirrored so what this panel draws itself measures the same as the host
 * components beside it. The host hands plugins colors but no metrics, so the scale has to be
 * restated here.
 */
export const spacing = { 1: 4, 2: 8, 3: 12, 4: 16, 6: 24, 8: 32 } as const;
export const fontSize = { sm: 12, base: 14, lg: 16 } as const;
export const radius = { sm: 2, base: 4, md: 6, lg: 8, xl: 12, full: 9999 } as const;
export const controlHeight = { tight: 28, compact: 32, field: 44 } as const;
export const iconSize = { xs: 12, sm: 14, md: 16, lg: 20 } as const;

/** Paseo centres its settings screens at this width rather than letting rows span the window. */
export const MAX_CONTENT_WIDTH = 720;

/** Paseo derives every text line height from its font size this way. */
export function leading(size: number): number {
  return Math.round(size * 1.4);
}

export type Palette = {
  isDark: boolean;
  surface0: string;
  surface1: string;
  surface2: string;
  border: string;
  borderAccent: string;
  foreground: string;
  foregroundMuted: string;
  foregroundExtraMuted: string;
  accent: string;
  accentForeground: string;
  statusSuccess: string;
  statusWarning: string;
  statusDanger: string;
};

type Rgb = { r: number; g: number; b: number };

/**
 * borderAccent is measured from surface0 rather than stepped off border, because on a light theme it
 * sits lighter than border rather than darker, so it cannot be a step in the same direction.
 */
const BORDER_ACCENT_RAMP = { dark: 0.1, light: 0.075 };

function parseColor(value: string): Rgb | null {
  const text = value.trim();
  const hex = text.startsWith("#") ? text.slice(1) : null;
  if (hex !== null && (hex.length === 3 || hex.length === 6 || hex.length === 8)) {
    const width = hex.length === 3 ? 1 : 2;
    const channel = (index: number) => {
      const part = hex.slice(index * width, index * width + width);
      const parsed = Number.parseInt(width === 1 ? part + part : part, 16);
      return Number.isNaN(parsed) ? null : parsed;
    };
    const r = channel(0);
    const g = channel(1);
    const b = channel(2);
    return r === null || g === null || b === null ? null : { r, g, b };
  }
  const rgb = /^rgba?\(([^)]+)\)$/i.exec(text);
  if (rgb) {
    const parts = rgb[1]!.split(/[\s,/]+/).filter((part) => part !== "");
    const [r, g, b] = parts.map((part) => Number.parseFloat(part));
    if ([r, g, b].some((part) => part === undefined || Number.isNaN(part))) return null;
    return { r: r!, g: g!, b: b! };
  }
  return null;
}

function toHex({ r, g, b }: Rgb): string {
  const channel = (value: number) =>
    Math.max(0, Math.min(255, Math.round(value)))
      .toString(16)
      .padStart(2, "0");
  return `#${channel(r)}${channel(g)}${channel(b)}`;
}

function mix(from: Rgb, to: Rgb, amount: number): Rgb {
  return {
    r: from.r + (to.r - from.r) * amount,
    g: from.g + (to.g - from.g) * amount,
    b: from.b + (to.b - from.b) * amount,
  };
}

function isDarkColor({ r, g, b }: Rgb): boolean {
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 < 0.5;
}

/**
 * Adds the two shades paseo's own components are written against but does not expose, so a control
 * this panel draws lands on the same colors as the host row beside it.
 */
export function derivePalette(theme: PluginTheme): Palette {
  const colors = theme.colors;
  const base = parseColor(colors.surface0);
  const muted = parseColor(colors.foregroundMuted);

  const host = {
    surface0: colors.surface0,
    surface1: colors.surface1,
    surface2: colors.surface2,
    border: colors.border,
    foreground: colors.foreground,
    foregroundMuted: colors.foregroundMuted,
    accent: colors.accent,
    accentForeground: colors.accentForeground,
    statusSuccess: colors.statusSuccess,
    statusWarning: colors.statusWarning,
    statusDanger: colors.statusDanger,
  };

  /** Only a theme whose surface is unreadable has to be assumed dark. */
  const isDark = isDarkColor(base ?? { r: 0, g: 0, b: 0 });

  if (base === null) {
    return { ...host, isDark, borderAccent: colors.border, foregroundExtraMuted: colors.foregroundMuted };
  }

  const target: Rgb = isDark ? { r: 255, g: 255, b: 255 } : { r: 0, g: 0, b: 0 };
  return {
    ...host,
    isDark,
    borderAccent: toHex(mix(base, target, isDark ? BORDER_ACCENT_RAMP.dark : BORDER_ACCENT_RAMP.light)),
    foregroundExtraMuted: muted === null ? colors.foregroundMuted : toHex(mix(muted, base, 0.35)),
  };
}
