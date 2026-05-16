const JUMP_PENALTY = 1800;
const ROUTE_BEAM_WIDTH = 180;

export function getRouteChecklist(session, options = {}) {
  const {
    startLocation = "",
    zoneName = () => "Unassigned",
    getLocationSystem = () => "",
    forceStartStop = false,
  } = options;
  const zoneLimit = getZoneLimit(session);
  const rows = allCargo(session)
    .filter(({ contract, item }) => contract.status !== "cancelled" && item.unloadedScu < item.quantityScu)
    .map(({ contract, item }, index) => ({
      index,
      contract,
      pickupLocation: contract.pickupLocation,
      item: { ...item },
    }));
  const stops = findOptimizedRouteStops(session, rows, {
    startLocation,
    zoneName,
    zoneLimit,
    getLocationSystem,
    forceStartStop,
  });

  return stops.map((stop, index) => ({
    ...stop,
    sequence: index + 1,
  }));
}

function findOptimizedRouteStops(session, rows, options) {
  const {
    startLocation,
    zoneName,
    zoneLimit,
    getLocationSystem,
    forceStartStop,
  } = options;
  const capacityScu = getShipCapacityScu(session);
  const start = rows.length ? startLocation || findFirstWorkLocation(rows) : "";
  if (!start) return [];

  const initialState = {
    rows: cloneRows(rows),
    current: start,
    stops: [],
    cost: 0,
    visitCounts: new Map(),
  };
  const completed = [];
  let beam = [initialState];
  const maxDepth = rows.length * 4 + 24;

  for (let depth = 0; depth < maxDepth && beam.length; depth += 1) {
    const nextStates = [];
    const bestByKey = new Map();

    beam.forEach((state) => {
      if (isRouteComplete(state.rows)) {
        completed.push(state);
        return;
      }

      getSearchCandidateLocations(session, state, {
        capacityScu,
        zoneLimit,
        zoneName,
        getLocationSystem,
        forceStartStop,
      }).forEach((location) => {
        const onboardBeforeScu = getSimulatedOnboardScu(state.rows);
        const stop = buildRouteStop(session, location, state.rows, onboardBeforeScu, zoneName, zoneLimit);
        if (!stop || stop.workScu <= 0) return;

        const nextRows = cloneRows(state.rows);
        if (!applyRouteStop(location, nextRows, capacityScu, zoneLimit)) return;

        const visitCounts = new Map(state.visitCounts);
        const previousVisits = visitCounts.get(location) ?? 0;
        visitCounts.set(location, previousVisits + 1);
        const nextState = {
          rows: nextRows,
          current: location,
          stops: [...state.stops, stop],
          cost: state.cost + getTransitionCost(state, stop, location, getLocationSystem),
          visitCounts,
        };
        const key = getRouteStateKey(nextState);
        const existing = bestByKey.get(key);
        if (!existing || getStateRank(nextState) < getStateRank(existing)) {
          bestByKey.set(key, nextState);
        }
      });
    });

    nextStates.push(...bestByKey.values());
    if (!nextStates.length) break;
    beam = nextStates
      .sort((a, b) => getStateRank(a) - getStateRank(b))
      .slice(0, ROUTE_BEAM_WIDTH);
  }

  const candidates = completed.length ? completed : beam;
  return candidates
    .sort((a, b) => getFinalStateCost(a) - getFinalStateCost(b))[0]?.stops ?? [];
}

function getSearchCandidateLocations(session, state, options) {
  const {
    capacityScu,
    zoneLimit,
    zoneName,
    getLocationSystem,
    forceStartStop,
  } = options;
  const onboardBeforeScu = getSimulatedOnboardScu(state.rows);
  const currentStop = buildRouteStop(session, state.current, state.rows, onboardBeforeScu, zoneName, zoneLimit);
  if (forceStartStop && !state.stops.length && currentStop?.workScu > 0) return [state.current];

  const candidates = new Set();
  if (currentStop?.workScu > 0) candidates.add(state.current);
  getRouteCandidateLocations(state.rows, state.current).forEach((location) => candidates.add(location));
  const candidateStops = [...candidates]
    .map((location) => ({
      location,
      stop: buildRouteStop(session, location, state.rows, onboardBeforeScu, zoneName, zoneLimit),
    }))
    .filter(({ stop }) => stop?.workScu > 0);
  const hasAlternativeProgress = candidateStops.some(({ location, stop }) =>
    location !== state.current &&
    (stop.loadScu > 0 || getDeferredCargoToDestination(state.rows, location) === 0)
  );

  return candidateStops
    .filter(({ stop }) => {
      const futureCargoToSameDestination = stop.unloadScu > 0 ? getDeferredCargoToDestination(state.rows, stop.name) : 0;
      const pureDeferredUnload = stop.unloadScu > 0 && stop.loadScu === 0 && futureCargoToSameDestination > 0;
      return !pureDeferredUnload || !hasAlternativeProgress;
    })
    .map(({ location }) => location)
    .map((location) => scoreRouteCandidate(state.rows, state.current, new Set(state.visitCounts.keys()), location, capacityScu, zoneLimit, getLocationSystem))
    .sort((a, b) => b.score - a.score || a.firstIndex - b.firstIndex)
    .map((candidate) => candidate.location);
}

