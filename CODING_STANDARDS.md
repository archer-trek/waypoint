# Coding Standards

Judgment calls for code review and UI/test changes in `waypoint`. Mechanical rules (unused vars, hooks deps, banned hex colors/raw Tailwind palettes, `leading-none` + `truncate` clipping) are enforced by `eslint.config.js` and `src/waypoint/theme-guard.test.ts`.

## UI, Typography, and Layout

- **Root `rem` baseline (`src/App.css`)**: `html, body, #root` sets `font-size: 15.5px` for document-flow reading (`1rem = 15.5px`) alongside `-webkit-font-smoothing: antialiased`. Do not rely on `text-base` assuming `16px` on mobile (`isNarrow`) navigation/list rows; set explicit `px` sizes and verify optical weight on high-DPI screens.
- **Vertical alignment & chrome**: Align narrow mobile list content edges directly to the header brand axis. Keep full-bleed header dividers flush to the viewport edges, and size paired icons optically (e.g. `Plus` spans less of its viewBox than `Settings`).
- **Preserve behavioral DOM/ARIA hooks**: Keep `.waypoint-*` semantic classes and `sr-only` landmarks expected by `SidebarView.test.tsx` and `WaypointApp.test.tsx`.

## Domain & ADR Consistency

- Use `GLOSSARY.md` terms in UI copy, tests, and PR descriptions (`Owner`, `Bot`, `Topic`, `未读`, `已读位置`, `正在回应`, `不可用`).
- Respect layout and interaction contracts in `docs/adr/` (e.g. ADR-0017 avatar-free Topic rows, ADR-0020 unread dot + pinned header, ADR-0021 wide split vs narrow stack, ADR-0026 monochrome semantic tokens). If a change intentionally revises an ADR, state the divergence explicitly and update or supersede the ADR.

## Tests

- Use `npm run test:unit` for fast UI feedback while iterating; run full `npm test`, `npm run lint`, and `npm run build` before pushing.
- In integration tests (`src/waypoint/WaypointApp.test.tsx`), await DOM convergence inside `waitFor(...)` rather than asserting synchronously right after a mock network/sync counter increments.
