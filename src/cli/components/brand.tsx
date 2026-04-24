/**
 * Smoo AI brand tokens for the CLI.
 *
 * Colors mirror `packages/ui/globals.css` in the smooai monorepo:
 *   - orange        → smooai-orange-600 (#f49f0a) — primary accent
 *   - teal          → smooai-green-800  (#00a6a6) — secondary/tech
 *   - darkBlue      → smooai-dark-blue  (#25405d) — neutral text
 *   - mutedOrange   → smooai-orange-900 (#523603) — chrome / separators
 */
export const BRAND = {
    orange: '#f49f0a',
    coral: '#ff6b6c',
    teal: '#00a6a6',
    darkBlue: '#25405d',
    mutedOrange: '#523603',
    green: '#10b981',
    red: '#ef4444',
    yellow: '#f59e0b',
    gray: '#6b7280',
} as const;

export const GRADIENTS = {
    heroOrangeTeal: [BRAND.orange, BRAND.teal] as [string, string],
    heroOrangeCoral: [BRAND.orange, BRAND.coral] as [string, string],
    successTeal: [BRAND.teal, '#22d3ee'] as [string, string],
} as const;
