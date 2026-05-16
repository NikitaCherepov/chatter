import type { TransitStop } from '../types';

// ── Shared Overpass helpers ─────────────────────────────────────────────

const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
const OVERPASS_HEADERS = {
  'Content-Type': 'application/x-www-form-urlencoded',
  'User-Agent': 'ChatterBot/1.0',
};

async function overpassQuery(query: string): Promise<any> {
  const res = await fetch(OVERPASS_URL, {
    method: 'POST',
    headers: OVERPASS_HEADERS,
    body: `data=${encodeURIComponent(query)}`,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Overpass API error ${res.status}: ${text.slice(0, 200)}`);
  }

  return res.json();
}

// ── Haversine distance ─────────────────────────────────────────────────

/**
 * Calculate the distance between two coordinates in meters (Haversine formula).
 */
function getDistanceMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371e3;
  const phi1 = (lat1 * Math.PI) / 180;
  const phi2 = (lat2 * Math.PI) / 180;
  const dPhi = ((lat2 - lat1) * Math.PI) / 180;
  const dLambda = ((lon2 - lon1) * Math.PI) / 180;

  const a =
    Math.sin(dPhi / 2) * Math.sin(dPhi / 2) +
    Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLambda / 2) * Math.sin(dLambda / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return R * c;
}

// ── Transit route types ────────────────────────────────────────────────

type OverpassMember = {
  type: string;
  role: string;
  ref: number;
  lat?: number;
  lon?: number;
  tags?: Record<string, string>;
  geometry?: Array<{ lat: number; lon: number }>;
};

type OverpassRelationElement = {
  type: 'relation';
  id: number;
  tags: Record<string, string>;
  members: OverpassMember[];
};

/** Info about the nearest stop to a point */
type NearestStopInfo = {
  name: string;
  coords: [number, number];
  distanceMeters: number;
  indexInRoute: number;
};

/** A fully processed route variant with sliced segment */
export type TransitRouteVariant = {
  routeName: string;
  routeType: string;
  /** Full polyline of the entire route (for reference) */
  fullStops: TransitStop[];
  /** Nearest stop to point A (pickup) */
  pickupStop: NearestStopInfo;
  /** Nearest stop to point B (dropoff) */
  dropoffStop: NearestStopInfo;
  /** Number of stops between pickup and dropoff (inclusive) */
  stopsToRideCount: number;
  /** Names of stops in the ride segment (for AI text) */
  stopsToRideList: string[];
  /** Total walking distance: to pickup + from dropoff */
  totalWalkingMeters: number;
  /** Sliced polyline between pickup and dropoff (for map) */
  slicedPath: [number, number][];
  /** Sliced stops between pickup and dropoff (for map markers) */
  slicedStops: TransitStop[];
  /** Direction: 1 = forward along route, -1 = reverse */
  direction: 1 | -1;
};

// ── findTransitRoute ───────────────────────────────────────────────────

/**
 * Find public transit routes that pass near both point A and point B.
 * For each route, finds the nearest stops to both points and slices the segment.
 * Uses auto-retry with expanded radius if first attempt returns nothing.
 */
export async function findTransitRoute(
  latA: number,
  lonA: number,
  latB: number,
  lonB: number,
  radiusMeters = 500,
): Promise<TransitRouteVariant[]> {
  const elements = await queryWithRetry<OverpassRelationElement>(
    (radius) => buildTransitQuery(latA, lonA, latB, lonB, radius),
    radiusMeters,
  );

  if (elements.length === 0) return [];

  const candidates: Array<{ variant: TransitRouteVariant; score: number }> = [];

  for (const rel of elements) {
    const routeName =
      rel.tags?.name ||
      rel.tags?.ref ||
      `${rel.tags?.route || 'transport'} ${rel.id}`;

    const routeType = rel.tags?.route || 'bus';

    // Collect all stops and way segments in order
    const stops: TransitStop[] = [];
    const pathSegments: [number, number][][] = [];

    for (const member of rel.members) {
      if (
        (member.role === 'stop' || member.role === 'platform') &&
        member.lat != null &&
        member.lon != null
      ) {
        stops.push({
          coords: [member.lat, member.lon],
          name: member.tags?.name || `Остановка #${stops.length + 1}`,
        });
      }

      if (member.type === 'way' && member.geometry && member.geometry.length > 0) {
        const segment: [number, number][] = member.geometry.map((pt) =>
          [pt.lat, pt.lon] as [number, number],
        );
        pathSegments.push(segment);
      }
    }

    if (stops.length < 2) continue;

    // Find nearest stops to point A and point B
    const pickup = findNearestStop(stops, latA, lonA);
    const dropoff = findNearestStop(stops, latB, lonB);

    if (!pickup || !dropoff) continue;
    if (pickup.indexInRoute === dropoff.indexInRoute) continue;

    // Determine direction: forward or backward along route
    const direction: 1 | -1 = pickup.indexInRoute < dropoff.indexInRoute ? 1 : -1;

    // Slice stops between pickup and dropoff
    const fromIdx = Math.min(pickup.indexInRoute, dropoff.indexInRoute);
    const toIdx = Math.max(pickup.indexInRoute, dropoff.indexInRoute);
    const slicedStops = stops.slice(fromIdx, toIdx + 1);

    // Slice the full path between pickup and dropoff coordinates
    const fullPath = stitchPath(pathSegments);
    const slicedPath = slicePathBetweenCoords(
      fullPath,
      pickup.coords,
      dropoff.coords,
    );

    const totalWalkingMeters = Math.round(pickup.distanceMeters + dropoff.distanceMeters);

    const variant: TransitRouteVariant = {
      routeName: `${routeTypeLabel(routeType)} ${routeName}`,
      routeType,
      fullStops: stops,
      pickupStop: {
        name: pickup.name,
        coords: pickup.coords,
        distanceMeters: Math.round(pickup.distanceMeters),
        indexInRoute: pickup.indexInRoute,
      },
      dropoffStop: {
        name: dropoff.name,
        coords: dropoff.coords,
        distanceMeters: Math.round(dropoff.distanceMeters),
        indexInRoute: dropoff.indexInRoute,
      },
      stopsToRideCount: slicedStops.length,
      stopsToRideList: slicedStops.map(s => s.name),
      totalWalkingMeters,
      slicedPath: slicedPath.length >= 2 ? slicedPath : fullPath,
      slicedStops,
      direction,
    };

    // Score: less walking = better
    const score = -totalWalkingMeters;
    candidates.push({ variant, score });
  }

  // Sort by walking distance (best first)
  candidates.sort((a, b) => b.score - a.score);

  return candidates.map(c => c.variant);
}

