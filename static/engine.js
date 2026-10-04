// The hot path: tilt -> steering, pedal/button state, and the 60 Hz WebSocket feed to the PC.
// Kept outside Preact on purpose; the UI only reads `state` (and writes pedals/buttons).
import { steerCurve, bitOf } from "./settings.js";

export const state = { steer: 0, gas: 0, brake: 0, connected: false, paired: null, gotMotion: false, paused: false };

// Pairing code from the QR link (?t=...). Remembered so opening the bare address later still works.
let token = new URLSearchParams(location.search).get("t") || "";
try {
  if (token) localStorage.setItem("pw-token", token);
  else token = localStorage.getItem("pw-token") || "";
} catch (_) {}
export const hasToken = () => !!token;

let cfg = null;
let fullLockDeg = 45, follow = 0.8;
let rawDeg = 0, smoothDeg = 0, offsetDeg = 0;
let flipped = false, lastOrientation = 0;
const held = new Map(); // on-screen button index -> bit it presses
let buttonsKey = "";
let ws = null, started = false;
const statusListeners = new Set();

export function setConfig(c) {
  cfg = c;
  fullLockDeg = 85 - c.steer.sensitivity; // higher sensitivity = less tilt for full lock
  follow = 1 - c.steer.smoothing / 100;   // 0 smoothing = raw sensor angle
  const key = JSON.stringify(c.buttons);
  if (key !== buttonsKey) { buttonsKey = key; held.clear(); } // bindings changed, let go of everything
}

export function onStatus(fn) {
  statusListeners.add(fn);
  return () => { statusListeners.delete(fn); };
}
function setLink(connected, paired) {
  state.connected = connected;
  state.paired = paired;
  statusListeners.forEach((fn) => fn({ connected, paired }));
}

export function setButton(index, down) {
  if (down && cfg.buttons[index]) held.set(index, bitOf(cfg.buttons[index].bind));
  else held.delete(index);
}
function keys() {
  let k = 0;
  for (const bit of held.values()) k |= 1 << bit;
  return k;
}

export function center() { offsetDeg = smoothDeg; }

// ---------- tilt -> steering angle
const wrap = (d) => ((d + 540) % 360) - 180; // keep math continuous across the +/-180 seam

function screenAngle() {
  if (screen.orientation && typeof screen.orientation.angle === "number") return screen.orientation.angle;
  return typeof window.orientation === "number" ? window.orientation : 90;
}

function tiltDegrees(ax, ay) {
  const a = ((screenAngle() % 360) + 360) % 360;
  // "Up" direction for a level wheel in this orientation, in phone sensor axes.
  let ux = 0, uy = 1;                       // portrait fallback
  if (a === 90)  { ux = 1;  uy = 0; }       // landscape, top of phone on the left
  if (a === 270) { ux = -1; uy = 0; }       // landscape, top of phone on the right
  // Some Android builds report gravity with the opposite sign. Only re-decide while the
  // phone is near level, so a big tilt past 90 degrees can't flip it.
  const dot = ax * ux + ay * uy;
  if (Math.abs(dot) > 0.7 * Math.hypot(ax, ay)) flipped = dot < 0;
  if (flipped) { ux = -ux; uy = -uy; }
  return Math.atan2(ux * ay - uy * ax, ux * ax + uy * ay) * (180 / Math.PI);
}

function updateSteer(ux, uy, smoothing) {
  state.gotMotion = true;
  rawDeg = tiltDegrees(ux, uy);
  smoothDeg = wrap(smoothDeg + wrap(rawDeg - smoothDeg) * smoothing);
  let v = wrap(smoothDeg - offsetDeg) / fullLockDeg;
  v = steerCurve(Math.max(-1, Math.min(1, v)), cfg.steer);
  state.steer = cfg.steer.invert ? -v : v;
}

// Chrome's deviceorientation is fused from gyro + accelerometer by Android, so it reacts
// much faster than raw accelerometer data. devicemotion is only the fallback.
function onOrientation(e) {
  if (e.beta == null || e.gamma == null) return;
  lastOrientation = performance.now();
  // "Up" (opposite of gravity) in phone axes, from the beta/gamma Euler angles.
  const R = Math.PI / 180, b = e.beta * R, c = e.gamma * R;
  updateSteer(-Math.cos(b) * Math.sin(c), Math.sin(b), follow);
}
function onMotion(e) {
  if (performance.now() - lastOrientation < 250) return; // fused data is flowing, use that
  const g = e.accelerationIncludingGravity;
  if (!g || g.x == null) return;
  updateSteer(g.x, g.y, Math.min(follow, 0.35)); // accelerometer is noisy, always smooth it some
}

// ---------- connection
function connect() {
  const t = encodeURIComponent(token);
  ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws?t=${t}`);
  ws.onopen = () => setLink(true, true);
  ws.onclose = async () => {
    // A browser can't see why a WebSocket failed, so ask whether the pairing code is the problem.
    let paired = null;
    try { paired = (await fetch(`/check?t=${t}`, { cache: "no-store" })).ok; } catch (_) {}
    setLink(false, paired);
    setTimeout(connect, paired === false ? 3000 : 1000);
  };
  ws.onerror = () => ws.close();
}

export function start() {
  if (started) return;
  started = true;
  window.addEventListener("deviceorientation", onOrientation);
  window.addEventListener("devicemotion", onMotion);
  connect();
  setInterval(() => {
    if (!ws || ws.readyState !== 1) return;
    const p = state.paused; // settings open: pedals and buttons are let go, steering stays live
    ws.send(JSON.stringify({
      s: +state.steer.toFixed(3),
      g: p ? 0 : +state.gas.toFixed(3),
      b: p ? 0 : +state.brake.toFixed(3),
      k: p ? 0 : keys(),
    }));
  }, 16);
  setTimeout(center, 400); // treat the starting position as center
}
