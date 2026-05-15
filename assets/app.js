import { getRouteChecklist } from "./route-planner.js";

const DB_NAME = "hauldeck";
const STORE_NAME = "app";
const DATA_KEY = "data";
const SCHEMA_VERSION = 2;
const DEFAULT_ZONES = ["Left Front", "Right Front", "Left Rear", "Right Rear"];

const app = document.querySelector("#app");

let state = {
  data: createEmptyData(),
  catalogs: { locations: [], locationOptions: [], locationSystems: new Map(), commodities: [] },
  screen: { name: "home" },
  showArchived: false,
  activeLocation: "",
};

boot();

async function boot() {
  try {
    const [data, catalogs] = await Promise.all([loadData(), loadCatalogs()]);
    state = { ...state, data, catalogs };
    render();
    registerServiceWorker();
  } catch (error) {
    app.innerHTML = `<main class="empty-state danger"><h1>HaulDeck could not start</h1><p>${escapeHtml(error.message)}</p></main>`;
  }
}

function createEmptyData() {
  return {
    schemaVersion: SCHEMA_VERSION,
    sessions: [],
    settings: { theme: "dark", quantityLabel: "SCU" },
  };
}

function createSession() {
  const now = new Date().toISOString();
  return {
    id: createId("session"),
    name: `Hauling Run ${new Date().toLocaleDateString()}`,
    status: "active",
    shipCapacityScu: 0,
    startLocation: "",
    createdAt: now,
    updatedAt: now,
    contracts: [],
    zones: DEFAULT_ZONES.map((name, index) => ({ id: createId("zone"), name, sortOrder: index })),
  };
}

function createContract(draft) {
  const now = new Date().toISOString();
  return normalizeContract({
    id: createId("contract"),
    contractName: clean(draft.contractName),
    pickupLocation: draft.pickupLocation.trim(),
    rewardAuec: numberOrUndefined(draft.rewardAuec),
    notes: clean(draft.notes),
    status: "planned",
    createdAt: now,
    updatedAt: now,
    items: draft.items.map(createCargoItem),
  });
}

function updateContract(contract, draft) {
  const existingItems = new Map((contract.items ?? []).map((item) => [item.id, item]));
  return normalizeContract({
    ...contract,
    contractName: clean(draft.contractName),
    pickupLocation: draft.pickupLocation.trim(),
    rewardAuec: numberOrUndefined(draft.rewardAuec),
    notes: clean(draft.notes),
    updatedAt: new Date().toISOString(),
    items: draft.items.map((item) => createCargoItem(item, existingItems.get(item.id))),
  });
}

function createCargoItem(draft, existing) {
  return normalizeCargoItem({
    id: draft.id || existing?.id || createId("item"),
    commodity: draft.commodity.trim(),
    dropoffLocation: draft.dropoffLocation.trim(),
    quantityScu: Number(draft.quantityScu),
    loadedScu: existing?.loadedScu ?? 0,
    unloadedScu: existing?.unloadedScu ?? 0,
    assignedZoneId: clean(draft.assignedZoneId) ?? existing?.assignedZoneId,
  });
}

function normalizeData(data) {
  const base = { ...createEmptyData(), ...(data ?? {}) };
  return {
    ...base,
    schemaVersion: SCHEMA_VERSION,
    sessions: (base.sessions ?? []).map((session) => ({
      ...session,
      shipCapacityScu: Math.max(0, Math.floor(Number(session.shipCapacityScu) || 0)),
      startLocation: String(session.startLocation ?? session.currentLocation ?? "").trim(),
      zones: session.zones?.length ? session.zones : DEFAULT_ZONES.map((name, index) => ({ id: createId("zone"), name, sortOrder: index })),
      contracts: (session.contracts ?? []).map(normalizeContract),
    })),
  };
}

function normalizeContract(contract) {
  const items = Array.isArray(contract.items) && contract.items.length
    ? contract.items.map(normalizeCargoItem)
    : [normalizeCargoItem({
        id: contract.itemId ?? createId("item"),
        commodity: contract.commodity ?? "",
        dropoffLocation: contract.dropoffLocation ?? "",
        quantityScu: contract.quantityScu ?? 1,
        loadedScu: contract.loadedScu ?? 0,
        unloadedScu: contract.unloadedScu ?? 0,
        assignedZoneId: contract.assignedZoneId,
      })];

  const quantityScu = items.reduce((total, item) => total + item.quantityScu, 0);
  const loadedScu = items.reduce((total, item) => total + item.loadedScu, 0);
  const unloadedScu = items.reduce((total, item) => total + item.unloadedScu, 0);
  const normalized = { ...contract, items, quantityScu, loadedScu, unloadedScu };
  return { ...normalized, status: deriveStatus(normalized) };
}

function normalizeCargoItem(item) {
  const quantityScu = clamp(Number(item.quantityScu), 1);
  const loadedScu = clamp(Number(item.loadedScu), 0, quantityScu);
  const unloadedScu = clamp(Number(item.unloadedScu), 0, loadedScu);
  return {
    id: item.id || createId("item"),
    commodity: String(item.commodity ?? "").trim(),
    dropoffLocation: String(item.dropoffLocation ?? "").trim(),
    quantityScu,
    loadedScu,
    unloadedScu,
    assignedZoneId: clean(item.assignedZoneId),
  };
}

function deriveStatus(contract) {
  if (contract.status === "cancelled") return "cancelled";
  if (contract.items.length && contract.items.every((item) => item.unloadedScu >= item.quantityScu)) return "delivered";
  if (contract.items.some((item) => item.unloadedScu > 0)) return "partial_unloaded";
  if (contract.items.length && contract.items.every((item) => item.loadedScu >= item.quantityScu)) return "loaded";
  if (contract.items.some((item) => item.loadedScu > 0)) return "partial_loaded";
  return "planned";
}