function getTransitionCost(state, stop, location, getLocationSystem) {
  const previousVisits = state.visitCounts.get(location) ?? 0;
  const fullLoadScu = getRemainingLoadScu(state.rows.filter((row) => row.pickupLocation === location && row.item.loadedScu < row.item.quantityScu));
  const unplannedLoadScu = Math.max(0, fullLoadScu - stop.loadScu);
  const futureCargoToSameDestination = stop.unloadScu > 0 ? getDeferredCargoToDestination(state.rows, location) : 0;
  const smallPickupOnlyPenalty = stop.loadScu > 0 && stop.unloadScu === 0 ? Math.max(0, 64 - stop.loadScu) * 200 : 0;
  const crossesSystem = getLocationSystem(state.current) && getLocationSystem(location) && getLocationSystem(state.current) !== getLocationSystem(location);

  let cost = 1000;
  cost += previousVisits * 2400;
  cost += unplannedLoadScu ? 900 + unplannedLoadScu * 18 : 0;
  cost += futureCargoToSameDestination ? 5000 + futureCargoToSameDestination * 120 : 0;
  cost += smallPickupOnlyPenalty;
  cost += stop.zoneLimited ? 1400 : 0;
  cost += stop.onboardAfterScu * 2;
  cost += stop.onboardDestinationsAfter * 45;
  cost += crossesSystem ? JUMP_PENALTY : 0;
  cost -= stop.unloadScu * 4;
  return cost;
}

function getStateRank(state) {
  return getFinalStateCost(state) + getRemainingWorkScu(state.rows) * 8;
}

function getFinalStateCost(state) {
  const revisitPenalty = [...state.visitCounts.values()].reduce((total, count) => total + Math.max(0, count - 1) * 1800, 0);
  return state.cost + state.stops.length * 80 + revisitPenalty + getRemainingWorkScu(state.rows) * 25;
}

function getRouteStateKey(state) {
  return `${state.current}|${state.rows.map((row) => `${row.item.loadedScu}/${row.item.unloadedScu}`).join(",")}`;
}

function cloneRows(rows) {
  return rows.map((row) => ({
    ...row,
    item: { ...row.item },
  }));
}

function isRouteComplete(rows) {
  return rows.every((row) => row.item.unloadedScu >= row.item.quantityScu);
}

function getRemainingWorkScu(rows) {
  return rows.reduce((total, row) => total + (row.item.quantityScu - row.item.unloadedScu), 0);
}

function allCargo(session) {
  return session.contracts.flatMap((contract) => contract.items.map((item) => ({ contract, item })));
}

