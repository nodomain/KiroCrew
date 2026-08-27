/**
 * The companion's window lifecycle.
 *
 * Electron is STUBBED — these pin the logic that decides whether a window should
 * exist, not the compositor. The rules under test are the ones that produce visible
 * bugs when broken: a failed probe must not tear the companion down, the overlay
 * must refuse input by default, and enable/disable must be idempotent.
 */

const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const Module = require("module");

/** Minimal Electron stand-in — enough to observe what the modules do. */
function stubElectron() {
  const created = [];
  const ipcHandlers = {};
  /** `ipcMain.handle` channels — the ones that answer, kept apart from `on`. */
  const ipcInvokers = {};

  class FakeWindow {
    constructor(opts) {
      this.opts = opts;
      this.destroyed = false;
      this.ignoreMouse = null;
      this.focusable = true;
      this.workspaces = null;
      this.loadedUrl = "";
      this.shown = false;
      this._events = {};
      this.sent = [];
      // did-finish-load fires synchronously so the activation handshake in
      // createOverlayFor runs and its set-active sends are observable.
      this.webContents = {
        on: (ev, cb) => { if (ev === "did-finish-load") cb(); },
        send: (ch, ...args) => this.sent.push({ ch, args }),
      };
      created.push(this);
    }
    setFocusable(v) { this.focusable = v; }
    setContentProtection(v) { this.contentProtection = v; }
    setIgnoreMouseEvents(ignore, opts) { this.ignoreMouse = { ignore, opts }; }
    setVisibleOnAllWorkspaces(v, opts) { this.workspaces = { v, opts }; }
    loadURL(u) { this.loadedUrl = u; }
    once(ev, cb) { this._events[ev] = cb; }
    on(ev, cb) { this._events[ev] = cb; }
    showInactive() { this.shown = true; }
    isVisible() { return this.shown; }
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; }
  }

  const dockCalls = { setActivationPolicy: [], dockShow: 0 };

  const displays = [
    { id: 1, bounds: { x: 0, y: 0, width: 1440, height: 900 } },
    { id: 2, bounds: { x: 1440, y: 0, width: 1920, height: 1080 } },
  ];

  // Mutable so a test can move the cursor between displays and drive a drag tick.
  let cursor = { x: 0, y: 0 };

  const electron = {
    app: {
      getPath: () => require("os").tmpdir(),
      on() {},
      setActivationPolicy: (p) => dockCalls.setActivationPolicy.push(p),
      dock: { show: () => { dockCalls.dockShow += 1; } },
    },
    BrowserWindow: FakeWindow,
    screen: {
      getAllDisplays: () => displays,
      getPrimaryDisplay: () => displays[0],
      getCursorScreenPoint: () => cursor,
    },
    ipcMain: {
      on: (ch, cb) => { ipcHandlers[ch] = cb; },
      // Electron throws on a second `handle` for one channel, so the real
      // registration removes first; the stub mirrors both halves.
      handle: (ch, cb) => {
        if (ipcInvokers[ch]) throw new Error(`second handler for '${ch}'`);
        ipcInvokers[ch] = cb;
      },
      removeHandler: (ch) => { delete ipcInvokers[ch]; },
    },
    contextBridge: { exposeInMainWorld: () => {} },
    ipcRenderer: { send: () => {} },
  };
  electron.BrowserWindow.fromWebContents = () => created[created.length - 1];

  const realResolve = Module._resolveFilename;
  Module._resolveFilename = function (request, ...rest) {
    if (request === "electron") return "electron";
    return realResolve.call(this, request, ...rest);
  };
  require.cache.electron = { id: "electron", filename: "electron", loaded: true, exports: electron };

  return {
    created,
    ipcHandlers,
    dockCalls,
    ipcInvokers,
    setCursor(x, y) { cursor = { x, y }; },
    addDisplay(d) { displays.push(d); },
    restore() {
      Module._resolveFilename = realResolve;
      delete require.cache.electron;
    },
  };
}

function loadModules() {
  const dir = path.join(__dirname, "..");
  for (const f of ["petOverlay.js", "index.js", "pageUrl.js"]) {
    delete require.cache[require.resolve(path.join(dir, f))];
  }
  return {
    overlay: require(path.join(dir, "petOverlay.js")),
    index: require(path.join(dir, "index.js")),
    pageUrl: require(path.join(dir, "pageUrl.js")),
  };
}

/**
 * Let the reconcile that `initCrewCompanion` fires on entry actually finish.
 *
 * `reconcileOnce` is guarded by an in-flight flag, so awaiting a second call
 * returns immediately while the first is still running — an assertion placed
 * straight after `init` races the probe and passes for the wrong reason. Found
 * exactly that way: a deliberately broken guard still passed until this wait
 * existed.
 */