function validateDraft(draft) {
  const errors = [];
  if (!draft.pickupLocation.trim()) errors.push("Pickup location is required.");
  if (!draft.items.length) errors.push("Add at least one cargo line.");
  draft.items.forEach((item, index) => {
    const label = `Line ${index + 1}`;
    if (!item.dropoffLocation.trim()) errors.push(`${label}: drop-off location is required.`);
    if (!item.commodity.trim()) errors.push(`${label}: commodity is required.`);
    if (!Number.isFinite(Number(item.quantityScu)) || Number(item.quantityScu) <= 0) {
      errors.push(`${label}: quantity must be greater than zero.`);
    }
  });
  if (draft.rewardAuec && Number(draft.rewardAuec) < 0) errors.push("Reward must be positive.");
  return errors;
}

function render() {
  const session = getCurrentSession();
  app.innerHTML = `
    <div class="app-shell">
      ${renderTopbar(session)}
      <main>${renderScreen(session)}</main>
    </div>
  `;
  bindEvents();
}

function renderTopbar(session) {
  return `
    <header class="topbar">
      <button class="ghost icon-button" data-nav="home" aria-label="Home">HD</button>
      <div>
        <p class="eyebrow">HaulDeck</p>
        <h1>${escapeHtml(session?.name ?? "Cargo runs")}</h1>
      </div>
    </header>
  `;
}

function renderScreen(session) {
  if (state.screen.name === "home") return renderHome();
  if (!session) return `<section class="empty-state"><h1>Session not found</h1><button class="primary" data-nav="home">Back home</button></section>`;
  if (state.screen.name === "dashboard") return renderDashboard(session);
  if (state.screen.name === "contract") return renderContractForm(session);
  if (state.screen.name === "load") return renderLoadMode(session);
  if (state.screen.name === "zones") return renderZones(session);
  return "";
}

function renderHome() {
  const sessions = state.data.sessions.filter((session) => state.showArchived || session.status === "active");
  return `
    <section class="hero-panel">
      <div>
        <p class="eyebrow">Offline cargo run organizer</p>
        <h2>Stack contracts without mixing cargo.</h2>
      </div>
      <button class="primary" data-action="new-session">New run</button>
    </section>
    <section class="toolbar">
      <label class="toggle"><input type="checkbox" data-action="toggle-archived" ${state.showArchived ? "checked" : ""}><span>Show archived</span></label>
    </section>
    ${sessions.length ? `<section class="stack">${sessions.map(renderSessionCard).join("")}</section>` : `
      <section class="empty-state"><h2>No hauling runs yet</h2><p>Create a run when you start stacking contracts.</p></section>
    `}
  `;
}

function renderSessionCard(session) {
  return `
    <article class="card session-card">
      <div>
        <p class="eyebrow">${session.status}</p>
        <h3>${escapeHtml(session.name)}</h3>
        <p class="muted">${session.contracts.length} contracts · ${allCargo(session).length} cargo lines · Updated ${new Date(session.updatedAt).toLocaleString()}</p>
      </div>
      <div class="button-row">
        <button class="primary" data-nav="dashboard" data-session-id="${session.id}">Open</button>
        <button class="danger-button" data-action="delete-session" data-session-id="${session.id}">Delete</button>
      </div>
    </article>
  `;
}

function renderDashboard(session) {
  const active = session.contracts.filter((contract) => contract.status !== "cancelled");
  const cargo = allCargo(session).filter(({ contract }) => contract.status !== "cancelled");
  const visibleContracts = getVisibleContractsForCurrentLocation(session);
  const activeContracts = visibleContracts.filter((contract) => !isCompletedContract(contract));
  const completedContracts = visibleContracts.filter(isCompletedContract);
  const totalScu = cargo.reduce((total, row) => total + row.item.quantityScu, 0);
  const loadedScu = cargo.reduce((total, row) => total + row.item.loadedScu, 0);
  const unloadedScu = cargo.reduce((total, row) => total + row.item.unloadedScu, 0);
  const totalReward = active.reduce((total, contract) => total + (contract.rewardAuec ?? 0), 0);
  const destinations = new Set(cargo.map((row) => row.item.dropoffLocation)).size;
  const warnings = getWarnings(session);
  return `
    <section class="card form-card">
      <label>Hauling run name<input value="${escapeAttribute(session.name)}" data-action="rename-session" data-session-id="${session.id}"></label>
      ${renderStartLocationField(session)}
      <div class="field-group">
        <label for="ship-capacity">Ship max SCU</label>
        <input id="ship-capacity" value="${escapeAttribute(session.shipCapacityScu || "")}" inputmode="numeric" data-action="ship-capacity" data-session-id="${session.id}" placeholder="Optional" aria-describedby="ship-capacity-hint">
        <span id="ship-capacity-hint" class="field-hint">Keep a safety margin: combo contracts and container sizes may not pack perfectly.</span>
      </div>
      <button class="primary full-width deck-primary-action" data-nav="contract" data-session-id="${session.id}">Add contract</button>
      <button class="secondary full-width deck-secondary-action" data-nav="zones" data-session-id="${session.id}">Zones</button>
    </section>
    ${renderRouteChecklist(session)}
    <section class="summary-grid">
      ${summary("Contracts", active.length)}
      ${summary("Lines", cargo.length)}
      ${summary("Total", `${totalScu} SCU`)}
      ${summary("Loaded", `${loadedScu} SCU`)}
      ${summary("Stops", destinations)}
      ${summary("Reward", `${totalReward.toLocaleString()} aUEC`)}
    </section>
    ${renderWarnings(warnings)}
    ${session.contracts.length ? `<h3 class="section-title">Contracts</h3>` : ""}
    ${activeContracts.length ? `<section class="stack">${activeContracts.map((contract) => renderContractCard(session, contract)).join("")}</section>` : session.contracts.length ? `
      <section class="empty-state compact-empty"><h2>No active contracts</h2><p>Completed contracts are tucked away below.</p></section>
    ` : `
      <section class="empty-state"><h2>No contracts in this run</h2><p>Add the first contract after accepting it in-game.</p></section>
    `}
    ${completedContracts.length ? `
      <details class="card completed-contracts">
        <summary>Completed contracts · ${completedContracts.length}</summary>
        <section class="stack">${completedContracts.map((contract) => renderContractCard(session, contract)).join("")}</section>
      </details>
    ` : ""}
    <section class="card form-card run-management-card">
      <div class="button-row">
        <button class="secondary" data-action="toggle-archive" data-session-id="${session.id}">${session.status === "active" ? "Archive run" : "Restore run"}</button>
        <button class="danger-button" data-action="delete-session" data-session-id="${session.id}">Delete run</button>
      </div>
    </section>
  `;
}

