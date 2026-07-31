import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { ThemeProvider, useTheme } from "../theme-provider";

function ThemeHarness() {
  const { theme, resolvedTheme, setTheme } = useTheme();
  return (
    <button onClick={() => setTheme("light")}>
      {theme}:{resolvedTheme}
    </button>
  );
}

describe("ThemeProvider", () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.className = "dark";
  });

  it("persists a selected theme and updates the document", async () => {
    render(
      <ThemeProvider>
        <ThemeHarness />
      </ThemeProvider>,
    );
    fireEvent.click(screen.getByRole("button"));
    await waitFor(() => expect(localStorage.getItem("scene-smith-theme")).toBe("light"));
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(screen.getByRole("button").textContent).toBe("light:light");
  });
});