async function settle() {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 10));
}

// ── the overlay window ──────────────────────────────────────────────────────

test("opens one overlay per display, covering each display's full bounds", () => {
  const stub = stubElectron();
  try {
    const { overlay } = loadModules();
    overlay.setOverlayTarget("http://localhost:5476", "");
    overlay.openPetWindow();

    assert.strictEqual(overlay.petWindowCount(), 2, "one per display");
    const [a, b] = stub.created;
    assert.strictEqual(a.opts.width, 1440);
    assert.strictEqual(b.opts.x, 1440, "second overlay sits on the second display");
  } finally {
    stub.restore();
  }
});

test("the overlay refuses mouse input by default, with forwarding on", () => {
  const stub = stubElectron();
  try {
    const { overlay } = loadModules();
    overlay.setOverlayTarget("http://localhost:5476", "");
    overlay.openPetWindow();

    // The window covers the whole desktop. Accepting input by default would make
    // the machine unclickable; `forward` is what still lets the renderer see the
    // cursor so it can tell when the pointer is over the companion.
    const win = stub.created[0];
    assert.deepStrictEqual(win.ignoreMouse, { ignore: true, opts: { forward: true } });
  } finally {
    stub.restore();
  }
});

test("the overlay is transparent, frameless, always on top and not focusable", () => {
  const stub = stubElectron();
  try {
    const { overlay } = loadModules();
    overlay.setOverlayTarget("http://localhost:5476", "");
    overlay.openPetWindow();
    const win = stub.created[0];

    assert.strictEqual(win.opts.transparent, true);
    assert.strictEqual(win.opts.frame, false);
    assert.strictEqual(win.opts.alwaysOnTop, true);
    assert.strictEqual(win.opts.skipTaskbar, true);
    assert.strictEqual(win.focusable, false);
    // The companion animates continuously in a never-focusable window, which
    // Chromium would otherwise throttle to a stall.
    assert.strictEqual(win.opts.webPreferences.backgroundThrottling, false);
    // Follows the user across spaces and over full-screen apps.
    assert.deepStrictEqual(win.workspaces, { v: true, opts: { visibleOnFullScreen: true } });
  } finally {
    stub.restore();
  }
});

test("the overlay is excluded from screen capture", () => {
  const stub = stubElectron();
  try {
    const { overlay } = loadModules();
    overlay.setOverlayTarget("http://localhost:5476", "");
    overlay.openPetWindow();

    // A display-sized window is the topmost window at every point on the screen.
    // Without content protection the macOS screenshot window picker offers the
    // overlay instead of the app under the cursor, and every region capture or
    // recording has the companion baked into it.
    for (const win of stub.created) {
      assert.strictEqual(win.contentProtection, true);
    }
  } finally {
    stub.restore();
  }
});

test("the overlay accepts the first mouse click, or nothing in it can be clicked", () => {
  const stub = stubElectron();
  try {
    const { overlay } = loadModules();
    overlay.setOverlayTarget("http://localhost:5476", "");
    overlay.openPetWindow();
    const win = stub.created[0];

    /*
     * A never-focusable window shown inactive never becomes active, so on macOS
     * every click into it is a "first mouse" click. Without this option that click
     * is spent activating the window instead of reaching the page: the bubble's ✕
     * revealed itself on hover (mousemove is forwarded) and then did nothing.
     *
     * Asserted on the CONSTRUCTOR options on purpose. `acceptFirstMouse` can only
     * be set there — the earlier `win.setAcceptFirstMouse?.(true)` called a method
     * BrowserWindow does not have, and the optional call made the miss invisible.
     * The fake window deliberately does not define that method, so reintroducing
     * the call fails loudly instead of silently doing nothing.
     */
    assert.strictEqual(win.opts.acceptFirstMouse, true);
    assert.strictEqual(
      typeof win.setAcceptFirstMouse,
      "undefined",
      "BrowserWindow has no setAcceptFirstMouse; the fake must not invent one",
    );
  } finally {
    stub.restore();
  }
});

test("opening twice does not create a second overlay per display", () => {
  const stub = stubElectron();
  try {
    const { overlay } = loadModules();
    overlay.setOverlayTarget("http://localhost:5476", "");
    overlay.openPetWindow();
    overlay.openPetWindow();
    assert.strictEqual(overlay.petWindowCount(), 2, "idempotent");
  } finally {
    stub.restore();
  }
});

test("closing is idempotent and leaves nothing behind", () => {
  const stub = stubElectron();
  try {
    const { overlay } = loadModules();
    overlay.setOverlayTarget("http://localhost:5476", "");
    overlay.openPetWindow();
    overlay.closePetWindow();
    overlay.closePetWindow();
    assert.strictEqual(overlay.petWindowCount(), 0);
    assert.ok(stub.created.every((w) => w.destroyed));
  } finally {
    stub.restore();
  }
});