function renderStartLocationField(session) {
  const locations = getSessionLocations(session);
  return `
    <div class="current-location-card">
      ${selectField("Start location", "", session.startLocation, locations, "Select route start", "current-location", { sessionId: session.id })}
      ${session.startLocation ? `<button class="secondary" data-action="clear-current-location" data-session-id="${session.id}">Clear</button>` : ""}
    </div>
  `;
}

function renderContractCard(session, contract) {
  const destinations = [...new Set(contract.items.map((item) => item.dropoffLocation))];
  return `
    <article class="card contract ${contract.status}">
      <div class="card-header">
        <div>
          <p class="eyebrow">${escapeHtml(contract.pickupLocation)} -> ${destinations.map(escapeHtml).join(", ")}</p>
          <h3>${escapeHtml(contract.contractName || `${contract.items.length} cargo line${contract.items.length === 1 ? "" : "s"}`)}</h3>
        </div>
        <span class="pill">${contract.quantityScu} SCU</span>
      </div>
      <div class="cargo-lines">
        ${contract.items.map((item) => `
          <div class="cargo-line-summary">
            <span><strong>${escapeHtml(item.commodity)}</strong><br>${escapeHtml(item.dropoffLocation)}</span>
            <span>${item.quantityScu} SCU<br><span class="muted">${item.loadedScu}/${item.quantityScu} loaded</span></span>
            <span>${escapeHtml(zoneName(session, item.assignedZoneId))}</span>
          </div>
        `).join("")}
      </div>
      <div class="meta-grid">
        <span>Loaded <strong>${contract.loadedScu}/${contract.quantityScu}</strong></span>
        <span>Unloaded <strong>${contract.unloadedScu}/${contract.quantityScu}</strong></span>
        <span>Status <strong>${contract.status.replaceAll("_", " ")}</strong></span>
        <span>Lines <strong>${contract.items.length}</strong></span>
      </div>
      ${contract.notes ? `<p class="muted">${escapeHtml(contract.notes)}</p>` : ""}
      <div class="button-row">
        <button class="secondary" data-nav="contract" data-session-id="${session.id}" data-contract-id="${contract.id}">Edit</button>
        <button class="secondary" data-action="duplicate-contract" data-session-id="${session.id}" data-contract-id="${contract.id}">Duplicate</button>
        <button class="danger-button" data-action="delete-contract" data-session-id="${session.id}" data-contract-id="${contract.id}">Delete</button>
      </div>
    </article>
  `;
}

function renderContractForm(session) {
  const contract = state.screen.contractId ? session.contracts.find((item) => item.id === state.screen.contractId) : null;
  const preset = state.screen.preset ?? {};
  const draft = {
    contractName: preset.contractName ?? contract?.contractName ?? "",
    pickupLocation: preset.pickupLocation ?? contract?.pickupLocation ?? session.startLocation ?? "",
    rewardAuec: preset.rewardAuec ?? contract?.rewardAuec ?? "",
    notes: preset.notes ?? contract?.notes ?? "",
    items: (preset.items ?? contract?.items ?? [emptyCargoDraft()]).map((item) => ({ ...item })),
  };
  return `
    <section class="card form-card">
      <div class="card-header"><div><p class="eyebrow">${contract ? "Edit contract" : "New contract"}</p><h2>${contract ? "Tune the details" : "Add cargo"}</h2></div></div>
      <div id="form-errors"></div>
      <form id="contract-form" class="form-grid" data-session-id="${session.id}" data-contract-id="${contract?.id ?? ""}">
        ${field("Pickup", "pickupLocation", draft.pickupLocation, "locations")}
        ${field("Reward aUEC", "rewardAuec", draft.rewardAuec, "", "text", "0", "Optional", "", "numeric")}
        ${field("Contract name/reference", "contractName", draft.contractName, "", "text", "", "Optional", "wide")}
        <label class="wide">Notes<textarea name="notes" rows="3" placeholder="Optional">${escapeHtml(draft.notes)}</textarea></label>
        <section class="wide cargo-lines-editor">
          <div class="card-header">
            <div>
              <p class="eyebrow">Cargo lines</p>
              <h3>Commodities and destinations</h3>
              <p class="muted">Add as many cargo lines as this contract contains. Pickup stays shared.</p>
            </div>
          </div>
          ${draft.items.map((item, index) => renderCargoLineEditor(session, item, index, draft.items.length)).join("")}
          <button class="secondary add-line-button" type="button" data-action="add-cargo-line" aria-label="Add cargo line" title="Add cargo line">+</button>
        </section>
      </form>
      <div class="button-row sticky-actions">
        <button class="secondary" data-nav="dashboard" data-session-id="${session.id}">Cancel</button>
        <button class="primary" data-action="save-contract" data-session-id="${session.id}" data-contract-id="${contract?.id ?? ""}">Save contract</button>
      </div>
    </section>
  `;
}

function renderRouteChecklist(session) {
  const stops = getRouteChecklist(session, {
    startLocation: session.startLocation,
    zoneName,
    getLocationSystem,
  });
  if (!stops.length) return "";
  const showSystems = new Set(stops.map((stop) => getLocationSystem(stop.name)).filter(Boolean)).size > 1;

  return `
    <section class="card destinations-card">
      <div class="card-header">
        <div>
          <p class="eyebrow">Route</p>
          <h2>Stop plan</h2>
        </div>
        <span class="pill">${stops.length} stop${stops.length === 1 ? "" : "s"}</span>
      </div>
      <div class="destination-list">
        ${stops.map((stop) => `
          <article class="destination-row ${stop.overCapacity ? "over-capacity" : ""}">
            <div class="stop-number">${stop.sequence}</div>
            <div>
              <button class="link-button destination-link" data-action="set-current-location" data-location="${escapeAttribute(stop.name)}">${escapeHtml(formatRouteLocation(stop.name, showSystems))}</button>
              <p class="muted">${stop.statusLabel} · ${stop.lines} line${stop.lines === 1 ? "" : "s"} · ${stop.commodities.map(escapeHtml).join(", ")}</p>
              ${stop.zones.length ? `<p class="muted">Zones: ${stop.zones.map(escapeHtml).join(", ")}</p>` : ""}
              ${stop.note ? `<p class="dependency-note">${escapeHtml(stop.note)}</p>` : ""}
            </div>
            <div class="destination-metrics">
              <strong>${stop.workScu} SCU</strong>
              ${stop.unloadScu ? `<span>${stop.unloadScu} unload</span>` : ""}
              ${stop.loadScu ? `<span>${stop.loadScu} load</span>` : ""}
              <span>On board after: ${stop.onboardAfterScu} SCU</span>
              ${stop.zoneLimit ? `<span>Destinations aboard: ${stop.onboardDestinationsAfter}/${stop.zoneLimit}</span>` : ""}
              ${stop.capacityScu ? `<span class="${stop.overCapacity ? "capacity-danger" : "capacity-ok"}">Max ${stop.capacityScu}</span>` : ""}
            </div>
            <button class="primary full-width destination-action" data-action="go-actions" data-location="${escapeAttribute(stop.name)}">I am here now</button>
          </article>
        `).join("")}
      </div>
    </section>
  `;
}

