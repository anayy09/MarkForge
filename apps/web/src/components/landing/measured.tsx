import Link from "next/link";
import { ArrowRight } from "@phosphor-icons/react/dist/ssr";
import { Eyebrow } from "@/components/ui/primitives";
import type { Baselines } from "@/lib/data";
import { Reveal, Section } from "@/components/landing/reveal";

const LABELS: [keyof Omit<Baselines["entries"][number], "fixture" | "loop" | "census">, string][] = [
  ["structural", "Structural"],
  ["textSensitive", "Text, ws-sensitive"],
  ["textInsensitive", "Text, ws-insensitive"],
  ["tableF1", "Table F1"],
  ["tableContentF1", "Table content F1"],
  ["spanF1", "Span F1"],
];

/**
 * The averages, immediately followed by the two rows that make the averages misleading.
 *
 * Printing 92.6% alone would be true and would leave a false impression, which is the
 * failure mode this project spends most of its effort on. The floor and the zero are on the
 * same screen as the mean, at the same size.
 */
export function Measured({ baselines }: { baselines: Baselines }) {
  const n = baselines.entries.length;
  const mean = (k: (typeof LABELS)[number][0]) =>
    (baselines.entries.reduce((sum, e) => sum + e[k], 0) / n) * 100;

  const sorted = [...baselines.entries].sort((a, b) => a.structural - b.structural);
  const floor = sorted[0];
  const zero = baselines.entries.find((e) => e.loop === "scan->md" && e.structural === 0);

  return (
    <Section className="rule-t py-16 lg:py-24">
      <Reveal>
        <Eyebrow>Measured, not claimed</Eyebrow>
        <h2 className="max-w-2xl text-3xl font-semibold tracking-tight text-ink md:text-4xl">
          {n} committed baselines, recomputed on every push.
        </h2>
        <p className="mt-4 max-w-prose text-[15px] leading-relaxed text-ink-muted">
          The build fails on any drop beyond the tolerance. Improvements do not update the
          file automatically, so a number going up is also a decision somebody committed.
        </p>
      </Reveal>

      <Reveal delay={0.06}>
        <dl className="mt-12 grid grid-cols-2 gap-x-6 gap-y-8 sm:grid-cols-3 lg:grid-cols-6">
          {LABELS.map(([key, label]) => (
            <div key={key}>
              <dd className="font-mono text-3xl tabular-nums tracking-tight text-ink md:text-4xl">
                {mean(key).toFixed(1)}
                <span className="text-lg text-ink-faint">%</span>
              </dd>
              <dt className="mt-1.5 text-[12px] leading-snug text-ink-muted">{label}</dt>
            </div>
          ))}
        </dl>
      </Reveal>

      <Reveal delay={0.1}>
        <div className="mt-14 grid gap-8 border-t border-rule pt-10 md:grid-cols-2 md:gap-14">
          {floor ? (
            <Outlier
              value={`${(floor.structural * 100).toFixed(1)}%`}
              title={floor.fixture}
              loop={floor.loop}
              body="The corpus floor. Nine lists and sixteen list items flatten into paragraphs on the way through PDF, and this measures the writer and the reader together rather than either alone."
            />
          ) : null}
          {zero ? (
            <Outlier
              value="0.0%"
              title={zero.fixture}
              loop={zero.loop}
              body="A scanned page with no text recogniser wired. There is no document to compare, so every metric is zero. Reporting a blank row instead would have made producing nothing look like producing something."
            />
          ) : null}
        </div>

        <Link
          href="/fidelity"
          className="mt-10 inline-flex items-center gap-2 text-[13px] text-ember underline-offset-4 hover:underline"
        >
          All {n} rows, every metric
          <ArrowRight size={13} />
        </Link>
      </Reveal>
    </Section>
  );
}

function Outlier({
  value,
  title,
  loop,
  body,
}: {
  value: string;
  title: string;
  loop: string;
  body: string;
}) {
  return (
    <div>
      <div className="font-mono text-4xl tabular-nums tracking-tight text-ember">{value}</div>
      <div className="mt-2 font-mono text-[12px] text-ink">
        {title} <span className="text-ink-faint">{loop}</span>
      </div>
      <p className="mt-2.5 max-w-prose text-[12.5px] leading-relaxed text-ink-muted">{body}</p>
    </div>
  );
}