test("no overlay is opened before a gateway origin is known", () => {
  const stub = stubElectron();
  try {
    const { overlay } = loadModules();
    overlay.setOverlayTarget("", "");
    overlay.openPetWindow();
    assert.strictEqual(overlay.petWindowCount(), 0, "deferred, not opened at a blank URL");
  } finally {
    stub.restore();
  }
});

// ── the page URL ────────────────────────────────────────────────────────────

test("the page URL mirrors the file layout, and omits an empty credential", () => {
  const stub = stubElectron();
  try {
    const { pageUrl } = loadModules();
    assert.strictEqual(
      pageUrl.companionPageUrl("http://localhost:5476", "pet.html"),
      "http://localhost:5476/app-windows/crew-companion/pet.html",
    );
    assert.strictEqual(
      pageUrl.companionPageUrl("http://localhost:5476/", "pet.html", "abc"),
      "http://localhost:5476/app-windows/crew-companion/pet.html?token=abc",
    );
  } finally {
    stub.restore();
  }
});

// ── the reconcile rule ──────────────────────────────────────────────────────

test("an inconclusive probe leaves the windows exactly as they are", async () => {
  const stub = stubElectron();
  try {
    const { overlay, index } = loadModules();
    overlay.setOverlayTarget("http://localhost:5476", "cred");
    overlay.openPetWindow();
    const before = overlay.petWindowCount();

    // No gateway is listening, so the probe cannot answer: that is UNKNOWN, and
    // treating it as "disabled" is what makes the companion appear to crash and
    // reappear every few seconds during an ordinary restart.
    index.initCrewCompanion({
      backendUrl: "http://127.0.0.1:9",
      fetchLocalToken: async () => "cred",
      glog: () => {},
    });
    await settle();

    assert.strictEqual(overlay.petWindowCount(), before, "unknown must not tear down");
    index.shutdownCrewCompanion();
  } finally {
    stub.restore();
  }
});

test("an inconclusive probe does not OPEN a companion either", async () => {
  const stub = stubElectron();
  try {
    const { overlay, index } = loadModules();
    overlay.setOverlayTarget("http://localhost:5476", "cred");
    // Nothing open yet, and the probe cannot answer.
    assert.strictEqual(overlay.petWindowCount(), 0);

    index.initCrewCompanion({
      backendUrl: "http://127.0.0.1:9",
      fetchLocalToken: async () => "cred",
      glog: () => {},
    });
    await settle();

    // This is the direction the three-state rule actually guards in this
    // implementation: teardown is already safe because "disabled" is matched
    // explicitly, but falling through on unknown would put a companion on screen
    // for an app nobody has enabled. Verified by reverting: deleting the
    // `state === "unknown"` early return makes this fail with 2 windows.
    assert.strictEqual(
      overlay.petWindowCount(),
      0,
      "unknown must not summon a companion for a possibly-disabled app",
    );
    index.shutdownCrewCompanion();
  } finally {
    stub.restore();
  }
});

test("no credential is unknown, not disabled", async () => {
  const stub = stubElectron();
  try {
    const { overlay, index } = loadModules();
    overlay.setOverlayTarget("http://localhost:5476", "cred");
    overlay.openPetWindow();

    index.initCrewCompanion({
      backendUrl: "http://localhost:5476",
      fetchLocalToken: async () => "", // cannot ask
      glog: () => {},
    });
    await settle();
    assert.strictEqual(overlay.petWindowCount(), 2, "kept, because we could not ask");
    index.shutdownCrewCompanion();
  } finally {
    stub.restore();
  }
});

test("shutdown closes every overlay", async () => {
  const stub = stubElectron();
  try {
    const { overlay, index } = loadModules();
    overlay.setOverlayTarget("http://localhost:5476", "cred");
    overlay.openPetWindow();
    index.initCrewCompanion({
      backendUrl: "http://127.0.0.1:9",
      fetchLocalToken: async () => "cred",
      glog: () => {},
    });
    index.shutdownCrewCompanion();
    assert.strictEqual(overlay.petWindowCount(), 0);
  } finally {
    stub.restore();
  }
});