function renderCargoLineEditor(session, item, index, itemCount) {
  return `
    <article class="cargo-line-editor" data-item-index="${index}">
      <div class="card-header">
        <p class="eyebrow">Line ${index + 1}</p>
        <button class="danger-button" type="button" data-action="remove-cargo-line" data-item-index="${index}" ${itemCount <= 1 ? "disabled" : ""}>Remove</button>
      </div>
      <input type="hidden" name="itemId" value="${escapeAttribute(item.id ?? "")}">
      ${field("Drop-off", "itemDropoffLocation", item.dropoffLocation, "locations")}
      ${field("Commodity", "itemCommodity", item.commodity, "commodities")}
      ${field("Quantity SCU", "itemQuantityScu", item.quantityScu ?? 1, "", "text", "1", "", "", "numeric")}
      <label>Zone<select name="itemAssignedZoneId">
        <option value="">Auto assign</option>
        ${session.zones.map((zone) => `<option value="${zone.id}" ${zone.id === item.assignedZoneId ? "selected" : ""}>${escapeHtml(zone.name)}</option>`).join("")}
      </select></label>
    </article>
  `;
}

function renderLoadMode(session) {
  return renderActionsMode(session);
}

function renderActionsMode(session) {
  const actionLocation = getActionLocation();
  const unloadRows = getUnloadRows(session);
  const loadRows = getLoadRows(session);
  const groups = loadRows.reduce((map, row) => {
    const key = row.contract.id;
    map[key] ??= { contract: row.contract, rows: [] };
    map[key].rows.push(row);
    return map;
  }, {});
  return `
    <section class="mode-header"><div><p class="eyebrow">Location actions</p><h2>${escapeHtml(actionLocation || "Choose a stop")}</h2></div><button class="secondary" data-nav="dashboard" data-session-id="${session.id}">Done</button></section>
    ${unloadRows.length ? `
      <section class="stack">
        <h3 class="section-title">Unload here first</h3>
        ${unloadRows.map((row) => renderProgressCard(session, row.contract, row.item, "unload")).join("")}
      </section>
    ` : actionLocation ? `<section class="empty-state compact-empty"><h2>No unload here</h2><p>Nothing loaded is due at this location.</p></section>` : ""}
    ${Object.values(groups).length ? `
      <article class="notice info cargo-elevator-hint">
        <span>Hint</span>
        <p>Pull one contract at a time from the cargo elevator, or only combine contracts that share the same destination. Station inventory shows totals, so mixed destinations quickly become hard to separate.</p>
      </article>
    ` : ""}
    ${Object.values(groups).length ? Object.values(groups).map(({ contract, rows }) => `
      <section class="stack action-contract-group">
        <div class="contract-group-heading">
          <h3 class="section-title">Load contract: ${escapeHtml(contract.contractName || contract.pickupLocation)}</h3>
          <p class="muted">${escapeHtml(formatCommodityTotals(rows))}</p>
        </div>
        ${rows.map((row) => renderProgressCard(session, row.contract, row.item, "load")).join("")}
      </section>
    `).join("") : `<section class="empty-state compact-empty"><h2>No load here</h2><p>${actionLocation ? "Nothing needs to be picked up at this location." : "Select a stop from the stop plan."}</p></section>`}
  `;
}

function renderProgressCard(session, contract, item, mode) {
  const isLoad = mode === "load";
  const value = isLoad ? item.loadedScu : item.unloadedScu;
  const max = isLoad ? item.quantityScu : item.loadedScu;
  const label = isLoad ? "Loaded SCU" : "Unloaded SCU";
  const zone = zoneName(session, item.assignedZoneId);
  return `
    <article class="card contract ${contract.status}">
      <div class="card-header">
        <div>
          <p class="eyebrow">${isLoad ? `To ${escapeHtml(item.dropoffLocation)}` : `From ${escapeHtml(contract.pickupLocation)}`}</p>
          <h3>${escapeHtml(isLoad ? item.commodity : `Unload zone ${zone}`)}</h3>
          ${isLoad ? "" : `<p class="muted">${escapeHtml(item.commodity)} · ${escapeHtml(item.loadedScu - item.unloadedScu)} SCU for ${escapeHtml(item.dropoffLocation)}</p>`}
          ${contract.contractName ? `<p class="muted">${escapeHtml(contract.contractName)}</p>` : ""}
        </div>
        <span class="pill">${escapeHtml(zone)}</span>
      </div>
      <div class="progress-line">
        <span>${label.replace(" SCU", "")} ${value} / ${Math.max(max, isLoad ? 1 : 0)} SCU</span>
        <progress value="${value}" max="${Math.max(max, 1)}"></progress>
      </div>
      <div class="stepper">
        <button data-action="step-${mode}" data-contract-id="${contract.id}" data-item-id="${item.id}" data-delta="-1">-</button>
        <label><span>${label}</span><input type="number" min="0" max="${max}" value="${value}" data-action="set-${mode}" data-contract-id="${contract.id}" data-item-id="${item.id}"></label>
        <button data-action="step-${mode}" data-contract-id="${contract.id}" data-item-id="${item.id}" data-delta="1">+</button>
      </div>
      <button class="primary full-width" ${!isLoad && item.loadedScu === 0 ? "disabled" : ""} data-action="max-${mode}" data-contract-id="${contract.id}" data-item-id="${item.id}">
        Mark fully ${isLoad ? "loaded" : "unloaded"}
      </button>
    </article>
  `;
}

