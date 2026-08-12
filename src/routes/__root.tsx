import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Outlet,
  Link,
  createRootRouteWithContext,
  useRouter,
  HeadContent,
  Scripts,
} from "@tanstack/react-router";
import { useEffect, useRef, type ReactNode } from "react";

import appCss from "../styles.css?url";
import { reportLovableError } from "../lib/lovable-error-reporting";
import { supabase } from "@/integrations/supabase/client";
import { decideAuthInvalidation } from "@/lib/auth-invalidation";
import { Toaster } from "@/components/ui/sonner";
import { ThemeProvider, themeBootScript } from "@/components/theme-provider";

function NotFoundComponent() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-7xl font-bold text-foreground">404</h1>
        <h2 className="mt-4 text-xl font-semibold text-foreground">Page not found</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          The page you're looking for doesn't exist or has been moved.
        </p>
        <div className="mt-6">
          <Link
            to="/"
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Go home
          </Link>
        </div>
      </div>
    </div>
  );
}

function ErrorComponent({ error, reset }: { error: Error; reset: () => void }) {
  console.error(error);
  const router = useRouter();
  useEffect(() => {
    reportLovableError(error, { boundary: "tanstack_root_error_component" });
  }, [error]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-xl font-semibold tracking-tight text-foreground">
          This page didn't load
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Something went wrong on our end. You can try refreshing or head back home.
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          <button
            onClick={() => {
              router.invalidate();
              reset();
            }}
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Try again
          </button>
          <a
            href="/"
            className="inline-flex items-center justify-center rounded-md border border-input bg-background px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent"
          >
            Go home
          </a>
        </div>
      </div>
    </div>
  );
}

const APP_TITLE = "Auto Video Creator v2";
const APP_DESCRIPTION =
  "Turn audio into scene-matched video. Upload a track and let Auto Video Creator draft a video for you.";

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Audio to vid" },
      {
        name: "description",
        content:
          "Project Shell provides the foundational structure for an automated video creation web application.",
      },
      { property: "og:title", content: "Audio to vid" },
      {
        property: "og:description",
        content:
          "Project Shell provides the foundational structure for an automated video creation web application.",
      },
      { property: "og:type", content: "website" },
      {
        property: "og:image",
        content:
          "https://pub-bb2e103a32db4e198524a2e9ed8f35b4.r2.dev/3ec63576-f374-44d9-b96b-ceca9d412c99/id-preview-f65b9cde--5428befa-2baf-416e-a4ac-071aeb9bec67.lovable.app-1784578872248.png",
      },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "twitter:title", content: "Audio to vid" },
      {
        name: "twitter:description",
        content:
          "Project Shell provides the foundational structure for an automated video creation web application.",
      },
      {
        name: "twitter:image",
        content:
          "https://pub-bb2e103a32db4e198524a2e9ed8f35b4.r2.dev/3ec63576-f374-44d9-b96b-ceca9d412c99/id-preview-f65b9cde--5428befa-2baf-416e-a4ac-071aeb9bec67.lovable.app-1784578872248.png",
      },
    ],
    links: [
      { rel: "stylesheet", href: appCss },
      { rel: "preconnect", href: "https://fonts.googleapis.com" },
      { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" },
      {
        rel: "stylesheet",
        href: "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap",
      },
      { rel: "icon", href: "/favicon.ico", type: "image/x-icon" },
    ],
  }),
  shellComponent: RootShell,
  component: RootComponent,
  notFoundComponent: NotFoundComponent,
  errorComponent: ErrorComponent,
});

function RootShell({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <HeadContent />
        <script dangerouslySetInnerHTML={{ __html: themeBootScript }} />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}

function RootComponent() {
  const { queryClient } = Route.useRouteContext();
  const router = useRouter();

  // Identity this tab last reacted to, and whether it has reacted at all. The
  // rule itself lives in auth-invalidation.ts, where it can be tested without a
  // router or a browser; these refs are only its memory.
  const lastUserId = useRef<string | null>(null);
  const hasHandledAuthEvent = useRef(false);

  useEffect(() => {
    const { data } = supabase.auth.onAuthStateChange((event, session) => {
      const decision = decideAuthInvalidation({
        event,
        userId: session?.user?.id ?? null,
        lastUserId: lastUserId.current,
        hasHandled: hasHandledAuthEvent.current,
      });
      lastUserId.current = decision.nextUserId;
      hasHandledAuthEvent.current = decision.handled;

      // Costly and therefore gated: this re-runs the _authenticated beforeLoad,
      // which is two round trips — supabase.auth.getUser() and
      // getAccessGateStatus().
      if (decision.invalidateRouter) router.invalidate();
      if (decision.invalidateQueries) queryClient.invalidateQueries();
    });
    return () => data.subscription.unsubscribe();
  }, [router, queryClient]);

  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <Outlet />
        <Toaster />
      </ThemeProvider>
    </QueryClientProvider>
  );
}
