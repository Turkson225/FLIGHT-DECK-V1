"use strict";

const $ = (id) => document.getElementById(id);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const finite = (...values) => values.find((value) => Number.isFinite(Number(value))) ?? null;
const safeNumber = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const safeBool = (value, fallback = false) => typeof value === "boolean" ? value : fallback;
const escapeHtml = (value) => String(value ?? "").replace(/[&<>'"]/g, (char) => ({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"}[char]));
const now = () => Date.now();

const DEFAULT_SETTINGS = Object.freeze({
  mode: "demo",
  endpoint: "",
  pollMs: 100,
  theme: "night",
  txMin: 9.9,
  txMax: 12.6,
  rxMin: 9.9,
  rxMax: 12.6
});

function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem("flightdeck.settings.v2") || "{}");
    return {...DEFAULT_SETTINGS, ...saved};
  } catch {
    return {...DEFAULT_SETTINGS};
  }
}

function loadEvents() {
  try {
    const saved = JSON.parse(localStorage.getItem("flightdeck.events.v2") || "[]");
    if (!Array.isArray(saved)) return [];
    return saved.filter((event) => event && typeof event === "object" && Number.isFinite(Date.parse(event.time)) && typeof event.message === "string")
      .slice(0, 120)
      .map((event) => ({
        time: new Date(event.time).toISOString(),
        source: typeof event.source === "string" ? event.source.slice(0, 32) : "SYSTEM",
        message: event.message.slice(0, 240),
        status: typeof event.status === "string" ? event.status.slice(0, 32) : "INFO",
        level: ["good", "warn", "bad"].includes(event.level) ? event.level : "good"
      }));
  } catch {
    return [];
  }
}

const settings = loadSettings();
const state = {
  schema: "flightdeck.telemetry.v1",
  safetyValid: false,
  deviceId: "FDV1-001",
  seq: 0,
  receivedAt: now(),
  source: "demo",
  uptimeMs: 0,
  control: {authority: "radio", armed: false, webEnabled: false, failsafe: false, lastAck: null},
  link: {
    rf: {state: "ok", ageMs: 18, qualityPct: 99.6, rateHz: 49.8, lossPct: .4, rpd: true},
    uart: {state: "ok", ageMs: 9},
    wifi: {rssiDbm: -54}
  },
  rc: {throttle: 0, rudder: 0, elevator: 0, aileron: 0, aux1: 50, aux2: 50, buttons: [false, false, false, false]},
  imu: {
    valid: true, ageMs: 8, rollDeg: 0, pitchDeg: 0, yawRateDps: 0,
    gyroDps: {x: 0, y: 0, z: 0}, accelG: {x: 0, y: 0, z: 1}, temperatureC: 33.2, vibrationG: .02
  },
  power: {txV: 11.8, rxV: 11.6},
  faults: []
};

const runtime = {
  startedAt: now(),
  events: loadEvents(),
  history: [],
  recorded: [],
  recording: false,
  alertSignature: "",
  telemetryPaused: false,
  chartWindow: 30,
  dataTimer: 0,
  dataGeneration: 0,
  ageTimer: 0,
  heartbeatTimer: 0,
  drawQueued: false,
  connectionAuthorized: settings.mode === "demo",
  consecutiveFailures: 0,
  lastFailureLogged: 0,
  dataAbortController: null,
  connectionTestPending: false,
  lastSnapshot: null,
  holdTimer: 0,
  commandInFlight: false,
  pendingManualControls: null,
  commandEpoch: 0,
  commandId: 0,
  commanded: {throttle: 0, aileron: 0, elevator: 0, rudder: 0},
  leaseId: null,
  benchActive: false,
  releasePending: false,
  sessionRequestToken: 0,
  sessionRequestPending: false,
  controlActionPending: false,
  sourceGeneration: 0,
  lastDirectSeq: null,
  lastDirectUptime: null,
  frameProgressAt: 0,
  directProgressCount: 0,
  activeView: "flight"
};

const MAX_HISTORY = 6200;

function saveSettings() {
  localStorage.setItem("flightdeck.settings.v2", JSON.stringify(settings));
}

function persistEvents() {
  localStorage.setItem("flightdeck.events.v2", JSON.stringify(runtime.events.slice(0, 120)));
}

function setText(id, value) {
  const element = $(id);
  if (element) element.textContent = value;
}

function setClass(id, className, on) {
  const element = $(id);
  if (element) element.classList.toggle(className, Boolean(on));
}

function toast(message) {
  const element = $("toast");
  element.textContent = message;
  element.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => element.classList.remove("show"), 2600);
}

function addEvent(source, message, status = "OK", level = "good") {
  const previous = runtime.events[0];
  if (previous && previous.message === message && previous.status === status && now() - Date.parse(previous.time) < 2500) return;
  runtime.events.unshift({time: new Date().toISOString(), source, message, status, level});
  runtime.events = runtime.events.slice(0, 120);
  persistEvents();
  renderEvents();
}

function normalizeAuthority(value) {
  const normalized = String(value || "radio").toLowerCase();
  if (["web", "bench", "bench_web"].includes(normalized)) return "web";
  if (normalized === "failsafe") return "failsafe";
  return "radio";
}

function acknowledgedAuthority(value, expected) {
  return typeof value === "string" && value.toLowerCase() === expected;
}

function acknowledgedTerminalAuthority(value) {
  if (typeof value !== "string") return null;
  const authority = value.toLowerCase();
  return ["radio", "failsafe"].includes(authority) ? authority : null;
}

function percentFromUs(value, throttle = false) {
  if (!Number.isFinite(Number(value))) return 0;
  return throttle
    ? clamp((Number(value) - 1000) / 10, 0, 100)
    : clamp((Number(value) - 1500) / 5, -100, 100);
}

function buttonsFrom(raw) {
  if (Array.isArray(raw)) return [0, 1, 2, 3].map((index) => Boolean(raw[index]));
  const mask = safeNumber(raw, 0);
  return [0, 1, 2, 3].map((index) => Boolean(mask & (1 << index)));
}

function hasSafetyContract(raw) {
  const control = raw?.control;
  const rf = raw?.link?.rf;
  const uart = raw?.link?.uart;
  const channels = raw?.rc?.channelsUs;
  const authority = String(control?.authority || "").toLowerCase();
  const rfState = String(rf?.state || "").toLowerCase();
  const uartState = String(uart?.state || "").toLowerCase();
  return raw?.schema === "flightdeck.telemetry.v1"
    && Number.isInteger(raw.seq)
    && raw.seq >= 0
    && raw.seq <= 0xffffffff
    && Number.isFinite(raw.uptimeMs)
    && raw.uptimeMs >= 0
    && control && typeof control === "object"
    && ["radio", "web", "bench", "bench_web", "failsafe"].includes(authority)
    && typeof control.armed === "boolean"
    && typeof control.webEnabled === "boolean"
    && typeof control.failsafe === "boolean"
    && rf && typeof rf === "object"
    && ["ok", "degraded", "lost"].includes(rfState)
    && Number.isFinite(rf.ageMs)
    && rf.ageMs >= 0
    && Number.isFinite(rf.qualityPct)
    && rf.qualityPct >= 0
    && rf.qualityPct <= 100
    && uart && typeof uart === "object"
    && ["ok", "degraded", "lost"].includes(uartState)
    && Number.isFinite(uart.ageMs)
    && uart.ageMs >= 0
    && Array.isArray(channels)
    && channels.length >= 6
    && channels.slice(0, 6).every((value) => Number.isFinite(value) && value >= 800 && value <= 2200);
}

