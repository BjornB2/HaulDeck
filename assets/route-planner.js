const ROUTE_BEAM_WIDTH = 240;
const MAX_LOAD_VARIANTS = 28;

export function getRouteChecklist(session, options = {}) {
  const {
    startLocation = "",
    zoneName = () => "Unassigned",
    getLocationSystem = () => "",
    forceStartStop = false,
  } = options;
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
    getLocationSystem,
    forceStartStop,
  } = options;
  const start = rows.length ? startLocation || findFirstWorkLocation(rows) : "";
  if (!start) return [];

  const config = {
    capacityScu: getShipCapacityScu(session),
    zoneLimit: getZoneLimit(session),
    zoneName,
    getLocationSystem,
  };
  const initialState = {
    rows: cloneRows(rows),
    current: start,
    stops: [],
    jumpCount: 0,
    partialLoadCount: 0,
    partialUnloadCount: 0,
    tiebreaker: 0,
  };
  const completed = [];
  let beam = [initialState];
  const maxDepth = rows.length * 5 + 32;

  for (let depth = 0; depth < maxDepth && beam.length; depth += 1) {
    const nextStates = new Map();

    beam.forEach((state) => {
      if (isRouteComplete(state.rows)) {
        completed.push(state);
        return;
      }

      const candidates = getCandidateLocations(state, forceStartStop);
      candidates.forEach((location) => {
        getStopOutcomes(session, state, location, config).forEach((outcome) => {
          const nextState = buildNextState(state, outcome, config);
          const key = getRouteStateKey(nextState);
          const existing = nextStates.get(key);
          if (!existing || compareStates(nextState, existing) < 0) {
            nextStates.set(key, nextState);
          }
        });
      });
    });

    if (!nextStates.size) break;
    beam = [...nextStates.values()]
      .sort(compareStates)
      .slice(0, ROUTE_BEAM_WIDTH);
  }

  const candidates = completed.length ? completed : beam;
  return candidates.sort(compareStates)[0]?.stops ?? [];
}

function getCandidateLocations(state, forceStartStop) {
  const currentHasWork = hasWorkAtLocation(state.rows, state.current);
  if (forceStartStop && !state.stops.length && currentHasWork) return [state.current];

  const locations = new Set();
  if (currentHasWork) locations.add(state.current);
  state.rows.forEach((row) => {
    if (row.item.loadedScu > row.item.unloadedScu) locations.add(row.item.dropoffLocation);
    if (row.item.loadedScu < row.item.quantityScu) locations.add(row.pickupLocation);
  });
  locations.delete("");
  return [...locations].sort((a, b) => getFirstLocationIndex(state.rows, a) - getFirstLocationIndex(state.rows, b));
}

function getStopOutcomes(session, state, location, config) {
  const afterUnloadRows = cloneRows(state.rows);
  const unloadRows = afterUnloadRows.filter((row) =>
    row.item.dropoffLocation === location &&
    row.item.loadedScu > row.item.unloadedScu
  );
  const unloadScu = unloadRows.reduce((total, row) => total + row.item.loadedScu - row.item.unloadedScu, 0);
  unloadRows.forEach((row) => {
    row.item.unloadedScu = row.item.loadedScu;
  });

  const loadRows = afterUnloadRows.filter((row) =>
    row.pickupLocation === location &&
    row.item.loadedScu < row.item.quantityScu
  );
  const loadVariants = getLoadVariants(loadRows, afterUnloadRows, config);

  return loadVariants
    .map((variant) => {
      const rows = cloneRows(afterUnloadRows);
      variant.loads.forEach((load) => {
        rows[load.rowIndex].item.loadedScu += load.amount;
      });
      const loadScu = variant.loads.reduce((total, load) => total + load.amount, 0);
      if (!unloadScu && !loadScu) return null;

      const plannedLoadRows = variant.loads.map((load) => rows[load.rowIndex]);
      const stop = buildRouteStopFromRows(session, location, state.rows, rows, unloadRows, plannedLoadRows, unloadScu, loadScu, config);
      return {
        location,
        rows,
        stop,
        loadedAllAvailable: variant.loadedAllAvailable,
        loadRowsCount: loadRows.length,
      };
    })
    .filter(Boolean);
}