test("the overlay registers the cursor-hitbox channels the renderer reports to", () => {
  const stub = stubElectron();
  try {
    const { overlay } = loadModules();
    overlay.registerOverlayIpc();

    // The renderer reports the companion's/bubble's rects and the menu's rect; the
    // main process polls the cursor and toggles ignore-mouse itself. Both channels
    // must be listened for or the reports are silent no-ops.
    assert.ok(
      stub.ipcHandlers["crew-companion:update-hitbox"],
      "pet/bubble hitbox channel must be registered",
    );
    assert.ok(
      stub.ipcHandlers["crew-companion:menu-hitbox"],
      "menu hitbox channel must be registered",
    );

    // The removed pointer-toggle round-trip must be gone.
    assert.strictEqual(
      stub.ipcHandlers["crew-companion:interactive"],
      undefined,
      "the pointer-enter/leave toggle was replaced by the hitbox poll",
    );

    overlay.stopHitboxPoll();
  } finally {
    stub.restore();
  }
});

test("showing an overlay re-asserts the host's Dock presence on macOS", () => {
  // macOS-only behaviour: assertHostStaysInDock no-ops off darwin, so there is
  // nothing to assert there.
  if (process.platform !== "darwin") return;
  const stub = stubElectron();
  try {
    const { overlay } = loadModules();
    overlay.setOverlayTarget("http://localhost:5476", "");
    overlay.openPetWindow();
    // The overlay's did-finish-load handler (the stub fires it synchronously) shows
    // the window and re-asserts the Dock during openPetWindow.

    // Showing the accessory-shaped overlay demotes the app to a Dock-less
    // accessory; the overlay must put the host straight back in the Dock, or
    // opening the companion makes Kiro Crew's Dock icon disappear.
    assert.ok(
      stub.dockCalls.setActivationPolicy.includes("regular"),
      "activation policy re-asserted to regular after showing the overlay",
    );
    assert.ok(stub.dockCalls.dockShow >= 1, "app.dock.show() called after showing the overlay");
  } finally {
    stub.restore();
  }
});

// ── "Open session" ──────────────────────────────────────────────────────────
//
// The overlay is a non-focusable full-display window with no handle on the
// dashboard, so its waiting-on-you CTA can only ASK the main process to surface
// the right window. What is pinned here is the answer as much as the action: the
// CTA is the only exit a sticky approval bubble has, and it clears that bubble
// only when this reports the dashboard was actually surfaced.

/** A dashboard window as `main.js` hands it over, with its SPA view attached. */
function fakeDashboard({
  minimized = false,
  viewGone = false,
  // Defaults to the dashboard's own origin: every case that is not about WHICH
  // page the view holds should read as "the dashboard is loaded".
  url = "http://127.0.0.1:9/?token=t",
} = {}) {
  const sent = [];
  return {
    sent,
    restored: false,
    shown: false,
    focused: false,
    isDestroyed: () => false,
    isMinimized() { return minimized; },
    restore() { this.restored = true; },
    show() { this.shown = true; },
    focus() { this.focused = true; },
    _mcView: {
      webContents: {
        isDestroyed: () => viewGone,
        getURL: () => url,
        send: (channel, arg) => sent.push([channel, arg]),
      },
    },
  };
}

test("open-session surfaces the dashboard and routes it to that session", () => {
  const stub = stubElectron();
  try {
    const { index } = loadModules();
    const win = fakeDashboard({ minimized: true });
    index.initCrewCompanion({
      backendUrl: "http://127.0.0.1:9",
      fetchLocalToken: async () => "",
      glog: () => {},
      getDashboardWindow: () => win,
    });

    assert.strictEqual(index.openDashboardSession("chat-7-1785905004"), true);
    // Minimised to the taskbar is the case that makes plain focus() insufficient.
    assert.ok(win.restored && win.shown && win.focused, "window must be surfaced");
    assert.deepStrictEqual(win.sent, [["navigate", "/chat?sid=chat-7-1785905004"]]);
    index.shutdownCrewCompanion();
  } finally {
    stub.restore();
  }
});

test("open-session encodes the slot key rather than splicing it into the query", () => {
  const stub = stubElectron();
  try {
    const { index } = loadModules();
    const win = fakeDashboard();
    index.initCrewCompanion({
      backendUrl: "http://127.0.0.1:9",
      fetchLocalToken: async () => "",
      glog: () => {},
      getDashboardWindow: () => win,
    });

    // Slot keys carry user-chosen names; an unencoded `&` would silently drop the
    // rest of the key and open a different session.
    index.openDashboardSession("chat a&b");
    assert.deepStrictEqual(win.sent, [["navigate", "/chat?sid=chat%20a%26b"]]);
    index.shutdownCrewCompanion();
  } finally {
    stub.restore();
  }
});

