import React, { useEffect, useState } from 'react';
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

/** Animates the map camera when center changes */
function FlyTo({ center, zoom }: { center: [number, number]; zoom: number }) {
  const map = useMap();
  useEffect(() => {
    map.flyTo(center, zoom, { duration: 1.5 });
  }, [center, zoom, map]);
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

  const zoom = mapData?.route ? 6 : mapData ? 14 : DEFAULT_ZOOM;

  return (
    <div className={s.root}>
      <MapContainer
        center={center}
        zoom={DEFAULT_ZOOM}
        className={s.map}
      >
        <TileLayer
          url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a>'
        />
        <FlyTo center={center} zoom={zoom} />

        {mapData?.action === 'show_place' && (
          <Marker position={center}>
            <Popup>{mapData.label || ''}</Popup>
          </Marker>
        )}

        {mapData?.route && (
          <Polyline positions={mapData.route} color="#00e5ff" weight={4} opacity={0.8} />
        )}
      </MapContainer>
    </div>
  );
}
