import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { HeroDemo } from "@/components/landing/HeroDemo";
import { cn } from "@/lib/utils";
import { useEffect, useState } from "react";
import { AudioLines, ArrowRight, Menu, X } from "lucide-react";
import { LANDING_PRODUCT_NAME } from "@/lib/branding";

// Search-result and social-preview text (Round C): states BOTH inputs, and
// promises no wait time anywhere — the in-app queue shows the live estimate.
// "narrated for you on our servers" is the verified 2026-08-26 production
// claim (tts-worker, server-side); nothing here says browser, download, or
// WebGPU, because none of that is true any more.
const META_TITLE = `${LANDING_PRODUCT_NAME} — Voiceover or script in, video out`;
const META_DESCRIPTION =
  `${LANDING_PRODUCT_NAME} turns a voiceover — or a script narrated for you on our servers — ` +
  "into a publish-ready video: transcribed, split into scenes, matched to stock footage, and rendered. " +
  "No editing timeline required.";
const META_SOCIAL_DESCRIPTION =
  "Upload audio or paste a script — narration is generated on our servers when you start from text. " +
  "Scene matching, stock footage, custom pacing, and auto-render.";

export const Route = createFileRoute("/")({
  ssr: false,
  head: () => ({
    meta: [
      { title: META_TITLE },
      { name: "description", content: META_DESCRIPTION },
      { property: "og:title", content: META_TITLE },
      { property: "og:description", content: META_SOCIAL_DESCRIPTION },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "twitter:title", content: META_TITLE },
      { name: "twitter:description", content: META_SOCIAL_DESCRIPTION },
    ],
  }),
  beforeLoad: async () => {
    const { data } = await supabase.auth.getUser();
    if (data.user) throw redirect({ to: "/dashboard" });
  },
  component: Landing,
});

// "Script narration" added (Round C): the one narration term, keeping the
// list at six rather than becoming a list of nine.
const TAGS = [
  "Script narration",
  "Transcription",
  "Scene matching",
  "Stock footage",
  "Custom pacing",
  "Auto-render",
];

const STEPS = [
  {
    // Step 1 covers both inputs (Round C); steps 2-5 are downstream of
    // narration and identical for both modes — confirmed unchanged.
    title: "Start with audio — or a script",
    body: "Drop in a voiceover, or paste your script and we narrate it on our servers. Either one is the entire brief.",
  },
  {
    title: "We break it into scenes",
    body: "Every sentence becomes a scene, timed to exactly what's spoken.",
  },
  {
    title: "We find the footage",
    body: "Each scene is matched to real stock footage that fits what's actually being said, not just a generic keyword.",
  },
  {
    title: "Review before you render",
    body: "Swap any clip, adjust pacing, nothing renders until you approve it.",
  },
  {
    title: "Render and download",
    body: "A finished, publish-ready video, yours to keep and use however you want.",
  },
];

const FAQ = [
  {
    q: "What do I need to provide?",
    // Both inputs, equal billing (Round C). "Generated for you" is the
    // verified server path — no browser, no download, nothing on the user's
    // machine (largest browser payload in the whole measured run: 57 KB).
    a: "An audio file — a voiceover or recorded narration — or just a script. Paste the text and the narration is generated for you. Nothing else required.",
  },
  {
    // New in Round C. Every claim traced to the 2026-08-26 production run:
    // server-side (tts-worker, RTF 0.760 under concurrent render load); no
    // WebGPU/GPU/download, identical on any machine; the job survives a
    // closed tab and the project resumes on the next visit; the queue shows
    // a live estimate. Deliberately NO end-to-end wait time stated — the
    // in-app estimate owns that number.
    q: "How does script narration work?",
    a: "Your script is read by a natural-sounding voice on our servers — nothing runs on your computer and there's nothing to download, so it works the same on any machine. You don't need to keep the tab open: the job keeps going, and your project picks up where it left off next time you look. A live time estimate shows while it runs.",
  },
  {
    q: "Where does the footage come from?",
    a: "Licensed stock video, matched automatically to what's being said in each scene.",
  },
  {
    q: "Can I change anything before it's final?",
    a: "Yes. Review every scene and its matched clip before rendering. Nothing goes final without your approval.",
  },
  {
    q: "Who owns the finished video?",
    a: "You do, completely. Download it and use it anywhere.",
  },
  {
    q: "How long can my video be?",
    // KEEP THIS WORDING — it was wrong once already (dc4227e fixed "a few
    // minutes" → 45). The numbers are CONFIRMED by production measurement,
    // 2026-08-26: 303 sentences → 763.775 s of narration = 2.4 words/sec,
    // so 45 min ≈ 6,480 words ≈ the "roughly 6,500-word script" stated here.
    a: "Narration up to 45 minutes renders reliably — roughly a 6,500-word script. Longer pieces should be split into parts, one project each.",
  },
];

