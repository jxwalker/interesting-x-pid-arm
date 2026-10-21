import {
  HISTORY_LEN,
  L1,
  L2,
  fk,
  type ArmState,
} from "./arm";

export interface Theme {
  bg0: string;
  bg1: string;
  grid: string;
  ghost: string;
  ghostGlow: string;
  linkA: string;
  linkB: string;
  joint: string;
  tip: string;
  tipGlow: string;
  trail: string;
  target: string;
  plotBg: string;
  err: string;
  torque: string;
  kick: string;
  payload: string;
}

export const THEME: Theme = {
  bg0: "#071018",
  bg1: "#0c1a24",
  grid: "rgba(120, 170, 190, 0.07)",
  ghost: "rgba(120, 210, 230, 0.22)",
  ghostGlow: "rgba(90, 220, 240, 0.12)",
  linkA: "#c8d4de",
  linkB: "#9eb0c0",
  joint: "#e8f0f6",
  tip: "#5eead4",
  tipGlow: "rgba(94, 234, 212, 0.55)",
  trail: "rgba(94, 234, 212, 0.55)",
  target: "#fb923c",
  plotBg: "rgba(4, 14, 22, 0.72)",
  err: "#5eead4",
  torque: "#fb923c",
  kick: "#f87171",
  payload: "#fbbf24",
};

export function resizeCanvas(
  canvas: HTMLCanvasElement,
  cssW: number,
  cssH: number,
): { width: number; height: number; dpr: number } {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const width = Math.max(1, Math.floor(cssW));
  const height = Math.max(1, Math.floor(cssH));
  canvas.width = Math.floor(width * dpr);
  canvas.height = Math.floor(height * dpr);
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  const ctx = canvas.getContext("2d");
  if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { width, height, dpr };
}

/** Map world coords (+y up, base at origin) → canvas pixels. */
export interface Cam {
  ox: number;
  oy: number;
  scale: number;
}

/**
 * Fit the full reachable disk (radius L1+L2) inside the canvas so a limp arm
 * at low Kp is never clipped at the bottom. Slightly tight margins so the arm
 * still reads large on 1280×720 / OG crops.
 */
export function makeCam(width: number, height: number): Cam {
  const reach = L1 + L2;
  const margin = 28;
  const scale = Math.min(
    (width - margin * 2) / (2 * reach),
    (height - margin * 2) / (2 * reach),
  );
  // tip_y = oy - worldY * scale; keep ±reach on-screen.
  const oyMin = margin + reach * scale;
  const oyMax = height - margin - reach * scale;
  // Prefer a slightly lower base so the figure-8 lives in the upper half.
  const oyIdeal = height * 0.56;
  const oy = Math.min(oyMax, Math.max(oyMin, oyIdeal));
  return {
    ox: width * 0.5,
    oy,
    scale,
  };
}

export function worldToScreen(
  cam: Cam,
  x: number,
  y: number,
): { x: number; y: number } {
  return {
    x: cam.ox + x * cam.scale,
    y: cam.oy - y * cam.scale,
  };
}

export function screenToWorld(
  cam: Cam,
  sx: number,
  sy: number,
): { x: number; y: number } {
  return {
    x: (sx - cam.ox) / cam.scale,
    y: (cam.oy - sy) / cam.scale,
  };
}

function drawGrid(ctx: CanvasRenderingContext2D, w: number, h: number, t: number): void {
  ctx.save();
  ctx.strokeStyle = THEME.grid;
  ctx.lineWidth = 1;
  const step = 36;
  const drift = (t * 0.012) % step;
  for (let x = -step + drift; x < w + step; x += step) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();
  }
  for (let y = -step + drift * 0.6; y < h + step; y += step) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
  }
  ctx.restore();
}

