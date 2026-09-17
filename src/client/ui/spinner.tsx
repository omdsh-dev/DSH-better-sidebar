import { IconLoadingOutline16 } from "@deepseek-ai/dsh-client-ui-primitives"
import { cn } from "./utils"

/**
 * Loading indicator. The host supplies the glyph (`IconLoadingOutline16`), and
 * the rotation rides `animate-spin` on it — the host icons render an `svg`, so
 * the utility applies to the glyph box the same way it did upstream.
 *
 * Upstream took `React.ComponentProps<"svg">`; host icons expose exactly
 * `size` / `className`, so the accessible status wrapper moved out one level
 * instead of being spread onto the glyph.
 */
function Spinner({
  className,
  size = 16,
  label = "Loading",
}: {
  className?: string
  size?: number
  label?: string
}) {
  return (
    <span role="status" aria-label={label} className="inline-flex">
      <IconLoadingOutline16 size={size} className={cn("animate-spin", className)} />
    </span>
  )
}

export { Spinner }