/**
 * Find the stop closest to a given coordinate.
 */
function findNearestStop(
  stops: TransitStop[],
  lat: number,
  lon: number,
): NearestStopInfo | null {
  if (stops.length === 0) return null;

  let bestDist = Infinity;
  let bestIdx = 0;

  for (let i = 0; i < stops.length; i++) {
    const d = getDistanceMeters(lat, lon, stops[i].coords[0], stops[i].coords[1]);
    if (d < bestDist) {
      bestDist = d;
      bestIdx = i;
    }
  }

  return {
    name: stops[bestIdx].name,
    coords: stops[bestIdx].coords,
    distanceMeters: bestDist,
    indexInRoute: bestIdx,
  };
}

/**
 * Slice a polyline to approximate the segment between two coordinate pairs.
 * Finds the closest points on the path to start and end coords.
 */
function slicePathBetweenCoords(
  path: [number, number][],
  startCoords: [number, number],
  endCoords: [number, number],
): [number, number][] {
  if (path.length < 2) return path;

  let startIdx = 0;
  let endIdx = path.length - 1;
  let minStartDist = Infinity;
  let minEndDist = Infinity;

  for (let i = 0; i < path.length; i++) {
    const dStart = getDistanceMeters(path[i][0], path[i][1], startCoords[0], startCoords[1]);
    if (dStart < minStartDist) {
      minStartDist = dStart;
      startIdx = i;
    }

    const dEnd = getDistanceMeters(path[i][0], path[i][1], endCoords[0], endCoords[1]);
    if (dEnd < minEndDist) {
      minEndDist = dEnd;
      endIdx = i;
    }
  }

  // Ensure start < end
  if (startIdx > endIdx) {
    [startIdx, endIdx] = [endIdx, startIdx];
  }

  return path.slice(startIdx, endIdx + 1);
}

