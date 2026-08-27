/**
 * petOverlay.js — the companion's transparent, always-on-top, click-through window.
 *
 * One overlay per display, each covering that display's full bounds. Full-bounds
 * rather than a small window because the companion moves around the screen and a
 * small window would need constant repositioning; covering everything and being
 * click-through is simpler and is what the reference implementation does.
 *
 * THE CLICK-THROUGH RULE IS LOAD-BEARING. The window sits over the entire desktop,
 * so one that accepted clicks would make the machine unusable. Input is refused by
 * default (`setIgnoreMouseEvents(true, { forward: true })`) and the renderer keeps
 * `pointer-events: none` on the body, enabling it only on the companion itself.
 * `forward: true` is what still lets the renderer SEE the cursor move, which is how
 * it knows when the pointer is over the sprite.
 *
 * SINGLE AVATAR ACROSS DISPLAYS. There is still one overlay per display, but the
 * avatar lives on exactly ONE of them at a time (`activeDisplayId`); every other
 * overlay is told it is inactive and renders nothing, so a multi-monitor user sees
 * one companion, not one per screen. The avatar is moved to another display ONLY by
 * dragging it across the screen boundary — it does NOT follow the cursor at rest.
 * The main process owns the cross-display handoff because mousemove events stop at a
 * window edge and only `screen.getCursorScreenPoint()` can follow a drag between
 * displays.
 */

const path = require("path");
const fs = require("fs");
const { app, BrowserWindow, screen, ipcMain } = require("electron");
const { companionPageUrl } = require("./pageUrl");

/** @type {Map<number, Electron.BrowserWindow>} display id -> overlay */
const overlays = new Map();

/**
 * Per-overlay cursor hitboxes: window -> { pet, bubble, menu }, each rect in that
 * overlay's local pixels or null. The renderer reports these; the poll below reads
 * them. Keyed by the window itself so a torn-down overlay drops out cleanly.
 * @type {Map<Electron.BrowserWindow, {pet: object|null, bubble: object|null, menu: object|null}>}
 */
const hitboxes = new Map();

/** Last ignore-mouse state applied per window, so the poll only toggles on change. */
const lastIgnore = new Map();

/** ~60fps, matching the desktop app's cursor poll. */
const HITBOX_POLL_MS = 16;

/** Pet box, matching the renderer's sprite size (shared constant PET_W/PET_H = 128). */
const PET_W = 128;
const PET_H = 128;

/** Force-stop a drag that never saw a mouseup (window blur, lost event). */
const DRAG_SAFETY_MS = 10_000;

let pollTimer = null;
let ipcRegistered = false;

/** Which display currently hosts the single avatar. @type {number|null} */
let activeDisplayId = null;

/** Cross-display drag state, owned entirely by the main process. */
let dragPollTimer = null;
let dragSafetyTimer = null;
let dragOffsetX = 0;
let dragOffsetY = 0;

let baseUrl = "";
let credential = "";
let log = () => {};

function setOverlayLogger(fn) {
  if (typeof fn === "function") log = fn;
}

function setOverlayTarget(url, token) {
  baseUrl = url || "";
  credential = token || "";
}

/**
 * Keep the HOST app in the Dock (macOS).
 *
 * macOS flips a window-owning app to the accessory activation policy — which drops
 * its Dock icon — when it shows a window shaped like this overlay (frameless,
 * transparent, always-on-top). Re-assert "regular" and the Dock icon right after
 * showing, so opening the companion never makes Kiro Crew vanish from the Dock.
 * Mirrors Mochi's assertHostStaysInDock (mochi/petOverlays.js), which carries the
 * same note; the crew-companion overlay was missing it.
 */
function assertHostStaysInDock() {
  if (process.platform !== "darwin") return;
  try {
    app.setActivationPolicy?.("regular");
    app.dock?.show?.();
  } catch {
    /* older Electron / already regular */
  }
}

// ── Position persistence ────────────────────────────────────────────────────
// Remembered in Electron's userData dir (the shell cannot resolve the gateway's
// data dir). Shape + 0600 mode mirror the reference implementation.

function petPosPath() {
  return path.join(app.getPath("userData"), "crew-companion-pet-position.json");
}

/** @type {{displayId?:number}|null} */
let savedPetPos = null;
try {
  savedPetPos = JSON.parse(fs.readFileSync(petPosPath(), "utf-8"));
} catch {
  /* first run / unreadable — fall back to a computed start position */
}