function renderZones(session) {
  const cargo = allCargo(session);
  return `
    <section class="mode-header"><div><p class="eyebrow">Zones</p><h2>Keep destination stacks separate.</h2></div><button class="secondary" data-nav="dashboard" data-session-id="${session.id}">Done</button></section>
    <section class="toolbar"><button class="primary" data-action="auto-assign" data-session-id="${session.id}">Auto assign</button></section>
    <section class="stack">
      ${session.zones.map((zone) => `<article class="card form-card"><label>Zone name<input value="${escapeAttribute(zone.name)}" data-action="rename-zone" data-zone-id="${zone.id}"></label></article>`).join("")}
    </section>
    <section class="stack">
      <h3 class="section-title">Cargo line assignments</h3>
      ${cargo.map(({ contract, item }) => `
        <article class="card assignment-card">
          <div>
            <p class="eyebrow">${escapeHtml(item.dropoffLocation)}</p>
            <h3>${escapeHtml(item.commodity)}</h3>
            <p class="muted">${escapeHtml(contract.pickupLocation)} · Current: ${escapeHtml(zoneName(session, item.assignedZoneId))}</p>
          </div>
          <select data-action="assign-zone" data-contract-id="${contract.id}" data-item-id="${item.id}">
            <option value="">Unassigned</option>
            ${session.zones.map((zone) => `<option value="${zone.id}" ${zone.id === item.assignedZoneId ? "selected" : ""}>${escapeHtml(zone.name)}</option>`).join("")}
          </select>
        </article>
      `).join("")}
    </section>
  `;
}

function bindEvents() {
  app.querySelectorAll("[data-nav]").forEach((element) => {
    element.addEventListener("click", () => {
      const name = element.dataset.nav;
      const sessionId = element.dataset.sessionId;
      const contractId = element.dataset.contractId;
      state.screen = name === "home" ? { name } : { name, sessionId, contractId: contractId || undefined };
      render();
      if (name === "contract") window.scrollTo({ top: 0, behavior: "instant" });
    });
  });

  app.querySelectorAll("[data-action]").forEach((element) => {
    const action = element.dataset.action;
    if (action === "new-session") element.addEventListener("click", createNewSession);
    if (action === "toggle-archived") element.addEventListener("change", (event) => {
      state.showArchived = event.currentTarget.checked;
      render();
    });
    if (action === "delete-session") element.addEventListener("click", () => deleteSession(element.dataset.sessionId));
    if (action === "toggle-archive") element.addEventListener("click", () => toggleArchive(element.dataset.sessionId));
    if (action === "rename-session") element.addEventListener("change", (event) => renameSession(element.dataset.sessionId, event.currentTarget.value));
    if (action === "ship-capacity") element.addEventListener("change", (event) => updateShipCapacity(element.dataset.sessionId, event.currentTarget.value));
    if (action === "ship-capacity") element.addEventListener("blur", (event) => updateShipCapacity(element.dataset.sessionId, event.currentTarget.value));
    if (action === "ship-capacity") element.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        updateShipCapacity(element.dataset.sessionId, event.currentTarget.value);
      }
    });
    if (action === "save-contract") element.addEventListener("click", () => saveContract(element.dataset.sessionId, element.dataset.contractId));
    if (action === "duplicate-contract") element.addEventListener("click", () => duplicateContract(element.dataset.sessionId, element.dataset.contractId));
    if (action === "delete-contract") element.addEventListener("click", () => deleteContract(element.dataset.sessionId, element.dataset.contractId));
    if (action === "add-cargo-line") element.addEventListener("click", addCargoLine);
    if (action === "remove-cargo-line") element.addEventListener("click", () => removeCargoLine(Number(element.dataset.itemIndex)));
    if (action?.startsWith("step-")) element.addEventListener("click", () => stepProgress(element.dataset.contractId, element.dataset.itemId, action.replace("step-", ""), Number(element.dataset.delta)));
    if (action?.startsWith("set-")) element.addEventListener("change", (event) => setProgress(element.dataset.contractId, element.dataset.itemId, action.replace("set-", ""), Number(event.currentTarget.value)));
    if (action?.startsWith("max-")) element.addEventListener("click", () => maxProgress(element.dataset.contractId, element.dataset.itemId, action.replace("max-", "")));
    if (action === "current-location") element.addEventListener("change", (event) => {
      setStartLocation(element.dataset.sessionId, event.currentTarget.value);
    });
    if (action === "current-location") element.addEventListener("blur", (event) => {
      setStartLocation(element.dataset.sessionId, event.currentTarget.value, false);
    });
    if (action === "current-location") element.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        setStartLocation(element.dataset.sessionId, event.currentTarget.value);
      }
    });
    if (action === "clear-current-location") element.addEventListener("click", () => {
      setStartLocation(element.dataset.sessionId, "");
      state.activeLocation = "";
    });
    if (action === "set-current-location") element.addEventListener("click", () => {
      setActiveLocation(element.dataset.location);
    });
    if (action === "go-actions") element.addEventListener("click", () => {
      setActiveLocation(element.dataset.location, false);
      state.screen = { name: "load", sessionId: getCurrentSession()?.id };
      render();
    });
    if (action === "auto-assign") element.addEventListener("click", () => saveSession(autoAssignZones(getCurrentSession())));
    if (action === "rename-zone") element.addEventListener("change", (event) => renameZone(element.dataset.zoneId, event.currentTarget.value));
    if (action === "assign-zone") element.addEventListener("change", (event) => assignZone(element.dataset.contractId, element.dataset.itemId, event.currentTarget.value));
  });

}

async function createNewSession() {
  const session = createSession();
  await persist({ ...state.data, sessions: [session, ...state.data.sessions] });
  state.screen = { name: "dashboard", sessionId: session.id };
  render();
}