const NAV_LINKS = [
  { href: "#process", label: "How it works" },
  { href: "#output", label: "Output" },
  { href: "#faq", label: "FAQ" },
];

const OUTPUT_FACTS = [
  { label: "Cut on", value: "Sentence boundaries" },
  { label: "Pacing", value: "3–6s fixed clips" },
  { label: "Formats", value: "9:16 · 16:9 · 1:1" },
  { label: "Output", value: "1080p MP4" },
];

function useScrolled() {
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 16);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
  return scrolled;
}

function Landing() {
  const scrolled = useScrolled();
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <div className="dark min-h-screen bg-background text-foreground">
      <header
        className={cn(
          "fixed inset-x-0 top-0 z-40 transition-all duration-300",
          scrolled ? "border-b border-border bg-background/80 backdrop-blur-xl" : "bg-transparent",
        )}
      >
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-6 py-4">
          <div className="flex min-w-0 items-center gap-2">
            <AudioLines className="h-5 w-5 shrink-0 text-primary" />
            <span className="truncate text-lg font-semibold tracking-tight">
              {LANDING_PRODUCT_NAME}
            </span>
          </div>

          <nav className="hidden items-center gap-8 md:flex" aria-label="Primary">
            {NAV_LINKS.map((l) => (
              <a
                key={l.href}
                href={l.href}
                className="text-sm text-muted-foreground transition-colors duration-200 hover:text-primary"
              >
                {l.label}
              </a>
            ))}
          </nav>

          <div className="hidden items-center gap-2 md:flex">
            <Button variant="ghost" size="sm" asChild>
              <Link to="/auth">Sign in</Link>
            </Button>
            <Button size="sm" asChild>
              <Link to="/auth">Start creating</Link>
            </Button>
          </div>

          <button
            type="button"
            aria-label={menuOpen ? "Close menu" : "Open menu"}
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((o) => !o)}
            className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-border text-foreground transition-colors hover:bg-elevated md:hidden"
          >
            {menuOpen ? <X className="h-4 w-4" /> : <Menu className="h-4 w-4" />}
          </button>
        </div>

        {menuOpen ? (
          <div className="border-t border-border bg-background/95 px-6 py-4 backdrop-blur-xl md:hidden">
            <nav className="flex flex-col gap-3" aria-label="Mobile">
              {NAV_LINKS.map((l) => (
                <a
                  key={l.href}
                  href={l.href}
                  onClick={() => setMenuOpen(false)}
                  className="text-sm text-muted-foreground transition-colors hover:text-primary"
                >
                  {l.label}
                </a>
              ))}
            </nav>
            <div className="mt-4 flex flex-col gap-2">
              <Button variant="outline" asChild>
                <Link to="/auth">Sign in</Link>
              </Button>
              <Button asChild>
                <Link to="/auth">Start creating</Link>
              </Button>
            </div>
          </div>
        ) : null}
      </header>

      <main>
        {/* Hero */}
        <section className="grain relative overflow-hidden">
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_50%_0%,var(--primary-subtle),transparent_60%)]"
          />
          <div className="relative mx-auto flex min-h-screen max-w-6xl flex-col items-center justify-center px-6 pb-24 pt-32 text-center sm:pt-36">
            <p className="text-sm text-muted-foreground">{TAGS.join(" · ")}</p>

            {/* Round C: both inputs, same cadence, still concrete — the
                closer "Get a video." survives intact. */}
            <h1 className="text-display mt-6 max-w-3xl text-foreground">
              Upload a voiceover or paste a script. Get a{" "}
              <em className="italic text-primary">video</em>.
            </h1>

            <p className="mx-auto mt-6 max-w-2xl text-base leading-relaxed text-muted-foreground sm:text-lg">
              {LANDING_PRODUCT_NAME} starts from a single audio file — or narrates your script for
              you — then matches footage, scores pacing, and renders a publish-ready video. No
              editing timeline required.
            </p>

            <div className="mt-10 flex flex-wrap items-center justify-center gap-4">
              <Button size="lg" asChild>
                <Link to="/auth">
                  Start creating
                  <ArrowRight className="ml-2 h-4 w-4" />
                </Link>
              </Button>
              <Button size="lg" variant="outline" asChild>
                <a href="#process">See how it works</a>
              </Button>
            </div>

            <div className="mt-16 w-full max-w-4xl text-left">
              <HeroDemo />
            </div>
          </div>
        </section>

        {/* Process */}
        <section id="process" className="scroll-mt-24 border-t border-border">
          <div className="mx-auto max-w-6xl px-6 py-24 sm:py-32 lg:py-40">
            <h2 className="text-center text-3xl font-semibold tracking-tight sm:text-4xl">
              From voice to video, five steps
            </h2>

            <ol className="mt-16 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {STEPS.map((step, i) => (
                <li
                  key={step.title}
                  className="reveal rounded-2xl border border-border bg-surface p-8 shadow-card transition-all duration-300 hover:border-border-hover hover:shadow-elevated"
                  style={{ animationDelay: `${i * 0.1}s` }}
                >
                  <span className="text-5xl font-bold text-muted-foreground/30">
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  <h3 className="mt-4 text-xl font-semibold">{step.title}</h3>
                  <p className="mt-2 leading-relaxed text-muted-foreground">{step.body}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        {/* Output */}
        <section id="output" className="scroll-mt-24 border-t border-border">
          <div className="mx-auto max-w-6xl px-6 py-24 sm:py-32 lg:py-40">
            <h2 className="text-center text-3xl font-semibold tracking-tight sm:text-4xl">
              Made to be watched, not skipped past
            </h2>
            <p className="mx-auto mt-4 max-w-3xl text-center leading-relaxed text-muted-foreground">
              Scenes are cut to sentence boundaries, so the picture changes when the meaning does.
              Footage is chosen from what the narration actually says, and you can set a fixed clip
              length when you want a faster, tighter rhythm.
            </p>

            <dl className="mt-14 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {OUTPUT_FACTS.map((f) => (
                <div
                  key={f.label}
                  className="rounded-2xl border border-border bg-surface p-6 text-center shadow-card"
                >
                  <dt className="text-sm uppercase tracking-wider text-muted-foreground">
                    {f.label}
                  </dt>
                  <dd className="mt-1 text-lg font-semibold text-foreground">{f.value}</dd>
                </div>
              ))}
            </dl>
          </div>
        </section>

        {/* FAQ */}
        <section id="faq" className="scroll-mt-24 border-t border-border">
          <div className="mx-auto max-w-3xl px-6 py-24 sm:py-32 lg:py-40">
            <h2 className="text-center text-3xl font-semibold tracking-tight sm:text-4xl">
              Questions people actually ask
            </h2>
            <Accordion type="single" collapsible className="mt-12 space-y-3">
              {FAQ.map((item) => (
                <AccordionItem
                  key={item.q}
                  value={item.q}
                  className="rounded-xl border border-border bg-surface px-6 transition-colors duration-300 data-[state=open]:bg-elevated"
                >
                  <AccordionTrigger className="py-6 text-left text-lg font-medium hover:no-underline">
                    {item.q}
                  </AccordionTrigger>
                  <AccordionContent className="pb-6 text-base leading-relaxed text-muted-foreground">
                    {item.a}
                  </AccordionContent>
                </AccordionItem>
              ))}
            </Accordion>
          </div>
        </section>

        {/* Final CTA */}
        <section className="border-t border-border bg-linear-to-b from-background to-surface">
          <div className="mx-auto max-w-6xl px-6 py-24 text-center sm:py-32">
            <h2 className="mx-auto max-w-2xl text-4xl font-bold tracking-tight sm:text-5xl">
              Your next video is one upload — or one script — away.
            </h2>
            <div className="mt-10 flex flex-wrap items-center justify-center gap-4">
              <Button size="lg" asChild>
                <Link to="/auth">
                  Start creating
                  <ArrowRight className="ml-2 h-4 w-4" />
                </Link>
              </Button>
              <Button size="lg" variant="outline" asChild>
                <a href="#process">See how it works</a>
              </Button>
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t border-border bg-surface">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-4 px-6 py-12 text-sm text-muted-foreground sm:flex-row">
          <span className="font-medium text-foreground">{LANDING_PRODUCT_NAME}</span>
          <nav className="flex flex-wrap items-center justify-center gap-6" aria-label="Footer">
            {NAV_LINKS.map((l) => (
              <a key={l.href} href={l.href} className="transition-colors hover:text-foreground">
                {l.label}
              </a>
            ))}
            <Link to="/auth" className="transition-colors hover:text-foreground">
              Sign in
            </Link>
          </nav>
          <span>Audio or script in, publish-ready video out.</span>
        </div>
      </footer>
    </div>
  );
}
