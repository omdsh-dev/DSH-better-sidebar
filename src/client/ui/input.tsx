import * as React from "react"
import { cn } from "./utils"

/**
 * Vendored shadcn/ui input, minus upstream's `file:` variant utilities
 * (`file:inline-flex` `file:h-7` `file:border-0` `file:bg-transparent`
 * `file:text-sm` `file:font-medium` `file:text-foreground`).
 *
 * Two reasons, and both are load-bearing: the plugin has no `<input
 * type="file">` surface, so they are dead class strings in a runtime object;
 * and they compile to `::file-selector-button` selectors, which is also
 * Tailwind preflight's signature — `tests/ui-foundation.spec.ts` uses that
 * string to prove the reset never ships (plugin CSS is a global `<style>`, so a
 * reset would repaint the whole DSH page), and the file-input variant would
 * trip that guard forever. Nothing else on the element changes.
 */
function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "h-9 w-full min-w-0 rounded-md border border-input bg-transparent px-3 py-1 text-base transition-[color,box-shadow] outline-none selection:bg-primary selection:text-primary-foreground placeholder:text-muted-foreground disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
        "focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50",
        "aria-invalid:border-destructive aria-invalid:ring-destructive/20",
        className
      )}
      {...props}
    />
  )
}

export { Input }