async function saveSession(session) {
  await persist({ ...state.data, sessions: state.data.sessions.map((item) => item.id === session.id ? normalizeSession(session) : item) });
  render();
}

async function deleteSession(sessionId) {
  if (!confirm("Delete this hauling session? This cannot be undone.")) return;
  await persist({ ...state.data, sessions: state.data.sessions.filter((session) => session.id !== sessionId) });
  state.screen = { name: "home" };
  render();
}

async function toggleArchive(sessionId) {
  const session = state.data.sessions.find((item) => item.id === sessionId);
  if (!session) return;
  const now = new Date().toISOString();
  await saveSession({
    ...session,
    status: session.status === "active" ? "archived" : "active",
    archivedAt: session.status === "active" ? now : undefined,
    updatedAt: now,
  });
}

async function renameSession(sessionId, name) {
  const session = state.data.sessions.find((item) => item.id === sessionId);
  if (!session || !name.trim()) return;
  await saveSession({ ...session, name: name.trim(), updatedAt: new Date().toISOString() });
}

async function updateShipCapacity(sessionId, value) {
  const session = state.data.sessions.find((item) => item.id === sessionId);
  if (!session) return;
  const shipCapacityScu = Math.max(0, Math.floor(Number(value) || 0));
  await saveSession({ ...session, shipCapacityScu, updatedAt: new Date().toISOString() });
}

async function setStartLocation(sessionId, value, shouldRender = true) {
  const session = state.data.sessions.find((item) => item.id === sessionId);
  if (!session) return;
  const startLocation = value.trim();
  if (session.startLocation === startLocation) return;
  await persist({
    ...state.data,
    sessions: state.data.sessions.map((item) => item.id === session.id
      ? normalizeSession({ ...item, startLocation, updatedAt: new Date().toISOString() })
      : item),
  });
  if (shouldRender) render();
}

function addCargoLine() {
  const draft = collectDraftFromForm();
  const previous = draft.items[draft.items.length - 1] ?? emptyCargoDraft();
  draft.items.push({ ...emptyCargoDraft(), dropoffLocation: previous.dropoffLocation });
  state.screen = { ...state.screen, preset: draft };
  render();
}

function removeCargoLine(index) {
  const draft = collectDraftFromForm();
  if (draft.items.length <= 1) return;
  draft.items.splice(index, 1);
  state.screen = { ...state.screen, preset: draft };
  render();
}

async function saveContract(sessionId, contractId) {
  const errorsElement = app.querySelector("#form-errors");
  const session = state.data.sessions.find((item) => item.id === sessionId);
  if (!session) return;

  const draft = collectDraftFromForm();
  const errors = validateDraft(draft);
  if (errors.length) {
    errorsElement.innerHTML = `<div class="notice danger"><span>Fix</span><p>${escapeHtml(errors.join(" "))}</p></div>`;
    return;
  }

  const contracts = contractId
    ? session.contracts.map((contract) => contract.id === contractId ? updateContract(contract, draft) : contract)
    : [createContract(draft), ...session.contracts];

  await saveSession(autoAssignZones({ ...session, contracts, updatedAt: new Date().toISOString() }));
  state.screen = { name: "dashboard", sessionId };
  render();
}

async function duplicateContract(sessionId, contractId) {
  const session = state.data.sessions.find((item) => item.id === sessionId);
  const contract = session?.contracts.find((item) => item.id === contractId);
  if (!session || !contract) return;
  state.screen = {
    name: "contract",
    sessionId,
    preset: { ...contract, items: contract.items.map((item) => ({ ...item, id: "" })) },
  };
  render();
}

async function deleteContract(sessionId, contractId) {
  if (!confirm("Delete this contract?")) return;
  const session = state.data.sessions.find((item) => item.id === sessionId);
  if (!session) return;
  await saveSession({
    ...session,
    contracts: session.contracts.filter((contract) => contract.id !== contractId),
    updatedAt: new Date().toISOString(),
  });
}

async function setProgress(contractId, itemId, mode, value) {
  const session = getCurrentSession();
  if (!session) return;
  const contracts = session.contracts.map((contract) => {
    if (contract.id !== contractId) return contract;
    return normalizeContract({
      ...contract,
      items: contract.items.map((item) => {
        if (item.id !== itemId) return item;
        const patch = mode === "load" ? { loadedScu: value } : { unloadedScu: value };
        return normalizeCargoItem({ ...item, ...patch });
      }),
      updatedAt: new Date().toISOString(),
    });
  });
  await saveSession({ ...session, contracts, updatedAt: new Date().toISOString() });
}

function stepProgress(contractId, itemId, mode, delta) {
  const row = findCargoLine(contractId, itemId);
  if (!row) return;
  const value = mode === "load" ? row.item.loadedScu : row.item.unloadedScu;
  setProgress(contractId, itemId, mode, value + delta);
}

function maxProgress(contractId, itemId, mode) {
  const row = findCargoLine(contractId, itemId);
  if (!row) return;
  setProgress(contractId, itemId, mode, mode === "load" ? row.item.quantityScu : row.item.loadedScu);
}

async function renameZone(zoneId, name) {
  const session = getCurrentSession();
  if (!session || !name.trim()) return;
  await saveSession({
    ...session,
    zones: session.zones.map((zone) => zone.id === zoneId ? { ...zone, name: name.trim() } : zone),
    updatedAt: new Date().toISOString(),
  });
}

async function assignZone(contractId, itemId, zoneId) {
  const session = getCurrentSession();
  if (!session) return;
  await saveSession({
    ...session,
    contracts: session.contracts.map((contract) => contract.id === contractId ? normalizeContract({
      ...contract,
      items: contract.items.map((item) => item.id === itemId ? { ...item, assignedZoneId: zoneId || undefined } : item),
    }) : contract),
    updatedAt: new Date().toISOString(),
  });
}

