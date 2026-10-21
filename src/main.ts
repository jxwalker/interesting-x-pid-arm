import "./styles.css";
import {
  KD_MAX,
  KD_MIN,
  KI_MAX,
  KI_MIN,
  KP_MAX,
  KP_MIN,
  PRESETS,
  addPayload,
  clearPayload,
  cloneGains,
  createArm,
  figureEight,
  kickArm,
  nearestPreset,
  resetIntegrators,
  setTarget,
  stepArm,
  type PidGains,
  type PresetId,
} from "./arm";
import {
  makeCam,
  paintStage,
  resizeCanvas,
  screenToWorld,
  type Cam,
} from "./viz";

/** Throttle DOM readouts (~10 Hz) and only rewrite when text changes. */
const READOUT_INTERVAL_MS = 100;

/** Auto trajectory angular speed (rad/s). */
const TRAJ_SPEED = 1.05;

interface AppState {
  gains: PidGains;
  preset: PresetId | "custom";
  width: number;
  height: number;
  autoTraj: boolean;
  trajT: number;
  dragging: boolean;
}

function mustEl<T extends HTMLElement>(
  root: HTMLElement,
  selector: string,
  ctor: new () => T,
): T {
  const el = root.querySelector(selector);
  if (!(el instanceof ctor)) {
    throw new Error(`Missing or wrong element: ${selector}`);
  }
  return el;
}

function isRecordMode(): boolean {
  return new URLSearchParams(window.location.search).has("record");
}

function setTextIfChanged(el: HTMLElement, next: string): void {
  if (el.textContent !== next) el.textContent = next;
}

function formatGain(n: number): string {
  return n.toFixed(1);
}

