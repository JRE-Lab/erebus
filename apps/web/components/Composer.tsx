"use client";

import { useState } from "react";
import { createForecast } from "@/lib/api";

interface Props {
  onCreated?: () => void;
}

// "New forecast" composer — gaze into the void, seed a root forecast. The engine
// recurses forward and the Corroboration Engine greens what reality confirms.
export function Composer({ onCreated }: Props) {
  const [context, setContext] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const submit = async () => {
    const ctx = context.trim();
    if (!ctx || busy) return;
    setBusy(true);
    setNote(null);
    try {
      const r = (await createForecast(ctx)) as { offline?: boolean } | undefined;
      setContext("");
      setNote(r?.offline ? "forecast seeded (offline fallback)." : "forecast seeded.");
      onCreated?.();
    } catch {
      setNote("could not seed forecast.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="nx-card p-3">
      <div className="flex items-start gap-2">
        <textarea
          className="nx-input min-h-[42px] flex-1 resize-none"
          rows={1}
          placeholder="Gaze into the void — seed a forecast (e.g. 'US escalates with Iran in the next 6 months')"
          value={context}
          onChange={(e) => setContext(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit();
          }}
        />
        <button
          className="nx-btn nx-btn-primary h-[42px] shrink-0"
          disabled={busy || !context.trim()}
          onClick={submit}
        >
          {busy ? "Seeding…" : "New forecast"}
        </button>
      </div>
      {note && <div className="mt-1.5 text-[11px] text-nx-text-secondary">{note}</div>}
    </div>
  );
}

export default Composer;