function normalizeFrame(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Telemetry response is not a JSON object");

  const channels = raw.rc?.channelsUs || raw.channelsUs || raw.channels?.valuesUs || null;
  const flatThrottle = finite(raw.throttle, raw.rc?.throttle);
  const flatRudder = finite(raw.rudder, raw.yawInput, raw.rc?.rudder);
  const flatElevator = finite(raw.elevator, raw.pitchInput, raw.rc?.elevator);
  const flatAileron = finite(raw.aileron, raw.rollInput, raw.rc?.aileron);
  const channel = (index, fallback, throttle = false) => Array.isArray(channels) && Number.isFinite(Number(channels[index]))
    ? percentFromUs(Number(channels[index]), throttle)
    : clamp(safeNumber(fallback, 0), throttle ? 0 : -100, 100);

  const gyro = raw.imu?.gyroDps || raw.gyroDps || {};
  const accel = raw.imu?.accelG || raw.accelG || {};
  const txV = finite(raw.power?.txV, raw.power?.txVoltage, raw.txVoltage, raw.power?.txMv != null ? Number(raw.power.txMv) / 1000 : null);
  const rxV = finite(raw.power?.aircraftV, raw.power?.rxV, raw.power?.rxVoltage, raw.rxVoltage, raw.power?.rxMv != null ? Number(raw.power.rxMv) / 1000 : null);
  const quality = finite(raw.link?.rf?.qualityPct, raw.link?.qualityPct, raw.linkQuality, 0);
  const rfAge = finite(raw.link?.rf?.ageMs, raw.link?.ageMs, raw.packetAge, 9999);
  const rfLoss = finite(raw.link?.rf?.lossPct, raw.link?.lossPct, 100 - safeNumber(quality, 0));
  const authority = normalizeAuthority(raw.control?.authority ?? raw.controlSource ?? raw.source);
  const imuValid = raw.imu?.valid == null ? true : Boolean(raw.imu.valid);

  const roll = finite(raw.imu?.rollDeg, raw.roll, state.imu.rollDeg);
  const pitch = finite(raw.imu?.pitchDeg, raw.pitch, state.imu.pitchDeg);
  const yawRate = finite(raw.imu?.yawRateDps, raw.yawRateDps, gyro.z, raw.gz, 0);
  const ax = finite(accel.x, raw.ax, 0);
  const ay = finite(accel.y, raw.ay, 0);
  const az = finite(accel.z, raw.az, 1);
  const vibration = Math.abs(Math.sqrt(ax * ax + ay * ay + az * az) - 1);

  return {
    schema: typeof raw.schema === "string" ? raw.schema : "flightdeck.telemetry.legacy",
    safetyValid: hasSafetyContract(raw),
    deviceId: typeof raw.deviceId === "string" ? raw.deviceId.slice(0, 40) : state.deviceId,
    seq: clamp(safeNumber(raw.seq, state.seq + 1), 0, 0xffffffff),
    receivedAt: now(),
    source: "direct",
    uptimeMs: clamp(safeNumber(raw.uptimeMs, state.uptimeMs), 0, Number.MAX_SAFE_INTEGER),
    control: {
      authority,
      armed: safeBool(raw.control?.armed, safeBool(raw.armed, false)),
      webEnabled: safeBool(raw.control?.webEnabled, safeBool(raw.health?.webControlEnabled, false)),
      failsafe: safeBool(raw.control?.failsafe, safeBool(raw.health?.rfFailsafe, authority === "failsafe")),
      lastAck: raw.control?.lastAck && typeof raw.control.lastAck === "object" ? raw.control.lastAck : null
    },
    link: {
      rf: {
        state: String(raw.link?.rf?.state ?? raw.link?.state ?? (rfAge < 300 ? "ok" : "lost")).toLowerCase(),
        ageMs: clamp(safeNumber(rfAge, 9999), 0, 60000),
        qualityPct: clamp(safeNumber(quality, 0), 0, 100),
        rateHz: clamp(safeNumber(raw.link?.rf?.rateHz ?? raw.link?.rateHz, 0), 0, 100),
        lossPct: clamp(safeNumber(rfLoss, 100), 0, 100),
        rpd: raw.link?.rf?.rpd == null ? null : Boolean(raw.link.rf.rpd)
      },
      uart: {
        state: String(raw.link?.uart?.state ?? (safeBool(raw.health?.uartOk, true) ? "ok" : "lost")).toLowerCase(),
        ageMs: clamp(safeNumber(raw.link?.uart?.ageMs, 0), 0, 60000)
      },
      wifi: {rssiDbm: finite(raw.link?.wifi?.rssiDbm, raw.network?.wifiRssiDbm, null)}
    },
    rc: {
      aileron: channel(0, flatAileron),
      elevator: channel(1, flatElevator),
      throttle: channel(2, flatThrottle, true),
      rudder: channel(3, flatRudder),
      aux1: Array.isArray(channels) ? clamp(percentFromUs(channels[4], true), 0, 100) : clamp(safeNumber(raw.pot1 ?? raw.rc?.aux1, 0), 0, 100),
      aux2: Array.isArray(channels) ? clamp(percentFromUs(channels[5], true), 0, 100) : clamp(safeNumber(raw.pot2 ?? raw.rc?.aux2, 0), 0, 100),
      buttons: buttonsFrom(raw.rc?.buttonsMask ?? raw.buttons ?? raw.rc?.buttons)
    },
    imu: {
      valid: imuValid,
      ageMs: clamp(safeNumber(raw.imu?.ageMs, 0), 0, 60000),
      rollDeg: clamp(safeNumber(roll, 0), -180, 180),
      pitchDeg: clamp(safeNumber(pitch, 0), -90, 90),
      yawRateDps: clamp(safeNumber(yawRate, 0), -2000, 2000),
      gyroDps: {
        x: clamp(safeNumber(gyro.x ?? raw.gx, 0), -2000, 2000),
        y: clamp(safeNumber(gyro.y ?? raw.gy, 0), -2000, 2000),
        z: clamp(safeNumber(gyro.z ?? raw.gz ?? yawRate, 0), -2000, 2000)
      },
      accelG: {
        x: clamp(safeNumber(ax, 0), -16, 16),
        y: clamp(safeNumber(ay, 0), -16, 16),
        z: clamp(safeNumber(az, 1), -16, 16)
      },
      temperatureC: finite(raw.imu?.temperatureC, raw.temperatureC, null),
      vibrationG: clamp(safeNumber(raw.imu?.vibrationG, vibration), 0, 16)
    },
    power: {
      txV: txV == null ? null : clamp(Number(txV), 0, 60),
      rxV: rxV == null ? null : clamp(Number(rxV), 0, 60)
    },
    faults: Array.isArray(raw.faults) ? raw.faults.filter((item) => typeof item === "string").slice(0, 12) : []
  };
}

function simulatedFrame() {
  const elapsed = (now() - runtime.startedAt) / 1000;
  const roll = Math.sin(elapsed * .57) * 13 + Math.sin(elapsed * .19) * 3.5;
  const pitch = Math.sin(elapsed * .43) * 7.5 + Math.cos(elapsed * .14) * 1.2;
  const benchPreparation = Boolean($("propellerCheck")?.checked || runtime.benchActive);
  const throttle = benchPreparation ? 0 : clamp(38 + Math.sin(elapsed * .18) * 17, 0, 100);
  const rudder = benchPreparation ? 0 : Math.sin(elapsed * .31) * 26;
  const elevator = benchPreparation ? 0 : Math.sin(elapsed * .49) * 34;
  const aileron = benchPreparation ? 0 : Math.sin(elapsed * .67) * 48;
  const ax = Math.sin(elapsed * 1.3) * .035;
  const ay = Math.cos(elapsed * 1.1) * .028;
  const az = 1 + Math.sin(elapsed * 1.7) * .018;
  return {
    schema: "flightdeck.telemetry.v1",
    deviceId: "FDV1-SIM",
    seq: state.seq + 1,
    uptimeMs: now() - runtime.startedAt,
    control: {authority: runtime.benchActive ? "web" : "radio", armed: false, webEnabled: runtime.benchActive, failsafe: false},
    link: {rf: {state: "ok", ageMs: 12 + Math.abs(Math.sin(elapsed * 1.4)) * 17, qualityPct: 98.4 + Math.sin(elapsed * .25) * 1.2, rateHz: 49.7, lossPct: .4, rpd: true}, uart: {state: "ok", ageMs: 8}, wifi: {rssiDbm: -54}},
    rc: {channelsUs: [1500 + aileron * 5, 1500 + elevator * 5, 1000 + throttle * 10, 1500 + rudder * 5, 1000 + (58 + Math.sin(elapsed * .12) * 13) * 10, 1000 + (72 + Math.cos(elapsed * .16) * 10) * 10], buttonsMask: (Math.sin(elapsed * .21) > .965 ? 1 : 0) | (Math.cos(elapsed * .17) > .975 ? 4 : 0)},
    imu: {valid: true, ageMs: 7, rollDeg: roll, pitchDeg: pitch, yawRateDps: Math.cos(elapsed * .31) * 8.1, gyroDps: {x: Math.cos(elapsed * .57) * 7.5, y: Math.cos(elapsed * .43) * 3.9, z: Math.cos(elapsed * .31) * 8.1}, accelG: {x: ax, y: ay, z: az}, temperatureC: 33.4 + Math.sin(elapsed * .04) * .5},
    power: {txV: 11.82 - elapsed / 9000 + Math.sin(elapsed * .04) * .025, aircraftV: 11.64 - elapsed / 7600 + Math.sin(elapsed * .05) * .035},
    faults: []
  };
}

function captureTransitions(previous, next) {
  if (!previous) return;
  if (previous.control.authority !== next.control.authority) addEvent("CONTROL", `Authority changed to ${next.control.authority.toUpperCase()}`, "CONFIRMED", next.control.authority === "failsafe" ? "bad" : "good");
  if (previous.control.armed !== next.control.armed) addEvent("RECEIVER", next.control.armed ? "Aircraft reports ARMED" : "Aircraft reports DISARMED", next.control.armed ? "ARMED" : "SAFE", next.control.armed ? "warn" : "good");
  if (!previous.control.failsafe && next.control.failsafe) addEvent("RADIO", "Receiver entered failsafe", "CRITICAL", "bad");
  if (previous.control.failsafe && !next.control.failsafe) addEvent("RADIO", "Receiver exited failsafe", "RECOVERED", "good");
  if (previous.link.rf.state !== next.link.rf.state) addEvent("RADIO", `RF state is ${next.link.rf.state.toUpperCase()}`, next.link.rf.state === "ok" ? "RECOVERED" : "DEGRADED", next.link.rf.state === "ok" ? "good" : "bad");
}

function applyFrame(raw, source) {
  const next = normalizeFrame(raw);
  next.source = source;
  if (source === "direct") {
    if (!next.safetyValid) {
      runtime.lastDirectSeq = null;
      runtime.lastDirectUptime = null;
      runtime.frameProgressAt = 0;
      runtime.directProgressCount = 0;
    } else {
      const firstFrame = runtime.lastDirectSeq == null;
      const rebooted = !firstFrame && next.uptimeMs + 1000 < runtime.lastDirectUptime && next.seq < runtime.lastDirectSeq;
      const sequenceDelta = firstFrame ? 1 : (next.seq - runtime.lastDirectSeq + 0x100000000) % 0x100000000;
      const sequenceAdvanced = sequenceDelta > 0 && sequenceDelta < 0x80000000;
      const progressed = firstFrame || rebooted || (sequenceAdvanced && next.uptimeMs >= runtime.lastDirectUptime);
      if (progressed) {
        runtime.frameProgressAt = now();
        runtime.directProgressCount = rebooted ? 1 : Math.min(runtime.directProgressCount + 1, 1000);
        runtime.lastDirectSeq = next.seq;
        runtime.lastDirectUptime = next.uptimeMs;
      } else return false;
    }
  } else {
    runtime.frameProgressAt = now();
  }
  const previous = runtime.lastSnapshot;
  Object.assign(state, next);
  captureTransitions(previous, next);
  runtime.lastSnapshot = typeof structuredClone === "function" ? structuredClone(next) : JSON.parse(JSON.stringify(next));
  runtime.consecutiveFailures = 0;
  pushHistory();
  renderAll();
  return true;
}

function pushHistory() {
  const sample = {
    time: state.receivedAt,
    roll: state.imu.valid ? state.imu.rollDeg : null,
    pitch: state.imu.valid ? state.imu.pitchDeg : null,
    yawRate: state.imu.valid ? state.imu.yawRateDps : null,
    txV: state.power.txV,
    rxV: state.power.rxV,
    quality: state.link.rf.qualityPct,
    throttle: state.rc.throttle
  };
  runtime.history.push(sample);
  if (runtime.history.length > MAX_HISTORY) runtime.history.splice(0, runtime.history.length - MAX_HISTORY);
  if (runtime.recording) runtime.recorded.push(sample);
  scheduleChartDraw();
}

