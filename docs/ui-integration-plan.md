# UI Integration Plan — Poker Ledger (Live + Quick-log)

**Author:** ui
**Status:** Draft — for team-lead sign-off before any implementation
**Scope:** Design-language integration of the Live Play module (merged at `475cbf5`) into the host Fishes app. Companion to `merged-app-vision.md` (pm) and em's diagnosis.
**Out of scope:** CSS or component implementation. This doc decides *what* ships next; the follow-up PR executes.

---

## TL;DR

The Live module is currently wired as a **sixth tab labeled "Live Play"**, sitting inside a tab-bar alongside Leaderboard / Sessions / Players / Debts / Rules. Per the product vision (one lifetime number across every game, regardless of how it was tracked), that framing is wrong. Live and Quick-log are **two ways of recording a night**, not two separate features. Users should never feel like they're switching apps.

**My five calls:**

1. **Nav:** Collapse the 6-tab bar. Live becomes a **mode-level action** ("Start live session" / "Join live session") reachable from anywhere, not a tab. The Live sub-views (admin/player/settlement) are routes, not tab contents.
2. **Tokens:** Unify `color.text.*`, `color.surface.*`, spacing, radii, and typography. Let **accent colors stay module-specific** — indigo for ledger-wide analytics, emerald for live-session success, amber for warnings. Single font stack.
3. **Empty/loading/error:** Port Thor's PR #2 `Toast` + `EmptyState` primitives into `src/components/shared/`. Quick-log currently has zero error surface; this is the biggest UX win for the effort.
4. **Mobile:** Both modules are broken at 375px in different ways. Live's join-code input is over-tracked; Fishes' 6-tab bar has hidden-scroll antipattern. Both need fixing in this PR, not a follow-up.
5. **Shared components (build list):** `<AppShell>`, `<ModeSwitcher>`, `<ToastProvider>`, `<EmptyState>`, `<ErrorBoundary>`, `<Button>`, `<Modal>`. Seven items, four are adapt-from-existing.

Strong product question flagged at the end — not deciding, asking.

---

## Current state (what I read, literally)