function buildRouteStop(session, location, rows, onboardBeforeScu = 0, zoneName, zoneLimit = 0) {
  const capacityScu = getShipCapacityScu(session);
  const unloadRows = rows.filter((row) => row.item.dropoffLocation === location && row.item.loadedScu > row.item.unloadedScu);
  const loadRows = rows.filter((row) => row.pickupLocation === location && row.item.loadedScu < row.item.quantityScu);
  const unloadScu = unloadRows.reduce((total, row) => total + row.item.loadedScu - row.item.unloadedScu, 0);
  const onboardAfterUnloadScu = Math.max(0, onboardBeforeScu - unloadScu);
  const onboardDestinationsAfterUnload = getOnboardDestinationSet(rows, location);
  const loadPlans = getLoadPlans(loadRows, capacityScu, onboardAfterUnloadScu, onboardDestinationsAfterUnload, zoneLimit);
  const plannedLoadRows = loadPlans.map((plan) => plan.row);
  const loadScu = loadPlans.reduce((total, plan) => total + plan.amount, 0);
  const zoneLimitedRows = getZoneLimitedRows(loadRows, onboardDestinationsAfterUnload, zoneLimit);
  if (!unloadRows.length && !plannedLoadRows.length) return null;

  const allRows = [...unloadRows, ...plannedLoadRows];
  const onboardAfterScu = onboardAfterUnloadScu + loadScu;
  const onboardDestinationsAfter = getOnboardDestinationsAfterPlans(onboardDestinationsAfterUnload, loadPlans);
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
    onboardDestinationsAfter: onboardDestinationsAfter.size,
    zoneLimit,
    zoneLimited: zoneLimitedRows.length > 0,
    capacityScu,
    overCapacity: capacityScu > 0 && onboardAfterScu > capacityScu,
    note: getRouteStopNote(plannedLoadRows, zoneLimitedRows, zoneLimit),
  };
}

function getRouteStopNote(loadRows, zoneLimitedRows = [], zoneLimit = 0) {
  const notes = [];
  if (loadRows.length) notes.push(`After loading here: ${unique(loadRows.map((row) => row.item.dropoffLocation)).join(", ")}.`);
  if (zoneLimitedRows.length && zoneLimit > 0) {
    const extraZones = unique(zoneLimitedRows.map((row) => row.item.dropoffLocation)).length;
    notes.push(`Add ${extraZones === 1 ? "one more cargo zone" : `${extraZones} more cargo zones`} for further optimized routing for this trip.`);
  }
  return notes.join(" ");
}

