const canvas = document.querySelector<HTMLCanvasElement>('#game');
const ctx = canvas?.getContext('2d');
if (!canvas || !ctx) throw new Error('Canvas 2D is not available');

// Dev-only views (excluded from production builds): /?debug-sim runs the sim locally,
// /?debug-net plays over the network against the game server.
const params = new URLSearchParams(location.search);
if (import.meta.env.DEV && params.has('debug-sim'))
  void import('./debug-sim.js').then((m) => m.startDebugSim(canvas, ctx));
else if (import.meta.env.DEV && params.has('debug-net'))
  void import('./debug-net.js').then((m) => m.startDebugNet(canvas, ctx));
else void start();

/** Placeholder until the phase 4 client: shows that the server is up. */
async function start(): Promise<void> {
  let status = 'server: …';
  try {
    const info = (await (await fetch('/api/info')).json()) as { protocolVersion: number };
    status = `server: up (protocol ${info.protocolVersion})`;
  } catch {
    status = 'server: unreachable';
  }
  const draw = () => {
    if (!canvas || !ctx) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(canvas.clientWidth * dpr);
    canvas.height = Math.round(canvas.clientHeight * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#111';
    ctx.fillRect(0, 0, canvas.clientWidth, canvas.clientHeight);
    ctx.fillStyle = '#eee';
    ctx.font = '20px system-ui, sans-serif';
    ctx.fillText('PokéSurvivor', 24, 40);
    ctx.font = '16px ui-monospace, monospace';
    ctx.fillText(status, 24, 72);
  };
  draw();
  addEventListener('resize', draw);
}
