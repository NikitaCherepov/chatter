export const THEME_EFFECTS_GUIDE=`# Effects, 3D and audio

All controls are headless: write your own markup, styling and animations. Effects/audio are
optional features. Existing themes do not need changes. See examples/effects/ for small reusable
components, not a mandatory layout.

## Bundled libraries

React projects may import three, @react-three/fiber, @react-three/drei, framer-motion and gsap.
For bundled dnd-kit packages and drag/sort behavior see drag-and-drop.md.
docs/libraries.json gives the exact installed versions. Imports load optional local bundles;
React is shared with the shell. No npm installation or arbitrary package/CDN imports are allowed.
Use named imports (Canvas/useFrame, Float/Stars, motion/AnimatePresence, gsap). Only the listed
package roots are supported; GSAP plugin subpaths and other package subpaths are not supported.
Editor declarations are installed once in types/node_modules and linked from generated project
tsconfig.json. They do not count as theme source or travel in exported themes.

Three/Drei features requiring network downloads, external fonts, workers or remote decoders are
unavailable. Prefer procedural geometry, Stars/Float and local, uncompressed GLB files; for
useGLTF disable Draco with its second argument false. Use local HDR textures instead of remote
environment presets. Do not assume every upstream helper works inside this isolated runtime.

## Local assets

Place files under assets/ (nested folders allowed). Supported formats: PNG/JPEG/WebP/GIF,
MP3/WAV/OGG/M4A/FLAC, GLB/HDR, TTF/WOFF/WOFF2. Codec support follows the desktop runtime.
Import assetSource from @chatter/ui, or call chatter.assetSource('assets/model.glb') in HTML.
It returns an isolated URL for a registered asset, or an empty string if unavailable. Use this
URL for loaders, CSS fonts and images. Do not import binary files as JS modules. HTML may use
the same bridge; optional library imports are for React projects.

Asset files are discovered automatically; do not add an assets property to theme.json. Internal
shell.assets is an app-owned registry. Assets are saved, restored and exported with the theme.
Limits per theme: 128 assets, 32 MiB per file, 64 MiB combined. These are separate from the 256
runtime files / 500,000 source characters. ZIP imports/exports allow 1024 entries and 96 MiB
total uncompressed data. Keep loops and textures small for quick preview and low memory use.

## Lifecycle and performance

const effects = useThemeEffects(); // @chatter/ui
// visible, enabled, intensity (0..1), reducedMotion, active, setPreferences(patch)

Use active to mount decorative Canvas scenes and start JS effects; scale motion/particle density
with intensity. Use dpr={[1,1.5]}, modest geometry and lighting. Do not animate the entire chat
or recreate scenes on streaming updates. A decorative canvas should not capture chat input.
Return cleanup from effects: cancel timers, revert GSAP contexts and dispose custom GPU resources.
Framer Motion and R3F own their normal component cleanup.

The app pauses requestAnimationFrame, CSS animations and GSAP's ticker while the shell is hidden
or minimized. On return pending frames resume. It suppresses CSS transitions/animations when
visual effects are disabled or the OS requests reduced motion. Arbitrary timers are not frozen;
use active for your own JS timelines. Do not depend on an animation finishing for a form to work.
Turning intensity to zero makes active false. HTML can subscribeThemeEnvironment for visibility
and preferences and use matchMedia for reduced motion; it owns its lifecycle cleanup.

## Sound and music

const audio = useThemeAudio(); // @chatter/ui
// soundEnabled, musicEnabled, soundVolume, musicVolume, activeSounds, error
audio.play('assets/click.wav', {volume:0.4, rate:1});
audio.tone(660,60,0.2); // sine tone: frequency Hz, duration milliseconds, relative volume
audio.stopSounds();
audio.music.play('assets/ambient.ogg',true); // true = loop; call from a user click
audio.music.pause(); audio.music.resume(); audio.music.stop();
// audio.music.asset and .status: idle/loading/playing/paused/error

Sounds and music start disabled. The user's device-local preferences survive theme changes.
Both hooks expose setPreferences(patch), which requires a genuine user gesture. Supported fields:
effectsEnabled, intensity, soundEnabled, musicEnabled, soundVolume, musicVolume. Numeric values
are 0..1. These same values are available in app settings. Do not enable audio on mount.
Music play/resume also requires a gesture. Enabling music alone never starts a track. Render a
Play button; a user can enable music and request play in the same click. Return booleans mean a
command was accepted by the bridge; playback state/error reports the eventual result.

Playback belongs to the app, not the isolated page: raw audio elements/Web Audio in the shell
are muted. Per-call volume cannot exceed the user's master volume. Sounds last at most 10 s;
up to 8 play concurrently with a limit of 20 starts/second. Tones accept 40..4000 Hz and
20..2000 ms. Rate is 0.25..4. Music is paused while hidden, resumes only a previously playing
track, and is ducked during message speech. Switching theme or reverting preview stops playback.
Pause/stop cancel pending loads. Report audio.error without blocking chat functionality.

For plain HTML use chatter.themeAudio(action,options), getThemeEnvironment and
subscribeThemeEnvironment. Actions are sound, tone, musicPlay, musicPause, musicResume,
musicStop and soundsStop. Options mirror the methods above. See chatter.d.ts for signatures.
`;

