import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

export type ThemePreference = "light" | "dark" | "system";

type ThemeContextValue = {
  theme: ThemePreference;
  resolvedTheme: "light" | "dark";
  setTheme: (theme: ThemePreference) => void;
};

const STORAGE_KEY = "scene-smith-theme";
const ThemeContext = createContext<ThemeContextValue | null>(null);

function systemTheme(): "light" | "dark" {
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<ThemePreference>(() => {
    if (typeof window === "undefined") return "system";
    const saved = window.localStorage.getItem(STORAGE_KEY);
    return saved === "light" || saved === "dark" || saved === "system" ? saved : "system";
  });
  const [resolvedTheme, setResolvedTheme] = useState<"light" | "dark">(() =>
    typeof window === "undefined" ? "dark" : theme === "system" ? systemTheme() : theme,
  );

  useEffect(() => {
    const media = window.matchMedia?.("(prefers-color-scheme: dark)");
    const apply = () => {
      const resolved = theme === "system" ? (media?.matches ? "dark" : "light") : theme;
      document.documentElement.classList.toggle("dark", resolved === "dark");
      window.localStorage.setItem(STORAGE_KEY, theme);
      setResolvedTheme(resolved);
    };
    apply();
    media?.addEventListener("change", apply);
    return () => media?.removeEventListener("change", apply);
  }, [theme]);

  const value = useMemo(() => ({ theme, resolvedTheme, setTheme }), [theme, resolvedTheme]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) throw new Error("useTheme must be used inside ThemeProvider");
  return context;
}

export const themeBootScript = `(() => {
  try {
    const saved = localStorage.getItem('${STORAGE_KEY}') || 'system';
    const dark = saved === 'dark' || (saved === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.classList.toggle('dark', dark);
  } catch (_) {}
})();`;
