import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * Card - shadcn/ui base, restyled to the kolm .card plate: warm-paper-2
 * surface, hairline border, a soft lift on hover. Drop `data-ledger` on a
 * parent (or use the `ledger` prop) to invert the plate onto the deep ledger.
 */
const Card = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement> & { ledger?: boolean }
>(({ className, ledger = false, ...props }, ref) => (
  <div
    ref={ref}
    className={cn(
      "rounded-lg border p-6 transition-[border-color,box-shadow] duration-200",
      ledger
        ? "border-[var(--line-ink)] bg-[var(--ink-deep-2)] text-on-ink hover:border-[var(--line-ink-2)] hover:shadow-[0_18px_50px_-30px_#000]"
        : "border-line bg-card text-card-foreground hover:border-line-2 hover:shadow-[0_18px_44px_-30px_rgba(14,19,16,0.22)]",
      className
    )}
    {...props}
  />
));
Card.displayName = "Card";

const CardHeader = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div ref={ref} className={cn("flex flex-col gap-1.5", className)} {...props} />
));
CardHeader.displayName = "CardHeader";

const CardTitle = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLHeadingElement>
>(({ className, ...props }, ref) => (
  <h3
    ref={ref}
    className={cn(
      "font-sans text-[20px] font-semibold leading-[1.3] tracking-[-0.012em]",
      className
    )}
    {...props}
  />
));
CardTitle.displayName = "CardTitle";

const CardKicker = React.forwardRef<
  HTMLParagraphElement,
  React.HTMLAttributes<HTMLParagraphElement>
>(({ className, ...props }, ref) => (
  <p
    ref={ref}
    className={cn(
      "font-mono text-[11px] font-medium uppercase tracking-[0.12em] text-ink-3",
      className
    )}
    {...props}
  />
));
CardKicker.displayName = "CardKicker";

const CardDescription = React.forwardRef<
  HTMLParagraphElement,
  React.HTMLAttributes<HTMLParagraphElement>
>(({ className, ...props }, ref) => (
  <p ref={ref} className={cn("text-[15px] text-ink-2", className)} {...props} />
));
CardDescription.displayName = "CardDescription";

const CardContent = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div ref={ref} className={cn("text-[15px]", className)} {...props} />
));
CardContent.displayName = "CardContent";

const CardFooter = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn("flex items-center gap-3", className)}
    {...props}
  />
));
CardFooter.displayName = "CardFooter";

export {
  Card,
  CardHeader,
  CardTitle,
  CardKicker,
  CardDescription,
  CardContent,
  CardFooter,
};
