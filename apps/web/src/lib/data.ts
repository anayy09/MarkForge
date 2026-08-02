import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { FlavorData } from "@/lib/formats";

/**
 * Build-time reads of what `scripts/prepare-assets.mjs` generated.
 *
 * Server-only. Pages call these and hand the result to client components as props, so the
 * browser never fetches them and there is no loading state for data that is already known.
 * Reading rather than importing keeps the generated files out of the typecheck: `tsc --noEmit`
 * has to pass on a fresh clone, where `public/markforge/` does not exist yet.
 */

const read = <T>(file: string): T =>
  JSON.parse(readFileSync(join(process.cwd(), "public/markforge", file), "utf8")) as T;

export interface SampleInfo {
  file: string;
  from: "md" | "docx" | "html";
  label: string;
  note: string;
}

export interface DiagnosticSummary {
  code: string;
  severity: "info" | "warning" | "error";
  message: string;
  lossy: boolean;
  construct?: string;
  retained?: { as: string; ref: string };
}

export interface WorkedExample {
  input: string;
  from: string;
  to: string;
  source: string | null;
  output: string;
  diagnostics: DiagnosticSummary[];
}

export interface BaselineEntry {
  fixture: string;
  loop: string;
  structural: number;
  textSensitive: number;
  textInsensitive: number;
  tableF1: number;
  tableContentF1: number;
  spanF1: number;
  census?: { nodeType: string; expected: number; actual: number }[];
}

export interface Baselines {
  version: number;
  tolerance: number;
  entries: BaselineEntry[];
}

export interface ParityDigest {
  input: string;
  to: string;
  bytes: number;
  sha256: string;
}

export const getParity = (): ParityDigest => read<ParityDigest>("parity.json");
export const getBaselines = (): Baselines => read<Baselines>("baselines.json");
export const getFlavors = (): FlavorData => read<FlavorData>("flavors.json");
export const getSamples = (): SampleInfo[] => read<SampleInfo[]>("samples/manifest.json");
export const getNodeTypes = (): string[] => read<string[]>("node-types.json");
export const getExamples = (): Record<string, WorkedExample> =>
  read<Record<string, WorkedExample>>("examples.json");
