import React, { useEffect, useRef, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { AttributionControl, MapContainer, Marker, Popup, Polyline, useMap, useMapEvents } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { subscribeMapData, getMapData, type MapData, type NearbyPlace } from '../lib/tools';
import { listMapPins, createMapPin, updateMapPin, deleteMapPin, type MapPinDto } from '../lib/api';
import { RadioGroup, type RadioOption } from './RadioGroup';
import s from './MapTool.module.scss';

// Fix Leaflet default icon bundling with Vite
import markerIcon2x from 'leaflet/dist/images/marker-icon-2x.png';
import markerIcon from 'leaflet/dist/images/marker-icon.png';
import markerShadow from 'leaflet/dist/images/marker-shadow.png';

delete (L.Icon.Default.prototype as any)._getIconUrl;
L.Icon.Default.mergeOptions({
  iconUrl: markerIcon,
  iconRetinaUrl: markerIcon2x,
  shadowUrl: markerShadow,
});

// Custom green icon for user pins
const userPinIcon = new L.Icon({
  iconUrl: markerIcon,
  iconRetinaUrl: markerIcon2x,
  shadowUrl: markerShadow,
  iconSize: [25, 41],
  iconAnchor: [12, 41],
  popupAnchor: [1, -34],
  shadowSize: [41, 41],
  className: s.userPinIcon,
});

// Custom orange circle icon for transit stops
const stopIcon = L.divIcon({
  html: `<svg width="20" height="20" viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg">
    <circle cx="10" cy="10" r="8" fill="#f97316" stroke="#fff" stroke-width="2"/>
    <circle cx="10" cy="10" r="3" fill="#fff"/>
  </svg>`,
  className: s.stopIcon,
  iconSize: [20, 20],
  iconAnchor: [10, 10],
  popupAnchor: [0, -12],
});

// Custom purple pin icon for POI search results
const poiIcon = L.divIcon({
  html: `<svg width="24" height="24" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
    <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z" fill="#8b5cf6" stroke="#fff" stroke-width="1.5"/>
    <circle cx="12" cy="9" r="2.5" fill="#fff"/>
  </svg>`,
  className: s.poiIcon,
  iconSize: [24, 24],
  iconAnchor: [12, 24],
  popupAnchor: [0, -24],
});

const DEFAULT_CENTER: [number, number] = [56.4977, 84.9744];
const DEFAULT_ZOOM = 12;
const LEAFLET_ATTRIBUTION_PREFIX =
  '<a href="https://leafletjs.com" title="A JavaScript library for interactive maps">Leaflet</a>';

const TILE_LAYERS: Record<string, { url: string; attribution: string }> = {
  light: {
    url: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a>',
  },
  satellite: {
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    attribution: 'Tiles &copy; Esri',
  },
  standard: {
    url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: '&copy; OpenStreetMap',
  },
};

const TILE_STORAGE_KEY = 'chatter-map-tile';

function loadTile(): string {
  try {
    const saved = localStorage.getItem(TILE_STORAGE_KEY);
    if (saved && TILE_LAYERS[saved]) return saved;
  } catch { /* */ }
  return 'light';
}

export type UserPin = {
  id: number;
  lat: number;
  lng: number;
  label: string;
};

/** Animates the map camera when new data arrives — only when data changes */
function FlyTo({ center, zoom }: { center: [number, number]; zoom: number }) {
  const map = useMap();
  const prevKeyRef = useRef('');
  const key = `${center[0].toFixed(4)},${center[1].toFixed(4)},${zoom}`;
  useEffect(() => {
    if (key !== prevKeyRef.current) {
      prevKeyRef.current = key;
      map.flyTo(center, zoom, { duration: 1.5 });
    }
  }, [key, center, zoom, map]);
  return null;
}

/** Fits map bounds to show entire route */
function FitBounds({ route }: { route: [number, number][] }) {
  const map = useMap();
  const appliedRef = useRef('');
  const key = route.map(p => `${p[0].toFixed(4)},${p[1].toFixed(4)}`).join('|');
  useEffect(() => {
    if (key !== appliedRef.current && route.length >= 2) {
      appliedRef.current = key;
      const bounds = L.latLngBounds(route);
      map.fitBounds(bounds, { padding: [40, 40], duration: 1.5 });
    }
  }, [key, route, map]);
  return null;
}

/** Handles map click for pin placement */
function ClickHandler({ placingPin, onMapClick }: { placingPin: boolean; onMapClick: (lat: number, lng: number) => void }) {
  useMapEvents({
    click(e) {
      if (placingPin) {
        onMapClick(e.latlng.lat, e.latlng.lng);
      }
    },
  });
  return null;
}

/** Calls invalidateSize() when the map container resizes (sidebar -> fullscreen etc.) */
function ResizeHandler() {
  const map = useMap();
  useEffect(() => {
    const container = map.getContainer();
    const ro = new ResizeObserver(() => {
      map.invalidateSize();
    });
    ro.observe(container);
    return () => ro.disconnect();
  }, [map]);
  return null;
}

/** Programmatically switches the tile layer on the map */
function TileSync({ tileKey }: { tileKey: string }) {
  const map = useMap();
  const layerRef = useRef<L.TileLayer | null>(null);

  useEffect(() => {
    const tile = TILE_LAYERS[tileKey];
    if (!tile) return;
    if (layerRef.current) {
      layerRef.current.remove();
    }
    layerRef.current = L.tileLayer(tile.url, { attribution: tile.attribution }).addTo(map);
    return () => {
      if (layerRef.current) {
        layerRef.current.remove();
        layerRef.current = null;
      }
    };
  }, [tileKey, map]);

  return null;
}

export function MapTool() {
  const { t } = useTranslation();
  const tileOptions: RadioOption[] = [
    { value: 'light', label: t('tools.map.light') },
    { value: 'satellite', label: t('tools.map.satellite') },
    { value: 'standard', label: t('tools.map.standard') },
  ];
  const [mapData, setMapData] = useState<MapData | null>(() => getMapData());
  const [tileKey, setTileKey] = useState<string>(loadTile);
  const [pins, setPins] = useState<MapPinDto[]>([]);
  const [placingPin, setPlacingPin] = useState(false);
  const [editingPinId, setEditingPinId] = useState<number | null>(null);
  const [editLabel, setEditLabel] = useState('');

  useEffect(() => {
    const unsub = subscribeMapData((data) => {
      setMapData(data);
    });
    return unsub;
  }, []);

  // Load pins from API
  useEffect(() => {
    listMapPins()
      .then(res => setPins(res.pins))
      .catch(() => {});
  }, []);

  // Persist tile choice
  useEffect(() => {
    localStorage.setItem(TILE_STORAGE_KEY, tileKey);
  }, [tileKey]);

  const handleMapClick = useCallback(async (lat: number, lng: number) => {
    try {
      const res = await createMapPin(lat, lng, '');
      const newPin: MapPinDto = { id: res.pin_id, lat, lng, label: '', created_at: Math.floor(Date.now() / 1000), updated_at: Math.floor(Date.now() / 1000) };
      setPins(prev => [...prev, newPin]);
      setEditingPinId(res.pin_id);
      setEditLabel('');
    } catch { /* */ }
    setPlacingPin(false);
  }, []);

  const handlePinLabelSave = useCallback(async (pinId: number) => {
    try {
      await updateMapPin(pinId, { label: editLabel });
      setPins(prev => prev.map(p => p.id === pinId ? { ...p, label: editLabel } : p));
    } catch { /* */ }
    setEditingPinId(null);
  }, [editLabel]);

  const handlePinDelete = useCallback(async (pinId: number) => {
    try {
      await deleteMapPin(pinId);
      setPins(prev => prev.filter(p => p.id !== pinId));
    } catch { /* */ }
    if (editingPinId === pinId) setEditingPinId(null);
  }, [editingPinId]);

  const handlePinDragEnd = useCallback(async (pinId: number, lat: number, lng: number) => {
    try {
      await updateMapPin(pinId, { lat, lng });
    } catch { /* */ }
    setPins(prev => prev.map(p => p.id === pinId ? { ...p, lat, lng } : p));
  }, []);

  const center: [number, number] =
    mapData?.lat != null && mapData?.lng != null
      ? [mapData.lat, mapData.lng]
      : DEFAULT_CENTER;

  const zoom = mapData ? 14 : DEFAULT_ZOOM;

  return (
    <div className={s.root}>
      {/* Pin placement button */}
      <button
        className={`${s.pinBtn} ${placingPin ? s.pinBtnActive : ''}`}
        onClick={() => setPlacingPin(prev => !prev)}
        title={placingPin ? t('common.cancel') : t('tools.map.addPoint')}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" />
          <circle cx="12" cy="10" r="3" />
        </svg>
      </button>

      {/* Tile layer selector */}
      <div className={s.tileSelector}>
        <RadioGroup
          options={tileOptions}
          value={tileKey}
          onChange={setTileKey}
        />
      </div>

      <MapContainer
        center={DEFAULT_CENTER}
        zoom={DEFAULT_ZOOM}
        className={s.map}
        zoomControl={true}
      scrollWheelZoom={true}
      doubleClickZoom={true}
      dragging={true}
      attributionControl={false}
    >
      <AttributionControl prefix={LEAFLET_ATTRIBUTION_PREFIX} />
      <TileSync tileKey={tileKey} />
        <ClickHandler placingPin={placingPin} onMapClick={handleMapClick} />
        <ResizeHandler />

        {/* Fly to single place */}
        {mapData?.action === 'show_place' && <FlyTo center={center} zoom={zoom} />}

        {/* Fit route bounds */}
        {mapData?.route && <FitBounds route={mapData.route} />}

        {/* Single place marker */}
        {mapData?.action === 'show_place' && (
          <Marker position={center}>
            <Popup>
              <strong>{mapData.label || t('tools.map.place')}</strong>
            </Popup>
          </Marker>
        )}

        {/* Route: from marker */}
        {mapData?.action === 'draw_route' && mapData.from && (
          <Marker position={[mapData.from.lat, mapData.from.lng]}>
            <Popup>
              <strong>{t('tools.map.from')}</strong><br />
              {mapData.from.label}
            </Popup>
          </Marker>
        )}

        {/* Route: to marker */}
        {mapData?.action === 'draw_route' && mapData.to && (
          <Marker position={[mapData.to.lat, mapData.to.lng]}>
            <Popup>
              <strong>{t('tools.map.to')}</strong><br />
              {mapData.to.label}
            </Popup>
          </Marker>
        )}

        {/* Route line */}
        {mapData?.route && (
          <Polyline positions={mapData.route} color="#3b82f6" weight={4} opacity={0.8} />
        )}

        {/* Transit route: polyline + stops */}
        {mapData?.action === 'transit_route' && mapData.path && (
          <>
            <FitBounds route={mapData.path} />
            <Polyline positions={mapData.path} color="#22c55e" weight={4} opacity={0.85} />
          </>
        )}
        {mapData?.action === 'transit_route' && mapData.stops?.map((stop, i) => (
          <Marker key={`stop-${i}-${stop.coords[0]}-${stop.coords[1]}`} position={stop.coords} icon={stopIcon}>
            <Popup>
              <strong>{stop.name}</strong><br />
              <span style={{ color: '#888', fontSize: '12px' }}>
                {stop.coords[0].toFixed(4)}, {stop.coords[1].toFixed(4)}
              </span>
            </Popup>
          </Marker>
        ))}
        {mapData?.action === 'transit_route' && mapData.routeName && (
          <Marker position={center}>
            <Popup>
              <strong>{mapData.routeName}</strong>
            </Popup>
          </Marker>
        )}

        {/* POI search results: markers for each found place */}
        {mapData?.action === 'poi_search' && mapData.places && mapData.places.length > 0 && (
          <>
            <FlyTo center={[mapData.places[0].lat, mapData.places[0].lng]} zoom={14} />
            {mapData.places.map((place) => (
              <Marker
                key={`poi-${place.id}`}
                position={[place.lat, place.lng]}
                icon={poiIcon}
              >
                <Popup>
                  <strong>{place.name}</strong>
                  {place.address && <><br /><span style={{ color: '#666', fontSize: '11px' }}>{place.address}</span></>}
                  {place.hours && <><br /><span style={{ color: '#888', fontSize: '11px' }}>{place.hours}</span></>}
                  {place.category && <><br /><span style={{ color: '#aaa', fontSize: '10px' }}>{place.category}</span></>}
                </Popup>
              </Marker>
            ))}
          </>
        )}

        {/* User pins */}
        {pins.map(pin => (
          <Marker
            key={pin.id}
            position={[pin.lat, pin.lng]}
            icon={userPinIcon}
            draggable={true}
            eventHandlers={{
              dragend: (e) => {
                const marker = e.target as L.Marker;
                const pos = marker.getLatLng();
                handlePinDragEnd(pin.id, pos.lat, pos.lng);
              },
            }}
          >
            <Popup>
              {editingPinId === pin.id ? (
                <div className={s.pinEditPopup}>
                  <input
                    className={s.pinEditInput}
                    type="text"
                    placeholder={t('tools.map.namePlaceholder')}
                    value={editLabel}
                    onChange={(e) => setEditLabel(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') handlePinLabelSave(pin.id); }}
                    autoFocus
                  />
                  <button className={s.pinEditSave} onClick={() => handlePinLabelSave(pin.id)}>OK</button>
                </div>
              ) : (
                <div className={s.pinPopup}>
                  <strong>{pin.label || t('tools.map.untitled')}</strong>
                  <div className={s.pinPopupCoords}>
                    {pin.lat.toFixed(4)}, {pin.lng.toFixed(4)}
                  </div>
                  <div className={s.pinPopupActions}>
                    <button className={s.pinPopupBtn} onClick={() => { setEditingPinId(pin.id); setEditLabel(pin.label); }}>{t('common.edit')}</button>
                    <button className={s.pinPopupBtn} onClick={() => handlePinDelete(pin.id)}>{t('common.delete')}</button>
                  </div>
                </div>
              )}
            </Popup>
          </Marker>
        ))}
      </MapContainer>
    </div>
  );
}