function drawLink(
  ctx: CanvasRenderingContext2D,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  width: number,
  color: string,
  glow: boolean,
): void {
  const ang = Math.atan2(y1 - y0, x1 - x0);
  const len = Math.hypot(x1 - x0, y1 - y0);
  ctx.save();
  ctx.translate(x0, y0);
  ctx.rotate(ang);

  if (glow) {
    ctx.shadowColor = "rgba(94, 234, 212, 0.35)";
    ctx.shadowBlur = 18;
  }

  // Capsule body.
  const r = width * 0.5;
  const grad = ctx.createLinearGradient(0, -r, 0, r);
  grad.addColorStop(0, "#f2f7fb");
  grad.addColorStop(0.35, color);
  grad.addColorStop(0.7, shade(color, -28));
  grad.addColorStop(1, shade(color, -48));

  ctx.beginPath();
  ctx.moveTo(r, -r);
  ctx.lineTo(len - r, -r);
  ctx.arc(len - r, 0, r, -Math.PI / 2, Math.PI / 2);
  ctx.lineTo(r, r);
  ctx.arc(r, 0, r, Math.PI / 2, -Math.PI / 2);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();

  // Specular stripe.
  ctx.shadowBlur = 0;
  ctx.beginPath();
  ctx.moveTo(r + 4, -r * 0.45);
  ctx.lineTo(len - r - 2, -r * 0.45);
  ctx.strokeStyle = "rgba(255,255,255,0.45)";
  ctx.lineWidth = Math.max(1.5, r * 0.28);
  ctx.lineCap = "round";
  ctx.stroke();

  ctx.restore();
}

function shade(hex: string, amount: number): string {
  const n = hex.replace("#", "");
  const num = Number.parseInt(n.length === 3 ? n.split("").map((c) => c + c).join("") : n, 16);
  const r = Math.min(255, Math.max(0, ((num >> 16) & 255) + amount));
  const g = Math.min(255, Math.max(0, ((num >> 8) & 255) + amount));
  const b = Math.min(255, Math.max(0, (num & 255) + amount));
  return `rgb(${r},${g},${b})`;
}

function drawJoint(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
): void {
  const g = ctx.createRadialGradient(x - r * 0.3, y - r * 0.3, 1, x, y, r);
  g.addColorStop(0, "#ffffff");
  g.addColorStop(0.45, THEME.joint);
  g.addColorStop(1, "#6b7c8c");
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = g;
  ctx.fill();
  ctx.beginPath();
  ctx.arc(x, y, r * 0.35, 0, Math.PI * 2);
  ctx.fillStyle = "#1a2834";
  ctx.fill();
}

