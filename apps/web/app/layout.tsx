import type { Metadata } from "next";
import "./globals.css";
import { NavRail } from "@/components/NavRail";
import { HealthBar } from "@/components/HealthBar";

export const metadata: Metadata = {
  title: "EREBUS — Forecast Tree",
  description:
    "A forward-branching forecast tree that greens as reality confirms it. Gaze into the void.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="flex h-screen w-screen overflow-hidden">
          <NavRail />
          <div className="flex min-w-0 flex-1 flex-col">
            <header className="flex h-14 shrink-0 items-center justify-between border-b border-nx-border px-5">
              <div className="flex items-baseline gap-3">
                <span
                  className="text-lg font-black tracking-[0.18em]"
                  style={{
                    background: "linear-gradient(90deg,#e8e8f0 0%, #6366f1 60%, #22c55e 120%)",
                    WebkitBackgroundClip: "text",
                    backgroundClip: "text",
                    color: "transparent",
                  }}
                >
                  EREBUS
                </span>
                <span className="hidden text-xs text-nx-text-muted sm:inline">
                  the tree greens as reality confirms it
                </span>
              </div>
              <HealthBar />
            </header>
            <main className="min-h-0 flex-1 overflow-hidden">{children}</main>
          </div>
        </div>
      </body>
    </html>
  );
}