// Only the DISPLAY the avatar lives on is persisted here, for restart election; its
// on-screen x/y is owned by the renderer (petBridge.savePosition/getWindowPosition).
function savePetPos(displayId) {
  savedPetPos = { displayId };
  try {
    fs.writeFileSync(petPosPath(), JSON.stringify(savedPetPos), { mode: 0o600 });
  } catch {
    /* a failed position write must never break the companion */
  }
}

// ── Display geometry (reference logic, verbatim) ─────────────────────────────

function findDisplayAtPoint(sx, sy) {
  return (
    screen.getAllDisplays().find(
      (d) =>
        sx >= d.bounds.x &&
        sx < d.bounds.x + d.bounds.width &&
        sy >= d.bounds.y &&
        sy < d.bounds.y + d.bounds.height,
    ) || null
  );
}

/** Nearest display by squared edge distance — the fallback for a cursor in a gap. */
function findNearestDisplay(sx, sy) {
  const displays = screen.getAllDisplays();
  let best = displays[0];
  let bestDist = Infinity;
  for (const d of displays) {
    const dx = Math.max(d.bounds.x - sx, 0, sx - (d.bounds.x + d.bounds.width));
    const dy = Math.max(d.bounds.y - sy, 0, sy - (d.bounds.y + d.bounds.height));
    const dist = dx * dx + dy * dy;
    if (dist < bestDist) {
      bestDist = dist;
      best = d;
    }
  }
  return best;
}

/** Clamp a local position: the avatar may hang half off left/right, never off top/bottom. */
function clampLocal(localX, localY, bounds) {
  return {
    x: Math.max(-PET_W / 2, Math.min(bounds.width - PET_W / 2, localX)),
    y: Math.max(0, Math.min(bounds.height - PET_H, localY)),
  };
}

// ── The handoff ──────────────────────────────────────────────────────────────

/**
 * Move the avatar to another display's overlay. The old overlay is told it is no
 * longer active (so it stops rendering) and returns to click-through — unless a
 * drag is in flight, which manages ignore-mouse across every overlay itself.
 */
function transferActiveToDisplay(targetDisplayId, localX, localY, isDragging = false) {
  const newWin = overlays.get(targetDisplayId);
  // Never hand the avatar to a display with no live overlay — e.g. a monitor
  // hot-plugged after startup that the drag poll selected. Deactivating the
  // current overlay for a target that cannot render would leave NO avatar on
  // screen, so keep it where it is until an overlay exists for that display.
  if (!newWin || newWin.isDestroyed()) return;

  if (activeDisplayId !== null && activeDisplayId !== targetDisplayId) {
    const oldWin = overlays.get(activeDisplayId);
    if (oldWin && !oldWin.isDestroyed()) {
      oldWin.webContents.send("crew-companion:set-active", false);
      if (!isDragging) oldWin.setIgnoreMouseEvents(true, { forward: true });
    }
  }

  activeDisplayId = targetDisplayId;
  // Drop any stale rect so the poll's null-hitbox safety net holds for the few
  // frames until the renderer re-reports on the new display.
  hitboxes.delete(newWin);
  lastIgnore.delete(newWin);
  newWin.webContents.send("crew-companion:set-active", true, localX, localY, isDragging);
}

// ── Cross-display drag poll ───────────────────────────────────────────────────
// Runs only while a drag is in flight. It follows the GLOBAL cursor (the only thing
// that crosses a window edge) and hands the avatar to whichever display the cursor
// is over. There is no at-rest cursor following — this timer exists solely for the
// duration of a drag.

function startDragPolling(offsetX, offsetY) {
  stopDragPolling();
  dragOffsetX = offsetX;
  dragOffsetY = offsetY;

  // Every overlay must accept mouse events so whichever display the cursor ends
  // over can report the mouseup that ends the drag.
  for (const win of overlays.values()) {
    if (win && !win.isDestroyed()) win.setIgnoreMouseEvents(false);
  }
  broadcastToPets("crew-companion:drag-listen-mouseup");

  dragSafetyTimer = setTimeout(() => {
    if (dragPollTimer !== null) stopDragPolling();
  }, DRAG_SAFETY_MS);
  dragSafetyTimer.unref?.();

  dragPollTimer = setInterval(dragPollOnce, HITBOX_POLL_MS);
  dragPollTimer.unref?.();
}

/**
 * One cross-display drag tick: follow the GLOBAL cursor (the only thing that crosses
 * a window edge) and hand the avatar to the display it is over, streaming the local
 * position to the active overlay in between. Split out from the interval so a drag
 * can be driven deterministically in tests.
 */
