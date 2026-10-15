import './ui.css';
import './styles.css';
import { loadFailed } from './load-recovery.js';

// Dev-only views (excluded from production builds): /?debug-sim runs the sim locally,
// /?debug-net plays over the network against the game server. Everything else is the app.
const params = new URLSearchParams(location.search);
// Dev-only: /?play-solo and /?play-net open the in-game client's test page (play.html).
const play = import.meta.env.DEV && (params.has('play-solo') || params.has('play-net'));
if (play) location.replace(`/play.html${location.search}`);
const debug = import.meta.env.DEV && (params.has('debug-sim') || params.has('debug-net'));

if (play) {
  // Redirecting.
} else if (debug) {
  document.body.classList.add('debug');
  const canvas = document.createElement('canvas');
  canvas.id = 'game';
  document.body.append(canvas);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D is not available');
  if (params.has('debug-sim'))
    void import('./debug-sim.js').then((m) => m.startDebugSim(canvas, ctx));
  else void import('./debug-net.js').then((m) => m.startDebugNet(canvas, ctx));
} else {
  void Promise.all([
    import('./app/app.js'),
    import('./screens/index.js'),
    import('./app/ui-sounds.js'),
    import('./input-device.js'),
    import('./menu-nav.js'),
    import('./ui-scale.js'),
  ]).then(
    ([
      { App },
      { routes },
      { wireUiSounds },
      { installInputDevice },
      { installMenuNav },
      { installUiScale },
    ]) => {
      const root = document.querySelector<HTMLElement>('#app');
      if (!root) throw new Error('#app is missing');
      wireUiSounds();
      // Prompts follow the input device in use; a gamepad moves through the menus.
      installInputDevice();
      installMenuNav();
      // The menus grow with large windows.
      installUiScale();
      const app = new App(root, routes);
      void app.boot();
    },
    // A chunk that failed to load: reload (once) or say so, rather than a blank page.
    loadFailed,
  );
}