function drawGhostArm(
  ctx: CanvasRenderingContext2D,
  cam: Cam,
  th1: number,
  th2: number,
): void {
  const pose = fk(th1, th2);
  const base = worldToScreen(cam, 0, 0);
  const elbow = worldToScreen(cam, pose.elbowX, pose.elbowY);
  const tip = worldToScreen(cam, pose.x, pose.y);

  ctx.save();
  ctx.strokeStyle = THEME.ghost;
  ctx.lineWidth = 7;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.setLineDash([6, 8]);
  ctx.shadowColor = THEME.ghostGlow;
  ctx.shadowBlur = 12;
  ctx.beginPath();
  ctx.moveTo(base.x, base.y);
  ctx.lineTo(elbow.x, elbow.y);
  ctx.lineTo(tip.x, tip.y);
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.beginPath();
  ctx.arc(tip.x, tip.y, 9, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(251, 146, 60, 0.35)";
  ctx.fill();
  ctx.strokeStyle = THEME.target;
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.restore();
}

function drawTrail(ctx: CanvasRenderingContext2D, cam: Cam, arm: ArmState): void {
  const n = Math.min(arm.trailLen, arm.trailI);
  if (n < 2) return;
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (let k = 1; k < n; k += 1) {
    const i0 = (arm.trailI - n + k - 1 + arm.trailLen * 8) % arm.trailLen;
    const i1 = (arm.trailI - n + k + arm.trailLen * 8) % arm.trailLen;
    const a = worldToScreen(cam, arm.trail[i0 * 2]!, arm.trail[i0 * 2 + 1]!);
    const b = worldToScreen(cam, arm.trail[i1 * 2]!, arm.trail[i1 * 2 + 1]!);
    const alpha = (k / n) * 0.55;
    ctx.strokeStyle = `rgba(94, 234, 212, ${alpha})`;
    ctx.lineWidth = 1.5 + (k / n) * 3.5;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }
  ctx.restore();
}

function drawPlot(
  ctx: CanvasRenderingContext2D,
  arm: ArmState,
  x: number,
  y: number,
  w: number,
  h: number,
): void {
  ctx.save();
  // Rounded panel.
  const r = 10;
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
  ctx.fillStyle = THEME.plotBg;
  ctx.fill();
  ctx.strokeStyle = "rgba(130, 190, 210, 0.18)";
  ctx.lineWidth = 1;
  ctx.stroke();

  ctx.fillStyle = "rgba(180, 210, 220, 0.55)";
  ctx.font = "500 10px 'IBM Plex Mono', monospace";
  ctx.fillText("error", x + 10, y + 14);
  ctx.fillStyle = "rgba(251, 146, 60, 0.7)";
  ctx.fillText("torque", x + 52, y + 14);

  const pad = 8;
  const plotX = x + pad;
  const plotY = y + 20;
  const plotW = w - pad * 2;
  const plotH = h - 28;
  const filled = arm.histFilled;
  if (filled < 2) {
    ctx.restore();
    return;
  }

  const drawSeries = (
    data: Float32Array,
    color: string,
    scaleY: number,
  ): void => {
    ctx.beginPath();
    for (let i = 0; i < filled; i += 1) {
      const idx = (arm.histI - filled + i + HISTORY_LEN) % HISTORY_LEN;
      const px = plotX + (i / (HISTORY_LEN - 1)) * plotW;
      const py = plotY + plotH - Math.min(1, data[idx]! * scaleY) * plotH;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.6;
    ctx.stroke();
  };

  drawSeries(arm.errHist, THEME.err, 1.35);
  drawSeries(arm.torqueHist, THEME.torque, 1);

  ctx.restore();
}

function drawBase(ctx: CanvasRenderingContext2D, cam: Cam): void {
  const b = worldToScreen(cam, 0, 0);
  ctx.save();
  // Pedestal.
  const w = 54;
  const h = 18;
  const grad = ctx.createLinearGradient(b.x, b.y, b.x, b.y + h + 8);
  grad.addColorStop(0, "#2a3a48");
  grad.addColorStop(1, "#121c24");
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.moveTo(b.x - w, b.y + 4);
  ctx.lineTo(b.x + w, b.y + 4);
  ctx.lineTo(b.x + w * 0.85, b.y + h + 10);
  ctx.lineTo(b.x - w * 0.85, b.y + h + 10);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = "rgba(180, 210, 230, 0.25)";
  ctx.stroke();

  // Floor shadow.
  ctx.beginPath();
  ctx.ellipse(b.x, b.y + h + 14, 70, 10, 0, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(0,0,0,0.35)";
  ctx.fill();
  ctx.restore();
}

export function paintStage(
  canvas: HTMLCanvasElement,
  arm: ArmState,
  cam: Cam,
  width: number,
  height: number,
  timeMs: number,
): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  // Atmosphere.
  const bg = ctx.createLinearGradient(0, 0, width, height);
  bg.addColorStop(0, THEME.bg0);
  bg.addColorStop(0.55, THEME.bg1);
  bg.addColorStop(1, "#08141c");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, width, height);

  // Soft vignette glow behind workspace.
  const glow = ctx.createRadialGradient(
    cam.ox,
    cam.oy - cam.scale * 0.9,
    20,
    cam.ox,
    cam.oy - cam.scale * 0.6,
    cam.scale * 2.2,
  );
  glow.addColorStop(0, "rgba(94, 234, 212, 0.07)");
  glow.addColorStop(0.5, "rgba(251, 146, 60, 0.04)");
  glow.addColorStop(1, "transparent");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, width, height);

  drawGrid(ctx, width, height, timeMs);
  drawBase(ctx, cam);
  drawGhostArm(ctx, cam, arm.desired[0], arm.desired[1]);
  drawTrail(ctx, cam, arm);

  const [j1, j2] = arm.joints;
  const pose = fk(j1.theta, j2.theta);
  const base = worldToScreen(cam, 0, 0);
  const elbow = worldToScreen(cam, pose.elbowX, pose.elbowY);
  const tip = worldToScreen(cam, pose.x, pose.y);

  // Kick flash ring + sparks.
  if (arm.kickFlash > 0) {
    ctx.save();
    const flash = arm.kickFlash;
    ctx.beginPath();
    ctx.arc(tip.x, tip.y, 18 + (1 - flash) * 52, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(248, 113, 113, ${flash * 0.9})`;
    ctx.lineWidth = 3.5;
    ctx.stroke();
    for (let s = 0; s < 8; s += 1) {
      const ang = (s / 8) * Math.PI * 2 + flash * 2;
      const rad = 22 + (1 - flash) * 36;
      ctx.beginPath();
      ctx.arc(
        tip.x + Math.cos(ang) * rad,
        tip.y + Math.sin(ang) * rad,
        2.2 + flash,
        0,
        Math.PI * 2,
      );
      ctx.fillStyle = `rgba(255, 180, 120, ${flash})`;
      ctx.fill();
    }
    ctx.restore();
  }

  drawLink(ctx, base.x, base.y, elbow.x, elbow.y, 22, THEME.linkA, false);
  drawLink(ctx, elbow.x, elbow.y, tip.x, tip.y, 16, THEME.linkB, true);
  drawJoint(ctx, base.x, base.y, 11);
  drawJoint(ctx, elbow.x, elbow.y, 9);

  // End effector glow.
  ctx.save();
  ctx.shadowColor = THEME.tipGlow;
  ctx.shadowBlur = 22;
  const tipGrad = ctx.createRadialGradient(
    tip.x - 3,
    tip.y - 3,
    1,
    tip.x,
    tip.y,
    12,
  );
  tipGrad.addColorStop(0, "#dffcf6");
  tipGrad.addColorStop(0.4, THEME.tip);
  tipGrad.addColorStop(1, "#0f766e");
  ctx.beginPath();
  ctx.arc(tip.x, tip.y, 11, 0, Math.PI * 2);
  ctx.fillStyle = tipGrad;
  ctx.fill();
  ctx.restore();

  // Payload mass hanging from tip.
  if (arm.payload > 0.05) {
    const drop = 14 + arm.payload * 6;
    ctx.save();
    ctx.strokeStyle = "rgba(251, 191, 36, 0.65)";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(tip.x, tip.y + 10);
    ctx.lineTo(tip.x, tip.y + drop);
    ctx.stroke();
    const pr = 6 + arm.payload * 2.2;
    ctx.beginPath();
    ctx.arc(tip.x, tip.y + drop + pr * 0.2, pr, 0, Math.PI * 2);
    ctx.fillStyle = THEME.payload;
    ctx.shadowColor = "rgba(251, 191, 36, 0.5)";
    ctx.shadowBlur = 12;
    ctx.fill();
    ctx.restore();
  }

  // Target crosshair (world target).
  const tgt = worldToScreen(cam, arm.targetX, arm.targetY);
  ctx.save();
  ctx.strokeStyle = THEME.target;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(tgt.x, tgt.y, 14, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(tgt.x - 18, tgt.y);
  ctx.lineTo(tgt.x + 18, tgt.y);
  ctx.moveTo(tgt.x, tgt.y - 18);
  ctx.lineTo(tgt.x, tgt.y + 18);
  ctx.stroke();
  ctx.restore();

  drawDominantLabel(ctx, arm, width);

  // Live plot (bottom-right of stage).
  const plotW = Math.min(220, width * 0.36);
  const plotH = 72;
  drawPlot(ctx, arm, width - plotW - 12, height - plotH - 12, plotW, plotH);
}

function drawDominantLabel(
  ctx: CanvasRenderingContext2D,
  arm: ArmState,
  width: number,
): void {
  let label: string;
  let color: string;
  switch (arm.dominant) {
    case "P":
      label = "P drives";
      color = THEME.tip;
      break;
    case "I":
      label = "I holds";
      color = THEME.payload;
      break;
    case "D":
      label = "D damps";
      color = "#93c5fd";
      break;
    default: {
      const _exhaustive: never = arm.dominant;
      void _exhaustive;
      label = "P drives";
      color = THEME.tip;
      break;
    }
  }

  ctx.save();
  ctx.font = "600 12px 'Space Grotesk', 'Segoe UI', sans-serif";
  const textW = ctx.measureText(label).width;
  const padX = 10;
  const padY = 7;
  const boxW = textW + padX * 2;
  const boxH = 26;
  const x = width - boxW - 12;
  const y = 12;
  const r = 8;
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + boxW, y, x + boxW, y + boxH, r);
  ctx.arcTo(x + boxW, y + boxH, x, y + boxH, r);
  ctx.arcTo(x, y + boxH, x, y, r);
  ctx.arcTo(x, y, x + boxW, y, r);
  ctx.closePath();
  ctx.fillStyle = "rgba(4, 14, 22, 0.72)";
  ctx.fill();
  ctx.strokeStyle = "rgba(130, 190, 210, 0.2)";
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.fillStyle = color;
  ctx.fillText(label, x + padX, y + padY + 11);
  ctx.restore();
}