function buildTransitQuery(latA: number, lonA: number, latB: number, lonB: number, radius: number): string {
  return [
    '[out:json][timeout:25];',
    `relation["type"="route"]["route"~"bus|share_taxi|trolleybus|tram"](around:${radius},${latA},${lonA})->.start;`,
    `relation["type"="route"]["route"~"bus|share_taxi|trolleybus|tram"](around:${radius},${latB},${lonB})->.end;`,
    'relation.start.end;',
    'out geom;',
  ].join('\n');
}

// ── searchNearby (POI search) ──────────────────────────────────────────

export type NearbyPlace = {
  id: number;
  lat: number;
  lng: number;
  name: string;
  address?: string;
  hours?: string;
  category?: string;
};

/**
 * Search for named places/POIs near a point by text query.
 * Searches both nodes and ways, returns centered coordinates.
 */
export async function searchNearby(
  lat: number,
  lng: number,
  query: string,
  radiusMeters = 3000,
): Promise<NearbyPlace[]> {
  const elements = await queryWithRetry<any>(
    (radius) => buildNearbyQuery(lat, lng, query, radius),
    radiusMeters,
  );

  const places: NearbyPlace[] = [];

  for (const el of elements) {
    const elLat = el.lat ?? el.center?.lat;
    const elLon = el.lon ?? el.center?.lon;
    if (elLat == null || elLon == null) continue;

    const name = el.tags?.name || el.tags?.['name:ru'] || el.tags?.brand || '';
    if (!name) continue;

    places.push({
      id: el.id,
      lat: elLat,
      lng: elLon,
      name,
      address: el.tags?.['addr:street']
        ? `${el.tags['addr:street']}${el.tags?.['addr:housenumber'] ? `, ${el.tags['addr:housenumber']}` : ''}`
        : undefined,
      hours: el.tags?.opening_hours,
      category: el.tags?.amenity || el.tags?.shop || el.tags?.tourism || el.tags?.office,
    });
  }

  return places;
}

function buildNearbyQuery(lat: number, lng: number, query: string, radius: number): string {
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [
    '[out:json][timeout:25];',
    '(',
    `  node["name"~"${escaped}",i](around:${radius},${lat},${lng});`,
    `  way["name"~"${escaped}",i](around:${radius},${lat},${lng});`,
    ');',
    'out center body;',
  ].join('\n');
}

// ── Shared utilities ───────────────────────────────────────────────────

/**
 * Execute Overpass query with auto-retry at expanded radius if empty result.
 */
async function queryWithRetry<T>(
  buildQuery: (radius: number) => string,
  initialRadius: number,
): Promise<T[]> {
  const radii = [initialRadius];

  if (initialRadius < 1000) radii.push(1200);
  if (initialRadius < 2500) radii.push(2500);

  for (const radius of radii) {
    const query = buildQuery(radius);
    const data = await overpassQuery(query);
    const elements: T[] = data.elements ?? [];

    if (elements.length > 0) return elements;
  }

  return [];
}

/**
 * Stitch ordered way segments into a continuous polyline.
 */
function stitchPath(segments: [number, number][][]): [number, number][] {
  if (segments.length === 0) return [];
  if (segments.length === 1) return segments[0];

  const result: [number, number][] = [...segments[0]];

  for (let i = 1; i < segments.length; i++) {
    const seg = segments[i];
    if (seg.length === 0) continue;

    const lastPt = result[result.length - 1];
    const firstPt = seg[0];

    if (
      lastPt &&
      firstPt &&
      Math.abs(lastPt[0] - firstPt[0]) < 1e-7 &&
      Math.abs(lastPt[1] - firstPt[1]) < 1e-7
    ) {
      result.push(...seg.slice(1));
    } else {
      result.push(...seg);
    }
  }

  return result;
}

function routeTypeLabel(type: string): string {
  const labels: Record<string, string> = {
    bus: 'Автобус',
    share_taxi: 'Маршрутка',
    trolleybus: 'Троллейбус',
    tram: 'Трамвай',
  };
  return labels[type] || 'Транспорт';
}
