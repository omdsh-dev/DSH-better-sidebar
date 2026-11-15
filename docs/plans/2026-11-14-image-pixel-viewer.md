# Image pixel viewer: zoom, pixel grid, distance and area measurement

The plugin used to hand every raster image to DSH's `ui-sidebar-documentpreview`
(`HOST_OWNED_EXTS` in `src/client/native/index.ts`). That preview can zoom, but
it cannot say how many pixels a line spans, and it has no notion of a pixel
boundary. This change takes the raster formats back: a new built-in `image`
viewer renders `png / jpg / jpeg / gif / webp / bmp / ico` inside the plugin's
own editor, with a continuous (not stepped) zoom, a nearest-neighbour bitmap,
and three measurement tools (two-axis distance, single-axis distance, area) plus
a per-measurement delete tool. SVG
stays with the host: it is vector artwork, so a
"one image pixel" is not a stable unit and the host's zoom viewport is the
better owner.

## Coordinate model

Three spaces, all pure functions in `src/client/image-view.ts`:

| Space | Origin | Unit |
| --- | --- | --- |
| image edge | image top-left | one pixel **border** (`0 … width`, `0 … height`) |
| image pixel | image top-left | one pixel **cell** (`0 … width-1`, `0 … height-1`) |
| stage | stage top-left | CSS pixel |

Measurements live in edge coordinates and are snapped to integer edges. That is
the only way two boundary lines can name an exact interval, and it matches
Photoshop's Info panel: a 5×5 image measured from its top edge (0) to its bottom
edge (5) is **5 px**, covering pixel rows 0–4.

The count is therefore inclusive of both end pixels while the geometry is the
edge difference. This is one rule, not two:

- line `(0,0) → (0,5)`: length 5 px, pixel labels `(0,0)` and `(0,4)`.
- line `(2,0) → (2,5)`: length 3 px, pixel labels `(2,2)` and `(2,4)`.
- rectangle `(0,0) → (5,5)`: width 5 px, height 5 px, area 25 px²,
  corner labels `(0,0)` and `(4,4)`.
- diagonal `(0,0) → (5,5)`: `ΔX 5`, `ΔY 5`, Euclidean length ≈ 7.07 px,
  pixel labels `(0,0)` and `(4,4)`.

`endpointPixel(edge, otherEdge)` picks the covered pixel nearest an endpoint:
the lower edge is itself a pixel row/column, the higher edge belongs to the
pixel just before it. A degenerate line (both edges equal) creates no
measurement.

Every annotation stores edges, so zooming and panning never moves it relative
to the image. Annotations are independent (several lines and rectangles may
coexist) and the toolbar clears all of them at once.

## Zoom and pan

- Wheel zoom anchored at the cursor. `scale` is CSS pixels per image pixel;
  `tx`/`ty` place the image origin inside the stage:
  `screen = origin + imageEdge × scale`.
- Every interaction step is quantized to a **whole percentage** (1% above 1%,
  0.1% below it), so the toolbar never shows `1756.2%`; the fit scale stays
  exact because it is a one-shot framing, not a step the reader takes.
- Range: 0.1% … 3200% (Photoshop's maximum). Opening fits the image inside the
  stage with 16 px padding and never upscales past 100%.
- `image-rendering: pixelated` from 100% up: each source pixel is a whole
  number of device pixels with no interpolation, so it stays a pixel block at
  any zoom. Below 100% the browser's normal downscale is used (nearest-neighbour
  downscaling would alias).
- A 1 px pixel grid is drawn from **600%** up, where Photoshop shows its own
  pixel grid. The grid follows the same scale and clips to the image.
- Drag pans. Once an image is larger than the stage, each overflowing axis may
  be pushed inward by up to **25% of the stage** (a percentage, not a pixel
  count, so the hand-feel is the same at any sidebar width); that blank stage is
  pannable space but cannot start a measurement. An axis whose image fits stays
  centered and cannot be dragged, and the same clamp runs for wheel zoom, fit,
  100% and a panel resize, so the allowance is always recomputed from the
  current stage size. See "Overscroll and auto-scroll" below.
- While a measurement tool is active, the left button draws instead, and the
  middle mouse button still pans. A right-button drag beyond 4 px also pans
  (temporarily, without switching the tool); a right click that never drags
  opens the host's shared `image` menu (copy image / download / save as /
  reveal) through `ctx.contextMenus`, carrying the session, path, media URL,
  name and MIME. Only a real right-drag suppresses the `contextmenu` that
  follows it — and dismisses a menu an earlier right click left open; a host
  without that service gets the untouched native menu.