test("an approval with no owning session raises the dashboard but routes nowhere", () => {
  const stub = stubElectron();
  try {
    const { index } = loadModules();
    const win = fakeDashboard();
    index.initCrewCompanion({
      backendUrl: "http://127.0.0.1:9",
      fetchLocalToken: async () => "",
      glog: () => {},
      getDashboardWindow: () => win,
    });

    // Unowned approvals are broadcast with slot:"" and live on the dashboard's own
    // approvals surface. Navigating anyway would claim to have opened a session
    // that was never identified — and throw away whatever the user had open.
    assert.strictEqual(index.openDashboardSession(""), true);
    assert.ok(win.shown && win.focused, "the dashboard is still surfaced");
    assert.deepStrictEqual(win.sent, [], "nothing is routed");
    index.shutdownCrewCompanion();
  } finally {
    stub.restore();
  }
});

test("open-session refuses when there is no dashboard window to surface", () => {
  const stub = stubElectron();
  try {
    const { index } = loadModules();
    index.initCrewCompanion({
      backendUrl: "http://127.0.0.1:9",
      fetchLocalToken: async () => "",
      glog: () => {},
      getDashboardWindow: () => null,
    });

    // False is what keeps the notification: the overlay leaves a sticky bubble up
    // rather than dismissing the user's only pointer to blocked work.
    assert.strictEqual(index.openDashboardSession("chat-7"), false);
    index.shutdownCrewCompanion();
  } finally {
    stub.restore();
  }
});

test("a routing request that cannot be delivered fails whole, without raising", () => {
  const stub = stubElectron();
  try {
    const { index } = loadModules();
    const win = fakeDashboard({ viewGone: true });
    index.initCrewCompanion({
      backendUrl: "http://127.0.0.1:9",
      fetchLocalToken: async () => "",
      glog: () => {},
      getDashboardWindow: () => win,
    });

    // A window mid-teardown can be raised but not routed. Raising it anyway would
    // leave the dashboard focused on the WRONG session while the overlay was told
    // the right one had been opened.
    assert.strictEqual(index.openDashboardSession("chat-7"), false);
    assert.ok(!win.shown && !win.focused, "no half-done surface");
    assert.deepStrictEqual(win.sent, []);
    index.shutdownCrewCompanion();
  } finally {
    stub.restore();
  }
});

test("the renderer's open-session channel answers rather than fires and forgets", async () => {
  const stub = stubElectron();
  try {
    const { index } = loadModules();
    const win = fakeDashboard();
    index.initCrewCompanion({
      backendUrl: "http://127.0.0.1:9",
      fetchLocalToken: async () => "",
      glog: () => {},
      getDashboardWindow: () => win,
    });

    // `handle`, not `on`: the overlay needs the outcome before it clears a bubble.
    const handler = stub.ipcInvokers["crew-companion:open-session"];
    assert.ok(handler, "open-session must be registered as an invokable channel");
    assert.strictEqual(await handler({}, "chat-7"), true);
    assert.deepStrictEqual(win.sent, [["navigate", "/chat?sid=chat-7"]]);

    // A renderer that sends something that is not a string must not reach
    // encodeURIComponent with it; it is read as "no session named".
    win.sent.length = 0;
    assert.strictEqual(await handler({}, { slot: "chat-7" }), true);
    assert.deepStrictEqual(win.sent, []);
    index.shutdownCrewCompanion();
  } finally {
    stub.restore();
  }
});

test("re-initialising does not throw on the already-registered channel", () => {
  const stub = stubElectron();
  try {
    const { index } = loadModules();
    const deps = {
      backendUrl: "http://127.0.0.1:9",
      fetchLocalToken: async () => "",
      glog: () => {},
      getDashboardWindow: () => null,
    };
    index.initCrewCompanion(deps);
    index.initCrewCompanion(deps);
    assert.ok(stub.ipcInvokers["crew-companion:open-session"]);
    index.shutdownCrewCompanion();
  } finally {
    stub.restore();
  }
});

test("open-session refuses while the view shows the boot/recovery splash", () => {
  const stub = stubElectron();
  try {
    const { index } = loadModules();
    // What the gateway-recovery and boot paths put on screen: loading.html,
    // loaded from disk. It has no `navigate` listener, so the message would be
    // dropped — and the caller dismisses the sticky notification on a `true`.
    const win = fakeDashboard({ url: "file:///C:/app/electron/loading.html" });
    index.initCrewCompanion({
      backendUrl: "http://127.0.0.1:9",
      fetchLocalToken: async () => "",
      glog: () => {},
      getDashboardWindow: () => win,
    });

    assert.strictEqual(
      index.openDashboardSession("chat-7"),
      false,
      "acknowledged a navigation the splash cannot perform",
    );
    assert.deepStrictEqual(win.sent, [], "navigate must not be sent to the splash");
    assert.ok(!win.shown && !win.focused, "no half-done surface");
    index.shutdownCrewCompanion();
  } finally {
    stub.restore();
  }
});

