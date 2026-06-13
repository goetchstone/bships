/**
 * Tiny pure CSS-block extractor for the HUD layout-contract tests. NOT a real
 * CSS parser — it just pulls the declaration body for a given selector out of
 * the HUD_CSS string so tests can assert the layout invariants that fix the
 * reported HUD bugs (chat never centered, minimap in a corner, interactive
 * children opt into pointer-events, central play rectangle stays clickable).
 * No DOM, no deps — unit-testable in plain node.
 */

/**
 * Return the declaration body (between the braces) of the FIRST rule whose
 * selector list contains `selector` exactly, or null if absent. Whitespace in
 * the returned body is collapsed to single spaces for stable matching.
 */
export function ruleBody(css: string, selector: string): string | null {
  let from = 0;
  for (;;) {
    const open = css.indexOf('{', from);
    if (open < 0) return null;
    const close = css.indexOf('}', open);
    if (close < 0) return null;
    const head = css.slice(from, open);
    from = close + 1;
    // A comment can precede the selector; strip a trailing comment block.
    const cleaned = head.replace(/\/\*[\s\S]*?\*\//g, '');
    const selectors = cleaned.split(',').map((s) => s.trim());
    if (selectors.includes(selector)) {
      return css.slice(open + 1, close).replace(/\s+/g, ' ').trim();
    }
  }
}

/** True when a rule body declares `prop: value` (value matched loosely). */
export function declares(body: string | null, prop: string, value: string): boolean {
  if (body === null) return false;
  const re = new RegExp(`(?:^|;|\\{)\\s*${escapeRe(prop)}\\s*:\\s*[^;]*${escapeRe(value)}`, 'i');
  return re.test(body);
}

/** The raw value text of `prop` in a rule body (first occurrence), or null. */
export function valueOf(body: string | null, prop: string): string | null {
  if (body === null) return null;
  const re = new RegExp(`(?:^|;|\\{)\\s*${escapeRe(prop)}\\s*:\\s*([^;]+)`, 'i');
  const m = re.exec(body);
  return m === null ? null : (m[1] ?? '').trim();
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
