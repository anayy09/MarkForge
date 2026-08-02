import type { Metadata } from "next";
import { Workbench } from "@/components/forge/workbench";
import { getFlavors, getSamples } from "@/lib/data";

export const metadata: Metadata = {
  title: "Forge",
  description:
    "Convert documents in your browser, with every diagnostic, the intermediate representation, and the fidelity metrics on screen.",
};

/**
 * Read at build time and handed down as props, so the workbench has its vocabulary before it
 * renders. Fetching the flavour list at runtime would put a loading state in front of data
 * that has been known since the build.
 */
export default function ForgePage() {
  return <Workbench flavors={getFlavors()} samples={getSamples()} />;
}
