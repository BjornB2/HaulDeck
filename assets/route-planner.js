const JUMP_PENALTY = 1800;

export function getRouteChecklist(session, options = {}) {
  const {
    startLocation = "",
    zoneName = () => "Unassigned",
    getLocationSystem = () => "",
  } = options;
  const rows = allCargo(session)
    .filter(({ contract, item }) => contract.status !== "cancelled" && item.unloadedScu < item.quantityScu)
    .map(({ contract, item }, index) => ({
      index,
      contract,
      pickupLocation: contract.pickupLocation,
      item: { ...item },
    }));
  const stops = [];
  const visited = new Set();
  const capacityScu = getShipCapacityScu(session);
  let current = rows.length ? startLocation || findFirstWorkLocation(rows) : "";
  let startStop = rows.length && startLocation ? createStartStop(startLocation, getSimulatedOnboardScu(rows), capacityScu) : null;

  for (let guard = 0; guard < rows.length * 20 + 50 && current; guard += 1) {
    const onboardBeforeScu = getSimulatedOnboardScu(rows);
    const shouldDeferLoad = shouldDeferConstrainedPickup(current, rows, capacityScu, onboardBeforeScu);
    const stop = shouldDeferLoad ? null : buildRouteStop(session, current, rows, onboardBeforeScu, zoneName);
    const changed = shouldDeferLoad ? false : applyRouteStop(current, rows, capacityScu);

    if (stop && stop.workScu > 0) {
      if (startStop && stop.name === startStop.name && stops.length === 0 && visited.size === 0) {
        startStop = mergeStartStop(startStop, stop);
      } else {
        stops.push(stop);
      }
    }

    visited.add(current);
    const next = chooseNextRouteLocation(rows, current, visited, capacityScu, getLocationSystem);
    if (!changed && !next) break;
    current = next;
  }

  const allStops = startStop ? [startStop, ...stops] : stops;
  return allStops.map((stop, index) => ({
    ...stop,
    sequence: index + 1,
  }));
}

function allCargo(session) {
  return session.contracts.flatMap((contract) => contract.items.map((item) => ({ contract, item })));
}

function createStartStop(location, onboardAfterScu = 0, capacityScu = 0) {
  return {
    name: location,
    sequence: 0,
    statusLabel: "Start point",
    lines: 0,
    commodities: ["Starting location"],
    zones: [],
    unloadScu: 0,
    loadScu: 0,
    workScu: 0,
    onboardBeforeScu: onboardAfterScu,
    onboardAfterScu,
    capacityScu,
    overCapacity: capacityScu > 0 && onboardAfterScu > capacityScu,
    note: "",
    isStart: true,
  };
}

function mergeStartStop(startStop, workStop) {
  return {
    ...workStop,
    sequence: 0,
    statusLabel: `Start point · ${workStop.statusLabel}`,
    note: workStop.note,
    isStart: true,
  };
}

function buildRouteStop(session, location, rows, onboardBeforeScu = 0, zoneName) {
  const capacityScu = getShipCapacityScu(session);
  const unloadRows = rows.filter((row) => row.item.dropoffLocation === location && row.item.loadedScu > row.item.unloadedScu);
  const loadRows = rows.filter((row) => row.pickupLocation === location && row.item.loadedScu < row.item.quantityScu);
  const unloadScu = unloadRows.reduce((total, row) => total + row.item.loadedScu - row.item.unloadedScu, 0);
  const onboardAfterUnloadScu = Math.max(0, onboardBeforeScu - unloadScu);
  const loadPlans = getLoadPlans(loadRows, capacityScu, onboardAfterUnloadScu);
  const plannedLoadRows = loadPlans.map((plan) => plan.row);
  const loadScu = loadPlans.reduce((total, plan) => total + plan.amount, 0);
  if (!unloadRows.length && !plannedLoadRows.length) return null;

  const allRows = [...unloadRows, ...plannedLoadRows];
  const onboardAfterScu = onboardAfterUnloadScu + loadScu;
  const statusLabel = unloadRows.length && plannedLoadRows.length ? "Unload, then load" : unloadRows.length ? "Unload" : "Load";

  return {
    name: location,
    statusLabel,
    lines: allRows.length,
    commodities: unique(allRows.map((row) => row.item.commodity)),
    zones: unique(allRows.map((row) => zoneName(session, row.item.assignedZoneId)).filter((zone) => zone !== "Unassigned")),
    unloadScu,
    loadScu,
    workScu: unloadScu + loadScu,
    onboardBeforeScu,
    onboardAfterScu,
    capacityScu,
    overCapacity: capacityScu > 0 && onboardAfterScu > capacityScu,
    note: getRouteStopNote(plannedLoadRows),
  };
}