function applyRouteStop(location, rows, capacityScu = 0, zoneLimit = 0) {
  let changed = false;
  rows.forEach((row) => {
    if (row.item.dropoffLocation === location && row.item.loadedScu > row.item.unloadedScu) {
      row.item.unloadedScu = row.item.loadedScu;
      changed = true;
    }
  });
  let availableScu = capacityScu > 0 ? Math.max(0, capacityScu - getSimulatedOnboardScu(rows)) : Infinity;
  const onboardDestinations = getOnboardDestinationSet(rows);
  rows.forEach((row) => {
    if (row.pickupLocation === location && row.item.loadedScu < row.item.quantityScu) {
      if (!canLoadDestination(onboardDestinations, row.item.dropoffLocation, zoneLimit)) return;
      const remaining = row.item.quantityScu - row.item.loadedScu;
      const loadScu = Math.min(remaining, availableScu);
      if (loadScu <= 0) return;
      row.item.loadedScu += loadScu;
      availableScu -= loadScu;
      onboardDestinations.add(row.item.dropoffLocation);
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

function shouldDeferSplitDelivery(location, rows, capacityScu, onboardBeforeScu) {
  const unloadRowsHere = rows.filter((row) => row.item.dropoffLocation === location && row.item.loadedScu > row.item.unloadedScu);
  if (!unloadRowsHere.length) return false;
  const loadRowsHere = rows.filter((row) => row.pickupLocation === location && row.item.loadedScu < row.item.quantityScu);
  if (loadRowsHere.length) return false;
  const deferredRowsForSameDestination = rows.filter((row) =>
    row.item.dropoffLocation === location &&
    row.pickupLocation !== location &&
    row.item.loadedScu < row.item.quantityScu
  );
  if (!deferredRowsForSameDestination.length) return false;
  if (capacityScu <= 0) return true;
  const availableScu = Math.max(0, capacityScu - onboardBeforeScu);
  return getRemainingLoadScu(deferredRowsForSameDestination) <= availableScu;
}

function chooseNextRouteLocation(rows, current, visited, capacityScu = 0, zoneLimit = 0, getLocationSystem) {
  const candidates = getRouteCandidateLocations(rows, current);
  if (!candidates.length) return "";

  const scored = candidates
    .map((location) => scoreRouteCandidate(rows, current, visited, location, capacityScu, zoneLimit, getLocationSystem))
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

function scoreRouteCandidate(rows, current, visited, location, capacityScu = 0, zoneLimit = 0, getLocationSystem) {
  const unloadRows = rows.filter((row) => row.item.dropoffLocation === location && row.item.loadedScu > row.item.unloadedScu);
  const loadRows = rows.filter((row) => row.pickupLocation === location && row.item.loadedScu < row.item.quantityScu);
  const unloadScu = unloadRows.reduce((total, row) => total + row.item.loadedScu - row.item.unloadedScu, 0);
  const onboardBeforeScu = getSimulatedOnboardScu(rows);
  const onboardAfterUnloadScu = Math.max(0, onboardBeforeScu - unloadScu);
  const onboardDestinationsAfterUnload = getOnboardDestinationSet(rows, location);
  const loadPlans = getLoadPlans(loadRows, capacityScu, onboardAfterUnloadScu, onboardDestinationsAfterUnload, zoneLimit);
  const loadScu = loadPlans.reduce((total, plan) => total + plan.amount, 0);
  const fullLoadScu = getRemainingLoadScu(loadRows);
  const unplannedLoadScu = fullLoadScu - loadScu;
  const desiredLoadScu = capacityScu > 0 ? Math.min(fullLoadScu, capacityScu) : fullLoadScu;
  const constrainedByCargoOnboard = capacityScu > 0 && loadRows.length && loadScu < desiredLoadScu && hasUnloadElsewhere(rows, location);
  const constrainedByZones = zoneLimit > 0 && loadRows.length && loadScu < fullLoadScu && getBlockedDestinationCount(loadRows, onboardDestinationsAfterUnload, zoneLimit) > 0;
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
  score -= constrainedByZones ? 850 : 0;
  score -= loadRows.length && loadScu === 0 && !unloadRows.length ? 1000 : 0;
  score -= crossesSystem ? JUMP_PENALTY : 0;
  score -= visited.has(location) ? 70 : 0;

  return {
    location,
    score,
    firstIndex: getFirstLocationIndex(rows, location),
  };
}

function getLoadPlans(loadRows, capacityScu, onboardAfterUnloadScu, onboardDestinations = new Set(), zoneLimit = 0) {
  let availableScu = capacityScu > 0 ? Math.max(0, capacityScu - onboardAfterUnloadScu) : Infinity;
  const plannedDestinations = new Set(onboardDestinations);
  return loadRows.map((row) => {
    if (!canLoadDestination(plannedDestinations, row.item.dropoffLocation, zoneLimit)) return { row, amount: 0 };
    const remaining = row.item.quantityScu - row.item.loadedScu;
    const amount = Math.min(remaining, availableScu);
    availableScu -= amount;
    if (amount > 0) plannedDestinations.add(row.item.dropoffLocation);
    return { row, amount };
  }).filter((plan) => plan.amount > 0);
}

function canLoadDestination(onboardDestinations, destination, zoneLimit = 0) {
  if (zoneLimit <= 0 || onboardDestinations.has(destination)) return true;
  return onboardDestinations.size < zoneLimit;
}

function getOnboardDestinationSet(rows, unloadingLocation = "") {
  return new Set(
    rows
      .filter((row) => row.item.loadedScu > row.item.unloadedScu && row.item.dropoffLocation !== unloadingLocation)
      .map((row) => row.item.dropoffLocation),
  );
}

function getOnboardDestinationsAfterPlans(onboardDestinations, loadPlans) {
  const destinations = new Set(onboardDestinations);
  loadPlans.forEach((plan) => {
    if (plan.amount > 0) destinations.add(plan.row.item.dropoffLocation);
  });
  return destinations;
}

function getBlockedDestinationCount(loadRows, onboardDestinations, zoneLimit = 0) {
  if (zoneLimit <= 0) return 0;
  const destinations = new Set(onboardDestinations);
  let blocked = 0;
  loadRows.forEach((row) => {
    if (destinations.has(row.item.dropoffLocation)) return;
    if (destinations.size >= zoneLimit) {
      blocked += 1;
      return;
    }
    destinations.add(row.item.dropoffLocation);
  });
  return blocked;
}

function getZoneLimitedRows(loadRows, onboardDestinations, zoneLimit = 0) {
  if (zoneLimit <= 0) return [];
  const destinations = new Set(onboardDestinations);
  const blockedRows = [];
  loadRows.forEach((row) => {
    if (destinations.has(row.item.dropoffLocation)) return;
    if (destinations.size >= zoneLimit) {
      blockedRows.push(row);
      return;
    }
    destinations.add(row.item.dropoffLocation);
  });
  return blockedRows;
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

function getZoneLimit(session) {
  return Math.max(0, session.zones?.length ?? 0);
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
