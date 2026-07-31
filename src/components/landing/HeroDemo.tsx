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
  74, 30, 64, 48, 82, 26, 58, 86, 20, 48, 70, 36, 92, 58, 66, 28, 54, 80, 34, 72, 44, 88, 30, 60,
  50, 76, 26, 64, 40, 84, 32, 68,
];

const THUMBS = [
  { label: "Convoy at dawn", position: "0%" },
  { label: "Mountain ridge", position: "33.333%" },
  { label: "Sunlit valley", position: "66.667%" },
  { label: "Final assembly", position: "100%" },
] as const;

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
                  step >= 1 && i % 16 === 15 ? "mr-2" : "",
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
          {THUMBS.map((thumb, index) => (
            <div
              key={thumb.label}
              className={cn(
                "relative aspect-video overflow-hidden rounded-lg border transition-all duration-500",
                step >= 2 && index === 1
                  ? "border-primary/70 shadow-[0_0_0_1px_rgb(245_166_35/0.15)]"
                  : "border-border",
              )}
            >
              <div
                className="absolute inset-0 bg-no-repeat transition-transform duration-700 hover:scale-105"
                style={{
                  backgroundImage: "url('/images/hero-storyboard.webp')",
                  backgroundPosition: `${thumb.position} center`,
                  backgroundSize: "400% 100%",
                }}
              />
              <div className="absolute inset-0 bg-linear-to-t from-black/75 via-black/5 to-black/10" />
              <span className="absolute inset-x-2 bottom-1.5 truncate text-[10px] font-medium text-white/90 sm:text-xs">
                {thumb.label}
              </span>
              {step >= 2 && index === 1 ? (
                <span className="absolute right-1.5 top-1.5 grid h-5 w-5 place-items-center rounded-full bg-primary text-primary-foreground shadow-sm">
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
