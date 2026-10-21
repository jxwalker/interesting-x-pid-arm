/** Two-joint planar arm + independent PID controllers with gravity. */

export const L1 = 1.05;
export const L2 = 0.82;
export const BASE_MASS_1 = 1.35;
export const BASE_MASS_2 = 0.95;
export const GRAVITY = 10.5;
/** Passive viscous damping — keep low so Kd is the visible damper. */
export const DAMPING = 0.12;
export const TORQUE_LIMIT = 85;
export const INTEGRAL_LIMIT = 4.8;
export const HISTORY_LEN = 160;

export type PresetId = "sloppy" | "tuned" | "jittery";
export type DominantTerm = "P" | "I" | "D";

export interface PidGains {
  kp: number;
  ki: number;
  kd: number;
}

export interface PresetDef {
  id: PresetId;
  label: string;
  hint: string;
  gains: PidGains;
}

export const PRESETS: Record<PresetId, PresetDef> = {
  sloppy: {
    id: "sloppy",
    label: "Sloppy",
    hint: "no I · tiny D",
    // Ki=0 → gravity sag stays; Kd≈0 → kick rings forever.
    gains: { kp: 18, ki: 0, kd: 0.05 },
  },
  tuned: {
    id: "tuned",
    label: "Tuned",
    hint: "snappy tracking",
    gains: { kp: 62, ki: 14, kd: 7.2 },
  },
  jittery: {
    id: "jittery",
    label: "Jittery",
    hint: "high P · thin D",
    gains: { kp: 115, ki: 2.5, kd: 0.22 },
  },
};

export const KP_MIN = 2;
export const KP_MAX = 120;
export const KI_MIN = 0;
export const KI_MAX = 24;
export const KD_MIN = 0;
export const KD_MAX = 14;

export interface Joint {
  theta: number;
  omega: number;
  integral: number;
  prevError: number;
  torque: number;
  error: number;
  termP: number;
  termI: number;
  termD: number;
}

export interface ArmState {
  joints: [Joint, Joint];
  /** Extra end-effector mass (payload). */
  payload: number;
  /** Impulse countdown for visual kick flash. */
  kickFlash: number;
  targetX: number;
  targetY: number;
  desired: [number, number];
  trail: Float32Array;
  trailLen: number;
  trailI: number;
  errHist: Float32Array;
  torqueHist: Float32Array;
  histI: number;
  histFilled: number;
  rmsError: number;
  peakTorque: number;
  /** Absolute PID term magnitudes (summed across joints), smoothed. */
  termP: number;
  termI: number;
  termD: number;
  dominant: DominantTerm;
}

function makeJoint(theta: number): Joint {
  return {
    theta,
    omega: 0,
    integral: 0,
    prevError: 0,
    torque: 0,
    error: 0,
    termP: 0,
    termI: 0,
    termD: 0,
  };
}

export function createArm(): ArmState {
  const shoulder = Math.PI * 0.55;
  const elbow = -Math.PI * 0.75;
  const tip = fk(shoulder, elbow);
  const trailLen = 48;
  return {
    joints: [makeJoint(shoulder), makeJoint(elbow)],
    payload: 0,
    kickFlash: 0,
    targetX: tip.x,
    targetY: tip.y,
    desired: [shoulder, elbow],
    trail: new Float32Array(trailLen * 2),
    trailLen,
    trailI: 0,
    errHist: new Float32Array(HISTORY_LEN),
    torqueHist: new Float32Array(HISTORY_LEN),
    histI: 0,
    histFilled: 0,
    rmsError: 0,
    peakTorque: 0,
    termP: 0,
    termI: 0,
    termD: 0,
    dominant: "P",
  };
}

/** Forward kinematics: base at origin, +y up. Angles from +x axis. */
export function fk(
  theta1: number,
  theta2: number,
): { x: number; y: number; elbowX: number; elbowY: number } {
  const elbowX = L1 * Math.cos(theta1);
  const elbowY = L1 * Math.sin(theta1);
  const x = elbowX + L2 * Math.cos(theta1 + theta2);
  const y = elbowY + L2 * Math.sin(theta1 + theta2);
  return { x, y, elbowX, elbowY };
}

/**
 * Analytic 2-link IK. Prefer the elbow-down solution that stays continuous
 * with the previous desired angles.
 */
