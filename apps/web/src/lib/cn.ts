/**
 * Class joining, with no dependency.
 *
 * `clsx` and `tailwind-merge` are 3 KB of solving a problem this app does not have: there is
 * one design system here and components do not accept arbitrary overriding class strings, so
 * there is nothing to de-conflict.
 */
export function cn(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}
