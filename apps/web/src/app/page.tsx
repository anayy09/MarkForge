import { Closing } from "@/components/landing/closing";
import { CompileBand } from "@/components/landing/compile-band";
import { DiagnosticsExample } from "@/components/landing/diagnostics-example";
import { Hero } from "@/components/landing/hero";
import { Measured } from "@/components/landing/measured";
import { getAgentifyExample, getBaselines, getExamples } from "@/lib/data";

/**
 * Five sections, five layout families, one eyebrow.
 *
 * It was nine sections, and the extra four were the problem rather than the value: a format
 * matrix, a pipeline diagram, a surface-parity table and a marquee of 53 IR node types, none
 * of which a visitor had a reason to read and all of which sat between them and the thing
 * the product does. What is left is the two actions, one proof for each, and the numbers
 * behind both.
 *
 * Every figure and every quoted line below comes from `getExamples`, `getBaselines` or
 * `getAgentifyExample`, all generated at build time by the real engine and the real
 * compiler. There is no hand-written measurement anywhere on this page, which is the least a
 * page making this particular argument can do.
 */
export default function Home() {
  const examples = getExamples();
  const asHtml = examples["mergedCellsAsHtml"];
  const flattened = examples["mergedCellsFlattened"];

  return (
    <>
      <Hero />
      <CompileBand example={getAgentifyExample()} />
      {asHtml && flattened ? (
        <DiagnosticsExample asHtml={asHtml} flattened={flattened} />
      ) : null}
      <Measured baselines={getBaselines()} />
      <Closing />
    </>
  );
}