export function ik(
  x: number,
  y: number,
  prev: readonly [number, number],
): [number, number] {
  const reach = Math.hypot(x, y);
  const maxR = L1 + L2 - 0.02;
  const minR = Math.abs(L1 - L2) + 0.02;
  const r = Math.min(maxR, Math.max(minR, reach));
  const scale = r / Math.max(1e-6, reach);
  const tx = x * scale;
  const ty = y * scale;

  const cosElbow =
    (tx * tx + ty * ty - L1 * L1 - L2 * L2) / (2 * L1 * L2);
  const c2 = Math.min(1, Math.max(-1, cosElbow));
  const sinMag = Math.sqrt(Math.max(0, 1 - c2 * c2));

  // Two elbow solutions; pick closer to previous.
  const candidates: [number, number][] = [];
  for (const s of [sinMag, -sinMag]) {
    const theta2 = Math.atan2(s, c2);
    const k1 = L1 + L2 * c2;
    const k2 = L2 * s;
    const theta1 = Math.atan2(ty, tx) - Math.atan2(k2, k1);
    candidates.push([theta1, theta2]);
  }

  let best = candidates[0]!;
  let bestCost = Infinity;
  for (const c of candidates) {
    const d1 = wrapAngle(c[0] - prev[0]);
    const d2 = wrapAngle(c[1] - prev[1]);
    const cost = d1 * d1 + d2 * d2;
    if (cost < bestCost) {
      bestCost = cost;
      best = c;
    }
  }
  return best;
}

export function wrapAngle(a: number): number {
  let x = a;
  while (x > Math.PI) x -= Math.PI * 2;
  while (x < -Math.PI) x += Math.PI * 2;
  return x;
}

/** Figure-eight (lemniscate of Gerono) biased laterally so gravity torque stays real. */
export function figureEight(t: number): { x: number; y: number } {
  const sx = 0.88;
  const sy = 0.48;
  const cx = 0.42;
  const cy = 0.92;
  return {
    x: cx + sx * Math.sin(t),
    y: cy + sy * Math.sin(t) * Math.cos(t),
  };
}

export function cloneGains(g: PidGains): PidGains {
  return { kp: g.kp, ki: g.ki, kd: g.kd };
}

export function nearestPreset(g: PidGains): PresetId | "custom" {
  for (const id of Object.keys(PRESETS) as PresetId[]) {
    const p = PRESETS[id].gains;
    if (
      Math.abs(p.kp - g.kp) < 0.05 &&
      Math.abs(p.ki - g.ki) < 0.05 &&
      Math.abs(p.kd - g.kd) < 0.05
    ) {
      return id;
    }
  }
  return "custom";
}

function pidTorque(
  joint: Joint,
  desired: number,
  gains: PidGains,
  dt: number,
): number {
  const error = wrapAngle(desired - joint.theta);
  const derivative = dt > 1e-6 ? (error - joint.prevError) / dt : 0;
  joint.prevError = error;
  joint.error = error;
  const termP = gains.kp * error;
  const termI = gains.ki * joint.integral;
  const termD = gains.kd * derivative;
  joint.termP = termP;
  joint.termI = termI;
  joint.termD = termD;
  let tau = termP + termI + termD;
  const saturated =
    tau > TORQUE_LIMIT - 1e-6 || tau < -TORQUE_LIMIT + 1e-6;
  // Conditional integration: freeze I when saturated in the same direction
  // as the error so wind-up does not hide Ki recovery.
  if (!saturated || Math.sign(error) !== Math.sign(tau)) {
    joint.integral += error * dt;
    joint.integral = Math.min(
      INTEGRAL_LIMIT,
      Math.max(-INTEGRAL_LIMIT, joint.integral),
    );
  }
  tau = termP + gains.ki * joint.integral + termD;
  joint.termI = gains.ki * joint.integral;
  tau = Math.min(TORQUE_LIMIT, Math.max(-TORQUE_LIMIT, tau));
  joint.torque = tau;
  return tau;
}

function updateDominant(arm: ArmState): void {
  const [j1, j2] = arm.joints;
  const rawP = Math.abs(j1.termP) + Math.abs(j2.termP);
  const rawI = Math.abs(j1.termI) + Math.abs(j2.termI);
  const rawD = Math.abs(j1.termD) + Math.abs(j2.termD);
  // Light EMA so the on-canvas label does not flicker.
  const a = 0.18;
  arm.termP = arm.termP * (1 - a) + rawP * a;
  arm.termI = arm.termI * (1 - a) + rawI * a;
  arm.termD = arm.termD * (1 - a) + rawD * a;

  let next: DominantTerm = "P";
  let best = arm.termP;
  if (arm.termI > best) {
    best = arm.termI;
    next = "I";
  }
  if (arm.termD > best) {
    next = "D";
  }
  arm.dominant = next;
}

