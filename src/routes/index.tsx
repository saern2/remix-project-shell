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
import { AudioLines, ArrowRight } from "lucide-react";

export const Route = createFileRoute("/")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "Auto Video Creator — Upload a voiceover, get a video" },
      {
        name: "description",
        content:
          "Auto Video Creator transcribes your audio, breaks it into scenes, matches stock footage, and renders a publish-ready video. No editing timeline required.",
      },
      { property: "og:title", content: "Auto Video Creator — Upload a voiceover, get a video" },
      {
        property: "og:description",
        content:
          "Transcription, scene matching, stock footage, custom pacing, and auto-render from a single audio file.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "twitter:title", content: "Auto Video Creator — Upload a voiceover, get a video" },
      {
        name: "twitter:description",
        content:
          "Transcription, scene matching, stock footage, custom pacing, and auto-render from a single audio file.",
      },
    ],
  }),
  beforeLoad: async () => {
    const { data } = await supabase.auth.getUser();
    if (data.user) throw redirect({ to: "/dashboard" });
  },
  component: Landing,
});

const TAGS = [
  "Transcription",
  "Scene matching",
  "Stock footage",
  "Custom pacing",
  "Auto-render",
];

const STEPS = [
  {
    title: "Upload your audio",
    body: "Drop in a voiceover or narration file. That's the entire brief.",
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
    a: "Just an audio file — a voiceover, narration, or recorded script. Nothing else required.",
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
    a: "Short-form works best today — narration up to a few minutes renders reliably. Longer pieces are still being stabilised, so we'd rather not promise them yet.",
  },
];

function Landing() {
  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-30 border-b border-border bg-background/80 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <div className="flex items-center gap-2">
            <AudioLines className="h-5 w-5 text-primary" />
            <span className="text-sm font-semibold tracking-tight">Auto Video Creator</span>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" asChild>
              <Link to="/auth">Sign in</Link>
            </Button>
            <Button size="sm" asChild>
              <Link to="/auth">Start creating</Link>
            </Button>
          </div>
        </div>
      </header>

      <main>
        {/* Hero */}
        <section className="mx-auto max-w-6xl px-6 pt-20 pb-24 sm:pt-28 sm:pb-32">
          <div className="grid items-center gap-16 lg:grid-cols-2">
            <div>
              <h1 className="text-display text-foreground">
                Upload a voiceover.
                <br />
                Get a video.
              </h1>
              <p className="mt-6 max-w-xl text-base leading-relaxed text-muted-foreground sm:text-lg">
                Auto Video Creator transcribes, matches footage, scores pacing, and renders a
                publish-ready video from a single audio file. No editing timeline required.
              </p>
              <ul className="mt-8 flex flex-wrap gap-2">
                {TAGS.map((tag) => (
                  <li
                    key={tag}
                    className="rounded-lg border border-border bg-surface px-3 py-1.5 text-xs font-medium text-muted-foreground"
                  >
                    {tag}
                  </li>
                ))}
              </ul>
              <div className="mt-10 flex flex-wrap items-center gap-3">
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
            <HeroDemo />
          </div>
        </section>

        {/* Process */}
        <section id="process" className="border-t border-border">
          <div className="mx-auto max-w-6xl px-6 py-24 sm:py-32">
            <h2 className="max-w-2xl text-3xl font-semibold tracking-tight sm:text-4xl">
              From voice to video, five steps
            </h2>
            <ol className="mt-14 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {STEPS.map((step, i) => (
                <li
                  key={step.title}
                  className="rounded-2xl border border-border bg-surface p-6 shadow-[0_8px_32px_rgb(0_0_0/0.25)]"
                >
                  <span className="text-sm font-semibold text-primary">
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  <h3 className="mt-3 text-lg font-semibold">{step.title}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{step.body}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        {/* Output */}
        <section className="border-t border-border">
          <div className="mx-auto max-w-6xl px-6 py-24 sm:py-32">
            <div className="grid gap-12 lg:grid-cols-2 lg:items-center">
              <div>
                <h2 className="text-3xl font-semibold tracking-tight sm:text-4xl">
                  Made to be watched, not skipped past
                </h2>
                <p className="mt-6 max-w-xl text-base leading-relaxed text-muted-foreground">
                  Scenes are cut to sentence boundaries, so the picture changes when the meaning
                  does. Footage is chosen from what the narration actually says, and you can set a
                  fixed clip length when you want a faster, tighter rhythm.
                </p>
              </div>
              <div className="rounded-3xl border border-border bg-surface p-8">
                <dl className="grid gap-8 sm:grid-cols-2">
                  <div>
                    <dt className="text-sm text-muted-foreground">Cut on</dt>
                    <dd className="mt-1 text-xl font-semibold">Sentence boundaries</dd>
                  </div>
                  <div>
                    <dt className="text-sm text-muted-foreground">Pacing</dt>
                    <dd className="mt-1 text-xl font-semibold">3–6s fixed clips</dd>
                  </div>
                  <div>
                    <dt className="text-sm text-muted-foreground">Formats</dt>
                    <dd className="mt-1 text-xl font-semibold">9:16 · 16:9 · 1:1</dd>
                  </div>
                  <div>
                    <dt className="text-sm text-muted-foreground">Output</dt>
                    <dd className="mt-1 text-xl font-semibold">1080p MP4</dd>
                  </div>
                </dl>
              </div>
            </div>
          </div>
        </section>

        {/* FAQ */}
        <section className="border-t border-border">
          <div className="mx-auto max-w-3xl px-6 py-24 sm:py-32">
            <h2 className="text-3xl font-semibold tracking-tight sm:text-4xl">
              Questions people actually ask
            </h2>
            <Accordion type="single" collapsible className="mt-10">
              {FAQ.map((item) => (
                <AccordionItem key={item.q} value={item.q}>
                  <AccordionTrigger className="text-left text-base">{item.q}</AccordionTrigger>
                  <AccordionContent className="text-base leading-relaxed text-muted-foreground">
                    {item.a}
                  </AccordionContent>
                </AccordionItem>
              ))}
            </Accordion>
          </div>
        </section>

        {/* Final CTA */}
        <section className="border-t border-border">
          <div className="mx-auto max-w-6xl px-6 py-24 text-center sm:py-32">
            <h2 className="mx-auto max-w-2xl text-3xl font-semibold tracking-tight sm:text-4xl">
              Your next video is one upload away.
            </h2>
            <div className="mt-10 flex flex-wrap items-center justify-center gap-3">
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

      <footer className="border-t border-border">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-3 px-6 py-10 text-xs text-muted-foreground sm:flex-row">
          <span>Auto Video Creator</span>
          <span>Audio in, publish-ready video out.</span>
        </div>
      </footer>
    </div>
  );
}