function getRouteStopNote(loadRows) {
  if (!loadRows.length) return "";
  return `After loading here: ${unique(loadRows.map((row) => row.item.dropoffLocation)).join(", ")}.`;
}

function applyRouteStop(location, rows, capacityScu = 0) {
  let changed = false;
  rows.forEach((row) => {
    if (row.item.dropoffLocation === location && row.item.loadedScu > row.item.unloadedScu) {
      row.item.unloadedScu = row.item.loadedScu;
      changed = true;
    }
  });
  let availableScu = capacityScu > 0 ? Math.max(0, capacityScu - getSimulatedOnboardScu(rows)) : Infinity;
  rows.forEach((row) => {
    if (row.pickupLocation === location && row.item.loadedScu < row.item.quantityScu) {
      const remaining = row.item.quantityScu - row.item.loadedScu;
      const loadScu = Math.min(remaining, availableScu);
      if (loadScu <= 0) return;
      row.item.loadedScu += loadScu;
      availableScu -= loadScu;
      changed = true;
    }
  });
  return changed;
}

function shouldDeferConstrainedPickup(location, rows, capacityScu, onboardBeforeScu) {
  if (capacityScu <= 0) return false;
  const hasUnloadHere = rows.some((row) => row.item.dropoffLocation === location && row.item.loadedScu > row.item.unloadedScu);
  if (hasUnloadHere) return false;
  const loadScuHere = getRemainingLoadScu(rows.filter((row) => row.pickupLocation === location && row.item.loadedScu < row.item.quantityScu));
  if (!loadScuHere) return false;
  const availableScu = Math.max(0, capacityScu - onboardBeforeScu);
  const desiredLoadScu = Math.min(loadScuHere, capacityScu);
  return hasUnloadElsewhere(rows, location) && desiredLoadScu > availableScu;
}

function chooseNextRouteLocation(rows, current, visited, capacityScu = 0, getLocationSystem) {
  const candidates = getRouteCandidateLocations(rows, current);
  if (!candidates.length) return "";

  const scored = candidates
    .map((location) => scoreRouteCandidate(rows, current, visited, location, capacityScu, getLocationSystem))
    .sort((a, b) => b.score - a.score || a.firstIndex - b.firstIndex);

  return scored[0]?.location ?? "";
}

function getRouteCandidateLocations(rows, current) {
  const candidates = new Set();
  rows.forEach((row) => {
    if (row.item.loadedScu > row.item.unloadedScu && row.item.dropoffLocation !== current) {
      candidates.add(row.item.dropoffLocation);
    }
    if (row.item.loadedScu < row.item.quantityScu && row.pickupLocation !== current) {
      candidates.add(row.pickupLocation);
    }
  });
  return [...candidates];
}