async function fetchJsonWithTimeout(url, options = {}, timeoutMs = 2600, trackDataRequest = false) {
  const controller = new AbortController();
  if (trackDataRequest) runtime.dataAbortController = controller;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const requestOptions = {...options, cache: "no-store", signal: controller.signal};
  try {
    const target = new URL(url);
    const host = target.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    const loopback = host === "localhost" || /^127\./.test(host) || host === "::1";
    const local = host.endsWith(".local") || /^10\./.test(host) || /^192\.168\./.test(host) || /^169\.254\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host) || /^(fc|fd|fe8|fe9|fea|feb)/i.test(host);
    if (target.protocol === "http:" && loopback) requestOptions.targetAddressSpace = "loopback";
    else if (target.protocol === "http:" && local) requestOptions.targetAddressSpace = "local";
  } catch { /* URL validation happens before a direct connection is saved. */ }
  try {
    const response = await fetch(url, requestOptions);
    const declaredLength = Number(response.headers.get("Content-Length"));
    if (Number.isFinite(declaredLength) && declaredLength > 131072) {
      controller.abort();
      throw new Error("Response body exceeds 128 KiB limit");
    }
    const rawBody = await response.text();
    if (rawBody.length > 131072) throw new Error("Response body exceeds 128 KiB limit");
    let body = {};
    let jsonValid = rawBody.length > 0;
    if (jsonValid) {
      try { body = JSON.parse(rawBody); } catch { jsonValid = false; }
    }
    return {response, body, jsonValid};
  } finally {
    clearTimeout(timer);
    if (runtime.dataAbortController === controller) runtime.dataAbortController = null;
  }
}

function endpointUrl(path, base = settings.endpoint) {
  return `${base.replace(/\/$/, "")}${path}`;
}

async function fetchTelemetry(base = settings.endpoint, trackDataRequest = false) {
  let result = await fetchJsonWithTimeout(endpointUrl("/api/v1/telemetry", base), {}, 2600, trackDataRequest);
  if (result.response.status === 404) result = await fetchJsonWithTimeout(endpointUrl("/api/telemetry", base), {}, 2600, trackDataRequest);
  if (!result.response.ok) throw new Error(`HTTP ${result.response.status}`);
  if (!result.jsonValid) throw new Error("Telemetry response is not valid JSON");
  return result.body;
}

async function pollDirect(generation) {
  if (generation !== runtime.dataGeneration || settings.mode !== "direct" || !runtime.connectionAuthorized) return;
  const endpoint = settings.endpoint;
  try {
    const raw = await fetchTelemetry(endpoint, true);
    if (generation !== runtime.dataGeneration || settings.mode !== "direct" || endpoint !== settings.endpoint) return;
    applyFrame(raw, "direct");
    updateConnectionResult(isFresh() ? "good" : "warn", isFresh()
      ? `Connected to ${settings.endpoint}. Telemetry is live.`
      : `Endpoint responds, but the telemetry sequence is not advancing.`);
  } catch (error) {
    if (generation !== runtime.dataGeneration) return;
    runtime.consecutiveFailures += 1;
    if (runtime.benchActive && !runtime.releasePending) {
      runtime.releasePending = true;
      releaseAuthority("Telemetry poll failed — safety release", true).finally(() => { runtime.releasePending = false; });
    }
    renderAll();
    updateConnectionResult("bad", `No telemetry: ${error.name === "AbortError" ? "request timed out" : error.message}.`);
    if (runtime.consecutiveFailures === 1 || now() - runtime.lastFailureLogged > 30000) {
      addEvent("NETWORK", `Telemetry connection failed: ${error.name === "AbortError" ? "timeout" : error.message}`, "OFFLINE", "bad");
      runtime.lastFailureLogged = now();
    }
  } finally {
    if (generation !== runtime.dataGeneration || settings.mode !== "direct" || !runtime.connectionAuthorized) return;
    const backoff = runtime.consecutiveFailures ? Math.min(5000, settings.pollMs * (runtime.consecutiveFailures + 2)) : settings.pollMs;
    runtime.dataTimer = setTimeout(() => pollDirect(generation), backoff);
  }
}

function runSimulation(generation) {
  if (generation !== runtime.dataGeneration || settings.mode !== "demo") return;
  applyFrame(simulatedFrame(), "demo");
  runtime.dataTimer = setTimeout(() => runSimulation(generation), 100);
}

function restartDataLoop() {
  const generation = ++runtime.dataGeneration;
  clearTimeout(runtime.dataTimer);
  runtime.dataAbortController?.abort();
  if (settings.mode === "demo") {
    runtime.connectionAuthorized = true;
    runSimulation(generation);
  } else if (runtime.connectionAuthorized && settings.endpoint) {
    pollDirect(generation);
  } else {
    renderAll();
  }
}

function invalidateTelemetrySource() {
  runtime.sourceGeneration += 1;
  runtime.commandEpoch += 1;
  runtime.lastSnapshot = null;
  runtime.consecutiveFailures = 0;
  runtime.lastDirectSeq = null;
  runtime.lastDirectUptime = null;
  runtime.frameProgressAt = 0;
  runtime.directProgressCount = 0;
  state.source = "none";
  state.receivedAt = 0;
  state.safetyValid = false;
  state.control = {authority: "radio", armed: false, webEnabled: false, failsafe: false, lastAck: null};
  state.link = {
    rf: {state: "lost", ageMs: 60000, qualityPct: 0, rateHz: 0, lossPct: 100, rpd: null},
    uart: {state: "lost", ageMs: 60000},
    wifi: {rssiDbm: null}
  };
  state.imu = {...state.imu, valid: false, ageMs: 60000};
  state.power = {txV: null, rxV: null};
  state.faults = [];
}

function telemetryAge() {
  const deliveryAge = Math.max(0, now() - state.receivedAt);
  if (settings.mode === "direct" && state.source === "direct" && runtime.frameProgressAt) {
    return Math.max(deliveryAge, now() - runtime.frameProgressAt);
  }
  return deliveryAge;
}

function isFresh() {
  if (settings.mode === "demo") return state.source === "demo" && telemetryAge() < 1000;
  const progressLimit = Math.max(1000, settings.pollMs * 3 + 250);
  return settings.mode === "direct"
    && state.source === "direct"
    && runtime.connectionAuthorized
    && telemetryAge() < progressLimit
    && runtime.consecutiveFailures < 3;
}

function rfHealthy() {
  return isFresh() && state.link.rf.state === "ok" && state.link.rf.ageMs < 300 && state.link.rf.qualityPct >= 65;
}

function uartHealthy() {
  return isFresh() && state.link.uart.state === "ok" && state.link.uart.ageMs < 1000;
}

function batteryPct(voltage, min, max) {
  if (!Number.isFinite(voltage) || !Number.isFinite(min) || !Number.isFinite(max) || max <= min) return null;
  return clamp((voltage - min) / (max - min) * 100, 0, 100);
}

function computeAssessment() {
  const txPct = batteryPct(state.power.txV, settings.txMin, settings.txMax);
  const rxPct = batteryPct(state.power.rxV, settings.rxMin, settings.rxMax);
  const fresh = isFresh();
  const rf = rfHealthy();
  const uart = uartHealthy();
  const imu = fresh && state.imu.valid && state.imu.ageMs < 500;
  const vibration = state.imu.vibrationG;
  let score = 100;
  if (!fresh) score -= 35;
  if (!rf) score -= 24;
  if (!uart) score -= 16;
  if (!imu) score -= 18;
  if (txPct != null && txPct < 20) score -= 10;
  if (rxPct != null && rxPct < 20) score -= 15;
  if (vibration > .18) score -= 12;
  if (state.control.failsafe) score -= 30;
  if (settings.mode === "direct" && fresh && !state.safetyValid) score -= 20;
  score = clamp(Math.round(score), 0, 100);
  return {txPct, rxPct, fresh, rf, uart, imu, vibration, score};
}

function formatAge(milliseconds) {
  if (milliseconds < 100) return "NOW";
  if (milliseconds < 1000) return `${Math.round(milliseconds)} ms`;
  if (milliseconds < 60000) return `${Math.round(milliseconds / 1000)} s`;
  return `${Math.round(milliseconds / 60000)} min`;
}

function setHealthText(id, text, level = "good") {
  const element = $(id);
  if (!element) return;
  element.textContent = text;
  element.classList.toggle("state-good", level === "good");
  element.classList.toggle("state-warn", level === "warn");
  element.classList.toggle("state-bad", level === "bad");
}

function renderHeader(assessment) {
  const age = telemetryAge();
  setText("deviceId", state.deviceId);
  setText("lastPacketLabel", state.source === "demo" ? "SIM NOW" : formatAge(age));
  const badge = $("sourceBadge");
  badge.className = "source-badge";
  const rail = $("railSignal");
  rail.className = "rail-signal";
  if (settings.mode === "demo") {
    badge.classList.add("simulated"); rail.classList.add("sim");
    setText("sourceText", "SIMULATED DATA"); setText("railSignal", "");
    rail.innerHTML = "<i></i><span>SIM</span>";
  } else if (assessment.fresh) {
    setText("sourceText", "LIVE DEVICE"); rail.innerHTML = "<i></i><span>LIVE</span>";
  } else {
    badge.classList.add("offline"); rail.classList.add("offline");
    setText("sourceText", runtime.connectionAuthorized ? "LINK OFFLINE" : "CONNECT REQUIRED"); rail.innerHTML = "<i></i><span>OFF</span>";
  }

  setHealthText("armStateTop", state.control.armed ? "ARMED" : "DISARMED", state.control.armed ? "warn" : "good");
  const authorityText = state.control.authority === "web" ? "BENCH WEB" : state.control.authority === "failsafe" ? "FAILSAFE" : "TRANSMITTER";
  setHealthText("authorityTop", authorityText, state.control.authority === "failsafe" ? "bad" : state.control.authority === "web" ? "warn" : "good");
  setHealthText("radioHealthTop", assessment.fresh ? `${Math.round(state.link.rf.qualityPct)}%` : "NO DATA", assessment.rf ? "good" : "bad");
  setText("packetAgeTop", assessment.fresh ? `${Math.round(state.link.rf.ageMs)} ms` : formatAge(age));
  setHealthText("uartTop", assessment.uart ? "LIVE" : "LOST", assessment.uart ? "good" : "bad");
  setHealthText("nodeTop", assessment.fresh ? "ONLINE" : "OFFLINE", assessment.fresh ? "good" : "bad");
}

