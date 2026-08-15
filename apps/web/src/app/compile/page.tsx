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
 *
 * ## Why the stubs are dropped here rather than in the workbench
 *
 * They are sent to the browser otherwise. Resolution copies the base profile into every
 * `extends` — sections, budget, traceability and all — so each of the seven stubs is a full
 * profile in the page payload, and the workbench discarded them on its first render. They
 * exist so the registry can demonstrate that adding a vendor is adding a file (ADR-0013),
 * which is a claim about the architecture rather than an invitation to compile against a
 * profile whose vendor conventions nobody has checked.
 *
 * The predicate is `!== "stub"` rather than `=== "firstClass"`, and quietly matters: `tier`
 * has three values, and `claude-commands` and `mcp-manifest` are `authored`. Both are real,
 * verified targets. What is left is the five `docs/AGENTIFY.md` measures.
 */
export default function CompilePage() {
  const targets = getTargets().filter((t) => t.tier !== "stub");
  return <CompileWorkbench targets={targets} sample={getAgentifySample()} />;
}
