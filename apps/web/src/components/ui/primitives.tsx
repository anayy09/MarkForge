import type { ButtonHTMLAttributes, AnchorHTMLAttributes, ReactNode, Ref } from "react";
import { cn } from "@/lib/cn";

/*
 * The shape rule lives in globals.css as --radius-panel (6px) and --radius-chip (3px), and
 * these are the only components that spend them. Panels and buttons are panel-radius, chips
 * and inputs are chip-radius, and there is no third value anywhere on the site.
 */

type Variant = "primary" | "secondary" | "ghost";
type Size = "md" | "sm";

const VARIANT: Record<Variant, string> = {
  // 5.21:1 in light, 7.65:1 in dark. Measured, not assumed.
  primary: "bg-ember text-ember-ink hover:brightness-[1.08] active:brightness-100",
  secondary: "border border-rule-strong text-ink hover:bg-sunken",
  ghost: "text-ink-muted hover:bg-sunken hover:text-ink",
};

const SIZE: Record<Size, string> = {
  md: "h-10 px-4 text-sm",
  sm: "h-8 px-3 text-[13px]",
};

const BASE = cn(
  "inline-flex items-center justify-center gap-2 rounded-panel font-medium",
  // whitespace-nowrap enforces the one-line CTA rule mechanically rather than by review.
  "whitespace-nowrap transition-[background-color,color,filter,transform] duration-150",
  "active:translate-y-px disabled:pointer-events-none disabled:opacity-45",
);

// `ref` is a plain prop in React 19, so there is no forwardRef wrapper here.
export function Button({
  variant = "secondary",
  size = "md",
  className,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  size?: Size;
  ref?: Ref<HTMLButtonElement>;
}) {
  return <button className={cn(BASE, VARIANT[variant], SIZE[size], className)} {...rest} />;
}

export function LinkButton({
  variant = "secondary",
  size = "md",
  className,
  ...rest
}: AnchorHTMLAttributes<HTMLAnchorElement> & { variant?: Variant; size?: Size }) {
  return <a className={cn(BASE, VARIANT[variant], SIZE[size], className)} {...rest} />;
}

/**
 * A small label. `tone="accent"` is for a real state (lossy, active, selected), never for
 * decoration, and `tone="danger"` only for a diagnostic of severity error.
 */
export function Chip({
  children,
  tone = "neutral",
  mono = false,
  className,
}: {
  children: ReactNode;
  tone?: "neutral" | "accent" | "danger" | "quiet";
  mono?: boolean;
  className?: string;
}) {
  const tones = {
    neutral: "bg-sunken text-ink-muted",
    quiet: "text-ink-faint",
    accent: "bg-ember-wash text-ember",
    danger: "bg-danger-wash text-danger",
  } as const;
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-chip px-1.5 py-0.5 text-[11px] leading-4",
        mono && "font-mono tabular-nums tracking-tight",
        tones[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

/** A bounded surface. Used where a boundary is real; grouping otherwise uses rules and space. */
export function Panel({
  children,
  className,
  inset = false,
}: {
  children: ReactNode;
  className?: string;
  inset?: boolean;
}) {
  return (
    <div
      className={cn(
        "rounded-panel border border-rule",
        inset ? "bg-sunken" : "bg-surface",
        className,
      )}
    >
      {children}
    </div>
  );
}

/**
 * The eyebrow, deliberately rationed.
 *
 * Landing pages built by rote put one of these above every section, which produces the same
 * templated rhythm every time. The site's budget is three across the whole landing page and
 * they are spent in the hero, the diagnostics section, and the measurement section.
 */
export function Eyebrow({ children }: { children: ReactNode }) {
  return (
    <p className="mb-4 font-mono text-[11px] uppercase tracking-[0.16em] text-ink-faint">
      {children}
    </p>
  );
}

/** A number, always monospaced and tabular so a column of them aligns. */
export function Stat({
  value,
  label,
  sub,
  tone = "neutral",
}: {
  value: string;
  label: string;
  sub?: string;
  tone?: "neutral" | "accent";
}) {
  return (
    <div>
      <div
        className={cn(
          "font-mono text-3xl tabular-nums tracking-tight md:text-4xl",
          tone === "accent" ? "text-ember" : "text-ink",
        )}
      >
        {value}
      </div>
      <div className="mt-1.5 text-sm text-ink">{label}</div>
      {sub ? <div className="mt-0.5 text-[13px] leading-snug text-ink-muted">{sub}</div> : null}
    </div>
  );
}
