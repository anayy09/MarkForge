"use client";

import { ArrowCounterClockwise } from "@phosphor-icons/react";
import { ControlGroup, NumberField, Select, TextField, Toggle } from "@/components/ui/controls";
import { Chip } from "@/components/ui/primitives";
import {
  REVISION_MODES,
  countOverrides,
  defaultSettings,
  effectiveMarkdown,
  type FlavorData,
  type MarkdownSettings,
  type OutputFormat,
  type Settings,
} from "@/lib/formats";

/**
 * Every renderer option the browser surface can express, and nothing it cannot.
 *
 * The panel shows the options for the *target* format only. Showing all three at once was the
 * first draft and it made the DOCX writer's `onMissingStyle` look like it had some bearing on
 * a Markdown conversion, which is exactly the kind of quiet wrongness the rest of this
 * project spends its effort avoiding.
 */
export function OptionsPanel({
  to,
  settings,
  flavors,
  onChange,
}: {
  to: OutputFormat;
  settings: Settings;
  flavors: FlavorData;
  onChange: (next: Settings) => void;
}) {
  const changed = countOverrides(flavors, settings);
  const set = <K extends keyof Settings>(key: K, value: Settings[K]) =>
    onChange({ ...settings, [key]: value });
  const setMd = (patch: Partial<MarkdownSettings>) =>
    set("markdown", { ...settings.markdown, ...patch });

  const preset = flavors.presets.find((p) => p.id === settings.markdown.flavor);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="rule-b flex h-9 shrink-0 items-center gap-2 px-3">
        <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-ink-faint">
          Options
        </span>
        {changed > 0 ? (
          <>
            <Chip mono tone="accent">
              {changed} changed
            </Chip>
            <button
              type="button"
              onClick={() => onChange(defaultSettings(flavors))}
              className="ml-auto flex items-center gap-1 rounded-chip px-1.5 py-1 text-[11px] text-ink-muted transition-colors hover:bg-sunken hover:text-ink"
            >
              <ArrowCounterClockwise size={11} />
              Reset
            </button>
          </>
        ) : (
          <span className="ml-auto text-[11px] text-ink-faint">all defaults</span>
        )}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <ControlGroup title="Pipeline">
          <Toggle
            label="Infer structure"
            help="Off keeps evidence as evidence: bold 16pt text stays a bold paragraph instead of becoming a heading. The CLI spells this --no-infer."
            checked={settings.infer}
            onChange={(v) => set("infer", v)}
          />
        </ControlGroup>

        {to === "md" ? (
          <>
            <ControlGroup title="Markdown flavour">
              <Select
                label="Flavour"
                help={
                  preset
                    ? `Decides what can be expressed at all, not only how it is spelled.`
                    : undefined
                }
                value={settings.markdown.flavor}
                options={flavors.presets.map((p) => ({ value: p.id, label: p.displayName }))}
                onChange={(flavor) => set("markdown", effectiveMarkdown(flavors, flavor))}
              />
              {preset ? <SyntaxMatrix preset={preset.syntax} /> : null}
            </ControlGroup>

            <ControlGroup title="Tables">
              <Select
                label="Merged cells"
                help="A pipe table cannot express a merge. auto keeps such tables as HTML and loses nothing; gfm flattens them and reports the loss."
                value={settings.markdown.tables}
                options={[
                  { value: "auto", label: "auto", note: "HTML only when merged" },
                  { value: "gfm", label: "gfm", note: "always pipes, lossy" },
                  { value: "html", label: "html", note: "always HTML" },
                ]}
                onChange={(tables) => setMd({ tables })}
              />
            </ControlGroup>

            <ControlGroup title="Spelling">
              <Select
                label="Headings"
                value={settings.markdown.headings}
                options={[
                  { value: "atx", label: "atx", note: "# Heading" },
                  { value: "setext", label: "setext", note: "underlined, levels 1 and 2 only" },
                ]}
                onChange={(headings) => setMd({ headings })}
              />
              <div className="grid grid-cols-2 gap-3">
                <Select
                  label="Bullet"
                  value={settings.markdown.bullet}
                  options={[
                    { value: "-", label: "-" },
                    { value: "*", label: "*" },
                    { value: "+", label: "+" },
                  ]}
                  onChange={(bullet) => setMd({ bullet })}
                />
                <Select
                  label="Fence"
                  value={settings.markdown.fence}
                  options={[
                    { value: "`", label: "`" },
                    { value: "~", label: "~" },
                  ]}
                  onChange={(fence) => setMd({ fence })}
                />
                <Select
                  label="Emphasis"
                  value={settings.markdown.emphasis}
                  options={[
                    { value: "_", label: "_" },
                    { value: "*", label: "*" },
                  ]}
                  onChange={(emphasis) => setMd({ emphasis })}
                />
                <Select
                  label="Strong"
                  value={settings.markdown.strong}
                  options={[
                    { value: "*", label: "**" },
                    { value: "_", label: "__" },
                  ]}
                  onChange={(strong) => setMd({ strong })}
                />
              </div>
              <Select
                label="List indent"
                value={settings.markdown.listIndent}
                options={[
                  { value: "one", label: "one", note: "one space past the marker" },
                  { value: "tab", label: "tab" },
                  { value: "mixed", label: "mixed" },
                ]}
                onChange={(listIndent) => setMd({ listIndent })}
              />
              <NumberField
                label="Reflow width"
                help="0 never reflows. Any other value rewraps paragraphs, which makes a one-word edit produce a diff spanning every following line."
                value={settings.markdown.lineWidth}
                min={0}
                max={200}
                onChange={(lineWidth) => setMd({ lineWidth })}
              />
            </ControlGroup>

            <ControlGroup title="Tracked changes">
              <Select
                label="Revision mode"
                value={settings.markdown.revisionMode}
                options={REVISION_MODES.map((m) => ({ value: m.value, label: m.label, note: m.note }))}
                onChange={(revisionMode) => setMd({ revisionMode })}
              />
            </ControlGroup>
          </>
        ) : null}

        {to === "html" ? (
          <ControlGroup title="HTML">
            <Toggle
              label="Full document"
              help="Off emits a fragment: no doctype, no head, no stylesheet."
              checked={settings.html.fullDocument}
              onChange={(fullDocument) => set("html", { ...settings.html, fullDocument })}
            />
            <Toggle
              label="Heading ids"
              help="Adds a stable id to every heading so fragments can link to it."
              checked={settings.html.headingIds}
              onChange={(headingIds) => set("html", { ...settings.html, headingIds })}
            />
            <TextField
              label="Title"
              help="Empty uses the document's own metadata, or omits the element."
              placeholder="Quarterly review"
              value={settings.html.title}
              onChange={(title) => set("html", { ...settings.html, title })}
            />
            <TextField
              label="Language"
              help="Written to the lang attribute. Empty omits it rather than guessing."
              placeholder="en"
              value={settings.html.lang}
              onChange={(lang) => set("html", { ...settings.html, lang })}
            />
          </ControlGroup>
        ) : null}

        {to === "docx" ? (
          <ControlGroup title="DOCX">
            <Select
              label="Missing style"
              help="What to do when the reference document does not define a style the writer needs. Measured on a real publisher template: 8 of the 38 Pandoc names were present, so synthesize is the common path, not the edge case."
              value={settings.docx.onMissingStyle}
              options={[
                { value: "synthesize", label: "synthesize", note: "create it" },
                { value: "warn", label: "warn", note: "use Normal, report it" },
                { value: "error", label: "error", note: "refuse" },
              ]}
              onChange={(onMissingStyle) => set("docx", { ...settings.docx, onMissingStyle })}
            />
            <Select
              label="Revision mode"
              value={settings.docx.revisionMode}
              options={REVISION_MODES.map((m) => ({ value: m.value, label: m.label, note: m.note }))}
              onChange={(revisionMode) => set("docx", { ...settings.docx, revisionMode })}
            />
          </ControlGroup>
        ) : null}

        {to === "pdf" ? (
          <ControlGroup title="PDF">
            <p className="text-[12px] leading-relaxed text-ink-muted">
              The Typst renderer takes no options here yet. ADR-0003 promises a template per
              style profile and none exists, so offering a profile selector would advertise a
              distinction that does not exist. All three profiles render the same.
            </p>
          </ControlGroup>
        ) : null}
      </div>
    </div>
  );
}

/**
 * What the chosen flavour can express.
 *
 * This is the part of a flavour that is not cosmetic. `commonmark` has no tables at all, so
 * choosing it turns a table into something else, and the panel should say that before the
 * conversion does.
 */
function SyntaxMatrix({ preset }: { preset: FlavorData["presets"][number]["syntax"] }) {
  const rows: [string, string | false | boolean][] = [
    ["tables", preset.tables],
    ["footnotes", preset.footnotes],
    ["math", preset.math],
    ["admonitions", preset.admonitions],
    ["front matter", preset.frontMatter],
  ];
  return (
    <dl className="mt-1 space-y-1">
      {rows.map(([label, value]) => (
        <div key={label} className="flex items-baseline justify-between gap-2">
          <dt className="text-[11px] text-ink-muted">{label}</dt>
          <dd
            className={
              value === false
                ? "font-mono text-[11px] text-ink-faint line-through"
                : "font-mono text-[11px] text-ink"
            }
          >
            {value === false ? "cannot express" : value === true ? "yes" : String(value)}
          </dd>
        </div>
      ))}
    </dl>
  );
}