test("open-session refuses while the view is still blank", () => {
  const stub = stubElectron();
  try {
    const { index } = loadModules();
    // A view created but not yet navigated reports an empty URL.
    const win = fakeDashboard({ url: "" });
    index.initCrewCompanion({
      backendUrl: "http://127.0.0.1:9",
      fetchLocalToken: async () => "",
      glog: () => {},
      getDashboardWindow: () => win,
    });

    assert.strictEqual(index.openDashboardSession("chat-7"), false);
    assert.deepStrictEqual(win.sent, []);
    index.shutdownCrewCompanion();
  } finally {
    stub.restore();
  }
});

test("open-session refuses when the view holds a foreign origin", () => {
  const stub = stubElectron();
  try {
    const { index } = loadModules();
    const win = fakeDashboard({ url: "https://example.com/chat?sid=chat-7" });
    index.initCrewCompanion({
      backendUrl: "http://127.0.0.1:9",
      fetchLocalToken: async () => "",
      glog: () => {},
      getDashboardWindow: () => win,
    });

    assert.strictEqual(index.openDashboardSession("chat-7"), false);
    assert.deepStrictEqual(
      win.sent,
      [],
      "a session key must never be sent to a page that is not the dashboard",
    );
    index.shutdownCrewCompanion();
  } finally {
    stub.restore();
  }
});

test("open-session still routes when the dashboard is on an in-app route", () => {
  const stub = stubElectron();
  try {
    const { index } = loadModules();
    // Preservation: the guard matches on ORIGIN, so a dashboard already deep in
    // the SPA (its own route, its own token query) must still be routable.
    const win = fakeDashboard({ url: "http://127.0.0.1:9/system?token=abc123" });
    index.initCrewCompanion({
      backendUrl: "http://127.0.0.1:9",
      fetchLocalToken: async () => "",
      glog: () => {},
      getDashboardWindow: () => win,
    });

    assert.strictEqual(index.openDashboardSession("chat-9"), true);
    assert.deepStrictEqual(win.sent, [["navigate", "/chat?sid=chat-9"]]);
    index.shutdownCrewCompanion();
  } finally {
    stub.restore();
  }
});

test("open-session with no session key surfaces a splash window but does NOT acknowledge", () => {
  const stub = stubElectron();
  try {
    const { index } = loadModules();
    // The empty-key contract still holds where it was right: this window is the
    // app's own, so raising it is useful and safe even mid-load.
    //
    // What changed is the ANSWER. The return value is what the overlay reads to
    // dismiss a sticky notification, and a loading window has no approvals
    // surface yet -- so reporting success threw away the user's only pointer to
    // work the gateway is still blocked on. Surfacing and acknowledging are now
    // separate: the window comes forward, and the notification stays.
    const win = fakeDashboard({ url: "file:///C:/app/electron/loading.html" });
    index.initCrewCompanion({
      backendUrl: "http://127.0.0.1:9",
      fetchLocalToken: async () => "",
      glog: () => {},
      getDashboardWindow: () => win,
    });

    assert.strictEqual(
      index.openDashboardSession(""),
      false,
      "a loading window acknowledged an approval it cannot yet surface",
    );
    assert.ok(win.shown && win.focused, "the dashboard window must still be raised");
    assert.deepStrictEqual(win.sent, []);
    index.shutdownCrewCompanion();
  } finally {
    stub.restore();
  }
});

test("a slot-less approval is refused when the window shows a foreign origin", () => {
  const stub = stubElectron();
  try {
    const { index } = loadModules();
    // `getDashboardWindow` is `focusedDashboardWindow()`, which returns the
    // focused window whenever it merely HAS an `_mcView` -- it never checks what
    // that view is showing. So a focused secondary window on another origin does
    // reach here.
    const win = fakeDashboard({ url: "https://example.invalid/other" });
    index.initCrewCompanion({
      backendUrl: "http://127.0.0.1:9",
      fetchLocalToken: async () => "",
      glog: () => {},
      getDashboardWindow: () => win,
    });

    // Caller authorization does not depend on naming a session. Answering true
    // here told the overlay to dismiss a sticky notification it had not acted
    // on, while the gateway stayed blocked on the approval.
    assert.strictEqual(
      index.openDashboardSession(""),
      false,
      "a slot-less approval bypassed the origin check",
    );
    assert.ok(!win.shown, "the window was raised before the check refused");
    assert.ok(!win.focused, "the window was focused before the check refused");
    assert.deepStrictEqual(win.sent, [], "nothing is routed");
    index.shutdownCrewCompanion();
  } finally {
    stub.restore();
  }
});

