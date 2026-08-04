import { DOCS, REPO_URL } from "@/lib/links";

/**
 * One line.
 *
 * This was three columns of nine links, which is a site map for a site with three pages. A
 * footer that size is a navigation surface, and a navigation surface at the bottom of a page
 * is where links go to be scrolled past. What survives is the licence, the source, and the
 * two documents someone might actually want after reading the page: the spec and the
 * measured limits.
 */
const LINKS = [
  { label: "Source", href: REPO_URL },
  { label: "Specification", href: DOCS.spec },
  { label: "Limits", href: DOCS.limits },
];

export function SiteFooter() {
  return (
    <footer className="rule-t mt-20">
      <div className="mx-auto flex max-w-[1400px] flex-col gap-3 px-5 py-8 sm:flex-row sm:items-center lg:px-8">
        <p className="text-[12px] text-ink-faint">Apache-2.0. Fixtures carry their own terms.</p>
        <nav className="flex items-center gap-5 sm:ml-auto">
          {LINKS.map((link) => (
            <a
              key={link.label}
              href={link.href}
              target="_blank"
              rel="noreferrer noopener"
              className="text-[12px] text-ink-muted transition-colors hover:text-accent"
            >
              {link.label}
            </a>
          ))}
        </nav>
      </div>
    </footer>
  );
}