function scoreRouteCandidate(rows, current, visited, location, capacityScu = 0, getLocationSystem) {
  const unloadRows = rows.filter((row) => row.item.dropoffLocation === location && row.item.loadedScu > row.item.unloadedScu);
  const loadRows = rows.filter((row) => row.pickupLocation === location && row.item.loadedScu < row.item.quantityScu);
  const unloadScu = unloadRows.reduce((total, row) => total + row.item.loadedScu - row.item.unloadedScu, 0);
  const onboardBeforeScu = getSimulatedOnboardScu(rows);
  const onboardAfterUnloadScu = Math.max(0, onboardBeforeScu - unloadScu);
  const loadPlans = getLoadPlans(loadRows, capacityScu, onboardAfterUnloadScu);
  const loadScu = loadPlans.reduce((total, plan) => total + plan.amount, 0);
  const fullLoadScu = getRemainingLoadScu(loadRows);
  const unplannedLoadScu = fullLoadScu - loadScu;
  const desiredLoadScu = capacityScu > 0 ? Math.min(fullLoadScu, capacityScu) : fullLoadScu;
  const constrainedByCargoOnboard = capacityScu > 0 && loadRows.length && loadScu < desiredLoadScu && hasUnloadElsewhere(rows, location);
  const loadedDestinations = getLoadedDestinationSet(rows);
  const futureDestinations = unique(loadPlans.map((plan) => plan.row.item.dropoffLocation));
  const unlocksLoadedDestination = futureDestinations.filter((destination) => loadedDestinations.has(destination)).length;
  const deferredCargoToSameDestination = getDeferredCargoToDestination(rows, location);
  const pureUnload = unloadScu > 0 && loadScu === 0;
  const unloadAndLoad = unloadScu > 0 && loadScu > 0;
  const pickupOnly = unloadScu === 0 && loadScu > 0;
  const crossesSystem = getLocationSystem(current) && getLocationSystem(location) && getLocationSystem(current) !== getLocationSystem(location);

  let score = 0;
  score += unloadScu * 18;
  score += loadScu * 3;
  score += pureUnload ? 80 : 0;
  score += unloadAndLoad ? 55 : 0;
  score += pickupOnly ? 15 : 0;
  score += unlocksLoadedDestination * 120;
  score += futureDestinations.length * 12;
  score -= deferredCargoToSameDestination * 160;
  score -= unplannedLoadScu * 25;
  score -= constrainedByCargoOnboard ? 900 + (desiredLoadScu - loadScu) * 120 : 0;
  score -= loadRows.length && loadScu === 0 && !unloadRows.length ? 1000 : 0;
  score -= crossesSystem ? JUMP_PENALTY : 0;
  score -= visited.has(location) ? 70 : 0;

  return {
    location,
    score,
    firstIndex: getFirstLocationIndex(rows, location),
  };
}

function getLoadPlans(loadRows, capacityScu, onboardAfterUnloadScu) {
  let availableScu = capacityScu > 0 ? Math.max(0, capacityScu - onboardAfterUnloadScu) : Infinity;
  return loadRows.map((row) => {
    const remaining = row.item.quantityScu - row.item.loadedScu;
    const amount = Math.min(remaining, availableScu);
    availableScu -= amount;
    return { row, amount };
  }).filter((plan) => plan.amount > 0);
}

function getRemainingLoadScu(loadRows) {
  return loadRows.reduce((total, row) => total + row.item.quantityScu - row.item.loadedScu, 0);
}

function hasUnloadElsewhere(rows, location) {
  return rows.some((row) => row.item.dropoffLocation !== location && row.item.loadedScu > row.item.unloadedScu);
}

function getSimulatedOnboardScu(rows) {
  return rows.reduce((total, row) => total + row.item.loadedScu - row.item.unloadedScu, 0);
}

function getShipCapacityScu(session) {
  return Math.max(0, Math.floor(Number(session.shipCapacityScu) || 0));
}

function getLoadedDestinationSet(rows) {
  return new Set(
    rows
      .filter((row) => row.item.loadedScu > row.item.unloadedScu)
      .map((row) => row.item.dropoffLocation),
  );
}

function getDeferredCargoToDestination(rows, destination) {
  return rows.reduce((total, row) => {
    if (
      row.item.dropoffLocation === destination &&
      row.item.loadedScu < row.item.quantityScu &&
      row.pickupLocation !== destination
    ) {
      return total + row.item.quantityScu - row.item.loadedScu;
    }
    return total;
  }, 0);
}

function getFirstLocationIndex(rows, location) {
  const indexes = rows.flatMap((row) => {
    const values = [];
    if (row.pickupLocation === location) values.push(row.index);
    if (row.item.dropoffLocation === location) values.push(row.index);
    return values;
  });
  return indexes.length ? Math.min(...indexes) : Number.MAX_SAFE_INTEGER;
}

function findFirstWorkLocation(rows) {
  const firstPickup = rows.find((row) => row.item.loadedScu < row.item.quantityScu);
  if (firstPickup) return firstPickup.pickupLocation;
  const firstDropoff = rows.find((row) => row.item.loadedScu > row.item.unloadedScu);
  return firstDropoff?.item.dropoffLocation ?? "";
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}
