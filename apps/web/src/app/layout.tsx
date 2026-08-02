import type { Metadata, Viewport } from "next";
import { GeistMono } from "geist/font/mono";
import { GeistSans } from "geist/font/sans";
import { SiteNav } from "@/components/site/nav";
import { SiteFooter } from "@/components/site/footer";
import { themeScript } from "@/components/site/theme";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL("https://markforge.app"),
  title: {
    default: "MarkForge",
    template: "%s / MarkForge",
  },
  description:
    "Convert Markdown, DOCX, HTML and PDF without losing what will not survive. Every construct that cannot be represented emits a diagnostic. Runs in your browser.",
  applicationName: "MarkForge",
  authors: [{ name: "MarkForge" }],
  openGraph: {
    title: "MarkForge",
    description:
      "Document conversion that reports what it loses. Six formats read, four written, measured against a committed corpus.",
    type: "website",
  },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#fafaf9" },
    { media: "(prefers-color-scheme: dark)", color: "#1c1917" },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      // Set by the inline script below before paint; React must not fight it on hydration.
      suppressHydrationWarning
      className={`${GeistSans.variable} ${GeistMono.variable}`}
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="min-h-[100dvh] antialiased">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-panel focus:bg-ember focus:px-3 focus:py-2 focus:text-sm focus:text-ember-ink"
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