function mount(): void {
  const appRoot = document.getElementById("app");
  if (!(appRoot instanceof HTMLElement)) {
    throw new Error("Missing #app");
  }
  const root = appRoot;
  const recordMode = isRecordMode();

  const boot = cloneGains(PRESETS.tuned.gains);
  const state: AppState = {
    gains: boot,
    preset: "tuned",
    width: 800,
    height: 480,
    autoTraj: true,
    trajT: 0.4,
    dragging: false,
  };

  const arm = createArm();
  // Boot slightly behind the target so the first seconds show a visible chase.
  const startPose = figureEight(state.trajT);
  setTarget(arm, startPose.x, startPose.y);
  arm.joints[0].theta = arm.desired[0] - 0.55;
  arm.joints[1].theta = arm.desired[1] + 0.85;
  arm.joints[0].omega = 0;
  arm.joints[1].omega = 0;

  let cam: Cam = makeCam(state.width, state.height);

  const presetButtons = (Object.keys(PRESETS) as PresetId[])
    .map((id) => {
      const p = PRESETS[id];
      const active = id === "tuned" ? " active" : "";
      const pressed = id === "tuned" ? "true" : "false";
      return `
      <button
        type="button"
        class="preset${active}"
        id="preset-${id}"
        data-preset="${id}"
        aria-pressed="${pressed}"
      >
        <span class="preset-label">${p.label}</span>
        <span class="preset-hint">${p.hint}</span>
      </button>`;
    })
    .join("");

  root.innerHTML = `
    <div class="grain" aria-hidden="true"></div>
    <div class="sweep" aria-hidden="true"></div>

    <header class="hero">
      <p class="brand">Interesting X</p>
      <h1 class="title">PID robot arm</h1>
      <p class="lede">
        P snaps, I fights gravity sag, D kills wobble — twist the gains and watch the arm chase.
      </p>
    </header>

    <p class="hint">
      <span class="hint-dot" aria-hidden="true"></span>
      <span>
        Drag the target, twist Kp / Ki / Kd, then Kick or Add payload and watch recovery.
      </span>
    </p>

    <aside class="explainer${recordMode ? " record-hide" : ""}" id="explainer" data-open="false">
      <button
        type="button"
        class="explainer-toggle"
        id="explainer-toggle"
        aria-expanded="false"
        aria-controls="explainer-body"
      >
        <span class="explainer-toggle-label">What am I looking at?</span>
        <span class="explainer-chevron" aria-hidden="true"></span>
      </button>
      <div class="explainer-body" id="explainer-body">
        <p>
          The glowing tip is where the arm <strong>is</strong>. The dashed ghost is where it
          <strong>should be</strong>. Each joint runs its own PID: P snaps toward the error,
          I eats steady sag from gravity, D kills overshoot. Low D looks drunk; Ki=0 leaves the
          tip hanging below the target under a payload.
        </p>
        <p>
          Inspired by
          <a href="https://x.com/oprydai/status/2106717616761094549" target="_blank" rel="noreferrer">@oprydai</a>
          on why PID “clicks” once you watch a robot move.
        </p>
      </div>
    </aside>

    <section class="stage" aria-label="PID-controlled robot arm" id="stage">
      <canvas id="canvas" role="img" aria-label="Animated two-joint robot arm"></canvas>
      <div class="hud" aria-live="polite">
        <span class="hud-item" id="hud-error">rms err 0.000</span>
        <span class="hud-item hud-accent" id="hud-mode">auto · figure-8</span>
        <span class="hud-item" id="hud-payload">payload 0.0</span>
      </div>
    </section>

    <section class="controls" aria-label="PID controls">
      <div class="presets" role="group" aria-label="Gain presets">
        ${presetButtons}
      </div>

      <div class="row">
        <div class="actions">
          <button type="button" class="btn warm" id="btn-kick">Kick</button>
          <button type="button" class="btn amber" id="btn-payload">Add payload</button>
          <button type="button" class="btn" id="btn-clear">Drop weight</button>
          <button type="button" class="btn" id="btn-auto">Resume loop</button>
        </div>
        <div class="sliders">
          <div class="field">
            <label for="param-kp">Kp · proportional</label>
            <input
              id="param-kp"
              type="range"
              min="${KP_MIN}"
              max="${KP_MAX}"
              step="0.5"
              value="${state.gains.kp}"
            />
            <div class="range-meta">
              <span>soft</span>
              <span class="val" id="kp-val">${formatGain(state.gains.kp)}</span>
              <span>snappy</span>
            </div>
          </div>
          <div class="field">
            <label for="param-ki">Ki · integral</label>
            <input
              id="param-ki"
              type="range"
              min="${KI_MIN}"
              max="${KI_MAX}"
              step="0.1"
              value="${state.gains.ki}"
            />
            <div class="range-meta">
              <span>sag</span>
              <span class="val" id="ki-val">${formatGain(state.gains.ki)}</span>
              <span>hold</span>
            </div>
          </div>
          <div class="field">
            <label for="param-kd">Kd · derivative</label>
            <input
              id="param-kd"
              type="range"
              min="${KD_MIN}"
              max="${KD_MAX}"
              step="0.05"
              value="${state.gains.kd}"
            />
            <div class="range-meta">
              <span>wobble</span>
              <span class="val" id="kd-val">${formatGain(state.gains.kd)}</span>
              <span>damped</span>
            </div>
          </div>
        </div>
      </div>
    </section>

    <p class="caption">
      Two-joint planar arm · independent joint PID · gravity + tip mass.
      Ghost arm = desired pose; trail = recent tip path; plot = tip error vs torque.
    </p>

    <footer class="foot">
      <span>apps/pid-arm</span>
      <span aria-hidden="true">·</span>
      <span>canvas 2D · no network</span>
    </footer>
  `;

  const stage = mustEl(root, "#stage", HTMLElement);
  const canvas = mustEl(root, "#canvas", HTMLCanvasElement);
  const btnKick = mustEl(root, "#btn-kick", HTMLButtonElement);
  const btnPayload = mustEl(root, "#btn-payload", HTMLButtonElement);
  const btnClear = mustEl(root, "#btn-clear", HTMLButtonElement);
  const btnAuto = mustEl(root, "#btn-auto", HTMLButtonElement);
  const paramKp = mustEl(root, "#param-kp", HTMLInputElement);
  const paramKi = mustEl(root, "#param-ki", HTMLInputElement);
  const paramKd = mustEl(root, "#param-kd", HTMLInputElement);
  const kpVal = mustEl(root, "#kp-val", HTMLElement);
  const kiVal = mustEl(root, "#ki-val", HTMLElement);
  const kdVal = mustEl(root, "#kd-val", HTMLElement);
  const hudError = mustEl(root, "#hud-error", HTMLElement);
  const hudMode = mustEl(root, "#hud-mode", HTMLElement);
  const hudPayload = mustEl(root, "#hud-payload", HTMLElement);
  const explainer = mustEl(root, "#explainer", HTMLElement);
  const explainerToggle = mustEl(root, "#explainer-toggle", HTMLButtonElement);

  let lastReadoutMs = 0;
  let lastTs = 0;
  let raf = 0;

  function syncPresetButtons(): void {
    for (const id of Object.keys(PRESETS) as PresetId[]) {
      const btn = root.querySelector(`#preset-${id}`);
      if (!(btn instanceof HTMLButtonElement)) continue;
      const on = state.preset === id;
      btn.classList.toggle("active", on);
      btn.setAttribute("aria-pressed", on ? "true" : "false");
    }
  }

  function syncSliders(): void {
    paramKp.value = String(state.gains.kp);
    paramKi.value = String(state.gains.ki);
    paramKd.value = String(state.gains.kd);
    setTextIfChanged(kpVal, formatGain(state.gains.kp));
    setTextIfChanged(kiVal, formatGain(state.gains.ki));
    setTextIfChanged(kdVal, formatGain(state.gains.kd));
  }

  function applyPreset(id: PresetId): void {
    state.gains = cloneGains(PRESETS[id].gains);
    state.preset = id;
    resetIntegrators(arm);
    syncSliders();
    syncPresetButtons();
  }

  function markCustomIfNeeded(): void {
    state.preset = nearestPreset(state.gains);
    syncPresetButtons();
  }

  function updateModeHud(): void {
    if (state.dragging) {
      setTextIfChanged(hudMode, "drag · pinned");
    } else if (state.autoTraj) {
      setTextIfChanged(hudMode, "auto · figure-8");
    } else {
      setTextIfChanged(hudMode, "pinned target");
    }
  }

  function layout(): void {
    const rect = stage.getBoundingClientRect();
    const sized = resizeCanvas(canvas, rect.width, Math.max(320, rect.height));
    state.width = sized.width;
    state.height = sized.height;
    cam = makeCam(state.width, state.height);
  }

  function pointerWorld(e: PointerEvent): { x: number; y: number } {
    const rect = canvas.getBoundingClientRect();
    const sx = ((e.clientX - rect.left) / rect.width) * state.width;
    const sy = ((e.clientY - rect.top) / rect.height) * state.height;
    return screenToWorld(cam, sx, sy);
  }

  function updateReadouts(now: number, force: boolean): void {
    if (!force && now - lastReadoutMs < READOUT_INTERVAL_MS) return;
    lastReadoutMs = now;
    setTextIfChanged(hudError, `rms err ${arm.rmsError.toFixed(3)}`);
    setTextIfChanged(hudPayload, `payload ${arm.payload.toFixed(1)}`);
    updateModeHud();
  }

  function tick(ts: number): void {
    if (!lastTs) lastTs = ts;
    const rawDt = Math.min(0.033, (ts - lastTs) / 1000);
    lastTs = ts;

    if (state.autoTraj && !state.dragging) {
      state.trajT += rawDt * TRAJ_SPEED;
      const p = figureEight(state.trajT);
      setTarget(arm, p.x, p.y);
    }

    // Fixed substeps keep stiff gains stable.
    const sub = rawDt > 0.02 ? 3 : 2;
    const h = rawDt / sub;
    for (let i = 0; i < sub; i += 1) {
      stepArm(arm, state.gains, h);
    }

    paintStage(canvas, arm, cam, state.width, state.height, ts);
    updateReadouts(ts, false);
    raf = requestAnimationFrame(tick);
  }

  for (const id of Object.keys(PRESETS) as PresetId[]) {
    const btn = mustEl(root, `#preset-${id}`, HTMLButtonElement);
    btn.addEventListener("click", () => {
      applyPreset(id);
    });
  }

  btnKick.addEventListener("click", () => {
    kickArm(arm);
  });

  btnPayload.addEventListener("click", () => {
    addPayload(arm);
  });

  btnClear.addEventListener("click", () => {
    clearPayload(arm);
  });

  btnAuto.addEventListener("click", () => {
    state.autoTraj = true;
    state.dragging = false;
    updateModeHud();
  });

  paramKp.addEventListener("input", () => {
    state.gains.kp = Number(paramKp.value);
    setTextIfChanged(kpVal, formatGain(state.gains.kp));
    markCustomIfNeeded();
  });

  paramKi.addEventListener("input", () => {
    state.gains.ki = Number(paramKi.value);
    setTextIfChanged(kiVal, formatGain(state.gains.ki));
    markCustomIfNeeded();
  });

  paramKd.addEventListener("input", () => {
    state.gains.kd = Number(paramKd.value);
    setTextIfChanged(kdVal, formatGain(state.gains.kd));
    markCustomIfNeeded();
  });

  explainerToggle.addEventListener("click", () => {
    const open = explainer.dataset.open !== "false";
    explainer.dataset.open = open ? "false" : "true";
    explainerToggle.setAttribute("aria-expanded", open ? "false" : "true");
  });

  canvas.addEventListener("pointerdown", (e) => {
    canvas.setPointerCapture(e.pointerId);
    state.dragging = true;
    state.autoTraj = false;
    const p = pointerWorld(e);
    setTarget(arm, p.x, p.y);
    updateModeHud();
  });

  canvas.addEventListener("pointermove", (e) => {
    if (!state.dragging) return;
    const p = pointerWorld(e);
    setTarget(arm, p.x, p.y);
  });

  const endPointer = (e: PointerEvent): void => {
    if (canvas.hasPointerCapture(e.pointerId)) {
      canvas.releasePointerCapture(e.pointerId);
    }
    state.dragging = false;
    updateModeHud();
  };

  canvas.addEventListener("pointerup", endPointer);
  canvas.addEventListener("pointercancel", endPointer);

  window.addEventListener("resize", () => {
    layout();
  });

  if (recordMode) {
    void runRecordChoreography();
  }

  async function runRecordChoreography(): Promise<void> {
    const sleep = (ms: number) =>
      new Promise<void>((resolve) => {
        window.setTimeout(resolve, ms);
      });

    // Keep the arm + target framed immediately, then pin a *lateral* high
    // target so gravity torque (and Ki sag/recovery) reads on camera.
    await sleep(500);
    state.autoTraj = false;
    setTarget(arm, 0.95, 0.95);
    updateModeHud();
    await sleep(700);
    const steps = 16;
    for (let i = 0; i <= steps; i += 1) {
      const u = i / steps;
      setTarget(arm, 0.55 + 0.5 * u, 1.05 - 0.12 * Math.sin(u * Math.PI));
      await sleep(40);
    }
    setTarget(arm, 1.05, 0.88);
    updateModeHud();
  }

  layout();
  syncPresetButtons();
  syncSliders();
  updateReadouts(performance.now(), true);
  raf = requestAnimationFrame(tick);
  void raf;
}

mount();
