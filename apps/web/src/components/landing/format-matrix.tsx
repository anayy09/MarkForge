import { Check, Minus } from "@phosphor-icons/react/dist/ssr";
import { FORMATS, INPUT_FORMATS } from "@/lib/formats";
import { Reveal, Section } from "@/components/landing/reveal";

/**
 * Six read, four written, and the two that are read-only said out loud.
 *
 * A capability grid is the one place a tool is most tempted to round up. The blanks here are
 * labelled with the reason underneath rather than left as absences a reader has to interpret.
 */
export function FormatMatrix() {
  return (
    <Section className="py-16 lg:py-24">
      <Reveal>
        <h2 className="max-w-2xl text-3xl font-semibold tracking-tight text-ink md:text-4xl">
          Six formats in, four out.
        </h2>
        <p className="mt-4 max-w-prose text-[15px] leading-relaxed text-ink-muted">
          Presentations and spreadsheets are read and not written. Nobody asked MarkForge to
          generate a spreadsheet, and building it on speculation would be machinery with no
          user, so <span className="font-mono text-ink">--to xlsx</span> refuses by name rather
          than failing somewhere internal.
        </p>
      </Reveal>

      <Reveal delay={0.06}>
        <div className="mt-10 overflow-x-auto">
          <table className="w-full min-w-[560px]">
            <thead>
              <tr className="rule-b">
                <th className="pb-3 text-left font-mono text-[10px] font-normal uppercase tracking-[0.14em] text-ink-faint">
                  format
                </th>
                <th className="w-28 pb-3 text-left font-mono text-[10px] font-normal uppercase tracking-[0.14em] text-ink-faint">
                  read
                </th>
                <th className="w-28 pb-3 text-left font-mono text-[10px] font-normal uppercase tracking-[0.14em] text-ink-faint">
                  write
                </th>
                <th className="pb-3 text-left font-mono text-[10px] font-normal uppercase tracking-[0.14em] text-ink-faint">
                  in this browser
                </th>
              </tr>
            </thead>
            <tbody>
              {INPUT_FORMATS.map((id) => {
                const f = FORMATS[id];
                return (
                  <tr key={id} className="rule-b last:border-b-0">
                    <td className="py-4 align-top">
                      <span className="text-[15px] text-ink">{f.label}</span>
                    </td>
                    <td className="py-4 align-top">
                      <Mark on />
                    </td>
                    <td className="py-4 align-top">
                      <Mark on={f.write} />
                    </td>
                    <td className="py-4 align-top">
                      <p className="max-w-[52ch] text-[12px] leading-relaxed text-ink-muted">
                        {f.read === "browser"
                          ? "Read and written here. The document never leaves the tab."
                          : f.write
                            ? "Written here through the Typst compiler. Reading one needs the server, and the app asks first."
                            : "Reading needs the server, and the app asks first. There is no writer, by decision."}
                      </p>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Reveal>
    </Section>
  );
}

function Mark({ on }: { on: boolean }) {
  return on ? (
    <span className="inline-flex items-center gap-1.5 text-[13px] text-ink">
      <Check size={13} className="text-ember" weight="bold" />
      yes
    </span>
  ) : (
    <span className="inline-flex items-center gap-1.5 text-[13px] text-ink-faint">
      <Minus size={13} />
      no
    </span>
  );
}
