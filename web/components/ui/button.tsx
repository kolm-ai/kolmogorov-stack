import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

/**
 * Button - shadcn/ui base, restyled to the kolm button system from
 * kolm-2026.css (.btn / .btn--primary / .btn--ghost). The primary fill is the
 * signal green; ghost is a hairline that darkens on hover.
 */
const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md font-sans font-semibold leading-none tracking-[-0.006em] transition-[background,border-color,color,box-shadow,transform] duration-150 [transition-timing-function:cubic-bezier(0.2,0.7,0.2,1)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-paper disabled:pointer-events-none disabled:opacity-60",
  {
    variants: {
      variant: {
        primary:
          "border border-[var(--accent)] bg-[var(--accent)] text-[var(--on-accent)] hover:border-[var(--accent-deep)] hover:bg-[var(--accent-deep)] hover:shadow-[0_10px_28px_-12px_rgba(17,135,90,0.42)] active:translate-y-px active:bg-[var(--accent-press)]",
        ghost:
          "border border-line-2 bg-transparent font-medium text-ink hover:border-ink hover:bg-[rgba(14,19,16,0.04)]",
        link: "text-accent-text underline-offset-4 hover:underline",
      },
      size: {
        default: "min-h-[46px] px-6 py-[14px] text-[15.5px]",
        sm: "min-h-[38px] px-4 py-[9px] text-[13.5px]",
        lg: "min-h-[52px] px-7 py-4 text-[16.5px]",
      },
    },
    defaultVariants: {
      variant: "primary",
      size: "default",
    },
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    );
  }
);
Button.displayName = "Button";

export { Button, buttonVariants };