function renderAttitude(assessment) {
  const roll = assessment.imu ? state.imu.rollDeg : 0;
  const pitch = assessment.imu ? state.imu.pitchDeg : 0;
  $("horizonWorld").style.transform = `translateY(${clamp(pitch * 3.2, -115, 115)}px) rotate(${-roll}deg)`;
  $("rollPointer").style.transform = `translateX(-50%) rotate(${clamp(roll, -60, 60)}deg)`;
  setText("pfdRoll", assessment.imu ? `${roll.toFixed(1)}°` : "—");
  setText("pfdPitch", assessment.imu ? `${pitch.toFixed(1)}°` : "—");
  setText("pfdYawRate", assessment.imu ? `${state.imu.yawRateDps.toFixed(1)}°/s` : "—");
  const accel = state.imu.accelG;
  const load = Math.sqrt(accel.x ** 2 + accel.y ** 2 + accel.z ** 2);
  setText("pfdG", assessment.imu ? `${load.toFixed(2)} g` : "—");
  setText("pfdTemp", assessment.imu && state.imu.temperatureC != null ? `${Number(state.imu.temperatureC).toFixed(1)} °C` : "N/A");
  const vibrationLabel = state.imu.vibrationG > .18 ? "HIGH" : state.imu.vibrationG > .09 ? "ELEVATED" : "LOW";
  setHealthText("pfdVibration", assessment.imu ? vibrationLabel : "N/A", vibrationLabel === "HIGH" ? "bad" : vibrationLabel === "ELEVATED" ? "warn" : "good");
  const badge = $("imuBadge");
  badge.className = `badge ${assessment.imu ? "good" : "bad"}`;
  badge.innerHTML = assessment.imu ? "<i></i> IMU NOMINAL" : "IMU INVALID";
  $("simWatermark").hidden = settings.mode !== "demo";
}

function setCheck(id, stateName, label) {
  const row = $(id);
  row.classList.remove("fail", "pending");
  if (stateName === "fail") row.classList.add("fail");
  if (stateName === "pending") row.classList.add("pending");
  row.querySelector("b").textContent = label;
}

function renderAuthority(assessment) {
  const authority = state.control.authority;
  setText("authorityLabel", authority === "web" ? "BENCH WEB CONTROL ACTIVE" : authority === "failsafe" ? "RECEIVER FAILSAFE" : "TRANSMITTER IN CONTROL");
  setText("authorityDescription", authority === "web" ? "Short-lived browser lease confirmed by the receiver." : authority === "failsafe" ? "Receiver has applied its configured safe outputs." : "The physical nRF24 controller owns all flight outputs.");
  const badge = $("authorityBadge");
  badge.className = `badge ${authority === "failsafe" ? "bad" : authority === "web" ? "warn" : "neutral"}`;
  badge.textContent = authority === "web" ? "BENCH ACTIVE" : authority === "failsafe" ? "FAILSAFE" : "OBSERVE";
  setCheck("checkTelemetry", assessment.fresh && state.safetyValid ? "good" : assessment.fresh ? "pending" : "fail", assessment.fresh && state.safetyValid ? "PASS" : assessment.fresh ? "READ ONLY" : "STALE");
  setCheck("checkRf", assessment.rf ? "good" : "fail", assessment.rf ? "PASS" : "FAIL");
  const controlsAligned = state.rc.throttle <= 2 && Math.abs(state.rc.aileron) <= 5 && Math.abs(state.rc.elevator) <= 5 && Math.abs(state.rc.rudder) <= 5;
  setCheck("checkThrottle", controlsAligned ? "good" : "pending", controlsAligned ? "PASS" : "CENTER / LOW");
  const physicalReady = settings.mode === "demo" ? runtime.benchActive : state.control.webEnabled;
  setCheck("checkPhysical", physicalReady ? "good" : "pending", physicalReady ? "CONFIRMED" : "NOT SET");
}

function renderPower(assessment) {
  const tx = state.power.txV;
  const rx = state.power.rxV;
  setText("txVoltage", tx == null ? "N/A" : `${tx.toFixed(2)} V`);
  setText("rxVoltage", rx == null ? "N/A" : `${rx.toFixed(2)} V`);
  setText("txBatteryPct", assessment.txPct == null ? "NOT CALIBRATED" : `${Math.round(assessment.txPct)}% EST.`);
  setText("rxBatteryPct", assessment.rxPct == null ? "NOT CALIBRATED" : `${Math.round(assessment.rxPct)}% EST.`);
  $("txBatteryBar").style.width = `${assessment.txPct ?? 0}%`;
  $("rxBatteryBar").style.width = `${assessment.rxPct ?? 0}%`;
  $("txBatteryBar").style.background = assessment.txPct != null && assessment.txPct < 20 ? "var(--red)" : "";
  $("rxBatteryBar").style.background = assessment.rxPct != null && assessment.rxPct < 20 ? "var(--red)" : "";
  setText("healthScore", assessment.score);
  setText("diagnosticScore", assessment.score);
  $("healthScore").parentElement.style.color = assessment.score < 55 ? "var(--red)" : assessment.score < 80 ? "var(--amber)" : "var(--green)";
  $("diagnosticScore").parentElement.style.color = $("healthScore").parentElement.style.color;

  const alerts = [];
  if (settings.mode === "demo") alerts.push({level: "warn", text: "Simulated dataset — no aircraft attached"});
  if (!assessment.fresh) alerts.push({level: "bad", text: "Telemetry stale — bench commands locked"});
  if (assessment.fresh && !assessment.rf) alerts.push({level: "bad", text: "Radio delivery or packet age is unsafe"});
  if (assessment.rxPct != null && assessment.rxPct < 20) alerts.push({level: "bad", text: "Aircraft battery estimate is low"});
  if (assessment.txPct != null && assessment.txPct < 20) alerts.push({level: "warn", text: "Transmitter battery estimate is low"});
  if (assessment.vibration > .18) alerts.push({level: "warn", text: "Vibration exceeds the current guard"});
  if (settings.mode === "direct" && assessment.fresh && !state.safetyValid) alerts.push({level: "warn", text: "V1 safety contract incomplete — read-only"});
  if (!alerts.length) alerts.push({level: "good", text: "All monitored systems nominal"});
  const visibleAlerts = alerts.slice(0, 3);
  const signature = visibleAlerts.map((alert) => `${alert.level}:${alert.text}`).join("|");
  if (signature !== runtime.alertSignature) {
    runtime.alertSignature = signature;
    $("alertStack").innerHTML = visibleAlerts.map((alert) => `<div class="alert ${alert.level}"><i></i><span>${escapeHtml(alert.text)}</span></div>`).join("");
  }
}

function renderInputs() {
  const rc = state.rc;
  setText("throttleInput", `${Math.round(rc.throttle)}%`);
  setText("rudderInput", `${Math.round(rc.rudder)}%`);
  setText("elevatorInput", `${Math.round(rc.elevator)}%`);
  setText("aileronInput", `${Math.round(rc.aileron)}%`);
  setText("aux1Value", `${Math.round(rc.aux1)}%`);
  setText("aux2Value", `${Math.round(rc.aux2)}%`);
  $("leftStickDot").style.left = `${50 + rc.rudder * .42}%`;
  $("leftStickDot").style.top = `${90 - rc.throttle * .8}%`;
  $("rightStickDot").style.left = `${50 + rc.aileron * .42}%`;
  $("rightStickDot").style.top = `${50 - rc.elevator * .42}%`;
  $("aux1Bar").style.width = `${rc.aux1}%`;
  $("aux2Bar").style.width = `${rc.aux2}%`;
  const host = $("buttonBank");
  if (host.children.length !== 4) host.innerHTML = [1,2,3,4].map((index) => `<div class="rc-button" data-button="${index - 1}">BUTTON ${index}<b>RELEASED</b></div>`).join("");
  rc.buttons.forEach((pressed, index) => {
    const item = host.children[index];
    item.classList.toggle("on", pressed);
    item.querySelector("b").textContent = pressed ? "PRESSED" : "RELEASED";
  });
}

function renderLink(assessment) {
  const links = [
    ["linkTx", assessment.rf, assessment.rf ? "good" : "bad"],
    ["linkRx", assessment.rf, assessment.rf ? "good" : "bad"],
    ["linkNode", assessment.fresh && assessment.uart, assessment.fresh && assessment.uart ? "good" : "bad"],
    ["linkBrowser", assessment.fresh, assessment.fresh ? "good" : "bad"]
  ];
  links.forEach(([id,, level]) => { $(id).classList.remove("good", "warn", "bad"); $(id).classList.add(level); });
  setText("linkTxValue", assessment.rf ? `${state.link.rf.rateHz ? state.link.rf.rateHz.toFixed(1) : "—"} Hz` : "NO LINK");
  setText("linkRxValue", assessment.rf ? "LIVE" : "FAILSAFE");
  setText("linkNodeValue", assessment.fresh && assessment.uart ? "ONLINE" : "OFFLINE");
  setText("linkBrowserValue", assessment.fresh ? "LIVE" : "STALE");
  const badge = $("linkBadge");
  badge.className = `badge ${assessment.score >= 80 ? "good" : assessment.score >= 55 ? "warn" : "bad"}`;
  badge.innerHTML = assessment.score >= 80 ? "<i></i> NOMINAL" : assessment.score >= 55 ? "DEGRADED" : "FAULT";

  setText("archTxState", assessment.rf ? `${state.link.rf.rateHz ? state.link.rf.rateHz.toFixed(1) : "—"} Hz` : "OFFLINE");
  setText("archRfState", `${state.link.rf.qualityPct.toFixed(1)}% delivery`);
  setText("archRxState", state.control.authority.toUpperCase());
  setText("archUartState", assessment.uart ? "Framed + CRC" : "Link lost");
  setText("archNodeState", assessment.fresh ? "ONLINE" : "OFFLINE");
  setText("archWebState", settings.mode === "demo" ? "Demo source" : assessment.fresh ? "Live endpoint" : "Disconnected");
  const arch = $("architectureBadge");
  arch.className = `badge ${assessment.score >= 80 ? "good" : assessment.score >= 55 ? "warn" : "bad"}`;
  arch.innerHTML = assessment.score >= 80 ? "<i></i> ALL SYSTEMS NOMINAL" : assessment.score >= 55 ? "SYSTEM DEGRADED" : "SYSTEM FAULT";
}