test("a slot-less approval is refused when the view is gone", () => {
  const stub = stubElectron();
  try {
    const { index } = loadModules();
    const win = fakeDashboard({ viewGone: true });
    index.initCrewCompanion({
      backendUrl: "http://127.0.0.1:9",
      fetchLocalToken: async () => "",
      glog: () => {},
      getDashboardWindow: () => win,
    });

    assert.strictEqual(
      index.openDashboardSession(""),
      false,
      "a slot-less approval was accepted by a destroyed view",
    );
    assert.ok(!win.shown, "the window was raised before the check refused");
    index.shutdownCrewCompanion();
  } finally {
    stub.restore();
  }
});

test("a ROUTED approval is still refused on the splash it cannot deliver to", () => {
  const stub = stubElectron();
  try {
    const { index } = loadModules();
    // The other side of the split: the local shell is not foreign, so it passes
    // authorization -- but it cannot receive a `navigate`, so a request that
    // names a slot must still fail whole rather than raise the window and lie.
    const win = fakeDashboard({ url: "file:///C:/app/electron/loading.html" });
    index.initCrewCompanion({
      backendUrl: "http://127.0.0.1:9",
      fetchLocalToken: async () => "",
      glog: () => {},
      getDashboardWindow: () => win,
    });

    assert.strictEqual(index.openDashboardSession("chat-7"), false);
    assert.ok(!win.shown, "the window was raised for a route it cannot deliver");
    assert.deepStrictEqual(win.sent, []);
    index.shutdownCrewCompanion();
  } finally {
    stub.restore();
  }
});

test("the turn-off IPC closes every overlay immediately", () => {
  const stub = stubElectron();
  try {
    const { overlay, index } = loadModules();
    overlay.setOverlayTarget("http://localhost:5476", "cred");
    overlay.openPetWindow();
    assert.ok(overlay.petWindowCount() > 0, "overlays are open first");
    index.initCrewCompanion({
      backendUrl: "http://127.0.0.1:9",
      fetchLocalToken: async () => "cred",
      glog: () => {},
    });
    // The renderer sends this after its disable POST succeeds. It must close the
    // overlay at once, not leave it until the next ~5s reconcile tick.
    stub.ipcHandlers["crew-companion:turn-off"]();
    assert.strictEqual(overlay.petWindowCount(), 0, "overlay closed immediately on turn-off");
    index.shutdownCrewCompanion();
  } finally {
    stub.restore();
  }
});

test("a transfer to a display with no live overlay is a no-op — the avatar stays put", () => {
  const stub = stubElectron();
  try {
    const { overlay } = loadModules();
    overlay.setOverlayTarget("http://localhost:5476", "");
    overlay.openPetWindow(); // active = display 1
    const winA = stub.created[0];
    winA.sent.length = 0;
    // A monitor hot-plugged after startup: an id with no overlay in the map. The
    // transfer must NOT deactivate the current overlay (that would blank the avatar).
    overlay.transferActiveToDisplay(999, 10, 10, false);
    assert.ok(
      !winA.sent.some((m) => m.ch === "crew-companion:set-active" && m.args[0] === false),
      "the current overlay is not deactivated for a display that has no overlay",
    );
  } finally {
    stub.restore();
  }
});

test("pet-ready replies to the requesting overlay with its active state", () => {
  const stub = stubElectron();
  try {
    const { overlay } = loadModules();
    overlay.setOverlayTarget("http://localhost:5476", "");
    overlay.openPetWindow();
    overlay.registerOverlayIpc();
    // The stub's fromWebContents resolves to the last-created window; clear its log,
    // then fire the readiness handshake and assert main answered with a set-active.
    const last = stub.created[stub.created.length - 1];
    last.sent.length = 0;
    stub.ipcHandlers["crew-companion:pet-ready"]({ sender: {} });
    assert.ok(
      last.sent.some((m) => m.ch === "crew-companion:set-active"),
      "pet-ready triggers a set-active reply to the requesting overlay",
    );
    overlay.stopHitboxPoll();
  } finally {
    stub.restore();
  }
});

test("only ONE display's overlay is told to render the avatar; the rest are inactive", () => {
  const stub = stubElectron();
  try {
    const { overlay } = loadModules();
    overlay.setOverlayTarget("http://localhost:5476", "");
    overlay.openPetWindow();

    // This is the two-ghosts fix at the main-process seam: the avatar lives on one
    // display, so exactly one overlay receives set-active(true) and every other
    // receives set-active(false).
    const activeOn = stub.created.filter((w) =>
      w.sent.some((m) => m.ch === "crew-companion:set-active" && m.args[0] === true),
    );
    const inactiveOn = stub.created.filter((w) =>
      w.sent.some((m) => m.ch === "crew-companion:set-active" && m.args[0] === false),
    );
    assert.strictEqual(activeOn.length, 1, "exactly one avatar across all displays");
    assert.strictEqual(
      inactiveOn.length,
      stub.created.length - 1,
      "every other overlay is explicitly inactive",
    );
  } finally {
    stub.restore();
  }
});

