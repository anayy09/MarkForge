import Link from "next/link";
import { ThemeToggle } from "@/components/site/theme";
import { REPO_URL } from "@/lib/links";

/**
 * One line at every width above `sm`, 56px tall. Four items and a toggle fit without
 * condensing, so there is no hamburger and no second row.
 */
export function SiteNav() {
  return (
    <header className="sticky top-0 z-30 rule-b bg-paper/85 backdrop-blur-md">
      <nav className="mx-auto flex h-14 max-w-[1400px] items-center gap-6 px-5 lg:px-8">
        <Link href="/" className="flex items-baseline">
          <span className="display text-[19px] leading-none text-ink">MarkForge</span>
        </Link>

        <div className="ml-auto flex items-center gap-1">
          <NavLink href="/compile">Compile</NavLink>
          <NavLink href="/forge">Convert</NavLink>
          <NavLink href={REPO_URL} external>
            Source
          </NavLink>
          <div className="ml-1 h-5 w-px bg-rule" />
          <ThemeToggle />
        </div>
      </nav>
    </header>
  );
}

function NavLink({
  href,
  children,
  external = false,
}: {
  href: string;
  children: React.ReactNode;
  external?: boolean;
}) {
  const className =
    "rounded-chip px-2.5 py-1.5 text-[13px] text-ink-muted transition-colors hover:bg-sunken hover:text-ink";
  if (external) {
    return (
      <a href={href} target="_blank" rel="noreferrer noopener" className={className}>
        {children}
      </a>
    );
  }
  return (
    <Link href={href} className={className}>
      {children}
    </Link>
  );
}
