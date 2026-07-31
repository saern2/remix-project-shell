"use client";

import * as React from "react";
import * as ProgressPrimitive from "@radix-ui/react-progress";

import { cn } from "@/lib/utils";

const Progress = React.forwardRef<
  React.ElementRef<typeof ProgressPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof ProgressPrimitive.Root>
>(({ className, value, ...props }, ref) => (
  <ProgressPrimitive.Root
    ref={ref}
    className={cn("relative h-2 w-full overflow-hidden rounded-full bg-field", className)}
    {...props}
  >
    <ProgressPrimitive.Indicator
      className="relative h-full w-full flex-1 overflow-hidden rounded-full bg-linear-to-r from-primary to-primary-hover transition-all duration-500 ease-out"
      style={{ transform: `translateX(-${100 - (value || 0)}%)` }}
    >
      <span
        aria-hidden="true"
        className="absolute inset-y-0 -left-full w-1/2 animate-shimmer bg-linear-to-r from-transparent via-white/25 to-transparent"
      />
    </ProgressPrimitive.Indicator>
  </ProgressPrimitive.Root>
));
Progress.displayName = ProgressPrimitive.Root.displayName;

export { Progress };
