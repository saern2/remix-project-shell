import { createFileRoute } from "@tanstack/react-router";
import { Monitor, Moon, Sun } from "lucide-react";
import { useTheme, type ThemePreference } from "@/components/theme-provider";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/_authenticated/settings")({ component: SettingsPage });

const choices: Array<{ value: ThemePreference; label: string; icon: typeof Sun }> = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "system", label: "System", icon: Monitor },
];

function SettingsPage() {
  const { theme, setTheme } = useTheme();
  return (
    <main className="mx-auto max-w-5xl px-5 py-8 sm:px-8 lg:py-10">
      <div className="mb-8">
        <p className="text-sm font-medium text-primary">Workspace</p>
        <h1 className="mt-1 text-2xl font-semibold">Settings</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Choose how Scene Smith looks on this device.
        </p>
      </div>
      <section className="border-t py-6" aria-labelledby="appearance-heading">
        <h2 id="appearance-heading" className="text-base font-semibold">
          Appearance
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Your preference is saved locally and follows system changes when selected.
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          {choices.map(({ value, label, icon: Icon }) => (
            <Button
              key={value}
              variant={theme === value ? "default" : "outline"}
              onClick={() => setTheme(value)}
              aria-pressed={theme === value}
            >
              <Icon className="mr-2 h-4 w-4" />
              {label}
            </Button>
          ))}
        </div>
      </section>
    </main>
  );
}
