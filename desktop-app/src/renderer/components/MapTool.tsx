import React, { useEffect, useRef, useState, useCallback } from 'react';
import { MapContainer, TileLayer, Marker, Popup, Polyline, useMap, LayersControl, useMapEvents } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { subscribeMapData, getMapData, type MapData } from '../lib/tools';
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

const DEFAULT_CENTER: [number, number] = [56.4977, 84.9744];
const DEFAULT_ZOOM = 12;

export type UserPin = {
  id: string;
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

/** Calls invalidateSize() when the map container resizes (sidebar → fullscreen etc.) */
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

export function MapTool() {
  const [mapData, setMapData] = useState<MapData | null>(() => getMapData());
  const [pins, setPins] = useState<UserPin[]>(() => {
    try {
      const saved = localStorage.getItem('chatter-map-pins');
      return saved ? JSON.parse(saved) : [];
    } catch { return []; }
  });
  const [placingPin, setPlacingPin] = useState(false);
  const [editingPinId, setEditingPinId] = useState<string | null>(null);
  const [editLabel, setEditLabel] = useState('');

  useEffect(() => {
    const unsub = subscribeMapData((data) => {
      setMapData(data);
    });
    return unsub;
  }, []);

  // Persist pins
  useEffect(() => {
    localStorage.setItem('chatter-map-pins', JSON.stringify(pins));
  }, [pins]);

  const handleMapClick = useCallback((lat: number, lng: number) => {
    const id = `pin-${Date.now()}`;
    setPins(prev => [...prev, { id, lat, lng, label: '' }]);
    setEditingPinId(id);
    setEditLabel('');
    setPlacingPin(false);
  }, []);

  const handlePinLabelSave = (pinId: string) => {
    setPins(prev => prev.map(p => p.id === pinId ? { ...p, label: editLabel } : p));
    setEditingPinId(null);
  };

  const handlePinDelete = (pinId: string) => {
    setPins(prev => prev.filter(p => p.id !== pinId));
    if (editingPinId === pinId) setEditingPinId(null);
  };

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
        title={placingPin ? 'Отмена' : 'Добавить точку'}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" />
          <circle cx="12" cy="10" r="3" />
        </svg>
      </button>

      <MapContainer
        center={DEFAULT_CENTER}
        zoom={DEFAULT_ZOOM}
        className={s.map}
        zoomControl={true}
        scrollWheelZoom={true}
        doubleClickZoom={true}
        dragging={true}
      >
        <LayersControl position="bottomleft">
          <LayersControl.BaseLayer checked name="Светлая">
            <TileLayer
              url="https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png"
              attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a>'
            />
          </LayersControl.BaseLayer>

          <LayersControl.BaseLayer name="Спутник">
            <TileLayer
              url="https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
              attribution="Tiles &copy; Esri"
            />
          </LayersControl.BaseLayer>

          <LayersControl.BaseLayer name="Стандартная">
            <TileLayer
              url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
              attribution='&copy; OpenStreetMap'
            />
          </LayersControl.BaseLayer>
        </LayersControl>

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
              <strong>{mapData.label || 'Место'}</strong>
            </Popup>
          </Marker>
        )}

        {/* Route: from marker */}
        {mapData?.action === 'draw_route' && mapData.from && (
          <Marker position={[mapData.from.lat, mapData.from.lng]}>
            <Popup>
              <strong>Откуда</strong><br />
              {mapData.from.label}
            </Popup>
          </Marker>
        )}

        {/* Route: to marker */}
        {mapData?.action === 'draw_route' && mapData.to && (
          <Marker position={[mapData.to.lat, mapData.to.lng]}>
            <Popup>
              <strong>Куда</strong><br />
              {mapData.to.label}
            </Popup>
          </Marker>
        )}

        {/* Route line */}
        {mapData?.route && (
          <Polyline positions={mapData.route} color="#3b82f6" weight={4} opacity={0.8} />
        )}

        {/* User pins */}
        {pins.map(pin => (
          <Marker key={pin.id} position={[pin.lat, pin.lng]} icon={userPinIcon}>
            <Popup>
              {editingPinId === pin.id ? (
                <div className={s.pinEditPopup}>
                  <input
                    className={s.pinEditInput}
                    type="text"
                    placeholder="Название..."
                    value={editLabel}
                    onChange={(e) => setEditLabel(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') handlePinLabelSave(pin.id); }}
                    autoFocus
                  />
                  <button className={s.pinEditSave} onClick={() => handlePinLabelSave(pin.id)}>OK</button>
                </div>
              ) : (
                <div className={s.pinPopup}>
                  <strong>{pin.label || 'Без названия'}</strong>
                  <div className={s.pinPopupCoords}>
                    {pin.lat.toFixed(4)}, {pin.lng.toFixed(4)}
                  </div>
                  <div className={s.pinPopupActions}>
                    <button className={s.pinPopupBtn} onClick={() => { setEditingPinId(pin.id); setEditLabel(pin.label); }}>Править</button>
                    <button className={s.pinPopupBtn} onClick={() => handlePinDelete(pin.id)}>Удалить</button>
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
