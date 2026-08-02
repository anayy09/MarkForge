import type { ParityDigest } from "@/lib/data";
import { Reveal, Section } from "@/components/landing/reveal";

const SURFACES = [
  { name: "Command line", detail: "markforge convert" },
  { name: "HTTP", detail: "two routes, no retention" },
  { name: "MCP", detail: "stdio, for an agent" },
  { name: "Browser", detail: "this page" },
];

/**
 * The claim, and the number it can be checked against.
 *
 * Four ways in exist so that privacy, automation and agent use do not each get a slightly
 * different converter. That is checked rather than intended: a gate runs every corpus fixture
 * through all four and compares byte for byte, with no key in the environment.
 */
export function Surfaces({ parity }: { parity: ParityDigest }) {
  return (
    <Section className="rule-t py-16 lg:py-24">
      <Reveal>
        <h2 className="max-w-2xl text-3xl font-semibold tracking-tight text-ink md:text-4xl">
          Four ways in. One set of bytes.
        </h2>
        <p className="mt-4 max-w-prose text-[15px] leading-relaxed text-ink-muted">
          A gate runs every fixture through all four and compares the output byte for byte,
          with no API key in the environment. This page is not a fifth implementation; it
          loads the same build that gate measures.
        </p>
      </Reveal>

      <Reveal delay={0.06}>
        <div className="mt-12 grid grid-cols-2 gap-px overflow-hidden rounded-panel border border-rule bg-rule lg:grid-cols-4">
          {SURFACES.map((s) => (
            <div key={s.name} className="bg-paper p-5">
              <h3 className="text-[14px] font-medium text-ink">{s.name}</h3>
              <p className="mt-1 font-mono text-[11px] text-ink-muted">{s.detail}</p>
              <p className="mt-5 font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint">
                sha256
              </p>
              {/* The same digest under each column, which is the entire point of the layout. */}
              <p className="mt-1 break-all font-mono text-[10.5px] leading-relaxed text-ember">
                {parity.sha256}
              </p>
            </div>
          ))}
        </div>

        <p className="mt-5 max-w-prose text-[12.5px] leading-relaxed text-ink-muted">
          <span className="font-mono text-ink">{parity.input}</span> converted to{" "}
          <span className="font-mono text-ink">{parity.to}</span>,{" "}
          <span className="font-mono tabular-nums text-ink">
            {parity.bytes.toLocaleString("en-US")}
          </span>{" "}
          bytes, hashed during this site&apos;s build. Run the same conversion from a clone and
          you get the same string.
        </p>
      </Reveal>
    </Section>
  );
}
