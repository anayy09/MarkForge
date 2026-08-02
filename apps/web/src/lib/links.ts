/** Every outbound link on the site, in one place, so none of them rots alone. */
export const REPO_URL = "https://github.com/anayy09/MarkForge";

const doc = (path: string) => `${REPO_URL}/blob/main/${path}`;

export const DOCS = {
  spec: doc("docs/SPEC.md"),
  fidelity: doc("docs/FIDELITY.md"),
  limits: doc("docs/LIMITS.md"),
  gates: doc("docs/GATES.md"),
  corpus: doc("docs/CORPUS.md"),
  status: doc("docs/STATUS.md"),
  scoreboard: doc("docs/SCOREBOARD.md"),
  openQuestions: doc("docs/OPEN_QUESTIONS.md"),
  adrs: `${REPO_URL}/tree/main/docs/adr`,
  irSchema: doc("packages/ir/schema/ir.v0.schema.json"),
  configSchema: doc("schema/markforge.config.v0.schema.json"),
  licence: doc("LICENSE"),
} as const;

export const ADR = {
  pdfEngine: doc("docs/adr/0003-pdf-engine-typst.md"),
  docxRenderer: doc("docs/adr/0004-docx-renderer.md"),
  llm: doc("docs/adr/0009-llm-openai-compatible-only.md"),
  baselines: doc("docs/adr/0010-fidelity-baselines.md"),
  browser: doc("docs/adr/0015-browser-build-boundaries.md"),
  flavors: doc("docs/adr/0021-markdown-flavor-presets.md"),
} as const;
