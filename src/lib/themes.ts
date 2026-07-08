/**
 * Per-company UI themes. The theme is stored on `company.color` (the accent hex,
 * which doubles as the theme key), so switching companies re-applies its theme
 * across the whole UI via CSS custom properties on :root. The first theme is the
 * default and matches the app's out-of-the-box look.
 */
export interface Theme {
  key: string;
  name: string;
  accent: string; // also the stored theme key (company.color)
  accentActive: string;
  rail: string;
  sidebar: string;
  titlebar: string;
}

export const THEMES: Theme[] = [
  {
    key: "plum",
    name: "Plum",
    accent: "#4a154b",
    accentActive: "#5b52e0",
    rail: "linear-gradient(180deg,#33093a 0%,#15131f 60%,#260a29 100%)",
    sidebar: "linear-gradient(180deg,#43104a 0%,#1c1a29 55%,#370d3a 100%)",
    titlebar: "linear-gradient(90deg,#33093a 0%,#43104a 40%,#370d3a 100%)",
  },
  {
    key: "ocean",
    name: "Ocean",
    accent: "#1d6fb8",
    accentActive: "#2b8ae0",
    rail: "linear-gradient(180deg,#0b2a44 0%,#0d1622 60%,#0a2033 100%)",
    sidebar: "linear-gradient(180deg,#123f63 0%,#111a26 55%,#0d3350 100%)",
    titlebar: "linear-gradient(90deg,#0b2a44 0%,#123f63 40%,#0d3350 100%)",
  },
  {
    key: "forest",
    name: "Forest",
    accent: "#2f855a",
    accentActive: "#38a169",
    rail: "linear-gradient(180deg,#0d3320 0%,#131f16 60%,#0a2818 100%)",
    sidebar: "linear-gradient(180deg,#164430 0%,#161f19 55%,#123a29 100%)",
    titlebar: "linear-gradient(90deg,#0d3320 0%,#164430 40%,#123a29 100%)",
  },
  {
    key: "teal",
    name: "Teal",
    accent: "#2c7a7b",
    accentActive: "#319795",
    rail: "linear-gradient(180deg,#0a3234 0%,#0f1a1b 60%,#092829 100%)",
    sidebar: "linear-gradient(180deg,#12494b 0%,#141d1e 55%,#0f3a3b 100%)",
    titlebar: "linear-gradient(90deg,#0a3234 0%,#12494b 40%,#0f3a3b 100%)",
  },
  {
    key: "crimson",
    name: "Crimson",
    accent: "#c53030",
    accentActive: "#e53e3e",
    rail: "linear-gradient(180deg,#3a0d0d 0%,#1f1313 60%,#2a0a0a 100%)",
    sidebar: "linear-gradient(180deg,#4a1414 0%,#1f1616 55%,#3a1010 100%)",
    titlebar: "linear-gradient(90deg,#3a0d0d 0%,#4a1414 40%,#3a1010 100%)",
  },
  {
    key: "sunset",
    name: "Sunset",
    accent: "#b7791f",
    accentActive: "#d69e2e",
    rail: "linear-gradient(180deg,#3a2708 0%,#1f1a13 60%,#2a1e0a 100%)",
    sidebar: "linear-gradient(180deg,#4a3410 0%,#1f1c16 55%,#3a2a10 100%)",
    titlebar: "linear-gradient(90deg,#3a2708 0%,#4a3410 40%,#3a2a10 100%)",
  },
  {
    key: "slate",
    name: "Slate",
    accent: "#4a5568",
    accentActive: "#5a7a9a",
    rail: "linear-gradient(180deg,#1a2130 0%,#12151c 60%,#161c28 100%)",
    sidebar: "linear-gradient(180deg,#232d3f 0%,#161a22 55%,#1e2636 100%)",
    titlebar: "linear-gradient(90deg,#1a2130 0%,#232d3f 40%,#1e2636 100%)",
  },
];

export const DEFAULT_THEME = THEMES[0];

export function themeForColor(color: string | null | undefined): Theme {
  return THEMES.find((t) => t.accent === color) ?? DEFAULT_THEME;
}

/** Applies a theme's colors to the document root; the whole UI reacts via vars. */
export function applyTheme(theme: Theme): void {
  const s = document.documentElement.style;
  s.setProperty("--rail-bg", theme.rail);
  s.setProperty("--sidebar-bg", theme.sidebar);
  s.setProperty("--titlebar-bg", theme.titlebar);
  s.setProperty("--accent", theme.accent);
  s.setProperty("--accent-active", theme.accentActive);
}
