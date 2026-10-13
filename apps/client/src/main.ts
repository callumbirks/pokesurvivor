import './styles.css';

// Dev-only views (excluded from production builds): /?debug-sim runs the sim locally,
// /?debug-net plays over the network against the game server. Everything else is the app.
const params = new URLSearchParams(location.search);
const debug = import.meta.env.DEV && (params.has('debug-sim') || params.has('debug-net'));

if (debug) {
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
  void Promise.all([import('./app/app.js'), import('./screens/index.js')]).then(
    ([{ App }, { routes }]) => {
      const root = document.querySelector<HTMLElement>('#app');
      if (!root) throw new Error('#app is missing');
      const app = new App(root, routes);
      void app.boot();
    },
  );
}