function getLoadVariants(loadRows, rowsAfterUnload, config) {
  if (!loadRows.length) return [{ loads: [], loadedAllAvailable: true }];

  const capacityLeft = getCapacityLeft(rowsAfterUnload, config.capacityScu);
  if (capacityLeft <= 0) return [{ loads: [], loadedAllAvailable: false }];

  const destinationGroups = groupLoadRowsByDestination(loadRows);
  const candidates = destinationGroups
    .filter((group) => canAddDestination(rowsAfterUnload, group.destination, group.zoneId, config.zoneLimit))
    .sort((a, b) => b.remainingScu - a.remainingScu || a.firstIndex - b.firstIndex);

  const variants = new Map();
  addLoadVariant(variants, [], loadRows.length === 0);

  for (let size = 1; size <= candidates.length; size += 1) {
    getCombinations(candidates, size, MAX_LOAD_VARIANTS).forEach((groups) => {
      if (!canLoadGroups(rowsAfterUnload, groups, config.zoneLimit)) return;
      const loads = [];
      let availableScu = capacityLeft;
      groups.forEach((group) => {
        group.rows.forEach((row) => {
          if (availableScu <= 0) return;
          const amount = Math.min(row.item.quantityScu - row.item.loadedScu, availableScu);
          if (amount <= 0) return;
          loads.push({ rowIndex: row.index, amount });
          availableScu -= amount;
        });
      });
      const intendedScu = groups.reduce((total, group) => total + group.remainingScu, 0);
      addLoadVariant(variants, loads, intendedScu <= capacityLeft);
    });
  }

  return [...variants.values()]
    .sort((a, b) => b.loads.reduce((total, load) => total + load.amount, 0) - a.loads.reduce((total, load) => total + load.amount, 0))
    .slice(0, MAX_LOAD_VARIANTS);
}

function groupLoadRowsByDestination(loadRows) {
  const groups = new Map();
  loadRows.forEach((row) => {
    const group = groups.get(row.item.dropoffLocation) ?? {
      destination: row.item.dropoffLocation,
      zoneId: row.item.assignedZoneId ?? "",
      rows: [],
      remainingScu: 0,
      firstIndex: row.index,
    };
    group.rows.push(row);
    group.remainingScu += row.item.quantityScu - row.item.loadedScu;
    group.firstIndex = Math.min(group.firstIndex, row.index);
    if (!group.zoneId && row.item.assignedZoneId) group.zoneId = row.item.assignedZoneId;
    groups.set(row.item.dropoffLocation, group);
  });
  return [...groups.values()];
}

function addLoadVariant(map, loads, loadedAllAvailable) {
  const normalized = loads.filter((load) => load.amount > 0);
  const key = normalized.map((load) => `${load.rowIndex}:${load.amount}`).join(",");
  if (!map.has(key)) map.set(key, { loads: normalized, loadedAllAvailable });
}

function getCombinations(items, size, limit, start = 0, prefix = [], output = []) {
  if (output.length >= limit) return output;
  if (prefix.length === size) {
    output.push(prefix);
    return output;
  }
  for (let index = start; index < items.length && output.length < limit; index += 1) {
    getCombinations(items, size, limit, index + 1, [...prefix, items[index]], output);
  }
  return output;
}

function canAddDestination(rows, destination, zoneId, zoneLimit) {
  const onboard = getOnboardDestinationDetails(rows);
  if (onboard.destinations.has(destination)) return true;
  if (zoneLimit > 0 && onboard.destinations.size >= zoneLimit) return false;
  if (!zoneId) return true;
  const occupiedBy = onboard.zones.get(zoneId);
  return !occupiedBy || occupiedBy === destination;
}

function canLoadGroups(rows, groups, zoneLimit) {
  const onboard = getOnboardDestinationDetails(rows);
  const destinations = new Set(onboard.destinations);
  const zones = new Map(onboard.zones);

  return groups.every((group) => {
    if (!destinations.has(group.destination)) {
      if (zoneLimit > 0 && destinations.size >= zoneLimit) return false;
      destinations.add(group.destination);
    }
    if (!group.zoneId) return true;
    const occupiedBy = zones.get(group.zoneId);
    if (occupiedBy && occupiedBy !== group.destination) return false;
    zones.set(group.zoneId, group.destination);
    return true;
  });
}

function buildRouteStopFromRows(session, location, beforeRows, afterRows, unloadRows, loadRows, unloadScu, loadScu, config) {
  const onboardBeforeScu = getSimulatedOnboardScu(beforeRows);
  const allRows = [...unloadRows, ...loadRows];
  const onboardDestinationsAfter = getOnboardDestinationDetails(afterRows).destinations;
  const statusLabel = unloadScu && loadScu ? "Unload, then load" : unloadScu ? "Unload" : "Load";

  return {
    name: location,
    statusLabel,
    lines: allRows.length,
    commodities: unique(allRows.map((row) => row.item.commodity)),
    zones: unique(allRows.map((row) => config.zoneName(session, row.item.assignedZoneId)).filter((zone) => zone !== "Unassigned")),
    unloadScu,
    loadScu,
    workScu: unloadScu + loadScu,
    onboardBeforeScu,
    onboardAfterScu: getSimulatedOnboardScu(afterRows),
    onboardDestinationsAfter: onboardDestinationsAfter.size,
    zoneLimit: config.zoneLimit,
    zoneLimited: hasZoneLimitedLoads(beforeRows, afterRows, location, config.zoneLimit),
    capacityScu: config.capacityScu,
    overCapacity: config.capacityScu > 0 && getSimulatedOnboardScu(afterRows) > config.capacityScu,
    note: getRouteStopNote(loadRows),
  };
}

