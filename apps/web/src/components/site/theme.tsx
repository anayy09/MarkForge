"use client";

import { useEffect, useState } from "react";
import { Monitor, MoonStars, Sun } from "@phosphor-icons/react";
import { cn } from "@/lib/cn";

export type ThemeChoice = "system" | "light" | "dark";

const STORAGE_KEY = "markforge-theme";

/**
 * Applied before first paint by `themeScript` below and again on every change here, so the
 * two must agree. Kept as one exported function for that reason.
 */
export function resolveTheme(choice: ThemeChoice): "light" | "dark" {
  if (choice !== "system") return choice;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/**
 * Runs before React hydrates, inline in <head>.
 *
 * Without it the page paints in light, then flips, and on a dark-mode machine that flash is
 * the first thing the user sees. Stringified rather than imported because it has to execute
 * before any bundle loads.
 */
export const themeScript = `(function(){try{
var c=localStorage.getItem(${JSON.stringify(STORAGE_KEY)})||"system";
var d=c==="dark"||(c==="system"&&matchMedia("(prefers-color-scheme: dark)").matches);
document.documentElement.setAttribute("data-theme",d?"dark":"light");
}catch(e){document.documentElement.setAttribute("data-theme","light");}})();`;

const ORDER: ThemeChoice[] = ["system", "light", "dark"];
const LABEL: Record<ThemeChoice, string> = {
  system: "Match the system",
  light: "Light",
  dark: "Dark",
};
const ICON = { system: Monitor, light: Sun, dark: MoonStars } as const;

export function ThemeToggle() {
  const [choice, setChoice] = useState<ThemeChoice>("system");
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEY) as ThemeChoice | null;
    if (stored && ORDER.includes(stored)) setChoice(stored);
    setReady(true);
  }, []);

  useEffect(() => {
    if (!ready) return;
    localStorage.setItem(STORAGE_KEY, choice);
    document.documentElement.setAttribute("data-theme", resolveTheme(choice));

    // A system choice has to keep tracking the system, not just read it once.
    if (choice !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const sync = () => document.documentElement.setAttribute("data-theme", resolveTheme("system"));
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, [choice, ready]);

  const next = ORDER[(ORDER.indexOf(choice) + 1) % ORDER.length] ?? "system";
  const Icon = ICON[choice];

  return (
    <button
      type="button"
      onClick={() => setChoice(next)}
      title={`Theme: ${LABEL[choice]}. Switch to ${LABEL[next].toLowerCase()}.`}
      aria-label={`Theme: ${LABEL[choice]}. Switch to ${LABEL[next].toLowerCase()}.`}
      className={cn(
        "grid h-8 w-8 place-items-center rounded-chip text-ink-muted",
        "transition-colors hover:bg-sunken hover:text-ink active:translate-y-px",
      )}
    >
      {/* Invisible until the stored choice is known, so the icon never shows the wrong state. */}
      <Icon size={17} className={ready ? "opacity-100" : "opacity-0"} />
    </button>
  );
}
