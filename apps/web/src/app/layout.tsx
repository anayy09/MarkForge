import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import { GeistMono } from "geist/font/mono";
import { GeistSans } from "geist/font/sans";
import { SiteNav } from "@/components/site/nav";
import { SiteFooter } from "@/components/site/footer";
import { themeScript } from "@/components/site/theme";
import "./globals.css";

/**
 * The display face, taken from the repo's own font set.
 *
 * `fonts/` at the repo root is the licensed set `@markforge/render-pdf` typesets PDFs with,
 * and `prepare-assets.mjs` copies the same four files into `public/markforge/fonts/` for the
 * in-browser Typst compiler. Pointing at the source directory rather than at that copy is
 * deliberate: the copy is gitignored build output, and a font the layout depends on should
 * not vanish when someone clears it.
 *
 * Two cuts, not four. Bold is left out because display type at this scale takes its weight
 * from size; loading it would be 294 KB for a weight the design never sets. `swap` and the
 * declared fallback let the first paint use the system serif and reflow once, which is the
 * right trade for a face that only sets headlines.
 */
const libertinus = localFont({
  src: [
    { path: "../../../../fonts/LibertinusSerif-Regular.otf", weight: "400", style: "normal" },
    { path: "../../../../fonts/LibertinusSerif-Italic.otf", weight: "400", style: "italic" },
  ],
  variable: "--font-libertinus",
  display: "swap",
  fallback: ["ui-serif", "Georgia", "serif"],
});

export const metadata: Metadata = {
  metadataBase: new URL("https://markforge.app"),
  title: {
    default: "MarkForge",
    template: "%s / MarkForge",
  },
  description:
    "Compile AGENTS.md, CLAUDE.md and skill files from the documents you already have, with every sentence traced to its source. Converts Markdown, DOCX, HTML and PDF and reports what will not survive. Runs in your browser.",
  applicationName: "MarkForge",
  authors: [{ name: "MarkForge" }],
  openGraph: {
    title: "MarkForge",
    description:
      "Compile agent context from a folder of mixed documents, with every sentence traced to its source.",
    type: "website",
  },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#faf9f7" },
    { media: "(prefers-color-scheme: dark)", color: "#16151a" },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      // Set by the inline script below before paint; React must not fight it on hydration.
      suppressHydrationWarning
      className={`${GeistSans.variable} ${GeistMono.variable} ${libertinus.variable}`}
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="min-h-[100dvh] antialiased">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-panel focus:bg-accent focus:px-3 focus:py-2 focus:text-sm focus:text-accent-ink"
        >
          Skip to content
        </a>
        <SiteNav />
        <main id="main">{children}</main>
        <SiteFooter />
      </body>
    </html>
  );
}