export const THEME_EFFECTS_EXAMPLES:Record<string,string>={
  'AmbientScene.tsx':`import React from 'react';
import {Canvas,useFrame} from '@react-three/fiber';
import {Float,Stars} from '@react-three/drei';
import {useThemeEffects} from '@chatter/ui';
import type {Mesh} from 'three';
function Orb({intensity}:{intensity:number}){
  const mesh=React.useRef<Mesh>(null);
  useFrame((_,delta)=>{if(mesh.current)mesh.current.rotation.y+=Math.min(delta,.05)*.14*intensity;});
  return <Float speed={.7*intensity} rotationIntensity={.15} floatIntensity={.3}>
    <mesh ref={mesh}><torusKnotGeometry args={[1,.22,96,12]}/><meshStandardMaterial color="#73e2e8" roughness={.3} metalness={.8}/></mesh>
  </Float>;
}
export function AmbientScene(){const effects=useThemeEffects();
  if(!effects.active)return null;
  return <div aria-hidden="true" style={{position:'absolute',inset:0,pointerEvents:'none',opacity:.4}}>
    <Canvas dpr={[1,1.5]} camera={{position:[0,0,5]}}>
      <ambientLight intensity={.6}/><pointLight position={[3,4,5]} intensity={18}/>
      <Stars radius={45} depth={20} count={Math.round(600*effects.intensity)} fade speed={.3}/>
      <Orb intensity={effects.intensity}/>
    </Canvas>
  </div>;
}
`,
  'AnimatedPanel.tsx':`import React from 'react';
import {motion,AnimatePresence} from 'framer-motion';
import {gsap} from 'gsap';
import {useThemeEffects} from '@chatter/ui';
export function AnimatedPanel({open,children}:React.PropsWithChildren<{open:boolean}>){
  const effects=useThemeEffects(),ref=React.useRef<HTMLDivElement>(null);
  React.useEffect(()=>{if(!effects.active||!ref.current||!open)return;
    const context=gsap.context(()=>gsap.to('[data-glow]',{opacity:.7,duration:2,repeat:-1,yoyo:true,ease:'sine.inOut'}),ref);
    return()=>context.revert();
  },[effects.active,open]);
  return <AnimatePresence>{open&&<motion.div ref={ref} initial={{opacity:0,y:effects.active?8:0}}
    animate={{opacity:1,y:0}} exit={{opacity:0}} transition={{duration:effects.active?.18:0}}>
    <div data-glow aria-hidden="true" style={{height:1,background:'currentColor',opacity:.2}}/>{children}
  </motion.div>}</AnimatePresence>;
}
`,
  'AudioControls.tsx':`import React from 'react';
import {useThemeAudio} from '@chatter/ui';
export function AudioControls(){const audio=useThemeAudio();
  return <div>
    <label><input type="checkbox" checked={audio.soundEnabled} onChange={e=>audio.setPreferences({soundEnabled:e.target.checked})}/>Sounds</label>
    <button onClick={()=>audio.tone(660,60,.2)} disabled={!audio.soundEnabled}>Test sound</button>
    <button onClick={()=>{audio.setPreferences({musicEnabled:true});audio.music.play('assets/ambient.ogg');}}>Play music</button>
    <button onClick={audio.music.pause}>Pause</button><button onClick={audio.music.resume}>Resume</button><button onClick={audio.music.stop}>Stop</button>
    <span role="status">{audio.music.status}{audio.error&&': '+audio.error}</span>
  </div>;
}
`,
};