function buildNextState(state, outcome, config) {
  const jumps = didJump(state.current, outcome.location, config.getLocationSystem) ? 1 : 0;
  const partialLoad = outcome.loadRowsCount && !outcome.loadedAllAvailable ? 1 : 0;
  const partialUnload = hasFutureCargoToDestination(outcome.rows, outcome.location) && outcome.stop.unloadScu > 0 ? 1 : 0;
  return {
    rows: outcome.rows,
    current: outcome.location,
    stops: [...state.stops, outcome.stop],
    jumpCount: state.jumpCount + jumps,
    partialLoadCount: state.partialLoadCount + partialLoad,
    partialUnloadCount: state.partialUnloadCount + partialUnload,
    tiebreaker: state.tiebreaker + getTiebreakerCost(outcome),
  };
}

function compareStates(a, b) {
  return compareScore(getStateScore(a), getStateScore(b));
}

function getStateScore(state) {
  const complete = isRouteComplete(state.rows) ? 0 : 1;
  // Lexicographic priority: complete route, fewest stops, fewest jumps, then soft handling preferences.
  return [
    complete,
    state.stops.length,
    state.jumpCount,
    state.partialLoadCount + state.partialUnloadCount,
    getRemainingWorkScu(state.rows),
    state.tiebreaker,
  ];
}

function compareScore(a, b) {
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const diff = (a[index] ?? 0) - (b[index] ?? 0);
    if (diff) return diff;
  }
  return 0;
}

function getTiebreakerCost(outcome) {
  const combinedBonus = outcome.stop.loadScu && outcome.stop.unloadScu ? -25 : 0;
  return outcome.stop.onboardDestinationsAfter * 8 - outcome.stop.workScu + combinedBonus;
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

function allCargo(session) {
  return session.contracts.flatMap((contract) => contract.items.map((item) => ({ contract, item })));
}

function hasWorkAtLocation(rows, location) {
  return rows.some((row) =>
    (row.item.loadedScu > row.item.unloadedScu && row.item.dropoffLocation === location) ||
    (row.item.loadedScu < row.item.quantityScu && row.pickupLocation === location)
  );
}

function getCapacityLeft(rows, capacityScu) {
  if (capacityScu <= 0) return Infinity;
  return Math.max(0, capacityScu - getSimulatedOnboardScu(rows));
}

function getOnboardDestinationDetails(rows) {
  const destinations = new Set();
  const zones = new Map();
  rows.forEach((row) => {
    if (row.item.loadedScu <= row.item.unloadedScu) return;
    destinations.add(row.item.dropoffLocation);
    if (row.item.assignedZoneId) {
      zones.set(row.item.assignedZoneId, row.item.dropoffLocation);
    }
  });
  return { destinations, zones };
}

function hasZoneLimitedLoads(beforeRows, afterRows, location, zoneLimit) {
  if (zoneLimit <= 0) return false;
  const loadRows = beforeRows.filter((row) => row.pickupLocation === location && row.item.loadedScu < row.item.quantityScu);
  if (!loadRows.length) return false;
  const loadedScu = afterRows.reduce((total, row, index) => {
    const before = beforeRows[index];
    return total + Math.max(0, row.item.loadedScu - before.item.loadedScu);
  }, 0);
  return loadedScu < getRemainingLoadScu(loadRows) && getOnboardDestinationDetails(afterRows).destinations.size >= zoneLimit;
}

function hasFutureCargoToDestination(rows, destination) {
  return rows.some((row) =>
    row.item.dropoffLocation === destination &&
    row.item.loadedScu < row.item.quantityScu &&
    row.pickupLocation !== destination
  );
}

function didJump(from, to, getLocationSystem) {
  const fromSystem = getLocationSystem(from);
  const toSystem = getLocationSystem(to);
  return Boolean(fromSystem && toSystem && fromSystem !== toSystem);
}

function getRouteStopNote(loadRows) {
  if (!loadRows.length) return "";
  return `After loading here: ${unique(loadRows.map((row) => row.item.dropoffLocation)).join(", ")}.`;
}

function getRemainingLoadScu(loadRows) {
  return loadRows.reduce((total, row) => total + row.item.quantityScu - row.item.loadedScu, 0);
}

function getRemainingWorkScu(rows) {
  return rows.reduce((total, row) => total + (row.item.quantityScu - row.item.unloadedScu), 0);
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
