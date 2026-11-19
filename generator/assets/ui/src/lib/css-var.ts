/**
 * Read `--c3-style-*` custom properties from the document root at runtime, for
 * the places CSS can't reach (eCharts options, canvas fills). One owner for the
 * SSR guard, the trim and the fallback; before this, seven files each had
 * their own copy.
 */

/** A reader bound to ONE computed-style snapshot of the root, for building a
 *  whole chart option (dozens of reads, one style lookup). Returns `fallback`
 *  when there's no DOM or the property is unset. */
export function cssVarReader(): (name: string, fallback?: string) => string {
  const cs = typeof window !== "undefined" ? getComputedStyle(document.documentElement) : null;
  return (name, fallback = "") => cs?.getPropertyValue(name).trim() || fallback;
}

/** One custom property's current value (or `fallback`). For many reads, use `cssVarReader()`. */
export function readCssVar(name: string, fallback = ""): string {
  return cssVarReader()(name, fallback);
}
