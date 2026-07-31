import { useEffect, useState } from "react";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";

// A looping, non-interactive micro-demo of the real pipeline stages:
// waveform -> scene breakdown -> matched clip -> render progress.
// 8-second loop, four 2-second states.
const SCENE_TEXT = "The convoy moved before first light.";

const STATES = [
  { label: "Transcribing", caption: SCENE_TEXT },
  { label: "Building scenes", caption: `Scene 1 · 0:00–0:08 · ${SCENE_TEXT}` },
  { label: "Matching footage", caption: "Matched: Desert convoy footage · 92% relevance" },
  { label: "Rendering", caption: "Rendering… 67%" },
] as const;

const BARS = [
  18, 42, 66, 30, 88, 54, 72, 24, 60, 92, 38, 70, 46, 84, 28, 62, 50, 78, 34, 68, 22, 56, 90, 40,
  74, 30, 64, 48, 82, 26, 58, 86,
];

const THUMBS = [0, 1, 2, 3];

export function HeroDemo() {
  const [step, setStep] = useState(0);

  useEffect(() => {
    const reduce =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduce) return;
    const id = setInterval(() => setStep((s) => (s + 1) % 4), 2000);
    return () => clearInterval(id);
  }, []);

  const state = STATES[step];
  const progress = step === 3 ? 67 : 24 * (step + 1);

  return (
    <div className="overflow-hidden rounded-2xl border border-border bg-surface shadow-elevated">
      <div className="flex items-center justify-between gap-3 border-b border-border px-5 py-3.5">
        <div className="flex min-w-0 items-center gap-2">
          <span className="h-2 w-2 shrink-0 rounded-full bg-primary" />
          <span className="truncate text-sm font-medium">narration-final.mp3</span>
        </div>
        <span className="shrink-0 rounded-full border border-primary/20 bg-primary-subtle px-3 py-1 text-xs font-medium text-primary">
          {state.label}
        </span>
      </div>

      <div className="p-5 sm:p-6">
        {/* Waveform */}
        <div className="flex h-20 items-center gap-[3px]" aria-hidden="true">
          {BARS.map((h, i) => {
            const segment = Math.floor((i / BARS.length) * 4);
            const active = step >= 1 ? segment <= step : i / BARS.length < 0.6;
            return (
              <span
                key={i}
                className={cn(
                  "flex-1 rounded-full transition-all duration-700",
                  active ? "bg-primary/80" : "bg-foreground/10",
                  step >= 1 && segment === step ? "bg-primary" : "",
                  // scene segmentation gaps
                  step >= 1 && i % 8 === 7 ? "mr-2" : "",
                )}
                style={{ height: `${step === 0 ? h : Math.max(18, h * 0.8)}%` }}
              />
            );
          })}
        </div>

        {/* Caption */}
        <p className="mt-5 min-h-10 text-sm leading-relaxed text-muted-foreground">
          {state.caption}
        </p>

        {/* Thumbnail grid */}
        <div
          className={cn(
            "mt-4 grid grid-cols-4 gap-2 transition-opacity duration-500",
            step >= 1 ? "opacity-100" : "opacity-0",
          )}
          aria-hidden="true"
        >
          {THUMBS.map((t) => (
            <div
              key={t}
              className={cn(
                "relative aspect-video overflow-hidden rounded-lg border transition-all duration-500",
                step >= 2 && t === 1
                  ? "border-primary/60 bg-linear-to-br from-primary/35 to-primary/5"
                  : "border-border bg-linear-to-br from-foreground/10 to-foreground/5",
              )}
            >
              {step >= 2 && t === 1 ? (
                <span className="absolute right-1 top-1 grid h-4 w-4 place-items-center rounded-full bg-primary text-primary-foreground">
                  <Check className="h-3 w-3" />
                </span>
              ) : null}
            </div>
          ))}
        </div>

        {/* Render progress */}
        <div className="mt-6">
          <div className="mb-2 flex items-center justify-between text-xs text-muted-foreground">
            <span>Render</span>
            <span>{progress}%</span>
          </div>
          <div className="h-2 w-full overflow-hidden rounded-full bg-field">
            <div
              className="h-full rounded-full bg-linear-to-r from-primary to-primary-hover transition-all duration-700"
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
