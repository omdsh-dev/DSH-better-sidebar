import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "./utils"
import { Slot } from "radix-ui"

/**
 * Vendored shadcn/ui button, trimmed to the task page's real inventory.
 *
 * Removed from upstream (`new-york`): the `link` variant and the `xs` / `lg` /
 * `icon-xs` / `icon-sm` / `icon-lg` sizes. The page's control heights are 28 px
 * (`sm`), 36 px (`default`) and the square 36 px icon button; every removed
 * class still lived in this runtime object and would have shipped in the bundle.
 */
const buttonVariants = cva(
  // LOCAL ADAPTATION: `transition-all` narrowed to the same property list the
  // page's other vendored controls use (see ui/toggle.tsx) — `all` also
  // animates layout/size changes, which makes resizes and mount transitions
  // laggy on a dense task page.
  "inline-flex shrink-0 items-center justify-center gap-2 rounded-md text-sm font-medium whitespace-nowrap transition-[color,background-color,border-color,box-shadow] outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/90",
        destructive:
          "bg-destructive text-destructive-foreground hover:bg-destructive/90 focus-visible:ring-destructive/20",
        outline:
          "border bg-background hover:bg-accent hover:text-accent-foreground",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-secondary/80",
        ghost: "hover:bg-accent hover:text-accent-foreground",
      },
      size: {
        default: "h-9 px-4 py-2 has-[>svg]:px-3",
        sm: "h-8 gap-1.5 rounded-md px-3 has-[>svg]:px-2.5",
        icon: "size-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

/**
 * LOCAL ADAPTATION (dsh-better-sidebar): `React.forwardRef`, because this
 * plugin runs on the DSH host's React 18 (react@^18.2.0 — ref-as-prop is a
 * React 19 feature). Without it, `<TooltipTrigger asChild><Button/></…>`
 * cannot measure its anchor: radix's `Slot` hands the child a ref and a plain
 * function component drops it (dev builds warn, production silently
 * mis-positions the floating layer). Upstream ships no forwardRef because the
 * registry targets React 19; the shadcn CLI `--diff` flow will try to remove
 * it — re-apply this adaptation when updating the file.
 */
const Button = React.forwardRef<
  HTMLButtonElement,
  React.ComponentProps<"button"> &
    VariantProps<typeof buttonVariants> & {
      asChild?: boolean
    }
>(function Button({ className, variant = "default", size = "default", asChild = false, ...props }, ref) {
  const Comp = asChild ? Slot.Root : "button"

  return (
    <Comp
      ref={ref}
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
})

export { Button, buttonVariants }
