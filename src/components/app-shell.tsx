import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { MaintenanceBanner } from "@/components/maintenance-banner";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState, type ReactNode } from "react";
import {
  AudioLines,
  ChartColumnBig,
  ChevronLeft,
  ChevronRight,
  CircleUserRound,
  FolderKanban,
  LayoutDashboard,
  LogOut,
  Menu,
  Moon,
  Settings,
  Shield,
  Sun,
  UsersRound,
  type LucideIcon,
} from "lucide-react";
import { useIsAdmin } from "@/hooks/use-is-admin";
import { supabase } from "@/integrations/supabase/client";
import { cn } from "@/lib/utils";
import { useTheme, type ThemePreference } from "@/components/theme-provider";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

type ShellPath =
  | "/dashboard"
  | "/stats"
  | "/projects/new"
  | "/projects"
  | "/settings"
  | "/account"
  | "/admin"
  | "/users";
type NavItem = { label: string; to: ShellPath; icon: LucideIcon; exact?: boolean };

const PRIMARY_NAV: NavItem[] = [
  { label: "Dashboard", to: "/dashboard", icon: LayoutDashboard, exact: true },
  { label: "Stats", to: "/stats", icon: ChartColumnBig, exact: true },
  { label: "Audio to Video", to: "/projects/new", icon: AudioLines },
  { label: "Projects", to: "/projects", icon: FolderKanban },
] as const;

const SECONDARY_NAV: NavItem[] = [
  { label: "Settings", to: "/settings", icon: Settings },
  { label: "Account", to: "/account", icon: CircleUserRound },
] as const;

function isActive(pathname: string, to: string, exact?: boolean) {
  if (to === "/dashboard" && !exact)
    return pathname === "/dashboard" || pathname.startsWith("/projects/");
  return exact ? pathname === to : pathname === to || pathname.startsWith(`${to}/`);
}

function ThemeMenuItems() {
  const { theme, setTheme } = useTheme();
  return (
    <>
      {(["light", "dark", "system"] as ThemePreference[]).map((option) => (
        <DropdownMenuItem key={option} onClick={() => setTheme(option)}>
          <span className="capitalize">{option}</span>
          {theme === option ? <span className="ml-auto text-primary">Selected</span> : null}
        </DropdownMenuItem>
      ))}
    </>
  );
}

function ShellNav({ collapsed, onNavigate }: { collapsed: boolean; onNavigate?: () => void }) {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const { isAdmin } = useIsAdmin();

  const renderLink = (item: NavItem) => {
    const active = isActive(pathname, item.to, item.exact);
    const Icon = item.icon;
    return (
      <Link
        key={item.label}
        to={item.to}
        aria-current={active ? "page" : undefined}
        title={collapsed ? item.label : undefined}
        onClick={onNavigate}
        className={cn(
          "flex h-10 items-center gap-3 rounded-md px-3 text-sm font-medium transition-colors",
          active
            ? "bg-sidebar-accent text-sidebar-accent-foreground"
            : "text-muted-foreground hover:bg-sidebar-accent/70 hover:text-sidebar-foreground",
          collapsed && "justify-center px-0",
        )}
      >
        <Icon className="h-4 w-4 shrink-0" />
        {!collapsed ? <span>{item.label}</span> : null}
      </Link>
    );
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-5 px-3 py-4">
      <nav aria-label="Primary navigation" className="space-y-1">
        {!collapsed ? (
          <p className="px-3 pb-2 text-xs font-medium text-muted-foreground">Workspace</p>
        ) : null}
        {PRIMARY_NAV.map(renderLink)}
      </nav>
      <div className="mt-auto space-y-1">
        {!collapsed ? (
          <p className="px-3 pb-2 text-xs font-medium text-muted-foreground">Manage</p>
        ) : null}
        {isAdmin ? (
          <>
            {renderLink({ label: "Admin", to: "/admin", icon: Shield, exact: true })}
            {renderLink({ label: "Users", to: "/users", icon: UsersRound })}
          </>
        ) : null}
        {SECONDARY_NAV.map(renderLink)}
      </div>
    </div>
  );
}

export function AppShell({ children, email }: { children: ReactNode; email?: string }) {
  const navigate = useNavigate();
  const { resolvedTheme } = useTheme();
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  const signOut = async () => {
    await supabase.auth.signOut();
    navigate({ to: "/auth", replace: true });
  };

  const accountMenu = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          className={cn(
            "h-auto w-full justify-start gap-3 px-3 py-2",
            collapsed && "justify-center px-0",
          )}
        >
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-primary-subtle text-primary">
            <CircleUserRound className="h-4 w-4" />
          </span>
          {!collapsed ? (
            <span className="min-w-0 text-left">
              <span className="block text-xs font-medium">Account</span>
              <span className="block truncate text-xs text-muted-foreground">
                {email ?? "Signed in"}
              </span>
            </span>
          ) : null}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="w-56">
        <DropdownMenuLabel className="truncate">{email ?? "Your account"}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
          Appearance
        </DropdownMenuLabel>
        <ThemeMenuItems />
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => void signOut()} className="text-destructive">
          <LogOut className="mr-2 h-4 w-4" /> Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  return (
    <div className="min-h-screen bg-background text-foreground">
      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-30 hidden border-r bg-sidebar transition-[width] duration-200 lg:flex lg:flex-col",
          collapsed ? "w-20" : "w-64",
        )}
      >
        <div className="flex h-16 items-center gap-3 border-b px-4">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-md bg-primary text-primary-foreground">
            <AudioLines className="h-5 w-5" />
          </span>
          {!collapsed ? <span className="font-semibold">Scene Smith</span> : null}
        </div>
        <ShellNav collapsed={collapsed} />
        <div className="border-t p-3">{accountMenu}</div>
        <Button
          variant="outline"
          size="icon"
          className="absolute -right-3 top-20 h-7 w-7 rounded-full bg-background"
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          onClick={() => setCollapsed((value) => !value)}
        >
          {collapsed ? (
            <ChevronRight className="h-3.5 w-3.5" />
          ) : (
            <ChevronLeft className="h-3.5 w-3.5" />
          )}
        </Button>
      </aside>

      <header className="sticky top-0 z-20 flex h-16 items-center justify-between border-b bg-background/95 px-4 backdrop-blur lg:hidden">
        <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
          <SheetTrigger asChild>
            <Button variant="ghost" size="icon" aria-label="Open navigation">
              <Menu className="h-5 w-5" />
            </Button>
          </SheetTrigger>
          <SheetContent side="left" className="flex w-72 flex-col p-0">
            <SheetTitle className="flex h-16 items-center gap-3 border-b px-4 text-base">
              <span className="grid h-9 w-9 place-items-center rounded-md bg-primary text-primary-foreground">
                <AudioLines className="h-5 w-5" />
              </span>
              Scene Smith
            </SheetTitle>
            <ShellNav collapsed={false} onNavigate={() => setMobileOpen(false)} />
            <div className="border-t p-3">{accountMenu}</div>
          </SheetContent>
        </Sheet>
        <span className="text-sm font-semibold">Scene Smith</span>
        <span className="text-muted-foreground" title={`${resolvedTheme} theme`}>
          {resolvedTheme === "dark" ? <Moon className="h-4 w-4" /> : <Sun className="h-4 w-4" />}
        </span>
      </header>

      <div className={cn("transition-[padding] duration-200", collapsed ? "lg:pl-20" : "lg:pl-64")}>
        {/* In the shell, not per-page: a notice you can navigate away from is
            how an admin forgets maintenance is on for three hours. */}
        <MaintenanceBanner />
        {children}
      </div>
    </div>
  );
}
