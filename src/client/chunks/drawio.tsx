/**
 * Lazy chunk entry: draw.io preview (maxGraph). Built as
 * `lib/client-drawio.js` and fetched only when a `.drawio` / `.dio` file is
 * first opened, so maxGraph never enters the startup core bundle.
 */
export { DrawioView } from '../DrawioView.tsx'
