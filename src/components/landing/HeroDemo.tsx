import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

// A looping, non-interactive micro-demo of the real pipeline stages:
// waveform -> scene breakdown -> matched clip -> render progress.
const SCENES = [
  { text: "The convoy moved before first light.", query: "military convoy dawn road" },
  { text: "Nobody on the ridge saw them coming.", query: "mountain ridge fog wide shot" },
  { text: "By noon, the valley was quiet again.", query: "empty valley midday sunlight" },
];

const STAGES = ["Transcribing", "Building scenes", "Matching footage", "Rendering"] as const;

const BARS = [
  18, 42, 66, 30, 88, 54, 72, 24, 60, 92, 38, 70, 46, 84, 28, 62, 50, 78, 34, 68, 22, 56, 90, 40,
  74, 30, 64, 48, 82, 26,
];

export function HeroDemo() {
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1400);
    return () => clearInterval(id);
  }, []);

  const stageIndex = tick % STAGES.length;
  const stage = STAGES[stageIndex];
  const revealed = stageIndex === 0 ? 1 : stageIndex + 1;
  const progress = stageIndex === 3 ? 92 : 24 * (stageIndex + 1);

  return (
    <div className="rounded-3xl border border-border bg-surface p-4 shadow-[0_8px_32px_rgb(0_0_0/0.4)] sm:p-6">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="h-2 w-2 rounded-full bg-primary" />
          <span className="text-sm font-medium">narration-final.mp3</span>
        </div>
        <span className="rounded-lg bg-elevated px-2.5 py-1 text-xs font-medium text-muted-foreground">
          {stage}…
        </span>
      </div>

      {/* Waveform */}
      <div className="mt-5 flex h-16 items-end gap-[3px]" aria-hidden="true">
        {BARS.map((h, i) => (
          <span
            key={i}
            className={cn(
              "flex-1 rounded-full transition-all duration-700",
              i / BARS.length < (stageIndex + 1) / 4 ? "bg-primary/80" : "bg-foreground/12",
            )}
            style={{ height: `${h}%` }}
          />
        ))}
      </div>

      {/* Scene breakdown */}
      <div className="mt-6 space-y-2">
        {SCENES.map((scene, i) => (
          <div
            key={scene.text}
            className={cn(
              "flex items-center gap-3 rounded-2xl border border-border bg-elevated/70 p-3 transition-all duration-700",
              i < revealed ? "opacity-100 translate-y-0" : "opacity-0 translate-y-2",
            )}
          >
            <div className="h-10 w-16 shrink-0 overflow-hidden rounded-lg bg-linear-to-br from-primary/30 to-foreground/10" />
            <div className="min-w-0">
              <p className="truncate text-sm">{scene.text}</p>
              <p className="truncate text-xs text-muted-foreground">
                {stageIndex >= 2 ? `matched · ${scene.query}` : "searching footage…"}
              </p>
            </div>
          </div>
        ))}
      </div>

      {/* Render progress */}
      <div className="mt-6">
        <div className="mb-2 flex items-center justify-between text-xs text-muted-foreground">
          <span>Render</span>
          <span>{progress}%</span>
        </div>
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-foreground/10">
          <div
            className="h-full rounded-full bg-primary transition-all duration-700"
            style={{ width: `${progress}%` }}
          />
        </div>
      </div>
    </div>
  );
}