function autoAssignZones(session) {
  const destinationToZone = new Map();
  const usedZones = new Set();
  const contracts = session.contracts.map((contract) => {
    const items = contract.items.map((item) => {
      if (item.assignedZoneId) {
        destinationToZone.set(item.dropoffLocation, item.assignedZoneId);
        usedZones.add(item.assignedZoneId);
      }
      return item;
    });
    return { ...contract, items };
  });
  const availableZones = session.zones.filter((zone) => !usedZones.has(zone.id));
  const assignedContracts = contracts.map((contract) => normalizeContract({
    ...contract,
    items: contract.items.map((item) => {
      if (item.assignedZoneId) return item;
      const existing = destinationToZone.get(item.dropoffLocation);
      if (existing) return { ...item, assignedZoneId: existing };
      const nextZone = availableZones.shift();
      if (!nextZone) return item;
      destinationToZone.set(item.dropoffLocation, nextZone.id);
      return { ...item, assignedZoneId: nextZone.id };
    }),
  }));
  return { ...session, contracts: assignedContracts, updatedAt: new Date().toISOString() };
}

function getWarnings(session) {
  const warnings = [];
  const cargo = allCargo(session).filter(({ contract }) => contract.status !== "cancelled");
  const unassigned = cargo.filter((row) => !row.item.assignedZoneId);
  if (unassigned.length) warnings.push({ level: "warning", message: `${unassigned.length} cargo line${unassigned.length === 1 ? "" : "s"} have unassigned cargo.` });
  const zoneLimitedStops = getRouteChecklist(session, { startLocation: session.startLocation, zoneName, getLocationSystem }).filter((stop) => stop.zoneLimited);
  if (zoneLimitedStops.length) warnings.push({ level: "info", message: `Route adjusted for ${session.zones.length} cargo zones. Add one more cargo zone for further optimized routing for this trip.` });
  const commodityDestinations = new Map();
  cargo.forEach(({ item }) => {
    const set = commodityDestinations.get(item.commodity) ?? new Set();
    set.add(item.dropoffLocation);
    commodityDestinations.set(item.commodity, set);
  });
  commodityDestinations.forEach((set, commodity) => {
    if (set.size > 1) warnings.push({ level: "warning", message: `${commodity} appears in multiple destinations. Keep those stacks physically separated.` });
  });
  getDestinationSummaries(session).forEach((destination) => {
    const zones = destination.zones.filter((zone) => zone !== "Unassigned");
    if (zones.length > 1) {
      warnings.push({ level: "warning", message: `${destination.name} is assigned to multiple zones. Keep one destination in one zone where possible.` });
    }
  });
  return warnings;
}

function renderWarnings(warnings) {
  if (!warnings.length) return "";
  return `<section class="stack">${warnings.map((warning) => `<article class="notice ${warning.level}"><span>${warning.level}</span><p>${escapeHtml(warning.message)}</p></article>`).join("")}</section>`;
}

async function loadCatalogs() {
  try {
    const [locations, commodities] = await Promise.all([
      fetch("./public/data/locations.json").then((response) => response.json()),
      fetch("./public/data/commodities.json").then((response) => response.json()),
    ]);
    const normalizedLocations = normalizeLocationCatalog(locations);
    return {
      locations: normalizedLocations,
      locationOptions: getLocationOptions(normalizedLocations),
      locationSystems: getLocationSystems(normalizedLocations),
      commodities: commodities.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" })),
    };
  } catch {
    return { locations: [], locationOptions: [], locationSystems: new Map(), commodities: [] };
  }
}

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
    };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
}

async function loadData() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).get(DATA_KEY);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(normalizeData(request.result));
  });
}

async function persist(data) {
  state.data = normalizeData(data);
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).put(state.data, DATA_KEY);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
}

function registerServiceWorker() {
  if ("serviceWorker" in navigator && location.protocol !== "file:") {
    navigator.serviceWorker.register("./service-worker.js").catch(() => {});
  }
}

function collectDraftFromForm() {
  const form = app.querySelector("#contract-form");
  if (!form) return { pickupLocation: "", items: [emptyCargoDraft()] };
  const rows = [...form.querySelectorAll(".cargo-line-editor")];
  return {
    pickupLocation: form.elements.pickupLocation?.value ?? "",
    rewardAuec: form.elements.rewardAuec?.value ?? "",
    contractName: form.elements.contractName?.value ?? "",
    notes: form.elements.notes?.value ?? "",
    items: rows.map((row) => ({
      id: row.querySelector('[name="itemId"]')?.value ?? "",
      dropoffLocation: row.querySelector('[name="itemDropoffLocation"]')?.value ?? "",
      commodity: row.querySelector('[name="itemCommodity"]')?.value ?? "",
      quantityScu: row.querySelector('[name="itemQuantityScu"]')?.value ?? "1",
      assignedZoneId: row.querySelector('[name="itemAssignedZoneId"]')?.value ?? "",
    })),
  };
}

function normalizeLocationCatalog(locations) {
  return locations
    .map((location) => typeof location === "string"
      ? { name: location, system: "Stanton", aliases: [] }
      : { name: location.name, system: location.system || "", aliases: location.aliases ?? [] })
    .filter((location) => location.name)
    .sort((a, b) => a.system.localeCompare(b.system) || a.name.localeCompare(b.name));
}

function getLocationOptions(locations) {
  return locations
    .map((location) => location.name)
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
}

function getLocationSystems(locations) {
  const systems = new Map();
  locations.forEach((location) => {
    systems.set(location.name.toLowerCase(), location.system);
    location.aliases?.forEach((alias) => systems.set(alias.toLowerCase(), location.system));
  });
  return systems;
}

function getLocationSystem(location) {
  return state.catalogs.locationSystems.get(String(location ?? "").toLowerCase()) ?? "";
}

function formatRouteLocation(location, showSystem = false) {
  const system = getLocationSystem(location);
  return showSystem && system ? `${system} > ${location}` : location;
}

function field(label, name, value, list = "", type = "text", min = "", placeholder = "", className = "", inputmode = "") {
  if (list === "locations") return selectField(label, name, value, state.catalogs.locationOptions, "Select location", "", {}, className);
  if (list === "commodities") return selectField(label, name, value, state.catalogs.commodities, "Select commodity", "", {}, className);
  return `<label class="${className}">${label}<input name="${name}" type="${type}" ${inputmode ? `inputmode="${inputmode}"` : ""} ${min ? `min="${min}"` : ""} ${list ? `list="${list}"` : ""} placeholder="${placeholder}" value="${escapeAttribute(value ?? "")}" autocomplete="off"></label>`;
}