- `src/App.tsx` is a **1498-line monolith**. Fishes views (dashboard, sessions, players, debts, rules) are inlined as `{activeTab === 'X' && ...}` blocks. Live views are imported from `src/views/Live*.tsx` and rendered through a nested `renderLiveSection()` dispatcher inside the 6th tab. The two halves share nothing but `App`'s state bag.
- **Two auth systems coexist.** The Fishes side has no login (it's a single-user ledger tool). Live has its own `liveUser` state persisted to `localStorage.live_poker_user`. Users who "use both modes" effectively have two separate identities today. The PM vision explicitly names this as wrong.
- **Two dark themes that don't match.**
  - *Fishes shell:* `text-zinc-100` on `bg-black/40` with a Three.js gradient background; indigo-500 tab accents; `font-black tracking-tighter uppercase italic` for the title; framer-motion page transitions.
  - *Live views:* `text-slate-50` on `bg-slate-950` (no Three.js — would conflict); emerald-400 accent with amber/sky tertiaries; static CSS animations; no framer-motion imports.
  - Zinc and slate are both neutral-greys but they **are not the same ramp**. Side-by-side on the same screen, this reads as "two apps stapled together."
- **Tab bar on mobile** uses `overflow-x-auto scrollbar-hide`. Six tabs plus an inline action button. On 375px the "Live Play" tab is off-screen by default — users have to horizontal-scroll to discover it. This is the first thing I noticed.
- **The Live module has nested tabs inside its container tab** (LiveLobby's `'dash' | 'create' | 'join'`). Tabs-in-tabs is a smell; in this case it's a symptom of the underlying wrong framing — Live is trying to be its own mini-app.
- **Stack:**
  - Tailwind v4 (real build, not CDN), `clsx` + `tailwind-merge` via a `cn()` util — I can use this freely for shared components.
  - `lucide-react` for icons (same as Thor), `motion/react` for animations (Thor uses static CSS — motion stays Fishes-only).
  - `@react-three/fiber` + `@react-three/drei` for the background.
  - `@google/genai`, `xlsx`, `react-dropzone` for Quick-log ingestion — unrelated to this plan.

---

## 1. Top-level nav pattern

### Recommendation: Mode-as-action, not mode-as-tab

Kill the 6-tab bar. Replace with a cleaner IA:

```
┌─────────────────────────────────────────────────────┐
│ Poker Ledger                  [ + Live Session ▾ ]  │  ← header
├─────────────────────────────────────────────────────┤
│  Leaderboard  Sessions  Players  Debts  Rules       │  ← 5-tab bar
├─────────────────────────────────────────────────────┤
│                                                     │
│  (tab content)                                      │
│                                                     │
└─────────────────────────────────────────────────────┘
```

The **`[+ Live Session]` split-button** in the header opens a dropdown with two actions: "Host a table" (→ `LiveLogin` if signed out, → `LiveSessionAdmin` on create) and "Join a table" (→ 6-digit code entry, → `LiveSessionPlayer`). An **active Live session shows a persistent banner** at the top of the shell ("Live session at Rohit's — 4 players — tap to return") so the user never loses their seat when browsing the ledger.

### Why this and not "Live as one of 5 tabs"

- **Pm's vision is explicit:** two modes, one ledger. Tabs suggest "one of these five things is your current context." Live isn't a context, it's an action that *creates* records that show up in the other five tabs. Burying it in the tab bar misrepresents the data model.
- **Six tabs already overflow 375px.** Dropping Live out of the bar solves the mobile-overflow problem for free.
- **Live sessions are short-lived.** You're in one for 3 hours once a week. You're in the leaderboard view every time you open the app. Equal-weight tabs give Live permanent visual real estate it doesn't need the other 165 hours of the week.
- **A persistent banner for active sessions** is the right "you're in a live game" affordance — works regardless of which tab you're on, can't be forgotten in the background.

### Why not "Mode switcher at the very top" (two containers)

I considered `[Quick-log | Live]` as a top-level toggle above the tab bar. Rejecting it because:
- It re-introduces the "two apps" feel pm wants gone.
- Quick-log and Live aren't symmetric — Quick-log is always-on (it's the ledger you're always looking at); Live is episodic.
- The shared Leaderboard/Sessions tabs need to show **both modes' data** — a top-level mode switch implies separation that the data model explicitly doesn't have.

### What ships (nav changes)

- Remove `'livePlay'` from `activeTab`.
- New header component with integrated `<ModeSwitcher>` (the split-button).
- New `<ActiveLiveSessionBanner>` component, shown when `liveRoute !== 'lobby'` or an active `sessionCode` exists.
- Live sub-routes (admin/player/settlement) are a **route switch**, not a tab — reached through the banner or the mode-switcher CTA, not via tab click.

---

## 2. Shared design tokens

### Unify these

| Token | Target value | Replaces |
|---|---|---|
| `color.surface.app` | `bg-slate-950` (Live's current base) | Fishes `bg-black/40` + Three.js gradient. See Three.js decision below. |
| `color.surface.card` | `bg-slate-900` | Fishes `bg-white/10 backdrop-blur-md border-white/10` (keep `.glass` utility aliased) |
| `color.text.primary` | `text-slate-100` | Fishes `text-zinc-100`, Live `text-slate-50` — pick one, zinc/slate are visually distinguishable side-by-side |
| `color.text.muted` | `text-slate-400` | Fishes `text-zinc-500`, Live `text-slate-500` |
| `color.text.dim` | `text-slate-600` | Live `text-slate-600`, Fishes inconsistent |
| `color.border.subtle` | `border-white/5` | Matches both after merge; keep |
| `color.focus.ring` | `ring-emerald-400/60 ring-offset-slate-950` | Live already uses this post-PR#2; Fishes has no unified focus-ring token |
| `font.sans` | `"Inter", system-ui` | Fishes already set it, Live CDN'd Plus Jakarta Sans — consolidate on Inter, ~$0 cost |
| `font.mono` | `"JetBrains Mono"` | Already in Fishes `@theme`, Live uses browser default — adopt Fishes |
| `radius.card` | `rounded-2xl` | Live uses mixed `rounded-2xl`/`rounded-3xl`/`rounded-[2rem]`; Fishes cleaner. Standardize on `2xl` for cards, `xl` for inputs, `full` for pills |
| `spacing.page` | `px-4 sm:px-6 md:px-12` | Fishes uses `px-6 md:px-12`; add phone step |
| `spacing.stack.card` | `space-y-4 sm:space-y-6` | Currently wildly inconsistent |
| `shadow.card` | `shadow-xl` | Both apps agree; codify |
| `animation.entry` | `animate-slide` (already in `index.css`) | Keep the simple CSS keyframe for Live; framer stays for Fishes-specific richness |

Mechanically: land these as **CSS custom properties** in `index.css` under `@theme` (Tailwind v4 supports this natively), not as a `tailwind.config.js` — Fishes is already on v4 with `@theme`. Live's Tailwind-CDN class literals get rewritten to use the unified values over the course of the PR, file by file.

### Keep module-specific (with justification)

| Token | Fishes value | Live value | Why kept separate |
|---|---|---|---|
| **Accent / primary CTA** | `indigo-500 → purple-600` gradient | `emerald-500` flat | Semantic: indigo reads as "analytics/ledger/data" across the ledger tabs; emerald reads as "success/money/approved" which is exactly what buy-in approval flows need. Unifying them would flatten meaning. |
| **Semantic positives** | `emerald-400` in sparklines | `emerald-400` | Already identical. Codify. |
| **Semantic negatives** | `rose-400` in sparklines | `rose-400` | Already identical. Codify. |
| **Warnings** | (minimal use) | `amber-400` | Live uses this for "pending approval" states; Fishes doesn't have an equivalent state, no conflict. |
| **Motion** | `framer-motion` tab transitions + `AnimatePresence` | CSS `@keyframes slideIn` | Framer is 35 kB; using it in Live too just to match would bloat the smaller surface. CSS slide is sufficient for the Live views' needs. Document the boundary: "framer for ledger analytics transitions; CSS for in-session state." |
| **Three.js background** | Fishes shell `<ThreeBackground />` | None | **Strong opinion:** drop Three.js entirely. Flagged as a product question below. |

### Three.js — product question (flagging, not deciding)

The `ThreeBackground` component is aesthetic-only and costs ~600 kB of three.js + drei + fiber in the bundle. It was part of the Fishes "Premium Analytics" framing. Under the new "Poker Ledger" name pm is proposing in `merged-app-vision.md`, the "Premium Analytics" tagline is going away too. I think the Three.js background should go with it — it's visual noise that competes with the actual data and makes the Live views impossible to read over. **But this is a product call, not a UI call.** Routing to team-lead.

---

## 3. Empty / loading / error surfaces

**Port Thor's PR #2 primitives. No half-measures.**

### What each module has today

- **Quick-log (Fishes side):** Two `alert()` calls (`App.tsx:305`, `App.tsx:326`). `uploadError` is set to local state but rendered inconsistently. Loading states are ad-hoc `isUploading` booleans. No empty states when the leaderboard/sessions/debts are empty — user sees a blank card.
- **Live side:** Still on pre-PR#2 Thor patterns — inline loading divs ("Connecting to Table..."), italic "No chip history found" strings, no toasts. (PR #2 itself lives in the Thor repo, not this one — it hasn't been ported here.)

### Port decision

Lift both primitives (`Toast.tsx`, `EmptyState.tsx`) from `Thor-Poker-Ledger` PR #2 into `src/components/shared/`. Minor adaptations needed:

- **Toast.tsx** — Already dependency-free, uses `useReducer` + `createPortal` + `aria-live`. Swap hand-coded class strings for the `cn()` util to match Fishes convention. Bundle impact: ~2 kB gzip. Net reduction vs. the current inconsistent mess because it lets us delete the `alert()`s and ad-hoc error divs.
- **EmptyState.tsx** — Currently hardcoded to emerald/amber/sky tones. Extend the `tone` enum to include `indigo` so Fishes-side empties can use the module accent. Three lines of CSS.

### Wire-up plan (not shipping this PR, but binding for the follow-up)

- `App.tsx` upload errors → `toast.error(...)`
- Excel/PDF parse success → `toast.success(...)`
- Every Quick-log empty block (empty leaderboard, no sessions, no debts, no players) → `<EmptyState>`
- Live views migrate to `useToast` for async events (already mapped in PR #2)
- `alert("...")` calls get deleted on sight — there are at least two in `App.tsx` and the Live views have one for invite-copy (PR #2 fixed it in Thor; we re-apply here).

---

## 4. Mobile strategy

Minimum viable mobile stance: **375×667 iPhone SE baseline.** Both modules were "mobile-friendly" on paper and broken in practice.

### What's broken today

| Surface | Break | Fix in this PR |
|---|---|---|
| Fishes header + 6-tab bar | Six tabs overflow `scrollbar-hide`'d container — "Live Play" off-screen by default | Dropping Live out of the bar (see §1) drops tab count to 5; remaining 5 fit at 375px with tighter `px-3` spacing |
| Fishes header title | `"Poker Fishes Ledger"` + `"Premium Analytics"` subtitle eats 60% of the 375px header | Shorter title per pm vision ("Poker Ledger"), drop tagline or move to settings page |
| Fishes Export PDF button | Fixed right of header, 140px wide — pushes title into truncation | Icon-only on mobile, text+icon on sm+ |
| Live join-code input | `text-4xl tracking-[0.6em] px-6` — 6 chars overflow at 375px (PR #2 already fixed this in Thor; re-apply) | Responsive tracking: `tracking-[0.3em]` on mobile, `tracking-[0.6em]` on sm+ |
| Live Lobby nested tabs | `'dash'/'create'/'join'` tab bar + outer tab container = double chrome | Flatten: Lobby becomes a single scrollable view with section CTAs, no inner tabs |
| Upload dropzone | Takes full width at 375px, readable, but the "Drop file or click to browse" copy wraps to 3 lines — minor | `text-xs` on mobile, text-sm sm+ |
| Active session banner (new) | Must not overlap safe-area-inset-top on notched devices | `pt-safe` utility, already in Thor PR #2's `index.html` — port the CSS |
| Modal padding | Both apps use `p-6` or larger — crowded on 375px | `p-4 sm:p-6` across all modals |

### Tablet

- 768px is fine today for the Fishes side; the grid layouts (`md:grid-cols-2`) already kick in correctly. Live views were designed phone-first and look unpolished on tablet (too much whitespace). **Out of scope for this PR** — noting for follow-up.
- Landscape iPhone (667×375) is an edge case; no explicit support, gracefully degrades to "scroll more."

### Tap targets

- Hard minimum `44×44px` on every interactive element, per WCAG + iOS HIG.
- The Fishes tab buttons (`TabButton`) currently have `px-3 md:px-6 py-3` with 16px icon + 10px text = ~40px tall at mobile. Bump to `py-3.5` (`min-h-[44px]`).
- The header Export PDF button is already correct size.
- Live buttons were bumped to `min-h-[44px]` in Thor PR #2; port with the components.

---

## 5. Minimum shared component set

**Seven components. Goal: maximum visual coherence, minimum new surface area.**

### Live in `src/components/shared/`

| Component | Source | Purpose | Why it must be shared |
|---|---|---|---|
| `<AppShell>` | **New** — extract from `App.tsx:508–571` | Fixed header + tab bar + optional active-session banner + main content slot | Every screen renders inside this. Prevents future drift. |
| `<ModeSwitcher>` | **New** | The split-button in the header (`+ Live Session ▾`) that opens "Host / Join" | Single entry point to Live from anywhere in the ledger. |
| `<ActiveLiveSessionBanner>` | **New** | "Live session at Rohit's — 4 players — tap to return" strip, shown when a Live session is active | Core UX affordance per §1. |
| `<ToastProvider>` + `useToast()` | **Adapt** from Thor PR #2 `components/Toast.tsx` | Async event notifications | Quick-log doesn't have any error surface today; this is the biggest UX improvement per unit effort. |
| `<EmptyState>` | **Adapt** from Thor PR #2 `components/EmptyState.tsx` | Icon + title + subtitle + optional CTA for empty lists | Consistent "nothing here yet" experience across both modules' ~8 empty surfaces. |
| `<ErrorBoundary>` | **Adapt** — there's already one in `src/components/ErrorBoundary.tsx` | Top-level crash fallback | Currently wraps nothing; should wrap `<AppShell>`'s children. Cleanup. |
| `<Button>` | **New** | `variant: primary-indigo \| primary-emerald \| ghost \| danger`, `size: sm/md/lg`, handles focus-ring + loading state | Button styling is the most-duplicated pattern across both modules. Extracting ends the copy-paste. |

### Explicitly NOT shared (left in-module)

- `<LiveLogin>`, `<LiveLobby>`, `<LiveSessionAdmin>`, `<LiveSessionPlayer>`, `<LiveSettlement>` — stay in `src/views/` as Live-mode routes.
- `<PLChart>` (inlined in LiveLobby today) — should be extracted to `src/components/charts/PLChart.tsx` during the follow-up PR since Fishes Leaderboard likely wants it too, but it's chart infrastructure, not design-system.
- `<ThreeBackground>` — pending the Three.js product question. If kept, stays where it is (used only by the Fishes shell).
- `<Modal>` wrapper — strongly considered, but Fishes has 2 modals and Live has 1, all bespoke shapes; abstracting at 3 use sites without a fourth on the horizon is premature. Add if a fourth modal appears.

### Directory shape

```
src/
  components/
    shared/
      AppShell.tsx
      ModeSwitcher.tsx
      ActiveLiveSessionBanner.tsx
      Toast.tsx                      ← port from Thor PR #2
      EmptyState.tsx                 ← port from Thor PR #2
      ErrorBoundary.tsx              ← move from src/components/
      Button.tsx
      cn.ts                          ← extract from App.tsx lines 46–48
    ThreeBackground.tsx              ← stays if kept (see product Q)
```

---

## Product questions for team-lead

Flagging, not deciding:

1. **Drop `<ThreeBackground>` entirely?** ~600 kB bundle, aesthetic-only, competes with data. My recommendation: yes, drop. Under the new "Poker Ledger" name the "Premium Analytics" framing is going away and the background was part of that framing. Room for cheaper alternatives (subtle CSS gradient, static felt texture like Thor used) if the team wants *some* background treatment.
2. **Live auth unification.** Today's code has two identity systems (`liveUser` + implicit single-user Fishes). Pm's vision requires they're the same person. This is out of my UI-only scope to decide, but the shared components I'm proposing assume a single `user` context — em's diagnosis should cover the auth layer and I'll wait on that before finalizing the shared-component contract.
3. **Brand reset scope.** Pm's vision says retire "Thor" and "Fishes" names everywhere users can see them. I assume that means: title text, login screen copy, menu labels, README user-facing sections. Confirm scope — does it include URL slugs, `localStorage` keys, etc.? (Migration cost differs.)

---

## What the follow-up PR looks like

Not this PR — this is the plan. The follow-up is roughly:

1. Shared components drop (AppShell, ToastProvider, EmptyState, ErrorBoundary, Button, cn).
2. Design tokens unified in `index.css` `@theme`.
3. App.tsx gutted: Fishes views extracted to `src/views/fishes/` (Dashboard.tsx, Sessions.tsx, Players.tsx, Debts.tsx, Rules.tsx), Live views stay where they are, `App.tsx` drops below 200 lines as pure shell + routing.
4. Live module re-wired as mode-action + banner, not 6th tab.
5. alert()s removed; every async call gets a toast.
6. Mobile audit at 375×667 on every new surface.
7. Three.js removed (pending decision) OR kept with clearer z-index boundaries.

Estimated size: ~6–8 commits, along the same shape as Thor PR #2. Commit plan will be part of the PR description, not this doc.

---

*End of plan. Ping ui when there are questions or you want me to dive deeper on any section.*
