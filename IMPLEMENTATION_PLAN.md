# HaulDeck — Implementation Plan

## Project Name

The project will be called **HaulDeck**.

HaulDeck is short, memorable, and fits the product: a deck-like cargo planning surface for hauling runs. It avoids sounding like a trade calculator and keeps the app focused on organization, loading, unloading, and cargo separation.

Optional subtitle:

> HaulDeck — Cargo run organizer for Star Citizen hauling contracts.

This is an unofficial fan tool and should clearly state that it is not affiliated with Cloud Imperium Games or Roberts Space Industries.

---

# Project Goal

Build a mobile-first static web app/PWA that helps Star Citizen players stack and manage multiple hauling contracts during a single cargo run.

The application should minimize manual input and help players:

- Organize cargo by destination
- Assign cargo to ship zones
- Track partial and complete loading
- Track partial and complete unloading
- Avoid cargo mixups
- Efficiently manage multi-stop hauling runs

The MVP must work without any official Star Citizen player API and without a runtime backend.

---

# Product Vision

HaulDeck is **not** a trade calculator.

HaulDeck is a cargo organization assistant: a mobile dispatcher/checklist for players who are already accepting hauling contracts in-game.

The app should be fast enough to use while playing, require as little typing as possible, and remain useful offline.

---

# Deployment Target

## Primary Target

Deploy as a static PWA on **GitHub Pages**.

GitHub Pages supports static HTML, CSS, JavaScript, and static assets. It does not run PHP or other server-side backends. Because HaulDeck stores MVP data locally in the browser, this is a good fit.

Expected project URL shape:

```text
https://<github-user>.github.io/HaulDeck/
```

If the repository is named `<github-user>.github.io`, the app can also run at:

```text
https://<github-user>.github.io/
```

The app must support being served from a subpath, because project repositories on GitHub Pages are commonly hosted under `/<repo-name>/`.

---

# Technical Direction

## Chosen Stack

Use:

- HTML5
- CSS3
- Vanilla JavaScript ES modules
- IndexedDB for durable local app data
- Service worker for offline support
- Optional GitHub Pages deployment without a build step

Do not use for MVP:

- PHP runtime
- Node.js runtime
- npm build tooling
- Server-side database
- Server-side authentication
- Live Star Citizen API integration
- RSI login
- Cloud sync

## Why This Stack

The no-build static stack keeps the project easy to run locally and easy to deploy later. The app can be served by any static file server, opened through a simple local server during development, and hosted on GitHub Pages when ready.

Vanilla JavaScript is enough for the MVP because the app has a focused set of screens and no server integration. The implementation should still keep domain logic, storage, and rendering cleanly separated where practical.

---

# Application Structure

Suggested structure:

```text
/
    index.html
    service-worker.js

/public
    manifest.webmanifest
    icons/
    data/
        locations.json
        commodities.json

/assets
    app.css
    app.js
```

For MVP, routing is implemented as simple client-side state. No build step or package installation is required.

---

# Core Data Model

## App Storage Root

```ts
type AppData = {
  schemaVersion: number;
  sessions: HaulingSession[];
  settings: AppSettings;
};
```

## Session

```ts
type HaulingSession = {
  id: string;
  name: string;
  status: "active" | "archived";
  shipCapacityScu?: number;
  startLocation?: string;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
  contracts: HaulingContract[];
  zones: ShipZone[];
};
```

## Contract

```ts
type HaulingContract = {
  id: string;
  contractName?: string;
  pickupLocation: string;
  rewardAuec?: number;
  notes?: string;
  items: CargoLine[];
  quantityScu: number;
  loadedScu: number;
  unloadedScu: number;
  status: "planned" | "partial_loaded" | "loaded" | "partial_unloaded" | "delivered" | "cancelled";
  createdAt: string;
  updatedAt: string;
};
```

## Cargo Line

A contract can contain multiple cargo lines. Each line represents one commodity going to one destination.

```ts
type CargoLine = {
  id: string;
  dropoffLocation: string;
  commodity: string;
  quantityScu: number;
  loadedScu: number;
  unloadedScu: number;
  assignedZoneId?: string;
};
```

## Zone

```ts
type ShipZone = {
  id: string;
  name: string;
  sortOrder: number;
};
```

## Settings

```ts
type AppSettings = {
  theme: "dark";
  quantityLabel: "SCU";
};
```

