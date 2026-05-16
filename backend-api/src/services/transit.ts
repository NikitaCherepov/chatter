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

export type TransitRouteVariant = {
  routeName: string;
  routeType: string;
  path: [number, number][];
  stops: TransitStop[];
};

// ── findTransitRoute ───────────────────────────────────────────────────

/**
 * Find public transit routes that pass near both point A and point B.
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

  const variants: TransitRouteVariant[] = [];

  for (const rel of elements) {
    const routeName =
      rel.tags?.name ||
      rel.tags?.ref ||
      `${rel.tags?.route || 'transport'} ${rel.id}`;

    const routeType = rel.tags?.route || 'bus';

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

    const path = stitchPath(pathSegments);
    if (path.length < 2) continue;

    variants.push({
      routeName: `${routeTypeLabel(routeType)} ${routeName}`,
      routeType,
      path,
      stops,
    });
  }

  return variants;
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
    // `out center` returns lat/lon for ways, direct lat/lon for nodes
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
 * Radius progression: initial → 1200m (if initial < 1000) → 2500m.
 */
async function queryWithRetry<T>(
  buildQuery: (radius: number) => string,
  initialRadius: number,
): Promise<T[]> {
  const radii = [initialRadius];

  // Auto-expand: if initial is small, add retry tiers
  if (initialRadius < 1000) radii.push(1200);
  if (initialRadius < 2500) radii.push(2500);

  for (const radius of radii) {
    const query = buildQuery(radius);
    const data = await overpassQuery(query);
    const elements: T[] = data.elements ?? [];

    if (elements.length > 0) return elements;
    // If we got nothing, retry with next (larger) radius
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
