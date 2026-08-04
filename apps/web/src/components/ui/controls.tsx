"use client";

import type { ReactNode } from "react";
import { useId } from "react";
import { CaretDown, Check } from "@phosphor-icons/react";
import { cn } from "@/lib/cn";

/*
 * Form rules, applied everywhere without exception:
 *   label ABOVE the input, never a placeholder standing in for one
 *   help text present in the markup, below the control
 *   every control reaches WCAG AA against --surface, including its border
 */

function Label({ htmlFor, children }: { htmlFor: string; children: ReactNode }) {
  return (
    <label htmlFor={htmlFor} className="block text-[12px] font-medium text-ink">
      {children}
    </label>
  );
}

function Help({ children }: { children: ReactNode }) {
  return <p className="mt-1 text-[11px] leading-snug text-ink-muted">{children}</p>;
}

const CONTROL = cn(
  "w-full rounded-chip border border-rule-strong bg-surface text-ink",
  "transition-colors hover:border-ink-faint",
  "focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/25",
);

export interface Option<T extends string> {
  value: T;
  label: string;
  /** Shown in the option row. Use for the thing the user cannot guess from the name. */
  note?: string;
}

export function Select<T extends string>({
  label,
  help,
  value,
  options,
  onChange,
  disabled = false,
}: {
  label: string;
  help?: string | undefined;
  value: T;
  options: readonly Option<T>[];
  onChange: (value: T) => void;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div>
      <Label htmlFor={id}>{label}</Label>
      <div className="relative mt-1">
        <select
          id={id}
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value as T)}
          className={cn(
            CONTROL,
            "h-8 appearance-none py-0 pl-2 pr-7 text-[13px]",
            "disabled:cursor-not-allowed disabled:opacity-50",
          )}
        >
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
              {o.note ? `  (${o.note})` : ""}
            </option>
          ))}
        </select>
        <CaretDown
          size={12}
          className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-ink-muted"
        />
      </div>
      {help ? <Help>{help}</Help> : null}
    </div>
  );
}

export function Toggle({
  label,
  help,
  checked,
  onChange,
  disabled = false,
}: {
  label: string;
  help?: string | undefined;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div>
      <div className="flex items-start gap-2">
        <button
          id={id}
          type="button"
          role="switch"
          aria-checked={checked}
          disabled={disabled}
          onClick={() => onChange(!checked)}
          className={cn(
            "mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-chip border transition-colors",
            checked ? "border-accent bg-accent text-accent-ink" : "border-rule-strong bg-surface",
            "hover:border-accent disabled:cursor-not-allowed disabled:opacity-50",
          )}
        >
          {checked ? <Check size={11} weight="bold" /> : null}
        </button>
        <label htmlFor={id} className="cursor-pointer select-none text-[12px] font-medium text-ink">
          {label}
        </label>
      </div>
      {help ? <div className="pl-6">{<Help>{help}</Help>}</div> : null}
    </div>
  );
}

export function NumberField({
  label,
  help,
  value,
  min = 0,
  max = 999,
  onChange,
}: {
  label: string;
  help?: string | undefined;
  value: number;
  min?: number;
  max?: number;
  onChange: (value: number) => void;
}) {
  const id = useId();
  return (
    <div>
      <Label htmlFor={id}>{label}</Label>
      <input
        id={id}
        type="number"
        value={value}
        min={min}
        max={max}
        onChange={(e) => {
          const n = Number(e.target.value);
          if (Number.isFinite(n)) onChange(Math.min(max, Math.max(min, n)));
        }}
        className={cn(CONTROL, "mt-1 h-8 px-2 font-mono text-[13px] tabular-nums")}
      />
      {help ? <Help>{help}</Help> : null}
    </div>
  );
}

export function TextField({
  label,
  help,
  value,
  placeholder,
  onChange,
}: {
  label: string;
  help?: string | undefined;
  value: string;
  placeholder?: string;
  onChange: (value: string) => void;
}) {
  const id = useId();
  return (
    <div>
      <Label htmlFor={id}>{label}</Label>
      <input
        id={id}
        type="text"
        value={value}
        // Never a stand-in for the label. This shows the shape of a valid value.
        placeholder={placeholder ?? ""}
        onChange={(e) => onChange(e.target.value)}
        className={cn(CONTROL, "mt-1 h-8 px-2 text-[13px] placeholder:text-ink-faint")}
      />
      {help ? <Help>{help}</Help> : null}
    </div>
  );
}

/** A group of controls under one heading, separated by a rule rather than boxed in a card. */
export function ControlGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rule-t px-4 py-4 first:border-t-0">
      <h3 className="mb-3 font-mono text-[11px] uppercase tracking-[0.14em] text-ink-faint">
        {title}
      </h3>
      <div className="space-y-3.5">{children}</div>
    </section>
  );
}