function renderTelemetryDetails(assessment) {
  const imu = state.imu;
  setText("sampleRate", `${settings.mode === "demo" ? "10.0" : (1000 / settings.pollMs).toFixed(1)} Hz`);
  setText("legendRoll", assessment.imu ? `${imu.rollDeg.toFixed(1)}°` : "—");
  setText("legendPitch", assessment.imu ? `${imu.pitchDeg.toFixed(1)}°` : "—");
  setText("legendYaw", assessment.imu ? `${imu.yawRateDps.toFixed(1)}°/s` : "—");
  [["accelX", imu.accelG.x, "g", 2], ["accelY", imu.accelG.y, "g", 2], ["accelZ", imu.accelG.z, "g", 2], ["gyroX", imu.gyroDps.x, "°/s", 1], ["gyroY", imu.gyroDps.y, "°/s", 1], ["gyroZ", imu.gyroDps.z, "°/s", 1]].forEach(([id, value, unit, digits]) => setText(id, assessment.imu ? `${value.toFixed(digits)} ${unit}` : "—"));
  setText("vibrationIndex", assessment.imu ? `${imu.vibrationG.toFixed(3)} g` : "—");
  $("vibrationBar").style.width = `${clamp(imu.vibrationG / .3 * 100, 0, 100)}%`;
  const sensorBadge = $("sensorFrameBadge");
  sensorBadge.className = `badge ${assessment.imu ? "good" : "bad"}`;
  sensorBadge.textContent = assessment.imu ? "VALID" : "INVALID";
  setText("qualityLarge", `${state.link.rf.qualityPct.toFixed(1)}%`);
  setText("qualityAge", `${Math.round(state.link.rf.ageMs)} ms`);
  setText("qualityRate", state.link.rf.rateHz ? `${state.link.rf.rateHz.toFixed(1)} Hz` : "N/A");
  setText("qualityLoss", `${state.link.rf.lossPct.toFixed(1)}%`);
  setText("qualityRpd", state.link.rf.rpd == null ? "N/A" : state.link.rf.rpd ? "DETECTED" : "BELOW THRESHOLD");
  setText("telemetryAge", `${Math.round(telemetryAge())} ms`);
  $("rollLimitTrack").querySelector("i").style.left = `${clamp(50 + imu.rollDeg / 120 * 100, 0, 100)}%`;
  $("pitchLimitTrack").querySelector("i").style.left = `${clamp(50 + imu.pitchDeg / 70 * 100, 0, 100)}%`;
  $("ageLimitTrack").querySelector("i").style.left = `${clamp(telemetryAge() / 1000 * 100, 0, 100)}%`;
  const withinEnvelope = assessment.imu && Math.abs(imu.rollDeg) <= 60 && Math.abs(imu.pitchDeg) <= 35 && assessment.fresh;
  const env = $("envelopeBadge");
  env.className = `badge ${withinEnvelope ? "good" : "bad"}`;
  env.textContent = withinEnvelope ? "NORMAL" : "LIMIT / STALE";
}

function renderDiagnostics(assessment) {
  const diagnostics = [
    {level: assessment.fresh ? "good" : "bad", title: "Telemetry freshness", detail: assessment.fresh ? `${formatAge(telemetryAge())} · current` : `${formatAge(telemetryAge())} · commands locked`, state: assessment.fresh ? "PASS" : "FAIL"},
    {level: assessment.rf ? "good" : "bad", title: "nRF24 delivery", detail: `${state.link.rf.qualityPct.toFixed(1)}% · ${Math.round(state.link.rf.ageMs)} ms age`, state: assessment.rf ? "PASS" : "CHECK"},
    {level: assessment.imu ? (assessment.vibration > .18 ? "warn" : "good") : "bad", title: "IMU & vibration", detail: assessment.imu ? `${assessment.vibration.toFixed(3)} g vibration index` : "MPU6050 frame is invalid", state: assessment.imu ? assessment.vibration > .18 ? "WARN" : "PASS" : "FAIL"},
    {level: assessment.rxPct != null && assessment.rxPct < 20 ? "warn" : "good", title: "Aircraft power", detail: state.power.rxV == null ? "Voltage unavailable" : `${state.power.rxV.toFixed(2)} V · ${Math.round(assessment.rxPct ?? 0)}% estimated`, state: state.power.rxV == null ? "N/A" : assessment.rxPct < 20 ? "LOW" : "PASS"}
  ];
  if (settings.mode === "direct") {
    const progressing = runtime.directProgressCount >= 2 && runtime.frameProgressAt > 0 && now() - runtime.frameProgressAt < 1000;
    diagnostics.unshift({level: progressing ? "good" : "bad", title: "Frame progression", detail: progressing ? `Sequence ${state.seq} is advancing` : "Need two advancing V1 frames; replay protection active", state: progressing ? "PASS" : "BLOCKED"});
    diagnostics.unshift({level: state.safetyValid ? "good" : "warn", title: "Control contract", detail: state.safetyValid ? "Versioned receiver state is complete" : "Legacy/incomplete frame; bench output blocked", state: state.safetyValid ? "V1 PASS" : "READ ONLY"});
  }
  $("diagnosticList").innerHTML = diagnostics.map((item) => `<div class="diagnostic-item ${item.level}"><i></i><span><b>${escapeHtml(item.title)}</b><small>${escapeHtml(item.detail)}</small></span><em>${escapeHtml(item.state)}</em></div>`).join("");
}

function renderBench(assessment) {
  const eligibility = benchEligibility(assessment, runtime.benchActive);
  $("enableBench").disabled = runtime.benchActive || runtime.sessionRequestPending || runtime.controlActionPending || !eligibility.ok;
  $("releaseControl").disabled = !runtime.benchActive || runtime.controlActionPending;
  $("emergencyStop").disabled = !runtime.benchActive || runtime.controlActionPending || !runtime.leaseId;
  $("testConnection").disabled = runtime.benchActive || runtime.sessionRequestPending || runtime.controlActionPending || runtime.connectionTestPending;
  $("saveConnection").disabled = runtime.benchActive || runtime.sessionRequestPending || runtime.controlActionPending || runtime.connectionTestPending;
  const bench = $("benchState");
  bench.className = `bench-state ${runtime.benchActive ? "active" : "observe"}`;
  bench.innerHTML = `<i></i><span>${runtime.benchActive ? "BENCH WEB ACTIVE" : "OBSERVE ONLY"}</span>`;
  $("consoleLock").hidden = runtime.benchActive;
  if (runtime.benchActive) $("sliderConsole").removeAttribute("inert"); else $("sliderConsole").setAttribute("inert", "");
  updateSteps();
  if (runtime.benchActive && !eligibility.ok && !runtime.releasePending) {
    runtime.releasePending = true;
    queueMicrotask(() => releaseAuthority(`Safety interlock: ${eligibility.reason}`, true).finally(() => { runtime.releasePending = false; }));
  }
}

function benchEligibility(assessment = computeAssessment(), activeLease = false) {
  const checks = [
    [$("propellerCheck").checked, "propeller confirmation removed"],
    [!runtime.controlActionPending, "a control safety action is still pending"],
    [document.visibilityState !== "hidden", "browser is not visible"],
    [assessment.fresh, "telemetry is stale"],
    [settings.mode === "demo" || state.safetyValid, "versioned safety contract is incomplete"],
    [settings.mode === "demo" || settings.pollMs <= 200, "bench polling must be at least 5 Hz"],
    [settings.mode === "demo" || runtime.directProgressCount >= 2, "telemetry sequence has not advanced twice"],
    [settings.mode === "demo" || now() - runtime.frameProgressAt < 1000, "telemetry sequence is frozen"],
    [assessment.rf, "radio link is unsafe"],
    [assessment.uart, "UART link is unsafe"],
    [state.rc.throttle <= 2, "transmitter throttle is above minimum"],
    [Math.abs(state.rc.aileron) <= 5, "transmitter aileron is not centered"],
    [Math.abs(state.rc.elevator) <= 5, "transmitter elevator is not centered"],
    [Math.abs(state.rc.rudder) <= 5, "transmitter rudder is not centered"],
    [!state.control.armed, "aircraft reports armed"],
    [!state.control.failsafe, "receiver reports failsafe"],
    [activeLease || state.control.authority === "radio", "receiver authority is not available"],
    [settings.mode === "demo" || state.control.webEnabled, "physical web-enable is not confirmed"]
  ];
  if (activeLease) checks.push([settings.mode === "demo" || state.control.authority === "web", "receiver no longer reports web authority"]);
  const failed = checks.find(([passed]) => !passed);
  return failed ? {ok: false, reason: failed[1]} : {ok: true, reason: "ready"};
}

function updateSteps(stage = runtime.benchActive ? "active" : "observe") {
  const order = ["Observe", "Request", "Physical", "Align", "Active"];
  const stageIndex = {observe: 0, request: 1, physical: 2, align: 3, active: 4}[stage] ?? 0;
  order.forEach((name, index) => {
    const row = $(`step${name}`);
    row.classList.toggle("complete", index <= stageIndex && stage !== "observe" || index === 0);
    row.classList.toggle("current", index === stageIndex && stage !== "active");
    row.querySelector("em").textContent = index < stageIndex ? "PASS" : index === stageIndex ? stage === "active" ? "ACTIVE" : "ACTIVE" : "WAIT";
  });
}

function renderEvents() {
  const mini = runtime.events.slice(0, 3);
  $("miniEvents").innerHTML = mini.length ? mini.map((event) => `<div class="mini-event"><time>${new Date(event.time).toISOString().slice(11, 19)}</time><span>${escapeHtml(event.message)}</span><b>${escapeHtml(event.status)}</b></div>`).join("") : `<div class="mini-event"><time>--:--:--</time><span>No mission events</span><b>READY</b></div>`;
  $("fullEventLog").innerHTML = runtime.events.length ? runtime.events.map((event) => `<div class="event-row"><time>${escapeHtml(new Date(event.time).toISOString().slice(11, 23))}</time><span>${escapeHtml(event.source)}</span><span>${escapeHtml(event.message)}</span><b class="${event.level === "bad" ? "bad" : event.level === "warn" ? "warn" : ""}">${escapeHtml(event.status)}</b></div>`).join("") : `<div class="event-row"><time>—</time><span>SYSTEM</span><span>No local events recorded</span><b>READY</b></div>`;
}

function renderAll() {
  const assessment = computeAssessment();
  renderHeader(assessment);
  renderAttitude(assessment);
  renderAuthority(assessment);
  renderPower(assessment);
  renderInputs();
  renderLink(assessment);
  renderTelemetryDetails(assessment);
  renderDiagnostics(assessment);
  renderBench(assessment);
}

function chartColors() {
  const css = getComputedStyle(document.documentElement);
  return {
    grid: css.getPropertyValue("--line").trim(),
    text: css.getPropertyValue("--muted").trim(),
    roll: css.getPropertyValue("--cyan").trim(),
    pitch: css.getPropertyValue("--violet").trim(),
    yawRate: css.getPropertyValue("--blue").trim(),
    zero: css.getPropertyValue("--line-strong").trim()
  };
}

