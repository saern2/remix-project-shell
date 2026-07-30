// Feature: render-pipeline-reliability, Property 14: Progress component forwards aria-label to DOM
import { describe, it, expect } from "vitest";


import * as React from "react";
import { render } from "@testing-library/react";
import * as fc from "fast-check";
import { Progress } from "../progress";

// Validates: Requirements 6.1, 6.4, 6.5

describe("Progress component – aria-label forwarding (Property 14)", () => {
  it("should forward any non-empty aria-label string to the progressbar element", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), (label) => {
        const { container, unmount } = render(
          <Progress value={50} aria-label={label} />
        );

        const progressbar = container.querySelector('[role="progressbar"]');
        expect(progressbar).not.toBeNull();
        expect(progressbar!.getAttribute("aria-label")).toBe(label);

        // Clean up between runs so each iteration is isolated
        unmount();
      }),
      { numRuns: 100 }
    );
  });
});
