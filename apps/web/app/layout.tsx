import "./globals.css";
import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "EREBUS — Recursive Intelligence",
  description: "Generate, adversarially challenge, and continuously refine theories about world events.",
};

const NAV = [
  { href: "/", label: "Dashboard", icon: "◉" },
  { href: "/sources", label: "Sources", icon: "⦿" },
  { href: "/settings", label: "Settings", icon: "⚙" },
];

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="flex h-screen overflow-hidden" style={{ background: "var(--nx-bg-primary)" }}>
        <aside
          className="flex flex-col shrink-0 border-r"
          style={{ width: 200, background: "var(--nx-bg-secondary)", borderColor: "var(--nx-border)" }}
        >
          <Link href="/" className="flex items-center gap-2 h-12 px-4 border-b" style={{ borderColor: "var(--nx-border)" }}>
            <span
              className="w-7 h-7 rounded flex items-center justify-center text-xs font-bold"
              style={{ background: "var(--nx-accent-indigo)", color: "#fff" }}
            >
              E
            </span>
            <span className="font-bold tracking-widest text-sm" style={{ color: "var(--nx-text-primary)" }}>
              EREBUS
            </span>
          </Link>
          <nav className="flex-1 py-2">
            {NAV.map((n) => (
              <Link
                key={n.href}
                href={n.href}
                className="flex items-center gap-3 px-4 py-2 text-xs transition-colors"
                style={{ color: "var(--nx-text-secondary)" }}
              >
                <span className="w-4 text-center">{n.icon}</span>
                {n.label}
              </Link>
            ))}
          </nav>
          <div className="px-4 py-3 border-t text-[10px]" style={{ borderColor: "var(--nx-border)", color: "var(--nx-text-muted)" }}>
            EREBUS v2.0
          </div>
        </aside>
        <main className="flex-1 overflow-y-auto">{children}</main>
      </body>
    </html>
  );
}
