import { Closing } from "@/components/landing/closing";
import { DiagnosticsExample } from "@/components/landing/diagnostics-example";
import { FormatMatrix } from "@/components/landing/format-matrix";
import { Hero } from "@/components/landing/hero";
import { Measured } from "@/components/landing/measured";
import { NodeTypes } from "@/components/landing/node-types";
import { Pipeline } from "@/components/landing/pipeline";
import { Privacy } from "@/components/landing/privacy";
import { RenderedPage } from "@/components/landing/rendered-page";
import { Surfaces } from "@/components/landing/surfaces";
import { getBaselines, getExamples, getNodeTypes, getParity } from "@/lib/data";

/**
 * Nine sections, eight layout families, two eyebrows, one marquee.
 *
 * Every number and every quoted diagnostic on this page comes from `getExamples`,
 * `getBaselines` or `getParity`, all of which are generated at build time by the real engine
 * and the committed baselines. There is no hand-written measurement anywhere below, which is
 * the least a page making this particular argument can do.
 */
export default function Home() {
  const examples = getExamples();
  const asHtml = examples["mergedCellsAsHtml"];
  const flattened = examples["mergedCellsFlattened"];

  return (
    <>
      <Hero />
      <FormatMatrix />
      <RenderedPage />
      {asHtml && flattened ? (
        <DiagnosticsExample asHtml={asHtml} flattened={flattened} />
      ) : null}
      <Pipeline />
      <Surfaces parity={getParity()} />
      <Measured baselines={getBaselines()} />
      <NodeTypes types={getNodeTypes()} />
      <Privacy />
      <Closing />
    </>
  );
}
