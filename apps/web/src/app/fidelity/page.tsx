import type { Metadata } from "next";
import { FidelityExplorer } from "@/components/fidelity/explorer";
import { getBaselines } from "@/lib/data";
import { DOCS } from "@/lib/links";

export const metadata: Metadata = {
  title: "Measured fidelity",
  description:
    "Every fixture, every round trip, six metrics each. The committed baselines CI recomputes on every push, including the rows that score zero.",
};

export default function FidelityPage() {
  const baselines = getBaselines();

  return (
    <div className="mx-auto max-w-[1400px] px-5 py-16 lg:px-8 lg:py-20">
      <header className="max-w-3xl">
        <h1 className="text-4xl font-semibold tracking-tight text-ink md:text-5xl">
          What a conversion costs, in numbers somebody has to keep.
        </h1>
        <p className="mt-5 text-[15px] leading-relaxed text-ink-muted">
          Six metrics, computed on trees rather than on strings, over a corpus where every
          fixture was chosen for the failure it catches. The build recomputes all of them and
          fails on a regression, so these are the numbers the project is held to rather than
          the numbers it chose to print.
        </p>
        <p className="mt-4 text-[13px] leading-relaxed text-ink-faint">
          One caveat before the numbers, because it is the one that matters most: nothing in
          this corpus was found in the wild. The fixtures were written to break specific
          things, so the percentages describe this corpus and not your documents. That is what
          the workbench is for.{" "}
          <a
            href={DOCS.limits}
            target="_blank"
            rel="noreferrer noopener"
            className="text-ink-muted underline underline-offset-4 transition-colors hover:text-ember"
          >
            The full list of limits
          </a>{" "}
          is kept beside the code.
        </p>
      </header>

      <div className="mt-14">
        <FidelityExplorer baselines={baselines} />
      </div>
    </div>
  );
}