function selectField(label, name, value, options, placeholder = "Select", action = "", dataset = {}, className = "") {
  const valueString = String(value ?? "");
  const normalizedOptions = [...new Set([...options, valueString].filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
  const dataAttributes = [
    action ? `data-action="${escapeAttribute(action)}"` : "",
    dataset.sessionId ? `data-session-id="${escapeAttribute(dataset.sessionId)}"` : "",
  ].filter(Boolean).join(" ");
  return `
    <label class="${className}">${label}
      <select ${name ? `name="${escapeAttribute(name)}"` : ""} ${dataAttributes}>
        <option value="">${escapeHtml(placeholder)}</option>
        ${normalizedOptions.map((option) => `<option value="${escapeAttribute(option)}" ${option === valueString ? "selected" : ""}>${escapeHtml(option)}</option>`).join("")}
      </select>
    </label>
  `;
}

function summary(label, value) {
  return `<article><span>${label}</span><strong>${value}</strong></article>`;
}

function getCurrentSession() {
  return state.screen.sessionId ? state.data.sessions.find((session) => session.id === state.screen.sessionId) : null;
}

function setActiveLocation(value, shouldRender = true) {
  const nextLocation = value.trim();
  if (state.activeLocation === nextLocation) return;
  state.activeLocation = nextLocation;
  if (shouldRender) render();
}

function getSessionLocations(session) {
  const locations = new Set();
  session.contracts.forEach((contract) => {
    if (contract.pickupLocation) locations.add(contract.pickupLocation);
    contract.items.forEach((item) => {
      if (item.dropoffLocation) locations.add(item.dropoffLocation);
    });
  });
  state.catalogs.locationOptions.forEach((location) => locations.add(location));
  return [...locations].sort();
}

function getLoadRows(session) {
  const actionLocation = getActionLocation();
  return allCargo(session).filter(({ contract, item }) =>
    contract.status !== "cancelled" &&
    item.loadedScu < item.quantityScu &&
    (!actionLocation || contract.pickupLocation === actionLocation),
  );
}

function formatCommodityTotals(rows) {
  const totals = rows.reduce((map, row) => {
    const remaining = row.item.quantityScu - row.item.loadedScu;
    map.set(row.item.commodity, (map.get(row.item.commodity) ?? 0) + remaining);
    return map;
  }, new Map());
  return [...totals.entries()]
    .sort(([a], [b]) => a.localeCompare(b, undefined, { sensitivity: "base" }))
    .map(([commodity, total]) => `${commodity}: ${total} SCU`)
    .join(" · ");
}

function getUnloadRows(session) {
  const actionLocation = getActionLocation();
  return allCargo(session).filter(({ contract, item }) =>
    contract.status !== "cancelled" &&
    item.loadedScu > item.unloadedScu &&
    item.dropoffLocation === actionLocation,
  );
}

function getVisibleContractsForCurrentLocation(session) {
  return session.contracts;
}

function isCompletedContract(contract) {
  return contract.status === "delivered" || contract.status === "cancelled";
}

function getActionLocation() {
  return state.activeLocation;
}

function normalizeSession(session) {
  return {
    ...session,
    shipCapacityScu: Math.max(0, Math.floor(Number(session.shipCapacityScu) || 0)),
    zones: session.zones?.length ? session.zones : DEFAULT_ZONES.map((name, index) => ({ id: createId("zone"), name, sortOrder: index })),
    contracts: (session.contracts ?? []).map(normalizeContract),
  };
}

function allCargo(session) {
  return session.contracts.flatMap((contract) => contract.items.map((item) => ({ contract, item })));
}

function getDestinationSummaries(session) {
  const summaries = new Map();
  allCargo(session)
    .filter(({ contract }) => contract.status !== "cancelled")
    .forEach(({ contract, item }) => {
      const summary = summaries.get(item.dropoffLocation) ?? {
        name: item.dropoffLocation,
        totalScu: 0,
        loadedScu: 0,
        unloadedScu: 0,
        lines: 0,
        commodities: new Set(),
        zones: new Set(),
        pickupsNeeded: new Set(),
      };
      summary.totalScu += item.quantityScu;
      summary.loadedScu += item.loadedScu;
      summary.unloadedScu += item.unloadedScu;
      summary.lines += 1;
      summary.commodities.add(item.commodity);
      summary.zones.add(zoneName(session, item.assignedZoneId));
      if (item.loadedScu < item.quantityScu) summary.pickupsNeeded.add(contract.pickupLocation);
      summaries.set(item.dropoffLocation, summary);
    });

  return [...summaries.values()].map((summary) => ({
    ...summary,
    commodities: [...summary.commodities],
    zones: [...summary.zones],
    pickupsNeeded: [...summary.pickupsNeeded],
    statusLabel: getDestinationStatus(summary),
    blocker: getDestinationBlocker(summary),
  }));
}

function getDestinationStatus(summary) {
  if (summary.unloadedScu >= summary.totalScu) return "Delivered";
  if (summary.loadedScu >= summary.totalScu) return "Ready to unload";
  if (summary.loadedScu > 0) return "Partially loaded";
  return "Needs pickup first";
}

function getDestinationBlocker(summary) {
  if (summary.loadedScu >= summary.totalScu) return "";
  return `Before this stop: load remaining cargo at ${[...summary.pickupsNeeded].join(", ")}.`;
}

function findCargoLine(contractId, itemId) {
  const session = getCurrentSession();
  const contract = session?.contracts.find((item) => item.id === contractId);
  const item = contract?.items.find((line) => line.id === itemId);
  return contract && item ? { contract, item } : null;
}

function emptyCargoDraft() {
  return { id: "", dropoffLocation: "", commodity: "", quantityScu: 1, assignedZoneId: "" };
}

function zoneName(session, zoneId) {
  return session.zones.find((zone) => zone.id === zoneId)?.name ?? "Unassigned";
}

function createId(prefix) {
  return `${prefix}_${crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`}`;
}

function clamp(value, min = 0, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function numberOrUndefined(value) {
  if (value === undefined || value === null || value === "") return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function clean(value) {
  const next = String(value ?? "").trim();
  return next || undefined;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeAttribute(value) {
  return escapeHtml(value);
}