function drawChart(canvas, seconds, detailed = false) {
  if (!canvas || !canvas.isConnected) return;
  const rect = canvas.getBoundingClientRect();
  if (rect.width < 10 || rect.height < 10) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const width = Math.round(rect.width * dpr);
  const height = Math.round(rect.height * dpr);
  if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, rect.width, rect.height);
  const colors = chartColors();
  const pad = detailed ? {l: 42, r: 12, t: 14, b: 23} : {l: 8, r: 8, t: 8, b: 8};
  const plotW = rect.width - pad.l - pad.r;
  const plotH = rect.height - pad.t - pad.b;
  const end = runtime.history.at(-1)?.time ?? now();
  const start = end - seconds * 1000;
  const samples = runtime.history.filter((sample) => sample.time >= start);
  const yMax = detailed ? 65 : 55;

  ctx.lineWidth = 1;
  ctx.strokeStyle = colors.grid;
  ctx.fillStyle = colors.text;
  ctx.font = "9px ui-monospace, monospace";
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  for (let index = 0; index <= 4; index += 1) {
    const y = pad.t + plotH * index / 4;
    ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(pad.l + plotW, y); ctx.stroke();
    if (detailed) ctx.fillText(`${Math.round(yMax - yMax * 2 * index / 4)}°`, pad.l - 7, y);
  }
  for (let index = 0; index <= 6; index += 1) {
    const x = pad.l + plotW * index / 6;
    ctx.beginPath(); ctx.moveTo(x, pad.t); ctx.lineTo(x, pad.t + plotH); ctx.stroke();
  }
  ctx.strokeStyle = colors.zero;
  ctx.beginPath(); ctx.moveTo(pad.l, pad.t + plotH / 2); ctx.lineTo(pad.l + plotW, pad.t + plotH / 2); ctx.stroke();

  const drawSeries = (key, color) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = detailed ? 1.8 : 1.5;
    ctx.lineJoin = "round";
    let drawing = false;
    ctx.beginPath();
    samples.forEach((sample) => {
      const value = sample[key];
      if (!Number.isFinite(value)) { drawing = false; return; }
      const x = pad.l + clamp((sample.time - start) / (seconds * 1000), 0, 1) * plotW;
      const y = pad.t + (1 - clamp((value + yMax) / (yMax * 2), 0, 1)) * plotH;
      if (!drawing) { ctx.moveTo(x, y); drawing = true; } else ctx.lineTo(x, y);
    });
    ctx.stroke();
  };
  drawSeries("roll", colors.roll);
  drawSeries("pitch", colors.pitch);
  drawSeries("yawRate", colors.yawRate);

  if (detailed) {
    ctx.fillStyle = colors.text;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    for (let index = 0; index <= 4; index += 1) {
      const x = pad.l + plotW * index / 4;
      ctx.fillText(index === 4 ? "NOW" : `−${Math.round(seconds - seconds * index / 4)}s`, x, pad.t + plotH + 7);
    }
  }
}

function scheduleChartDraw() {
  if (runtime.telemetryPaused || runtime.drawQueued) return;
  runtime.drawQueued = true;
  requestAnimationFrame(() => {
    runtime.drawQueued = false;
    drawChart($("flightChart"), runtime.chartWindow, false);
    if (runtime.activeView === "telemetry") drawChart($("telemetryChart"), runtime.chartWindow, true);
  });
}

function navigate(view, updateHash = true) {
  if (!["flight", "telemetry", "control", "systems"].includes(view)) view = "flight";
  runtime.activeView = view;
  $$('[data-view-panel]').forEach((panel) => {
    const active = panel.dataset.viewPanel === view;
    panel.hidden = !active;
    panel.classList.toggle("active", active);
  });
  $$('[data-view]').forEach((button) => {
    const active = button.dataset.view === view;
    button.classList.toggle("active", active);
    if (active) button.setAttribute("aria-current", "page"); else button.removeAttribute("aria-current");
  });
  if (updateHash && location.hash !== `#${view}`) history.replaceState(null, "", `#${view}`);
  if (view === "telemetry" || view === "flight") setTimeout(scheduleChartDraw, 30);
}

function updateConnectionResult(level, message) {
  const element = $("connectionResult");
  element.className = `connection-result ${level === "good" ? "" : level}`;
  element.querySelector("span").textContent = message;
}

function validateEndpoint(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error("Enter a complete URL such as http://192.168.4.1"); }
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Only HTTP or HTTPS endpoints are supported");
  return url.origin + url.pathname.replace(/\/$/, "");
}

async function testEndpoint() {
  if (runtime.benchActive || runtime.sessionRequestPending || runtime.controlActionPending || runtime.connectionTestPending) return toast("Finish the current connection or control action first");
  runtime.connectionTestPending = true;
  renderAll();
  updateConnectionResult("warn", "Testing the telemetry endpoint…");
  try {
    const candidate = validateEndpoint($("endpointInput").value.trim());
    const raw = await fetchTelemetry(candidate);
    const normalized = normalizeFrame(raw);
    if (normalized.safetyValid) {
      updateConnectionResult("good", `V1 frame shape verified at ${candidate}. Connect to confirm sequence freshness.`);
      toast("V1 frame shape verified");
    } else {
      updateConnectionResult("warn", `Telemetry is reachable, but the V1 safety contract is incomplete. Read-only mode only.`);
      toast("Telemetry found; bench control remains locked");
    }
  } catch (error) {
    updateConnectionResult("bad", `Connection test failed: ${error.name === "AbortError" ? "request timed out" : error.message}.`);
  } finally {
    runtime.connectionTestPending = false;
    renderAll();
  }
}

async function postJson(path, payload, timeout = 1800, leaseOverride = runtime.leaseId) {
  const headers = {"Content-Type": "application/json"};
  if (leaseOverride) headers["X-FlightDeck-Session"] = leaseOverride;
  const {response, body, jsonValid} = await fetchJsonWithTimeout(endpointUrl(path), {method: "POST", headers, body: JSON.stringify(payload)}, timeout);
  if (!response.ok) throw new Error(body?.reason || `HTTP ${response.status}`);
  if (!jsonValid) throw new Error("Receiver response is not valid JSON");
  return body;
}

function readStagedControls() {
  return {
    throttle: clamp(Number($("webThrottle").value), 0, 100),
    aileron: clamp(Number($("webAileron").value), -100, 100),
    elevator: clamp(Number($("webElevator").value), -100, 100),
    rudder: clamp(Number($("webRudder").value), -100, 100)
  };
}

function currentCommandPayload(controls = runtime.commanded) {
  const percentToUs = (value) => Math.round(1500 + clamp(Number(value), -100, 100) * 5);
  return {
    schema: "flightdeck.command.v1",
    leaseId: runtime.leaseId,
    commandId: ++runtime.commandId,
    issuedAt: new Date().toISOString(),
    ttlMs: 250,
    mode: "bench",
    deadman: true,
    channelsUs: {
      throttle: 1000 + controls.throttle * 10,
      roll: percentToUs(controls.aileron),
      pitch: percentToUs(controls.elevator),
      yaw: percentToUs(controls.rudder)
    }
  };
}

function setCommandAck(level, text) {
  const ack = $("commandAck");
  ack.className = `command-ack ${level || ""}`;
  ack.querySelector("span").textContent = text;
}

