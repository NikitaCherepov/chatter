import React, { useEffect, useRef, useState } from 'react';
import { MapContainer, TileLayer, Marker, Popup, Polyline, useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { subscribeMapData, type MapData } from '../lib/tools';
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

const DEFAULT_CENTER: [number, number] = [56.4977, 84.9744]; // City
const DEFAULT_ZOOM = 12;

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

export function MapTool() {
  const [mapData, setMapData] = useState<MapData | null>(null);

  useEffect(() => {
    const unsub = subscribeMapData((data) => {
      setMapData(data);
    });
    return unsub;
  }, []);

  const center: [number, number] =
    mapData?.lat != null && mapData?.lng != null
      ? [mapData.lat, mapData.lng]
      : DEFAULT_CENTER;

  const zoom = mapData ? 14 : DEFAULT_ZOOM;

  return (
    <div className={s.root}>
      <MapContainer
        center={DEFAULT_CENTER}
        zoom={DEFAULT_ZOOM}
        className={s.map}
        zoomControl={true}
        scrollWheelZoom={true}
        doubleClickZoom={true}
        dragging={true}
      >
        {/* Light mode tiles */}
        <TileLayer
          url="https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png"
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a>'
        />

        {/* Fly to single place */}
        {mapData?.action === 'show_place' && <FlyTo center={center} zoom={zoom} />}

        {/* Fit route bounds */}
        {mapData?.route && <FitBounds route={mapData.route} />}

        {/* Single place marker with label */}
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
      </MapContainer>
    </div>
  );
}