/**
 * Semi-implicit Euler step with gravity on both links and optional payload
 * mass at the tip. Controllers command joint torques independently.
 */
export function stepArm(
  arm: ArmState,
  gains: PidGains,
  dt: number,
): void {
  const dtClamped = Math.min(0.033, Math.max(0.001, dt));
  const [j1, j2] = arm.joints;
  const m1 = BASE_MASS_1;
  const m2 = BASE_MASS_2 + arm.payload;

  const tau1 = pidTorque(j1, arm.desired[0], gains, dtClamped);
  const tau2 = pidTorque(j2, arm.desired[1], gains, dtClamped);
  updateDominant(arm);

  // Approximate gravity torques (y-up world).
  const g = GRAVITY;
  const th1 = j1.theta;
  const th2 = j1.theta + j2.theta;
  const g1 =
    -g *
    ((m1 * 0.5 + m2) * L1 * Math.cos(th1) +
      m2 * 0.5 * L2 * Math.cos(th2));
  const g2 = -g * m2 * 0.5 * L2 * Math.cos(th2);

  const I1 = m1 * L1 * L1 * 0.33 + m2 * L1 * L1;
  const I2 = m2 * L2 * L2 * 0.33 + 0.12 * arm.payload;

  const a1 = (tau1 + g1 - DAMPING * j1.omega) / Math.max(0.2, I1);
  const a2 = (tau2 + g2 - DAMPING * j2.omega) / Math.max(0.12, I2);

  j1.omega += a1 * dtClamped;
  j2.omega += a2 * dtClamped;
  // Soft velocity clamps keep extreme gains from exploding.
  j1.omega = Math.min(16, Math.max(-16, j1.omega));
  j2.omega = Math.min(18, Math.max(-18, j2.omega));
  j1.theta += j1.omega * dtClamped;
  j2.theta += j2.omega * dtClamped;

  const tip = fk(j1.theta, j2.theta);
  const ti = arm.trailI % arm.trailLen;
  arm.trail[ti * 2] = tip.x;
  arm.trail[ti * 2 + 1] = tip.y;
  arm.trailI += 1;

  const tipErr = Math.hypot(arm.targetX - tip.x, arm.targetY - tip.y);
  const torqueMag = Math.abs(j1.torque) + Math.abs(j2.torque);
  arm.errHist[arm.histI] = tipErr;
  arm.torqueHist[arm.histI] = torqueMag / TORQUE_LIMIT;
  arm.histI = (arm.histI + 1) % HISTORY_LEN;
  arm.histFilled = Math.min(HISTORY_LEN, arm.histFilled + 1);

  let errSq = 0;
  let peak = 0;
  for (let i = 0; i < arm.histFilled; i += 1) {
    const e = arm.errHist[i]!;
    errSq += e * e;
    const t = arm.torqueHist[i]!;
    if (t > peak) peak = t;
  }
  arm.rmsError = Math.sqrt(errSq / Math.max(1, arm.histFilled));
  arm.peakTorque = peak;

  if (arm.kickFlash > 0) {
    arm.kickFlash = Math.max(0, arm.kickFlash - dtClamped * 1.8);
  }
}

export function setTarget(arm: ArmState, x: number, y: number): void {
  arm.targetX = x;
  arm.targetY = y;
  arm.desired = ik(x, y, arm.desired);
}

export function kickArm(arm: ArmState): void {
  arm.joints[0].omega += (Math.random() > 0.5 ? 1 : -1) * (9.5 + Math.random() * 4);
  arm.joints[1].omega += (Math.random() > 0.5 ? 1 : -1) * (12.5 + Math.random() * 5);
  arm.kickFlash = 1;
}

export function addPayload(arm: ArmState): void {
  arm.payload = Math.min(3.6, arm.payload + 1.2);
  // Instant sag impulse so the weight is visible immediately.
  arm.joints[0].omega -= 1.6;
  arm.joints[1].omega -= 2.8;
}

export function clearPayload(arm: ArmState): void {
  arm.payload = 0;
}

export function resetIntegrators(arm: ArmState): void {
  for (const j of arm.joints) {
    j.integral = 0;
    j.prevError = 0;
    j.termP = 0;
    j.termI = 0;
    j.termD = 0;
  }
  arm.termP = 0;
  arm.termI = 0;
  arm.termD = 0;
  arm.dominant = "P";
}
