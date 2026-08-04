import type { Metadata } from "next";
import { CompileWorkbench } from "@/components/compile/workbench";
import { getAgentifySample, getTargets } from "@/lib/data";

export const metadata: Metadata = {
  title: "Compile",
  description:
    "Compile AGENTS.md, CLAUDE.md and skill files from a folder of mixed documents, with every generated sentence traced back to the document it came from. Runs entirely in your browser.",
};

/**
 * SPEC §10, on a page.
 *
 * The target profiles and the sample corpus are read at build time and handed down as props,
 * so the browser fetches neither. The profiles in particular have to arrive this way: they
 * are resolved and schema-validated in Node by `prepare-assets.mjs`, and the browser's
 * `registryFromProfiles` refuses anything that still carries an unresolved `extends`.
 */
export default function CompilePage() {
  return <CompileWorkbench targets={getTargets()} sample={getAgentifySample()} />;
}