function dragPollOnce() {
  let cursor;
  try {
    cursor = screen.getCursorScreenPoint();
  } catch {
    return;
  }
  const petScreenX = cursor.x - dragOffsetX;
  const petScreenY = cursor.y - dragOffsetY;

  const target =
    findDisplayAtPoint(cursor.x, cursor.y) || findNearestDisplay(cursor.x, cursor.y);
  const localX = petScreenX - target.bounds.x;
  const localY = petScreenY - target.bounds.y;

  // Crossing a screen boundary hands the avatar to the new display AT the crossing
  // point — but only if that display actually has an overlay. A display hot-plugged
  // after enable has none (nothing opens one), so transferring there would no-op
  // while savePetPos hammered fs.writeFileSync ~60x/sec on the main thread and the
  // avatar froze. In that case fall through and keep streaming to the active overlay,
  // clamped to its OWN display's edge, so the avatar tracks the cursor instead.
  if (target.id !== activeDisplayId && overlays.has(target.id)) {
    transferActiveToDisplay(target.id, localX, localY, true);
    savePetPos(target.id);
    return;
  }

  const activeDisplay =
    screen.getAllDisplays().find((d) => d.id === activeDisplayId) || target;
  const clamped = clampLocal(
    petScreenX - activeDisplay.bounds.x,
    petScreenY - activeDisplay.bounds.y,
    activeDisplay.bounds,
  );
  const win = overlays.get(activeDisplayId);
  if (win && !win.isDestroyed()) {
    win.webContents.send("crew-companion:drag-update", clamped.x, clamped.y);
  }
}

function stopDragPolling() {
  if (dragPollTimer === null) return;
  // One last transfer check before stopping: an avatar released the instant it
  // crosses to a new display would otherwise snap back to the last-polled display,
  // because the interval is cleared before the next tick runs that final transfer.
  try {
    dragPollOnce();
  } catch {
    /* windows torn down mid-drag — nothing to transfer */
  }
  clearInterval(dragPollTimer);
  dragPollTimer = null;
  if (dragSafetyTimer !== null) {
    clearTimeout(dragSafetyTimer);
    dragSafetyTimer = null;
  }

  // Final position, so the renderer can run its edge-snap animation.
  let cursor;
  try {
    cursor = screen.getCursorScreenPoint();
  } catch {
    cursor = null;
  }
  if (cursor && activeDisplayId !== null) {
    const display = screen.getAllDisplays().find((d) => d.id === activeDisplayId);
    if (display) {
      const clamped = clampLocal(
        cursor.x - dragOffsetX - display.bounds.x,
        cursor.y - dragOffsetY - display.bounds.y,
        display.bounds,
      );
      const win = overlays.get(activeDisplayId);
      if (win && !win.isDestroyed()) {
        win.webContents.send("crew-companion:drag-ended", clamped.x, clamped.y);
      }
      savePetPos(activeDisplayId);
    }
  }

  // CRITICAL: restore ignore-mouse on ALL overlays. The hitbox poll switches the
  // active overlay back to interactive once the renderer reports a real rect.
  for (const win of overlays.values()) {
    if (win && !win.isDestroyed()) win.setIgnoreMouseEvents(true, { forward: true });
    lastIgnore.set(win, true);
  }
}

/**
 * Send an overlay its current active state. Used for the initial reveal and —
 * crucially — as the reply to `crew-companion:pet-ready`, which the renderer sends
 * once its onSetActive listener is mounted. That handshake replaces a fixed timer:
 * a slow renderer (e.g. a long theme load) could otherwise miss every set-active
 * and stay hidden forever.
 */
function sendActiveStateTo(win, knownDisplayId = null) {
  if (!win || win.isDestroyed()) return;
  let displayId = knownDisplayId;
  if (displayId === null) {
    for (const [id, w] of overlays) {
      if (w === win) {
        displayId = id;
        break;
      }
    }
  }
  if (displayId === null) return;
  if (displayId !== activeDisplayId) {
    win.webContents.send("crew-companion:set-active", false);
    return;
  }
  // During an active drag, stamp the activation with the LIVE drag coordinates and
  // isDragging=true. A slow target renderer that missed the transfer IPC would
  // otherwise treat a bare activation as at-rest and clear the carried bubble after
  // the shared cursor already advanced past it (dropping the reminder). With the drag
  // state attached the renderer adopts the in-flight drag instead of clearing.
  if (dragPollTimer !== null) {
    try {
      const cursor = screen.getCursorScreenPoint();
      const display = screen.getAllDisplays().find((d) => d.id === activeDisplayId);
      if (display) {
        win.webContents.send(
          "crew-companion:set-active",
          true,
          cursor.x - dragOffsetX - display.bounds.x,
          cursor.y - dragOffsetY - display.bounds.y,
          true,
        );
        return;
      }
    } catch {
      /* cursor unavailable — fall through to a bare activation */
    }
  }
  win.webContents.send("crew-companion:set-active", true);
}

