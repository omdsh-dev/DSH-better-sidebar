/**
 * Row bound of ONE `fs.trees` batch request.
 *
 * Shared by both halves so they cannot drift: the host refuses a larger batch
 * outright (`too many paths (max N)`), and the client splits the visible set on
 * the same number — a session whose persisted expansion set reaches the cap
 * used to blank its WHOLE file tree on every mount/refresh. Kept free of
 * runtime dependencies so the browser bundle pulls nothing in with it.
 */
export const FS_TREES_MAX_PATHS = 64
