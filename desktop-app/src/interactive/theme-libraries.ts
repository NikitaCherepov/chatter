import * as React from 'react';
import * as ReactDOM from 'react-dom';
import * as ReactDOMClient from 'react-dom/client';
const global = window as any;
global.ChatterReact = React;
global.ChatterReactDOM = ReactDOM;
global.ChatterReactDOMClient = ReactDOMClient;
const definitions: Record<string, { file: string; global: string; member?: string }> = {
  three: { file: 'three', global: 'ChatterThree', member: 'Three' },
  '@react-three/fiber': { file: 'three', global: 'ChatterThree', member: 'Fiber' },
  '@react-three/drei': { file: 'three', global: 'ChatterThree', member: 'Drei' },
  'framer-motion': { file: 'motion', global: 'ChatterMotion' },
  gsap: { file: 'gsap', global: 'ChatterGsap' },
  '@dnd-kit/core': { file: 'dnd', global: 'ChatterDnd', member: 'Core' },
  '@dnd-kit/sortable': { file: 'dnd', global: 'ChatterDnd', member: 'Sortable' },
  '@dnd-kit/modifiers': { file: 'dnd', global: 'ChatterDnd', member: 'Modifiers' },
  '@dnd-kit/utilities': { file: 'dnd', global: 'ChatterDnd', member: 'Utilities' },
};
const loading = new Map<string, Promise<void>>();
export async function loadThemeLibraries(sources: string[]) {
  const names = new Set<string>();
  for (const source of sources)
    for (const match of source.matchAll(/\brequire\(["']([^"']+)["']\)/g))
      if (definitions[match[1]]) names.add(match[1]);
  await Promise.all(
    [...names].map((name) => {
      const definition = definitions[name];
      if (!loading.has(definition.file))
        loading.set(
          definition.file,
          new Promise<void>((resolve, reject) => {
            const script = document.createElement('script');
            script.src = new URL('/_library/' + definition.file + '.js', location.href).href;
            script.onload = () => resolve();
            script.onerror = () => reject(new Error('Theme library unavailable: ' + name));
            document.head.append(script);
          }),
        );
      return loading.get(definition.file);
    }),
  );
}
export function themeLibrary(name: string) {
  const definition = definitions[name];
  if (!definition) return undefined;
  const module = global[definition.global];
  if (!module) throw new Error('Theme library not loaded: ' + name);
  return definition.member ? module[definition.member] : module;
}