function createOverlayFor(display) {
  const win = new BrowserWindow({
    x: display.bounds.x,
    y: display.bounds.y,
    width: display.bounds.width,
    height: display.bounds.height,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    hasShadow: false,
    enableLargerThanScreen: true,
    show: false,
    /*
     * Deliver the FIRST click to the page — a constructor option, the only place
     * this can be set.
     *
     * On macOS a click into an inactive window is consumed to activate it, and this
     * overlay is `setFocusable(false)` + `showInactive()`, so it never becomes the
     * active window: EVERY click is a first-mouse click. Without this the window
     * accepted `mousemove` (ignore-mouse is set with `forward: true`) but never the
     * `mousedown` behind it — so the bubble's hover-revealed ✕ appeared under the
     * cursor and did nothing when clicked, and the notification could not be
     * dismissed at all.
     *
     * It used to be attempted as `win.setAcceptFirstMouse?.(true)` after
     * construction. No such method exists on BrowserWindow — `acceptFirstMouse` is
     * a BaseWindow CONSTRUCTOR option only — and the optional call swallowed the
     * miss silently, which is why it read as done for so long.
     */
    acceptFirstMouse: true,
    webPreferences: {
      preload: path.join(__dirname, "pet-preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      // The companion animates continuously and the window is never focusable, so
      // without this Chromium throttles it to a stall for its whole lifetime.
      backgroundThrottling: false,
    },
  });

  win.setFocusable(false);
  // Refuse input by default; the renderer re-enables it over the sprite alone.
  win.setIgnoreMouseEvents(true, { forward: true });
  // INVISIBLE TO SCREEN CAPTURE (macOS NSWindowSharingNone, Windows
  // WDA_EXCLUDEFROMCAPTURE; no-op elsewhere). The overlay covers a whole display,
  // so without this it is the topmost window at EVERY point on the screen: the
  // macOS screenshot picker (Cmd+Shift+4 space / Cmd+Shift+5 window mode) offers
  // the overlay instead of the app the user is pointing at, and a region capture
  // or recording bakes the companion into the result. A decoration must not
  // appear in the user's screenshots, screen recordings, or screen shares — the
  // same reason computer use's cursor overlay sets NSWindowSharingNone.
  win.setContentProtection(true);
  // Follow the user across spaces and over full-screen apps — a companion that
  // vanished when you switched desktops would not be company.
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  win.loadURL(companionPageUrl(baseUrl, "pet.html", credential));
  // Activation handshake. The renderer draws NOTHING until it receives
  // set-active(true); we send the flag BEFORE revealing so the avatar only ever
  // appears on the active overlay. This first send is a best-effort fast path — the
  // RELIABLE delivery is the renderer's `crew-companion:pet-ready` (sent once its
  // listener is mounted), answered via sendActiveStateTo. That replaces the old
  // fixed 300ms re-send, which lost the event entirely if the renderer's effect
  // mounted later (e.g. a slow theme load) and left the avatar hidden forever.
  win.webContents.on("did-finish-load", () => {
    if (win.isDestroyed()) return;
    // Route through the one drag-aware choke so a reveal landing mid-drag carries the
    // drag state rather than a bare activation that would clear the carried bubble.
    // Pass the known display id: the overlay is not in the map yet at did-finish-load.
    sendActiveStateTo(win, display.id);
    if (!win.isVisible()) win.showInactive();
    // Showing this accessory-shaped window demotes the app to a Dock-less accessory
    // on macOS; put the host back in the Dock (see assertHostStaysInDock).
    assertHostStaysInDock();
  });
  win.on("closed", () => {
    for (const [id, w] of overlays) if (w === win) overlays.delete(id);
    hitboxes.delete(win);
    lastIgnore.delete(win);
  });
  return win;
}

/**
 * Open an overlay on every display, but designate exactly ONE as active (the avatar
 * lives there). Active display = the one holding the saved position, else the
 * display under the cursor, else the primary. Idempotent per display.
 */
function openPetWindow() {
  if (!baseUrl) {
    log("crew-companion: no gateway origin yet, deferring overlay");
    return;
  }

  const primary = screen.getPrimaryDisplay();
  const displays = screen.getAllDisplays();

  activeDisplayId = savedPetPos && typeof savedPetPos.displayId === "number"
    ? savedPetPos.displayId
    : null;
  if (activeDisplayId === null || !displays.some((d) => d.id === activeDisplayId)) {
    let cur = { x: primary.bounds.x, y: primary.bounds.y };
    try {
      cur = screen.getCursorScreenPoint();
    } catch {
      /* headless / test — fall back to primary */
    }
    activeDisplayId = (findDisplayAtPoint(cur.x, cur.y) || primary).id;
  }
  for (const display of displays) {
    const existing = overlays.get(display.id);
    if (existing && !existing.isDestroyed()) continue;
    try {
      overlays.set(
        display.id,
        createOverlayFor(display),
      );
      log(
        `crew-companion: overlay opened on display ${display.id}` +
          (display.id === activeDisplayId ? " (active)" : ""),
      );
    } catch (err) {
      log(`crew-companion: overlay failed on display ${display.id} — ${err && err.message}`);
    }
  }
}

/** Close every overlay. Idempotent. */
function closePetWindow() {
  stopDragPolling();
  for (const [id, win] of [...overlays]) {
    overlays.delete(id);
    if (win && !win.isDestroyed()) win.destroy();
  }
  activeDisplayId = null;
}

function petWindowCount() {
  let n = 0;
  for (const win of overlays.values()) if (win && !win.isDestroyed()) n += 1;
  return n;
}

/**
 * Send a message to every companion overlay.
 *
 * There is one overlay per display, and all of them need state changes that happen
 * elsewhere — the panel closing, for instance — or a companion on a second monitor
 * would be left believing the panel is still open.
 */
function broadcastToPets(channel, ...args) {
  for (const win of overlays.values()) {
    if (win && !win.isDestroyed()) win.webContents.send(channel, ...args);
  }
}

/** True when this window is one of the companion overlays. */
function isPetWindow(win) {
  for (const w of overlays.values()) if (w === win) return true;
  return false;
}

/**
 * ── Cursor-hitbox authority ────────────────────────────────────────────────
 *
 * The overlay is click-through everywhere except a few small regions — the
 * companion, its bubble, and (while open) the context menu. The renderer reports
 * those rects; the main process polls the real cursor at ~60fps and toggles this
 * window's ignore-mouse itself. Doing the hit-test here rather than on a
 * pointer-enter/leave IPC round-trip is what stops a click on the companion body
 * falling through to the window behind it.
 *
 * `forward: true` on the ignore state keeps move events flowing even while the
 * window is click-through, which is what lets this poll keep seeing the cursor.
 */

/** True when the point is within the rect (inclusive of its edges). */
function pointInRect(rect, x, y) {
  return (
    !!rect &&
    x >= rect.x &&
    x <= rect.x + rect.w &&
    y >= rect.y &&
    y <= rect.y + rect.h
  );
}

/** True when the point falls inside ANY of this overlay's reported hitboxes. */
function cursorHitsWindow(boxes, localX, localY) {
  if (!boxes) return false;
  return (
    pointInRect(boxes.pet, localX, localY) ||
    pointInRect(boxes.bubble, localX, localY) ||
    pointInRect(boxes.menu, localX, localY)
  );
}

/** Merge a window's pet/bubble hitboxes, preserving any menu rect. */
function setWindowHitbox(win, pet, bubble) {
  if (!win) return;
  const cur = hitboxes.get(win) || { pet: null, bubble: null, menu: null };
  hitboxes.set(win, { pet: pet || null, bubble: bubble || null, menu: cur.menu || null });
}

/** Merge a window's menu hitbox, preserving its pet/bubble rects. */
function setWindowMenuHitbox(win, rect) {
  if (!win) return;
  const cur = hitboxes.get(win) || { pet: null, bubble: null, menu: null };
  hitboxes.set(win, { pet: cur.pet || null, bubble: cur.bubble || null, menu: rect || null });
}

/**
 * Decide one overlay's click-through state from a SCREEN cursor point and apply it.
 *
 * Converts the cursor to overlay-local coordinates using the window's OWN bounds —
 * ground truth versus display.bounds, which can drift with the macOS menu bar or a
 * display rearrangement. Toggles ignore-mouse only when it actually changes.
 * Returns the ignore state applied.
 */
function refreshOverlayInput(win, cursor) {
  if (!win || win.isDestroyed()) return true;
  const b = win.getBounds();
  const localX = cursor.x - b.x;
  const localY = cursor.y - b.y;
  const shouldIgnore = !cursorHitsWindow(hitboxes.get(win), localX, localY);
  if (lastIgnore.get(win) !== shouldIgnore) {
    lastIgnore.set(win, shouldIgnore);
    win.setIgnoreMouseEvents(shouldIgnore, { forward: true });
  }
  return shouldIgnore;
}

/**
 * One poll iteration. Only the ACTIVE overlay is interactive at rest; every other
 * overlay stays click-through because it hosts no avatar. The drag poll owns
 * ignore-mouse across all overlays while a drag is in flight, so this yields to it.
 * There is no at-rest cursor following.
 */
function pollOverlayInputOnce() {
  if (dragPollTimer !== null) return; // drag poll owns ignore-mouse during a drag
  let cursor;
  try {
    cursor = screen.getCursorScreenPoint();
  } catch {
    return; // no cursor available (e.g. under test) — nothing to do
  }
  const activeWin = activeDisplayId !== null ? overlays.get(activeDisplayId) : null;
  for (const win of overlays.values()) {
    try {
      if (win === activeWin) {
        refreshOverlayInput(win, cursor);
      } else if (win && !win.isDestroyed()) {
        // A non-active overlay never hosts the avatar, so it stays click-through.
        if (lastIgnore.get(win) !== true) {
          lastIgnore.set(win, true);
          win.setIgnoreMouseEvents(true, { forward: true });
        }
      }
    } catch {
      /* window torn down between checks — skip it */
    }
  }
}

function startHitboxPoll() {
  if (pollTimer) return;
  pollTimer = setInterval(pollOverlayInputOnce, HITBOX_POLL_MS);
  // A background poll must never be the reason the process cannot exit.
  pollTimer.unref?.();
}

function stopHitboxPoll() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

/**
 * Register the overlay's cursor-hitbox and drag IPC and start the poll. Called once
 * from `initCrewCompanion`. Each renderer reports its own window's rects; the sender
 * is resolved back to its overlay so one display's report cannot describe another's.
 */
function registerOverlayIpc() {
  if (ipcRegistered) return;
  ipcRegistered = true;

  ipcMain.on("crew-companion:update-hitbox", (event, pet, bubble) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win && isPetWindow(win)) setWindowHitbox(win, pet, bubble);
  });

  ipcMain.on("crew-companion:menu-hitbox", (event, rect) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win && isPetWindow(win)) setWindowMenuHitbox(win, rect);
  });

  // Cross-display drag: the renderer reports the drag start (with the cursor->sprite
  // offset) and end; the main process follows the global cursor in between and hands
  // the avatar between displays. ANY overlay reporting a mouseup ends the drag,
  // because after a handoff the cursor may be over a different overlay than the one
  // that started the gesture.
  ipcMain.on("crew-companion:drag-start", (event, offsetX, offsetY) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win && isPetWindow(win)) startDragPolling(offsetX || 0, offsetY || 0);
  });
  ipcMain.on("crew-companion:drag-end", (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win && isPetWindow(win)) stopDragPolling();
  });
  ipcMain.on("crew-companion:drag-mouseup", (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win && isPetWindow(win) && dragPollTimer !== null) stopDragPolling();
  });

  // The renderer sends this once its onSetActive listener is mounted; reply with
  // this overlay's current active state so a slow renderer never misses activation.
  ipcMain.on("crew-companion:pet-ready", (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win && isPetWindow(win)) sendActiveStateTo(win);
  });

  startHitboxPoll();
}

module.exports = {
  assertHostStaysInDock,
  broadcastToPets,
  isPetWindow,
  openPetWindow,
  closePetWindow,
  petWindowCount,
  setOverlayLogger,
  setOverlayTarget,
  registerOverlayIpc,
  stopHitboxPoll,
  transferActiveToDisplay,
  startDragPolling,
  stopDragPolling,
  dragPollOnce,
  // Exported for tests: they drive the toggle directly rather than through the
  // live cursor poll.
  pointInRect,
  cursorHitsWindow,
  refreshOverlayInput,
  pollOverlayInputOnce,
  setWindowHitbox,
  setWindowMenuHitbox,
  // Exported for tests: pure geometry decisions.
  _findDisplayAtPoint: findDisplayAtPoint,
  _findNearestDisplay: findNearestDisplay,
  _clampLocal: clampLocal,
  PET_W,
  PET_H,
};