For MVP, `quantityScu`, `loadedScu`, and `unloadedScu` should always represent SCU. Contract-level quantities are derived from cargo lines. If the game flow later requires crate counts or container sizes, that can be added as a separate model.

---

# MVP Feature Set

## 1. Hauling Sessions

A hauling session represents one active hauling run.

Users can:

- Create a session
- Continue a previous session
- Rename a session
- Archive a session
- Delete a session
- Export a session
- Import a session

Session data is stored locally in IndexedDB.

Acceptance criteria:

- Sessions survive refreshes and browser restarts
- Archived sessions are hidden from the default active list
- Deleting a session requires confirmation
- Export produces a portable JSON file
- Import validates schema before saving

---

## 2. Minimal Contract Input

The app should require as little typing as possible.

Required fields:

- Pickup location
- At least one cargo line
- Cargo line drop-off location
- Cargo line commodity
- Cargo line quantity in SCU

Optional fields:

- Reward in aUEC
- Notes
- Contract name/reference

Users can dynamically add or remove cargo lines in the contract form through an "Add cargo line" action. There is no fixed line limit in the app model. This supports contracts that contain multiple commodities and/or multiple destinations while keeping one shared pickup location for the contract.

After saving a contract, the app should offer quick actions:

- Same pickup
- Same first destination
- Same first commodity
- Duplicate previous contract

Acceptance criteria:

- Unknown custom locations and commodities are allowed
- Each cargo line quantity must be greater than zero
- Reward must be empty or numeric
- A contract can be edited or deleted after creation
- A contract can contain multiple cargo lines
- Each cargo line can have its own destination, commodity, quantity, zone, loaded SCU, and unloaded SCU
- Quick actions prefill the next contract form

---

## 3. Autocomplete Catalogs

Provide autocomplete for:

- Locations
- Commodities

Source data comes from local static JSON files:

```text
/public/data/locations.json
/public/data/commodities.json
```

The MVP should not depend on online APIs.

Future data sources may include:

- Star Citizen Wiki API
- UEX Corp data
- Community datasets

Acceptance criteria:

- Autocomplete works offline
- Users can still enter custom values
- Catalog loading failure does not block manual entry

---

## 4. Ship Zones

Players physically separate cargo inside their ship. HaulDeck helps track where each destination's cargo should go.

Default abstract zones:

- Left Front
- Right Front
- Left Rear
- Right Rear

Users can rename zones.

Example custom zone names:

- Elevator Side
- Cockpit Side
- Upper Deck
- Port Side
- Starboard

Acceptance criteria:

- Each new session starts with default zones
- Zones can be renamed
- Cargo lines can be manually assigned or reassigned
- Manual assignments are preserved when automatic assignment runs

---

## 5. Automatic Zone Assignment

The app should automatically group cargo by destination.

Rules:

- One destination should map to one zone where possible
- Existing manual assignments should be preserved
- New destinations should use the first available zone
- If there are more destinations than zones, extra destinations remain unassigned
- Unassigned cargo lines should stay usable but display a warning

Example:

| Destination | Zone |
|---|---|
| Baijini Point | Left Rear |
| Everus Harbor | Left Front |
| Seraphim Station | Right Rear |

Acceptance criteria:

- Cargo lines with the same destination receive the same zone by default
- Manual reassignment affects the selected cargo line
- Zone shortage does not block contract creation

---

## 6. Warnings

Show warnings when:

- Same commodity goes to multiple destinations
- More destinations exist than available zones
- Unassigned cargo lines exist
- Duplicate contract patterns are detected
- Loaded line quantity exceeds total line quantity
- Unloaded line quantity exceeds loaded line quantity

Example warning:

> Medical Supplies appears in multiple destinations. Keep those stacks physically separated.

Warnings should be helpful, not noisy. They should never prevent a player from continuing during gameplay unless data would become invalid.

---

## 7. Dashboard

The main session screen shows:

- Number of active contracts
- Number of cargo lines
- Total SCU
- Loaded SCU
- Unloaded SCU
- Number of destinations
- Total reward
- Active warnings
- Destination summary
- Zone summary
- Start location selector

Main actions:

- Add Contract
- Manage Zones

Acceptance criteria:

- Dashboard updates immediately after edits
- Delivered and cancelled contracts are collapsed under completed contracts
- The most important next actions are reachable with large touch targets
- Clicking "I am here now" on a stop opens the Actions screen for that stop
- Adding a contract defaults pickup to the start location when one is selected

---

## 8. Actions Mode

Actions mode assists the player at the currently selected location.

Behavior:

- Show unload actions first for cargo already loaded and due at the current location
- Show load actions second for cargo that should be picked up at the current location
- Group load cargo by contract, because cargo elevator retrieval happens per contract
- Show commodity, total SCU, loaded SCU, unloaded SCU, destination, and assigned ship zone
- Allow partial loading with a stepper/input
- Allow partial unloading with a stepper/input
- Allow one-tap "mark fully loaded"
- Allow one-tap "mark fully unloaded"
- Keep incomplete items visible until fully loaded

Acceptance criteria:

- A player can mark 0 to total SCU as loaded
- A player cannot unload more SCU than has been loaded
- Loaded progress survives refreshes
- Unloaded progress survives refreshes
- Fully loaded cargo lines move to a completed/secondary visual state
- Quantity controls are large enough for mobile use

---

## 9. Stop Plan

The stop plan should behave like pending route work, not a static unique destination list.

Behavior:

- Show pending stops in a dependency-aware order
- Include pickup stops as well as delivery stops
- Include the selected start location as stop 0
- Allow the same location to appear again later when the route genuinely returns there
- Hide stops that have no remaining load or unload work
- Stop rows have an "I am here now" action that opens the Actions screen for that stop
- Stop actions navigate to the location actions screen
- Use a scored route heuristic rather than first-match ordering
- Prefer unloading-only stops before stops that also introduce new pickup cargo, so the ship flies as empty as practical
- Penalize visiting a destination before all currently reachable cargo for that destination has been picked up
- Prefer pickup stops that unlock deliveries to destinations already on board
- Track total SCU on board after every stop
- If a ship max SCU is set, limit simulated loading to available capacity
- Treat the max SCU as a planning limit, with UI guidance that combo contracts and container sizes may require a safety margin
- Penalize inter-system jumps heavily so Stanton, Pyro, and Nyx routes avoid unnecessary jumps

Acceptance criteria:

- A pickup that unlocks a delivery appears before that delivery
- A location with completed delivery and completed pickup disappears from the checklist
- A route should avoid obvious repeated visits when one visit can combine the same destination's cargo
- A return contract can show the same location again if it has new work later in the route
- Each route stop shows the total SCU expected on board after completing that stop
- The route planner does not intentionally load more SCU than the configured ship max SCU
- A route avoids jumping systems while useful work remains in the current system

---

# Offline and PWA Requirements

HaulDeck should behave like an installable mobile app.

Requirements:

- Installable on phone
- Offline capable after first successful load
- Cached app shell
- Cached static catalog data
- Persistent local storage
- App icon and theme color

Service worker strategy:

- Cache versioned static app assets
- Cache `locations.json` and `commodities.json`
- Prefer network for app updates when online
- Fall back to cache when offline
- Clear old caches after activation

Acceptance criteria:

- App opens while offline after first visit
- Existing sessions remain available offline
- A new deployment does not permanently trap users on stale assets

---

# Storage Strategy

Use IndexedDB for primary storage.

Reasons:

- Better suited than localStorage for structured app data
- More robust for larger sessions
- Non-blocking API
- Easier future migration to richer local data

A small storage wrapper should hide IndexedDB complexity from UI components.

Storage requirements:

- Schema version stored with data
- Migration functions for future schema changes
- Export/import JSON
- Defensive handling for corrupted or invalid imported data

MVP may use a small IndexedDB helper dependency if it meaningfully reduces code complexity.

---

# UI Requirements

Design goals:

- Mobile-first
- Dark theme
- High contrast
- Large touch targets
- Fast navigation
- Minimal typing
- One-handed use where practical
- Usable while gaming
- Clear status at a glance

Interaction guidelines:

- Prefer large tappable rows over tiny controls
- Use steppers for SCU changes
- Use autocomplete and recent values to reduce typing
- Avoid modal-heavy workflows for core actions
- Keep load and unload screens focused on the immediate task
- Make warnings visible but not disruptive

Optional progressive enhancement:

- Use the Wake Lock API where supported to help keep the screen awake during loading/unloading.

---

# Navigation Structure

## Home

