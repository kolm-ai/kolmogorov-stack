import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

/**
 * Badge - shadcn/ui base, restyled to the kolm .badge family. `verified`
 * carries the one place the signal green appears as a fill + dot; `void` is the
 * desaturated tampered state (never alarm-red); `ctrl` is the MACHINE-voice
 * control-id chip.
 */
const badgeVariants = cva(
  "inline-flex items-center gap-[7px] rounded-sm border font-mono text-[11.5px] font-medium tracking-[0.03em] transition-colors",
  {
    variants: {
      variant: {
        default: "border-line-2 px-3 py-1.5 text-ink-2",
        verified:
          "border-accent-edge bg-accent-soft px-3 py-1.5 text-ink before:h-[7px] before:w-[7px] before:flex-none before:rounded-full before:bg-[var(--accent)] before:content-['']",
        void: "border-void-edge bg-void-soft px-3 py-1.5 text-void",
        ctrl: "border-line bg-paper-2 px-[10px] py-[5px] text-[11px] tracking-[0.02em] text-ink-2",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <span className={cn(badgeVariants({ variant }), className)} {...props} />
  );
}

export { Badge, badgeVariants };