- The toolbar is a **single-select** tool group: exactly one tool is pressed at
  a time. A temporary right-drag pan borrows the hand's selection for its
  duration (the measurement tool reads unpressed) and releasing returns the
  pressed state to the tool, without changing the tool itself.
- The **default tool is two-axis distance**: opening a picture and dragging
  draws a measurement immediately; pan is the hand button, the middle button,
  or a right-button drag.
- Toolbar: zoom out, current percentage (click = 100%), zoom in, fit (frame
  with opposite corner brackets), pan (open hand), single-axis distance,
  two-axis distance, area, delete measurement, clear all. The status bar shows
  image dimensions, the zoom level and the pixel under the cursor.
  `ResizeObserver` refits while the reader has not zoomed or panned; after that
  the view is theirs.

## Rendering

The stage contains, in order: a screen-space frame (checkerboard for
transparency plus a 1 px outline), ONE scaled container
(`translate(tx,ty) scale(s)`) holding the bitmap and the measurement geometry, a
screen-space pixel grid, and a screen-space label layer.

The geometry MUST live inside the bitmap's container. An earlier version drew
it in a separate screen-space SVG; at fractional zoom the vector line and the
bitmap's nearest-neighbour pixel border were rasterized independently and
visible drifted apart (3200% looked aligned, 1756.2% did not). Sharing one
transform removes that class of bug structurally: the line and the pixel it
names cannot move relative to each other. Because the geometry is inside an
HTML CSS transform, `vector-effect: non-scaling-stroke` cannot see the ancestor
zoom; the stroke width is therefore set to `3 / scale` user units, which
renders exactly 3 CSS px at every zoom. The width is a CSS-pixel thickness, not
an image-pixel one: the calibration ticks stay one IMAGE pixel long (0.5 px on
each side of the border), so at 48% a tick reads as a short stub rather than
shrinking with the zoom.

A measurement is one solid red line with no halo, fill, shadow or endpoint
dots. The two calibration ticks at a distance's ends are exactly **one image
pixel long** (0.5 px on each side of the measured border) and run perpendicular
to the measured line — a single-axis line therefore gets its tick automatically.
A rectangle draws a single red outline plus a faint translucent red wash inside
it (24%), and the wash never tints the pixel grid: the grid layer is a later
screen-space sibling of the scaled canvas, so it paints on top. Draft geometry is
the same in dashed red and disappears on pointer up.

The single-axis tool follows the dominant axis of the drag (`|dx| >= |dy|` is
horizontal, otherwise vertical), snapping both ends to pixel borders. Its length
is the corresponding axis difference, so the readout is always the number of
pixels that axis spans. Its icon is not a redrawn mark: the two-axis glyph is
literally rotated 45° inside the same 16-unit viewBox, so stroke weight, tick
length and dot size are identical by construction. That makes it taller than its
sibling and slightly high in the toolbar, which is accepted.

The delete tool is a per-measurement eraser: with it selected, the measurement
nearest the pointer (within 8 CSS px of the drawn line or rectangle border) is
drawn 6 CSS px thick as a hover target, and a left click removes exactly that
one annotation. The pointer cursor turns into a hand over a target.
Clicking empty space does nothing, right-drag still pans, and the existing
clear-all button keeps removing every annotation at once.

Labels are bare red text (20 px for pixel coordinates, 24 px for the measured
value), with no background box and no shadow. Their position is a pure function
of the measured pixels — no stage-edge clamping, so they do not float around
while the window moves. A distance shows only its length (`25 px`) beside the
line, plus both covered pixels in parentheses at its ends. On a horizontal
measurement the result (number + `px` as one block) is centered above the
segment's midpoint and the endpoint labels anchor to its upper-left and
upper-right (fully above the line, never on it or its dots); vertical and
diagonal measurements keep the result to the line's left and the along-line
placement outside the endpoints. The result label is
anchored by its `px` suffix: it sits on the line's left or upper side, 24 px
away, right-aligned to that point, so a long number (`1000 px`) grows away from
the line instead of crossing it. A rectangle shows its width beside the width
edge and its height beside the height edge, plus the two corner pixels in
parentheses, offset outside the outline so they never cover it.

