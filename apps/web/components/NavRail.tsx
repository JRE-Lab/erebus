"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const ITEMS: { href: string; label: string; glyph: string; hint: string }[] = [
  { href: "/", label: "Explorer", glyph: "◈", hint: "the forecast tree" },
  { href: "/studio", label: "Studio", glyph: "▶", hint: "content from the green" },
];

export function NavRail() {
  const pathname = usePathname();
  return (
    <nav className="flex w-[68px] shrink-0 flex-col items-center gap-1 border-r border-nx-border py-4">
      <div
        className="mb-4 grid h-9 w-9 place-items-center rounded-xl text-base font-black"
        style={{
          background: "linear-gradient(140deg,#6366f1,#22c55e)",
          color: "#0a0a0f",
        }}
        title="EREBUS"
      >
        E
      </div>
      {ITEMS.map((item) => {
        const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            title={`${item.label} — ${item.hint}`}
            className="group flex w-14 flex-col items-center gap-1 rounded-xl py-2.5 transition"
            style={{
              background: active ? "rgba(99,102,241,0.14)" : "transparent",
              border: active ? "1px solid rgba(99,102,241,0.4)" : "1px solid transparent",
            }}
          >
            <span
              className="text-lg leading-none transition"
              style={{ color: active ? "var(--nx-indigo)" : "var(--nx-text-muted)" }}
            >
              {item.glyph}
            </span>
            <span
              className="text-[10px] font-semibold tracking-wide"
              style={{ color: active ? "var(--nx-text-primary)" : "var(--nx-text-muted)" }}
            >
              {item.label}
            </span>
          </Link>
        );
      })}
    </nav>
  );
}
