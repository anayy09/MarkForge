import Link from "next/link";
import { DOCS, REPO_URL } from "@/lib/links";

const COLUMNS: { heading: string; links: { label: string; href: string }[] }[] = [
  {
    heading: "Use it",
    links: [
      { label: "Forge", href: "/forge" },
      { label: "Fidelity", href: "/fidelity" },
      { label: "Source", href: REPO_URL },
    ],
  },
  {
    heading: "Read it",
    links: [
      { label: "Specification", href: DOCS.spec },
      { label: "Decision records", href: DOCS.adrs },
      { label: "Golden corpus", href: DOCS.corpus },
    ],
  },
  {
    heading: "Check it",
    links: [
      { label: "Measured fidelity", href: DOCS.fidelity },
      { label: "Known limits", href: DOCS.limits },
      { label: "Gates", href: DOCS.gates },
    ],
  },
];

export function SiteFooter() {
  return (
    <footer className="rule-t mt-24">
      <div className="mx-auto max-w-[1400px] px-5 py-14 lg:px-8">
        <div className="grid gap-10 md:grid-cols-[2fr_1fr_1fr_1fr]">
          <div className="max-w-xs">
            <div className="text-[15px] font-semibold tracking-tight text-ink">MarkForge</div>
            <p className="mt-2 text-[13px] leading-relaxed text-ink-muted">
              Six formats read, four written, on surfaces that agree byte for byte.
            </p>
          </div>

          {COLUMNS.map((col) => (
            <div key={col.heading}>
              <h2 className="font-mono text-[11px] uppercase tracking-[0.14em] text-ink-faint">
                {col.heading}
              </h2>
              <ul className="mt-3 space-y-2">
                {col.links.map((l) => (
                  <li key={l.label}>
                    <FooterLink href={l.href}>{l.label}</FooterLink>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="rule-t mt-12 flex flex-col gap-2 pt-6 text-[12px] text-ink-faint sm:flex-row sm:items-center sm:justify-between">
          <p>
            Apache-2.0. Chosen over MIT for the patent grant, which matters for a tool
            implementing OOXML and PDF.
          </p>
          <p>
            Fixtures carry their own terms and are not covered by that licence.
          </p>
        </div>
      </div>
    </footer>
  );
}

function FooterLink({ href, children }: { href: string; children: React.ReactNode }) {
  const className = "text-[13px] text-ink-muted transition-colors hover:text-ember";
  return href.startsWith("/") ? (
    <Link href={href} className={className}>
      {children}
    </Link>
  ) : (
    <a href={href} target="_blank" rel="noreferrer noopener" className={className}>
      {children}
    </a>
  );
}