## Overscroll and auto-scroll

Two rules share one entry point, `clampTransform`, so they can never disagree
about where the picture may sit:

- **Overscroll.** For each axis where the scaled image is larger than the stage,
  the image may be pushed inward by `OVERSCROLL_RATIO = 25%` of that stage axis,
  not a fixed pixel count: the right panel can be resized at will, and a
  percentage keeps "I can nudge one edge a quarter of the way in" true at every
  width. With a 100×100 visible area the image's top-left corner may therefore
  move to (25, 25). At the old 719×863 sidebar stage that is ≈180 px of blank on
  each side and ≈216 px top/bottom. An axis whose image fits is still centered
  and immovable. Because wheel zoom, fit, 100%, dragging and the `ResizeObserver`
  re-clamp all call `clampTransform`, the allowance is always derived from the
  current stage size, and a shrunken panel immediately takes back the excess
  blank. The blank is pannable but not drawable: `onPointerDown` still requires
  the start edge to be inside the image; once a drag has started the pointer may
  leave the image and the end snaps to the nearest pixel border as before.
- **Auto-scroll while drawing.** With a distance / single-axis / rectangle
  gesture in flight, a pointer within `AUTO_SCROLL_EDGE = 24` CSS px of a stage
  edge starts panning the view toward that edge. The two axes are independent,
  so a rectangle can grow in two directions at once. Speed ramps linearly from 0
  at the inside of the band to `AUTO_SCROLL_MAX_STEP = 12` CSS px per animation
  frame at the stage border, and stays there when the pointer is dragged out of
  the stage (pointer capture keeps the gesture alive). Each frame re-runs the
  same snap / axis-lock / hover update a real `pointermove` would run, so the
  draft keeps growing, the status bar keeps naming the pixel under the pointer,
  and stopping the pointer at the edge scrolls until `clampTransform` reaches the
  overscroll limit and then stops. The loop is a single `requestAnimationFrame`
  chain that is cancelled on pointer up, `pointercancel`, a new gesture and
  unmount, and it never runs for a pan (middle button or right-drag), so the
  temporary-pan gesture cannot fight it.

## Routing

`canOpen` no longer refuses raster image extensions. It does refuse them when
the viewer is disabled (or unregistered) **and** no other enabled viewer claims
them, so the host's preview keeps owning the address instead of dropping the
file on the `code` catch-all's download pane. SVG remains in `HOST_OWNED_EXTS`.
An external plugin cannot register the `image` id while the built-in owns it
(the registry rejects duplicate ids), but another descriptor that claims these
extensions still wins on priority and keeps the address in the plugin.

## Non-goals

- SVG rasterisation or measurement.
- AVIF/HEIC and other formats the host does not render: they stay on the
  plugin's existing download path.
- Exporting measurements, calibration to physical units, angle readouts,
  touch pinch gestures and annotation editing/undo.
- Auto-fit after the reader has interacted; the view is the reader's.

## Verification

- `tests/image-view.spec.ts`: fit/clamp/zoom anchoring, the 25% stage
  overscroll (including the 100×100 → (25,25) example and per-axis centering),
  edge snapping, inclusive counts, endpoint pixel mapping, single-axis locking,
  eraser hit distances to a segment / rectangle border, auto-scroll ramp /
  both-axis judgement / band boundaries, whole-percent zoom quantization,
  zoom formatting, grid threshold.
- `tests/image-preview.spec.tsx`: load → fit, wheel zoom at the cursor, tool
  switching, default two-axis tool, single-select during a right-drag pan,
  drag measurement with bare red labels, one-line geometry (no halo/dots/fill),
  axis locking, `px`-anchored result label, eraser hover + per-line delete,
  right-drag pan with context-menu suppression (and a plain right click that
  keeps the menu), auto-scroll growing a draft and stopping on release and at
  the overscroll boundary, no measurement from the blank margin, multiple
  annotations, clear, disabled/empty error states.
- `tests/builtins.spec.ts`, `tests/native-surface.spec.ts`: the image viewer is
  built in, claims the seven raster extensions, SVG stays host-owned, and a
  disabled image viewer hands the address back.
- `pnpm.cmd typecheck`, `pnpm.cmd exec eslint .`,
  `pnpm.cmd exec vitest run --maxWorkers=2`.
