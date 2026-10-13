import { Connection, socketUrl } from './connection.js';

const canvas = document.querySelector<HTMLCanvasElement>('#game');
const ctx = canvas?.getContext('2d');
if (!canvas || !ctx) throw new Error('Canvas 2D is not available');

const connection = new Connection(socketUrl(location));

function frame(): void {
  if (!canvas || !ctx) return;
  const dpr = window.devicePixelRatio || 1;
  const width = Math.round(canvas.clientWidth * dpr);
  const height = Math.round(canvas.clientHeight * dpr);
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#111';
  ctx.fillRect(0, 0, canvas.clientWidth, canvas.clientHeight);
  ctx.fillStyle = '#eee';
  ctx.font = '20px system-ui, sans-serif';
  ctx.fillText('PokéSurvivor', 24, 40);
  ctx.font = '16px ui-monospace, monospace';
  ctx.fillText(`server: ${connection.state}`, 24, 72);
  const rtt = connection.rttMs === null ? '—' : `${connection.rttMs.toFixed(1)} ms`;
  ctx.fillText(`RTT: ${rtt}`, 24, 96);

  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