test("dragging the avatar across the boundary hands it off — still exactly one avatar", () => {
  const stub = stubElectron();
  try {
    const { overlay } = loadModules();
    overlay.setOverlayTarget("http://localhost:5476", "");
    overlay.openPetWindow(); // cursor at (0,0) -> active display 1
    const [winA, winB] = stub.created;

    // A drag begins on display 1; then the cursor moves onto display 2 and one tick runs.
    overlay.startDragPolling(10, 10);
    stub.setCursor(2000, 500); // inside display 2's bounds
    overlay.dragPollOnce();

    // The avatar handed off: display 1 told inactive, display 2 told active — so it
    // lives on exactly one screen, the one the cursor dragged it to.
    assert.ok(
      winA.sent.some((m) => m.ch === "crew-companion:set-active" && m.args[0] === false),
      "old display told inactive on crossing",
    );
    assert.ok(
      winB.sent.some((m) => m.ch === "crew-companion:set-active" && m.args[0] === true),
      "new display told active on crossing",
    );

    // Ending the drag restores click-through on every overlay (the hitbox poll makes
    // the active one interactive again once the renderer reports a real rect).
    overlay.stopDragPolling();
    assert.deepStrictEqual(winA.ignoreMouse, { ignore: true, opts: { forward: true } });
    assert.deepStrictEqual(winB.ignoreMouse, { ignore: true, opts: { forward: true } });
  } finally {
    stub.restore();
  }
});

test("a readiness reply DURING a drag carries the drag state, not a bare activation", () => {
  const stub = stubElectron();
  try {
    const { overlay } = loadModules();
    overlay.setOverlayTarget("http://localhost:5476", "");
    overlay.openPetWindow(); // active = display 1
    const [, winB] = stub.created;
    overlay.registerOverlayIpc();

    // Drag the avatar onto display 2, so display 2 (the last-created window that
    // pet-ready resolves to) is now the active one and a drag is in progress.
    overlay.startDragPolling(10, 10);
    stub.setCursor(2000, 500);
    overlay.dragPollOnce();
    winB.sent.length = 0;

    // A slow renderer only now finishes mounting and sends pet-ready. The reply must
    // NOT be a bare set-active(true): that would make the renderer activate at-rest
    // and clear the carried bubble. It must carry isDragging=true so the renderer
    // adopts the in-flight drag and keeps the reminder.
    stub.ipcHandlers["crew-companion:pet-ready"]({ sender: {} });
    const reply = winB.sent.find(
      (m) => m.ch === "crew-companion:set-active" && m.args[0] === true,
    );
    assert.ok(reply, "readiness during a drag re-activates the requesting overlay");
    assert.strictEqual(reply.args[3], true, "the reply carries isDragging=true");
    assert.strictEqual(typeof reply.args[1], "number", "and the live drag x");
    assert.strictEqual(typeof reply.args[2], "number", "and the live drag y");

    overlay.stopDragPolling();
    overlay.stopHitboxPoll();
  } finally {
    stub.restore();
  }
});

test("a drag over a display with NO overlay streams to the active overlay, not fs", () => {
  const stub = stubElectron();
  try {
    const { overlay } = loadModules();
    overlay.setOverlayTarget("http://localhost:5476", "");
    overlay.openPetWindow(); // overlays for displays 1 and 2
    // A monitor hot-plugged after enable: present to the OS but with no overlay in
    // the map (nothing opens one for it).
    stub.addDisplay({ id: 3, bounds: { x: 3360, y: 0, width: 1280, height: 720 } });

    overlay.startDragPolling(10, 10);
    for (const w of stub.created) w.sent.length = 0;
    stub.setCursor(3800, 300); // inside display 3, which has no overlay
    overlay.dragPollOnce();

    // No hand-off to a non-existent overlay, and the active overlay keeps getting a
    // clamped drag-update (the avatar tracks the cursor on its own display) instead
    // of the loop no-oping and hammering savePetPos on the main thread.
    assert.ok(
      !stub.created.some((w) =>
        w.sent.some((m) => m.ch === "crew-companion:set-active" && m.args[0] === false),
      ),
      "no overlay is deactivated for a display that has no overlay",
    );
    assert.ok(
      stub.created.some((w) =>
        w.sent.some((m) => m.ch === "crew-companion:drag-update"),
      ),
      "the active overlay still receives a clamped drag-update",
    );

    overlay.stopDragPolling();
    overlay.stopHitboxPoll();
  } finally {
    stub.restore();
  }
});