- Active sessions list
- Archived sessions access
- New session button
- Import session button

## Session Dashboard

- Summary
- Warnings
- Destination groups
- Zone overview
- Start location selector
- Quick actions

## Add/Edit Contract

- Fast entry form
- Autocomplete
- Recent values
- Quick duplicate actions
- Pickup defaults to start location when available

## Actions Mode

- Current-location checklist
- Unload section first
- Load section second
- Load section grouped by contract
- Partial loaded controls
- Partial unloaded controls
- Fully loaded action
- Fully unloaded action

## Zones

- Rename zones
- Reassign contracts
- Run automatic assignment

---

# Suggested Development Order

## Milestone 1 — Static App Shell

- Create no-build static app structure
- Add base layout
- Add dark mobile-first CSS
- Add simple screen navigation
- Configure GitHub Pages base path support

Done when:

- App runs locally
- App runs from static files without package installation
- Navigation works without a backend

---

## Milestone 2 — Local Storage Foundation

- Add IndexedDB wrapper
- Add schema versioning
- Add session CRUD
- Add export/import helpers

Done when:

- Sessions survive refresh
- Export/import round trip works
- Invalid imports are rejected with a useful message

---

## Milestone 3 — Contract System

- Add contract form
- Add edit/delete behavior
- Add autocomplete from static JSON catalogs
- Add quick actions
- Add validation

Done when:

- Contracts can be created, edited, deleted, and persisted
- Unknown custom values are accepted
- Contract totals appear on the dashboard

---

## Milestone 4 — Zones and Warnings

- Add default zones
- Add zone rename UI
- Add manual contract assignment
- Add automatic destination-based assignment
- Add warning detection

Done when:

- Same-destination cargo is grouped into zones
- Zone shortage is warned about
- Manual choices are preserved

---

## Milestone 5 — Load and Unload Workflows

- Add load mode grouped by pickup
- Add partial loading
- Add unload mode filtered by destination
- Add partial unloading
- Add delivered/completed states

Done when:

- Loading and unloading progress survives refresh
- Users cannot unload more than loaded
- Completed contracts are clearly visible but de-emphasized

---

## Milestone 6 — PWA and GitHub Pages Deployment

- Add manifest
- Add icons
- Add service worker
- Add offline asset caching
- Configure GitHub Pages static hosting when ready to publish

Done when:

- App installs on mobile
- App opens offline after first visit
- Static files can be served from GitHub Pages

---

# GitHub Pages Deployment Plan

No build step is required. When the app is ready to publish:

- Create a GitHub repository
- Push the static files
- Enable GitHub Pages from the repository root or `/docs`
- Keep links and asset URLs relative so the app works under `/<repo-name>/`

For a project repository, the expected URL is:

```text
https://<github-user>.github.io/HaulDeck/
```

For a user/organization site repository named `<github-user>.github.io`, the expected URL is:

```text
https://<github-user>.github.io/
```

---

# Future Features

These are explicitly not MVP requirements.

## OCR/Screenshot Import

- Upload screenshot
- OCR extracts contract data
- User confirms extracted values

## Cloud Sync

- Optional backend sync
- Multi-device continuity
- Account-based saved sessions

## Ship Templates

Preconfigured layouts for:

- C1 Spirit
- Freelancer MAX
- Caterpillar
- Hercules C2
- Hull A

## Route Optimization

- Ship capacity presets and per-run overrides
- Distance-aware ordering using local coordinates or a distance matrix
- Risk-aware ordering for mixed commodities and zone conflicts
- Ship-template-aware loading constraints
- System-aware routing with Stanton, Pyro, and Nyx metadata

## Shared Runs

- Read-only session sharing
- Multi-crew coordination
- Live collaborative updates

---

# Non-Goals for MVP

Do not implement in MVP:

- RSI login
- Live game integration
- Real-time cargo sync
- Trading profit calculators
- Multiplayer collaboration
- AI assistant
- Complex 3D ship rendering
- Runtime backend
- Server database

---

# Final MVP Definition

HaulDeck MVP is a lightweight static PWA that allows Star Citizen players to:

- Quickly enter hauling contracts
- Group cargo by destination
- Assign ship zones
- Track partial and complete loading
- Track partial and complete unloading
- Avoid cargo mixups with practical warnings
- Export and import local sessions
- Install and use the app offline
- Deploy entirely through GitHub Pages