async function requestBenchAuthority(requestToken) {
  let grantedLease = null;
  const sourceGeneration = runtime.sourceGeneration;
  const assertSafe = (activeLease = false) => {
    if (requestToken !== runtime.sessionRequestToken) throw new Error("Request cancelled");
    if (sourceGeneration !== runtime.sourceGeneration) throw new Error("Data source changed");
    const eligibility = benchEligibility(computeAssessment(), activeLease);
    if (!eligibility.ok) throw new Error(eligibility.reason);
  };
  try {
    assertSafe();
  } catch (error) {
    setCommandAck("bad", `BLOCKED · ${error.message}`);
    toast(`Bench request blocked: ${error.message}`);
    return;
  }
  updateSteps("request");
  setCommandAck("pending", "REQUESTING RECEIVER AUTHORITY");
  if (settings.mode === "demo") {
    try {
      await new Promise((resolve) => setTimeout(resolve, 350)); assertSafe(); updateSteps("physical");
      await new Promise((resolve) => setTimeout(resolve, 350)); assertSafe(); updateSteps("align");
      await new Promise((resolve) => setTimeout(resolve, 350)); assertSafe();
      runtime.leaseId = `demo-${now()}`;
      activateBench("Simulated receiver acknowledgement");
    } catch (error) {
      if (requestToken !== runtime.sessionRequestToken) return;
      setCommandAck("bad", `CANCELLED · ${error.message}`);
      updateSteps("observe");
      toast(`Bench request cancelled: ${error.message}`);
    }
    return;
  }
  try {
    const response = await postJson("/api/v1/session", {
      schema: "flightdeck.session.v1",
      action: "requestBench",
      propellerRemoved: true,
      initialChannelsUs: {throttle: 1000, roll: 1500, pitch: 1500, yaw: 1500},
      alignmentToleranceUs: 50
    });
    if (response?.accepted === true && typeof response.leaseId === "string" && response.leaseId.length >= 16) grantedLease = response.leaseId;
    if (!grantedLease || !acknowledgedAuthority(response?.authority, "web")) throw new Error(response?.reason || "Receiver did not confirm web authority");
    updateSteps("physical");
    const confirmationDeadline = now() + 900;
    while (true) {
      try {
        assertSafe(true);
        break;
      } catch (error) {
        if (error.message !== "receiver no longer reports web authority" || now() >= confirmationDeadline) {
          if (error.message === "receiver no longer reports web authority") throw new Error("Telemetry did not confirm web authority");
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    updateSteps("align");
    runtime.leaseId = grantedLease;
    activateBench("Receiver granted a short-lived bench lease");
  } catch (error) {
    if (grantedLease) {
      try { await postJson("/api/v1/control/release", {schema: "flightdeck.command.v1", action: "release", leaseId: grantedLease, reason: "activation_cancelled"}, 1800, grantedLease); } catch { /* Receiver TTL remains the final backstop. */ }
    }
    if (requestToken !== runtime.sessionRequestToken) return;
    setCommandAck("bad", `REJECTED · ${error.message}`);
    addEvent("BENCH", `Authority rejected: ${error.message}`, "REJECTED", "bad");
    updateSteps("observe");
    toast(`Bench request rejected: ${error.message}`);
  }
}

function activateBench(message) {
  runtime.commandEpoch += 1;
  runtime.benchActive = true;
  runtime.pendingManualControls = null;
  runtime.commanded = {throttle: 0, aileron: 0, elevator: 0, rudder: 0};
  ["webThrottle", "webAileron", "webElevator", "webRudder"].forEach((id) => { $(id).value = 0; setText(`${id}Value`, "0%"); });
  state.control.authority = "web";
  state.control.webEnabled = true;
  updateSteps("active");
  setCommandAck("good", "RECEIVER ACKNOWLEDGED · BENCH ACTIVE");
  addEvent("BENCH", message, "ACTIVE", "warn");
  renderAll();
  toast("Bench controls enabled — receiver lease active");
  scheduleHeartbeat();
}

async function sendCommand(manual = false, explicitControls = null) {
  if (!runtime.benchActive) return;
  if (runtime.commandInFlight) {
    if (manual) {
      runtime.pendingManualControls = explicitControls || readStagedControls();
      setCommandAck("pending", "COMMAND QUEUED · WAITING FOR CURRENT ACK");
    }
    return;
  }
  runtime.commandInFlight = true;
  const commandEpoch = runtime.commandEpoch;
  const stagedControls = manual ? (explicitControls || readStagedControls()) : runtime.commanded;
  const payload = currentCommandPayload(stagedControls);
  if (manual) setCommandAck("pending", `COMMAND ${payload.commandId} · AWAITING RECEIVER`);
  try {
    if (settings.mode === "demo") {
      if (manual) {
        await new Promise((resolve) => setTimeout(resolve, 140));
        if (commandEpoch !== runtime.commandEpoch || !runtime.benchActive) return;
        runtime.commanded = {...stagedControls};
        setCommandAck("good", `COMMAND ${payload.commandId} · SIMULATED ACK`);
        addEvent("COMMAND", `Bench command ${payload.commandId} applied in simulation`, "ACK", "good");
      }
    } else {
      const response = await postJson("/api/v1/control", payload, 850);
      if (response?.accepted !== true) throw new Error(response?.reason || "Receiver acknowledgement missing");
      if (response.leaseId !== payload.leaseId) throw new Error("Receiver acknowledgement lease mismatch");
      if (!Number.isInteger(response.commandId) || response.commandId !== payload.commandId) throw new Error("Receiver acknowledgement ID mismatch");
      if (!acknowledgedAuthority(response.authority, "web")) throw new Error("Receiver no longer owns web authority");
      if (commandEpoch !== runtime.commandEpoch || !runtime.benchActive) return;
      runtime.commanded = {...stagedControls};
      if (manual) {
        setCommandAck("good", `COMMAND ${payload.commandId} · RECEIVER ACK`);
        addEvent("COMMAND", `Receiver applied command ${payload.commandId}`, "ACK", "good");
      }
    }
  } catch (error) {
    if (commandEpoch !== runtime.commandEpoch || !runtime.benchActive) return;
    setCommandAck("bad", `COMMAND ${payload.commandId} · ${error.message}`);
    addEvent("COMMAND", `Command rejected or timed out: ${error.message}`, "REJECTED", "bad");
    if (!manual) releaseAuthority("Command heartbeat lost", true);
  } finally {
    runtime.commandInFlight = false;
    if (runtime.benchActive && runtime.pendingManualControls) {
      const queuedControls = runtime.pendingManualControls;
      runtime.pendingManualControls = null;
      queueMicrotask(() => sendCommand(true, queuedControls));
    }
  }
}

function scheduleHeartbeat() {
  clearTimeout(runtime.heartbeatTimer);
  if (!runtime.benchActive) return;
  runtime.heartbeatTimer = setTimeout(async () => {
    await sendCommand(false);
    scheduleHeartbeat();
  }, 100);
}

async function releaseAuthority(reason = "Operator released control", silent = false) {
  if (runtime.controlActionPending) return false;
  clearTimeout(runtime.heartbeatTimer);
  runtime.controlActionPending = true;
  const actionEpoch = ++runtime.commandEpoch;
  const sourceGeneration = runtime.sourceGeneration;
  const leaseId = runtime.leaseId;
  runtime.benchActive = false;
  runtime.pendingManualControls = null;
  runtime.leaseId = null;
  setCommandAck("pending", settings.mode === "direct" && leaseId ? "RELEASE REQUESTED · AWAITING RECEIVER" : "NO COMMAND PENDING");
  updateSteps("observe");
  renderAll();
  try {
    let terminalAuthority = settings.mode === "demo" ? "radio" : null;
    if (settings.mode === "direct" && leaseId) {
      try {
        const response = await postJson("/api/v1/control/release", {schema: "flightdeck.command.v1", action: "release", leaseId, reason}, 1800, leaseId);
        if (actionEpoch !== runtime.commandEpoch || sourceGeneration !== runtime.sourceGeneration) return false;
        terminalAuthority = acknowledgedTerminalAuthority(response?.authority);
        if (response?.accepted !== true || response.leaseId !== leaseId || response.motorSafe !== true || response.armed !== false || !terminalAuthority) throw new Error(response?.reason || "Receiver safe-terminal acknowledgement missing");
      } catch (error) {
        if (actionEpoch !== runtime.commandEpoch || sourceGeneration !== runtime.sourceGeneration) return false;
        setCommandAck("bad", "RELEASE UNCONFIRMED · HEARTBEAT STOPPED");
        addEvent("CONTROL", `${reason}; receiver confirmation missing: ${error.message}`, "LEASE EXPIRY", "bad");
        if (!silent) toast(`Release unconfirmed; heartbeat stopped and receiver lease must expire: ${error.message}`);
        return false;
      }
    }
    if (actionEpoch !== runtime.commandEpoch || sourceGeneration !== runtime.sourceGeneration) return false;
    if (terminalAuthority) {
      state.control.authority = terminalAuthority;
      state.control.armed = false;
      state.control.failsafe = terminalAuthority === "failsafe";
      state.control.webEnabled = false;
      setCommandAck("good", terminalAuthority === "radio" ? "RECEIVER CONFIRMED · RADIO AUTHORITY" : "RECEIVER CONFIRMED · MOTOR-SAFE FAILSAFE");
      addEvent("CONTROL", reason, terminalAuthority === "radio" ? "RADIO" : "FAILSAFE", terminalAuthority === "radio" ? "good" : "warn");
      if (!silent) toast(terminalAuthority === "radio" ? "Receiver confirmed radio authority" : "Receiver confirmed motor-safe failsafe");
    }
    return Boolean(terminalAuthority);
  } finally {
    runtime.controlActionPending = false;
    renderAll();
  }
}

function startHold() {
  if ($("enableBench").disabled || runtime.holdTimer || runtime.sessionRequestPending) return;
  const eligibility = benchEligibility(computeAssessment(), false);
  if (!eligibility.ok) return toast(`Bench request blocked: ${eligibility.reason}`);
  $("enableBench").classList.add("holding");
  const requestToken = ++runtime.sessionRequestToken;
  runtime.holdTimer = setTimeout(() => {
    runtime.holdTimer = 0;
    $("enableBench").classList.remove("holding");
    const finalEligibility = benchEligibility(computeAssessment(), false);
    if (!finalEligibility.ok) return toast(`Bench request cancelled: ${finalEligibility.reason}`);
    runtime.sessionRequestPending = true;
    renderAll();
    requestBenchAuthority(requestToken).finally(() => {
      runtime.sessionRequestPending = false;
      renderAll();
    });
  }, 2000);
}

function cancelHold() {
  const hadPendingHold = Boolean(runtime.holdTimer);
  clearTimeout(runtime.holdTimer);
  runtime.holdTimer = 0;
  $("enableBench").classList.remove("holding");
  if (hadPendingHold) runtime.sessionRequestToken += 1;
}

function centerSurfaces() {
  ["webAileron", "webElevator", "webRudder"].forEach((id) => { $(id).value = 0; setText(`${id}Value`, "0%"); });
  if (runtime.benchActive) setCommandAck("", "CENTER STAGED · PRESS SEND TO APPLY");
  toast("Centered values staged");
}

async function emergencyStop() {
  if (!runtime.benchActive || !runtime.leaseId || runtime.controlActionPending) {
    return toast("Priority stop is available only during an active receiver bench lease");
  }
  clearTimeout(runtime.heartbeatTimer);
  runtime.controlActionPending = true;
  const actionEpoch = ++runtime.commandEpoch;
  const sourceGeneration = runtime.sourceGeneration;
  runtime.sessionRequestToken += 1;
  $("webThrottle").value = 0;
  setText("webThrottleValue", "0%");
  ["webAileron", "webElevator", "webRudder"].forEach((id) => { $(id).value = 0; setText(`${id}Value`, "0%"); });
  const leaseId = runtime.leaseId;
  const commandId = ++runtime.commandId;
  runtime.commanded = {throttle: 0, aileron: 0, elevator: 0, rudder: 0};
  runtime.benchActive = false;
  runtime.pendingManualControls = null;
  runtime.leaseId = null;
  renderAll();
  setCommandAck("pending", `PRIORITY KILL ${commandId} · AWAITING RECEIVER`);
  try {
    let terminalAuthority = "radio";
    if (settings.mode === "demo") {
      await new Promise((resolve) => setTimeout(resolve, 120));
      if (actionEpoch !== runtime.commandEpoch || sourceGeneration !== runtime.sourceGeneration) return;
      state.control.authority = "radio";
      state.control.armed = false;
      state.control.failsafe = false;
      state.control.webEnabled = false;
    } else {
      const response = await postJson("/api/v1/control/kill", {
        schema: "flightdeck.command.v1",
        action: "motorSafeRelease",
        leaseId,
        commandId,
        issuedAt: new Date().toISOString(),
        throttleUs: 1000
      }, 650, leaseId);
      if (actionEpoch !== runtime.commandEpoch || sourceGeneration !== runtime.sourceGeneration) return;
      terminalAuthority = acknowledgedTerminalAuthority(response?.authority);
      if (response?.accepted !== true || response.leaseId !== leaseId || response.motorSafe !== true || response.killLatched !== true || response.rearmRequired !== true) throw new Error(response?.reason || "Motor-safe latch acknowledgement missing");
      if (!Number.isInteger(response.commandId) || response.commandId !== commandId) throw new Error("Kill acknowledgement ID mismatch");
      if (!terminalAuthority) throw new Error("Receiver did not confirm a safe terminal authority");
      if (response.armed !== false) throw new Error("Receiver did not confirm disarmed state");
      state.control.authority = terminalAuthority;
      state.control.armed = false;
      state.control.failsafe = terminalAuthority === "failsafe";
      state.control.webEnabled = false;
    }
    setCommandAck("good", `KILL ${commandId} · MOTOR-SAFE LATCHED · ${terminalAuthority.toUpperCase()}`);
    addEvent("KILL", `Receiver latched motor-safe ${terminalAuthority} outcome; physical re-arm required`, "LATCHED", terminalAuthority === "radio" ? "good" : "warn");
    toast("Receiver confirmed motor-safe latch; physical re-arm required");
  } catch (error) {
    if (actionEpoch !== runtime.commandEpoch || sourceGeneration !== runtime.sourceGeneration) return;
    setCommandAck("bad", "KILL UNCONFIRMED · USE PHYSICAL KILL");
    addEvent("KILL", `Priority kill unconfirmed: ${error.message}`, "PHYSICAL ACTION", "bad");
    toast("Kill unconfirmed — use the physical kill/disarm control now");
  } finally {
    runtime.controlActionPending = false;
    renderAll();
  }
}

function downloadFile(filename, content, type = "text/csv;charset=utf-8") {
  const blob = new Blob([content], {type});
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url; anchor.download = filename; document.body.append(anchor); anchor.click(); anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportTelemetry() {
  const rows = runtime.recorded.length ? runtime.recorded : runtime.history;
  if (!rows.length) return toast("No telemetry samples to export");
  const csv = ["timestamp,roll_deg,pitch_deg,yaw_rate_dps,tx_voltage,aircraft_voltage,radio_quality_pct,throttle_pct", ...rows.map((row) => [new Date(row.time).toISOString(), row.roll, row.pitch, row.yawRate, row.txV, row.rxV, row.quality, row.throttle].join(","))].join("\n");
  downloadFile(`flightdeck-telemetry-${new Date().toISOString().replace(/[:.]/g, "-")}.csv`, csv);
  toast(`Exported ${rows.length} telemetry samples`);
}

function exportEvents() {
  const csv = ["timestamp,source,event,status", ...runtime.events.map((event) => [event.time, event.source, `"${event.message.replaceAll('"', '""')}"`, event.status].join(","))].join("\n");
  downloadFile(`flightdeck-events-${new Date().toISOString().slice(0, 10)}.csv`, csv);
  toast("Event log exported");
}

function updateClock() {
  const date = new Date();
  setText("utcClock", date.toISOString().slice(11, 19));
  const elapsed = Math.floor((now() - runtime.startedAt) / 1000);
  setText("missionClock", `${String(Math.floor(elapsed / 3600)).padStart(2, "0")}:${String(Math.floor(elapsed % 3600 / 60)).padStart(2, "0")}:${String(elapsed % 60).padStart(2, "0")}`);
}

function applyTheme(theme) {
  settings.theme = theme === "day" ? "day" : "night";
  document.documentElement.dataset.theme = settings.theme;
  document.querySelector('meta[name="theme-color"]').content = settings.theme === "day" ? "#e9f0f4" : "#050a10";
  saveSettings();
  scheduleChartDraw();
}

function syncSettingsForm() {
  $("connectionMode").value = settings.mode;
  $("endpointInput").value = settings.endpoint;
  $("pollInterval").value = String(settings.pollMs);
  $("txMinVoltage").value = settings.txMin;
  $("txMaxVoltage").value = settings.txMax;
  $("rxMinVoltage").value = settings.rxMin;
  $("rxMaxVoltage").value = settings.rxMax;
  $("mixedContentWarning").hidden = !(location.protocol === "https:" && /^http:\/\//i.test(settings.endpoint));
}

function wireInterface() {
  $$('[data-view]').forEach((button) => button.addEventListener("click", () => navigate(button.dataset.view)));
  $$('[data-go]').forEach((button) => button.addEventListener("click", () => navigate(button.dataset.go)));
  window.addEventListener("hashchange", () => navigate(location.hash.slice(1), false));

  $("themeToggle").addEventListener("click", () => applyTheme(settings.theme === "night" ? "day" : "night"));
  $$('[data-chart-window]').forEach((button) => button.addEventListener("click", () => {
    runtime.chartWindow = Number(button.dataset.chartWindow);
    $$('[data-chart-window]').forEach((item) => item.classList.toggle("active", item === button));
    setText("chartStart", `−${runtime.chartWindow < 60 ? `${runtime.chartWindow} s` : `${runtime.chartWindow / 60} min`}`);
    scheduleChartDraw();
  }));

  $("pauseTelemetry").addEventListener("click", () => {
    runtime.telemetryPaused = !runtime.telemetryPaused;
    setText("pauseTelemetry", runtime.telemetryPaused ? "RESUME VIEW" : "PAUSE VIEW");
    setText("chartStatus", runtime.telemetryPaused ? "VIEW PAUSED" : "STREAMING");
    if (!runtime.telemetryPaused) scheduleChartDraw();
  });
  $("recordTelemetry").addEventListener("click", () => {
    runtime.recording = !runtime.recording;
    if (runtime.recording) runtime.recorded = [];
    setText("recordTelemetry", runtime.recording ? "■ STOP RECORDING" : "● START RECORDING");
    addEvent("RECORDER", runtime.recording ? "Telemetry recording started" : `Telemetry recording stopped at ${runtime.recorded.length} samples`, runtime.recording ? "ACTIVE" : "SAVED", "good");
  });
  $("exportTelemetry").addEventListener("click", exportTelemetry);

  $("connectionMode").addEventListener("change", () => {
    const direct = $("connectionMode").value === "direct";
    $("mixedContentWarning").hidden = !(direct && location.protocol === "https:" && /^http:\/\//i.test($("endpointInput").value));
  });
  $("endpointInput").addEventListener("input", () => {
    $("mixedContentWarning").hidden = !(location.protocol === "https:" && /^http:\/\//i.test($("endpointInput").value));
  });
  $("testConnection").addEventListener("click", testEndpoint);
  $("saveConnection").addEventListener("click", async () => {
    if (runtime.sessionRequestPending || runtime.controlActionPending || runtime.connectionTestPending) return toast("Wait for the current connection or control action to finish");
    const mode = $("connectionMode").value;
    try {
      const endpoint = mode === "direct" ? validateEndpoint($("endpointInput").value.trim()) : settings.endpoint;
      const changed = mode !== settings.mode || endpoint !== settings.endpoint;
      if (runtime.benchActive) {
        const released = await releaseAuthority("Connection mode or endpoint changed", true);
        if (!released) throw new Error("Receiver did not confirm release; connection settings were not changed");
      }
      settings.endpoint = endpoint;
      settings.mode = mode;
      settings.pollMs = clamp(Number($("pollInterval").value), 100, 1000);
      runtime.connectionAuthorized = mode === "demo" || Boolean(settings.endpoint);
      if (changed) invalidateTelemetrySource();
      saveSettings(); syncSettingsForm();
      restartDataLoop();
      updateConnectionResult("good", mode === "demo" ? "Demo source active. No device connection required." : `Connecting to ${settings.endpoint}…`);
      addEvent("CONFIG", `Data source set to ${mode.toUpperCase()}`, "SAVED", "good");
      toast(mode === "demo" ? "Simulation mode active" : "Connecting to Flight Deck device");
    } catch (error) {
      updateConnectionResult("bad", error.message);
      toast(error.message);
    }
  });
  $("connectButton").addEventListener("click", () => { navigate("systems"); setTimeout(() => $("endpointInput").focus(), 50); });
  $("saveCalibration").addEventListener("click", () => {
    const values = [$("txMinVoltage").value, $("txMaxVoltage").value, $("rxMinVoltage").value, $("rxMaxVoltage").value].map(Number);
    if (values.some((value) => !Number.isFinite(value) || value <= 0) || values[1] <= values[0] || values[3] <= values[2]) return toast("Full voltage must be higher than empty voltage");
    [settings.txMin, settings.txMax, settings.rxMin, settings.rxMax] = values;
    saveSettings(); renderAll(); addEvent("CONFIG", "Battery calibration updated", "SAVED", "good"); toast("Battery calibration saved");
  });

  $("propellerCheck").addEventListener("change", renderAll);
  const hold = $("enableBench");
  ["pointerdown"].forEach((event) => hold.addEventListener(event, startHold));
  ["pointerup", "pointercancel", "pointerleave"].forEach((event) => hold.addEventListener(event, cancelHold));
  hold.addEventListener("keydown", (event) => { if (!event.repeat && ["Enter", " "].includes(event.key)) { event.preventDefault(); startHold(); } });
  hold.addEventListener("keyup", (event) => { if (["Enter", " "].includes(event.key)) cancelHold(); });
  $("releaseControl").addEventListener("click", () => releaseAuthority());
  $("emergencyStop").addEventListener("click", emergencyStop);
  $("centerSurfaces").addEventListener("click", centerSurfaces);
  $("sendCommand").addEventListener("click", () => sendCommand(true));
  ["webThrottle", "webAileron", "webElevator", "webRudder"].forEach((id) => $(id).addEventListener("input", () => {
    setText(`${id}Value`, `${$(id).value}%`);
    if (runtime.benchActive) setCommandAck("", "CHANGES STAGED · PRESS SEND TO APPLY");
  }));

  $("exportEvents").addEventListener("click", exportEvents);
  $("clearEvents").addEventListener("click", () => { runtime.events = []; persistEvents(); renderEvents(); toast("Local event log cleared"); });

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      cancelHold();
      runtime.sessionRequestToken += 1;
      if (runtime.benchActive) releaseAuthority("Browser hidden — safety release", true);
    }
  });
  window.addEventListener("resize", scheduleChartDraw);
  window.addEventListener("beforeunload", () => {
    if (runtime.benchActive && settings.mode === "direct" && runtime.leaseId && navigator.sendBeacon) {
      navigator.sendBeacon(endpointUrl("/api/v1/control/release"), new Blob([JSON.stringify({leaseId: runtime.leaseId, action: "release", reason: "browser_unload"})], {type: "application/json"}));
    }
  });
}

function initialize() {
  applyTheme(settings.theme);
  syncSettingsForm();
  wireInterface();
  renderEvents();
  addEvent("SYSTEM", "Flight Deck V1 interface initialized", settings.mode === "demo" ? "SIMULATION" : "READY", settings.mode === "demo" ? "warn" : "good");
  navigate(location.hash.slice(1) || "flight", false);
  if (settings.mode === "direct") {
    runtime.connectionAuthorized = false;
    invalidateTelemetrySource();
    updateConnectionResult("warn", "Direct endpoint saved. Press SAVE & CONNECT to grant local-network access.");
  }
  restartDataLoop();
  renderAll();
  updateClock();
  setInterval(updateClock, 1000);
  runtime.ageTimer = setInterval(() => { if (settings.mode === "direct") renderAll(); }, 250);
}

initialize();
