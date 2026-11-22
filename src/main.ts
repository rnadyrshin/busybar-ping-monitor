import { device } from "@shared/device";
import { registerFontMaps, textWidth, type DisplayDrawParams } from "@busy-app/busy-lib";
import { bold, condensed, normal, small, tiny } from "@busy-app/busy-lib/fonts";
import manifest from "./appmeta/manifest.json";
import { DEFAULTS, loadSettings, type Settings, type ValueFont } from "./settings.ts";

for (const f of [tiny, small, condensed, normal, bold]) registerFontMaps(f);

/** The name the app draws under; the device clears elements by this id. */
const APP = manifest.id;

const W = 72;
const H = 16;

/**
 * The intro animation (built by dev/tools/make_anim.py). Its sections: "connect" is one packet round trip of
 * CONNECT_LOOP_MS, looped; "ok" and "fail" flash the link for FLASH_MS, then wipe the graph in, RESULT_MS in all.
 */
const ANIM = "animations/link.anim";
const CONNECT_LOOP_MS = 1200;
const FLASH_MS = 333;
const RESULT_MS = 800;
/** The intro shows at least one round trip and gives up waiting for the first answer after CONNECT_TIMEOUT_MS. */
const CONNECT_TIMEOUT_MS = 3000;
/** A host name wider than the screen scrolls, at this many pixels a minute. */
const SCROLL_RATE = 1500;

/**
 * The value in the top-left corner, in the font from the settings, with a tiny unit raised to the top of the digits.
 * The fonts leave empty rows above the glyphs, so the texts start above the screen to use the top row: `y` is that
 * offset, `h` the height of the backing under the digits.
 */
const VALUE_FONT_BOX: Record<ValueFont, { y: number; h: number }> = {
  tiny: { y: -1, h: 5 },
  small: { y: -2, h: 6 },
  condensed: { y: -2, h: 8 },
  normal: { y: -2, h: 8 },
  bold: { y: -2, h: 8 },
};
const UNIT_Y = -2;
const UNIT_H = 4;
/** Under each text a half-transparent backing keeps it readable over the graph. */
const BACKING = "#000000A0";

const GREEN = "#00D26A";
const YELLOW = "#FFC400";
const RED = "#FF3B30";
const GRAY = "#8A8A8A";

/** Bars are drawn dim with a bright top pixel, so the line of the latest values reads first. */
const PALETTE: Record<string, string> = {
  ".": "none",
  _: "#262626",
  g: GREEN,
  y: YELLOW,
  r: RED,
  G: "#004424",
  Y: "#554100",
  R: "#6A1913",
};

/** XPM2 header for the 72×16 graph with the palette above, one character per pixel. */
const XPM_HEADER =
  `! XPM2\n${W} ${H} ${Object.keys(PALETTE).length} 1\n` +
  Object.entries(PALETTE)
    .map(([k, v]) => `${k} c ${v}`)
    .join("\n");

/** The scale steps the wheel moves through, ms at the top of the graph. */
const SCALES = [100, 200, 500, 1000, 2000];
/** The top of the graph never goes below this, so ordinary jitter stays a calm line. */
const MIN_CEILING = SCALES[0];
/** Nor above this: anything slower is a full-height column. */
const MAX_CEILING = SCALES[SCALES.length - 1];
/** How long the scale stays on screen after a turn of the wheel. */
const SCALE_SHOW_MS = 1500;

type Elements = DisplayDrawParams["elements"];
type Element = Elements[number];
/** A sample: latency in ms, or null for a lost probe. */
type Sample = number | null;

/**
 * The bar has no ICMP, so latency is the round trip of one small plain-HTTP request: the closest thing to a ping an
 * app can do. IP literals skip DNS. 8.8.8.8 and 9.9.9.9 drop plain HTTP, so they would only ever show loss.
 */
function urlFor(host: string): string {
  if (/^https?:\/\//i.test(host)) return host;
  if (host === "1.1.1.1" || host === "1.0.0.1") return `http://${host}/cdn-cgi/trace`;
  return `http://${host}/`;
}

/** What the intro shows: the host name without the scheme or the path. */
function labelFor(host: string): string {
  return host.replace(/^https?:\/\//i, "").split("/")[0];
}

/**
 * The automatic top of the graph: the highest value on screen rounded up a little, so the peak reaches the top row
 * and small changes of the maximum do not rescale the graph; kept between MIN_CEILING and MAX_CEILING.
 */
function ceilingFor(history: Sample[]): number {
  let top = 0;
  for (const v of history) if (v !== null && v > top) top = v;
  const step = top <= 100 ? 5 : top <= 500 ? 25 : 100;
  return Math.min(MAX_CEILING, Math.max(MIN_CEILING, Math.ceil(top / step) * step));
}

function rect(id: string, x: number, y: number, width: number, height: number, color: string, z: number): Element {
  return { id, type: "rectangle", x, y, width, height, radius: 0, border_width: 0, fill: "solid", fill_colors: [color], z_index: z };
}

function main(): void {
  let settings: Settings = DEFAULTS;
  const history: Sample[] = [];
  let intro = true;
  let drawing = false;
  let dirty = false;
  let stopped = false;
  let inflight = 0;
  let probeTimer: ReturnType<typeof setTimeout> | undefined;
  let introTimer: ReturnType<typeof setTimeout> | undefined;

  const report = (err: unknown, context: string) =>
    console.error(`${APP}: ${context}: ${err instanceof Error ? err.message : String(err)}`);

  const level = (ms: number) => (ms < settings.warnMs ? 0 : ms < settings.badMs ? 1 : 2);

  /** Wheel-chosen index into SCALES, or -1 while the scale is automatic (until the first turn of the wheel). */
  let manualScale = -1;
  let scaleShownUntil = 0;
  let scaleTimer: ReturnType<typeof setTimeout> | undefined;

  const currentCeiling = () => (manualScale < 0 ? ceilingFor(history) : SCALES[manualScale]);

  const scaleLabel = () => {
    const c = currentCeiling();
    return c >= 1000 ? c / 1000 + "s" : c + "ms";
  };

  /** One wheel step: the first one starts from the step nearest to the automatic scale. */
  const turnScale = (delta: number) => {
    if (manualScale < 0) {
      const auto = ceilingFor(history);
      manualScale = SCALES.findIndex((s) => s >= auto);
      if (manualScale < 0) manualScale = SCALES.length - 1;
    }
    manualScale = Math.max(0, Math.min(SCALES.length - 1, manualScale + delta));
    scaleShownUntil = Date.now() + SCALE_SHOW_MS;
    if (scaleTimer !== undefined) clearTimeout(scaleTimer);
    scaleTimer = setTimeout(() => {
      scaleTimer = undefined;
      draw();
    }, SCALE_SHOW_MS);
    draw();
  };

  /** The latest value split into the number and its unit. */
  const valueText = (): { text: string; unit: string } => {
    const last = history[history.length - 1];
    if (last === undefined) return { text: "...", unit: "" };
    if (last === null) return { text: "loss", unit: "" };
    if (last >= 1000) return { text: (last / 1000).toFixed(1), unit: "s" };
    return { text: String(Math.round(last)), unit: "ms" };
  };

  /**
   * The graph is kept as its 16 rows of XPM characters. Each new sample shifts every row by one column and appends the
   * new column: 16 short string operations instead of rebuilding 1152 pixels, which takes the bar's JS engine about
   * 160 ms and makes the next probe read high. The rows are rebuilt only when the scale changes or the graph is cleared.
   */
  let rows: string[] = [];
  let rowsCeiling = 0;
  /** Samples pushed so far, and how many of them the rows already show. */
  let pushed = 0;
  let synced = 0;
  let rowsStale = true;
  /** Column strings, top to bottom, by height and colour level: the same few repeat all the time. */
  const columns: Record<string, string> = {};
  const EMPTY_COLUMN = ".".repeat(H - 1) + "_";
  let LOSS_COLUMN = "";
  for (let y = 0; y < H; y++) LOSS_COLUMN += y % 2 === 1 ? "R" : ".";

  const column = (v: Sample | undefined, ceiling: number): string => {
    if (v === undefined) return EMPTY_COLUMN;
    if (v === null) return LOSS_COLUMN;
    const lv = level(v);
    const h = Math.max(1, Math.min(H, Math.round((v / ceiling) * H)));
    const key = h * 3 + lv;
    let col = columns[key];
    if (col === undefined) {
      col = ".".repeat(H - h) + "gyr"[lv] + "GYR"[lv].repeat(h - 1);
      columns[key] = col;
    }
    return col;
  };

  /** The history graph as XPM2, newest sample on the right. */
  const graphXpm = (): string => {
    const ceiling = currentCeiling();
    const fresh = pushed - synced;
    if (rowsStale || ceiling !== rowsCeiling || fresh > W) {
      const pad = W - history.length;
      const cols: string[] = [];
      for (let x = 0; x < W; x++) cols.push(column(x >= pad ? history[x - pad] : undefined, ceiling));
      rows = [];
      for (let y = 0; y < H; y++) {
        let line = "";
        for (let x = 0; x < W; x++) line += cols[x][y];
        rows.push(line);
      }
      rowsCeiling = ceiling;
      rowsStale = false;
    } else {
      for (let i = fresh; i > 0; i--) {
        const col = column(history[history.length - i], ceiling);
        for (let y = 0; y < H; y++) rows[y] = rows[y].slice(1) + col[y];
      }
    }
    synced = pushed;
    return XPM_HEADER + "\n" + rows.join("\n");
  };

  /** A text with its half-transparent backing; an empty text keeps both ids with nothing visible. */
  const label = (id: string, text: string, font: ValueFont, x: number, y: number, height: number, color: string): Elements => {
    const w = text ? textWidth(text, font) : 0;
    return [
      rect(id + "_bg", x, 0, Math.max(1, w + 1), height, text ? BACKING : "#00000000", 1),
      { id, type: "text", x: x + 1, y, align: "top_left", font, text: text || " ", color, z_index: 2 },
    ];
  };

  /** The graph with the latest value in the top-left corner, and the scale top-right for a moment after the wheel. */
  const graphFrame = (): Elements => {
    const { text, unit } = valueText();
    const font = settings.valueFont;
    const box = VALUE_FONT_BOX[font];
    const valueW = textWidth(text, font);
    const scale = Date.now() < scaleShownUntil ? scaleLabel() : "";
    const scaleX = scale ? W - textWidth(scale, "tiny") - 1 : W - 1;
    return [
      { id: "graph", type: "xpmbitmap", x: 0, y: 0, data: graphXpm(), z_index: 0 },
      ...label("value", text, font, 0, box.y, box.h, "#FFFFFFFF"),
      ...label("unit", unit, "tiny", valueW, UNIT_Y, UNIT_H, GRAY + "FF"),
      // The scale has digits: tiny digits need one row more than the lowercase unit.
      ...label("scale", scale, "tiny", scaleX, VALUE_FONT_BOX.tiny.y, VALUE_FONT_BOX.tiny.h, GRAY + "FF"),
    ];
  };

  /** What each element id last looked like on the device, so a graph frame sends only what changed. */
  let sent: Record<string, string> = {};

  /** Draws the graph. One display request in flight at most: a change meanwhile is drawn right after it. */
  const draw = () => {
    if (stopped || intro) return;
    if (drawing) {
      dirty = true;
      return;
    }
    const elements: Elements = [];
    for (const el of graphFrame()) {
      // The bitmap is compared by its data alone: stringifying 1.3 KB on every frame is not free here.
      const key = el.type === "xpmbitmap" ? el.data : JSON.stringify(el);
      if (sent[el.id] !== key) {
        sent[el.id] = key;
        elements.push(el);
      }
    }
    dirty = false;
    if (elements.length === 0) return;
    drawing = true;
    device
      .DisplayDraw({ application_name: APP, priority: 50, elements })
      .catch((err) => {
        // The device state is unknown now: send everything next time.
        sent = {};
        report(err, "draw");
      })
      .then(() => {
        drawing = false;
        if (dirty) draw();
        runWaitingProbe();
      });
  };

  /** The first real probe: whether it has settled, and whether it answered. */
  let replied = false;
  let replyOk = false;
  let introStart = 0;

  const send = (elements: Elements, context: string) =>
    device.DisplayDraw({ application_name: APP, priority: 50, elements }).catch((err) => report(err, context));

  /** The host over the intro animation: centred when it fits, scrolled by the firmware when it does not. */
  const hostElement = (color: string): Element => {
    const host = labelFor(settings.host);
    const w = textWidth(host, "normal");
    const base = { id: "host", type: "text", y: 6, align: "mid_left", font: "normal", text: host, color, z_index: 3 } as const;
    if (w <= W) return { ...base, x: Math.floor((W - w) / 2) };
    return { ...base, x: 0, width: W, scroll_rate: SCROLL_RATE, scroll_start_delay: 300, scroll_repeat_delay: 600 };
  };

  /**
   * The intro, styled as a connection: the host over a link with a packet running along it (the "connect" section,
   * looped, played by the firmware). Once the first real probe has settled, the animation finishes its round trip
   * and plays "ok" (or "fail"), which flashes the link and wipes in the graph drawn underneath.
   */
  const runIntro = () => {
    introStart = Date.now();
    void send(
      [{ id: "intro", type: "animation", path: ANIM, section: "connect", loop: true, x: 0, y: 0, z_index: 1 }, hostElement("#FFFFFFFF")],
      "intro",
    );
    introTimer = setTimeout(waitForReply, CONNECT_LOOP_MS);
  };

  const waitForReply = () => {
    if (stopped) return;
    const elapsed = Date.now() - introStart;
    if (!replied && elapsed < CONNECT_TIMEOUT_MS) {
      introTimer = setTimeout(waitForReply, 100);
      return;
    }
    const ok = replied && replyOk;
    // The result plays after the round trip in progress: await_previous_end lets the loop finish first.
    const toResult = CONNECT_LOOP_MS - (elapsed % CONNECT_LOOP_MS);
    void send(
      [
        { id: "graph", type: "xpmbitmap", x: 0, y: 0, data: graphXpm(), z_index: 0 },
        { id: "intro", type: "animation", path: ANIM, section: ok ? "ok" : "fail", loop: false, await_previous_end: true, x: 0, y: 0, z_index: 1 },
      ],
      "intro result",
    );
    const color = ok ? GREEN : RED;
    introTimer = setTimeout(() => {
      void send([hostElement(color + "FF")], "intro host");
      // The host fades out in a few steps while the wipe runs.
      fadeHost(color, 3, FLASH_MS);
    }, toResult);
  };

  const fadeHost = (color: string, left: number, delay: number) => {
    introTimer = setTimeout(() => {
      if (stopped) return;
      if (left === 0) {
        finishIntro();
        return;
      }
      const alpha = Math.round((255 * (left - 1)) / 3);
      void send([hostElement(color + alpha.toString(16).padStart(2, "0").toUpperCase())], "intro fade");
      fadeHost(color, left - 1, left === 1 ? RESULT_MS - FLASH_MS - 300 : 100);
    }, delay);
  };

  /** Removes the intro elements, then hands the screen to the graph. */
  const finishIntro = () => {
    introTimer = undefined;
    drawing = true;
    device
      .DisplayClear({ application_name: APP, element_ids: ["intro", "host"] })
      .catch((err) => report(err, "clear"))
      .then(() => {
        drawing = false;
        intro = false;
        draw();
        runWaitingProbe();
      });
  };

  let hostDown = false;
  let lastProbeError = "";

  /** One probe: round trip in ms, or null on error or timeout. */
  const probe = (url: string): Promise<Sample> => {
    // A probe that outlived its timeout still holds a connection: past two of them, count a loss without asking.
    if (inflight >= 2) return Promise.resolve(null);
    const timeoutMs = Math.max(1500, Math.min(3000, settings.intervalMs * 2));
    const started = Date.now();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<null>((resolve) => {
      timeout = setTimeout(() => resolve(null), timeoutMs);
    });
    inflight++;
    const request = fetch(url, { method: "GET", redirect: "manual", cache: "no-store" })
      .then(async (res) => {
        const ms = Date.now() - started;
        // Drain the (tiny) body so the connection is released.
        await res.text();
        return ms;
      })
      .catch((err) => {
        lastProbeError = err instanceof Error ? err.message : String(err);
        return null;
      })
      .then((ms) => {
        inflight--;
        return ms;
      });
    return Promise.race([request, expired]).then((ms) => {
      clearTimeout(timeout);
      return ms;
    });
  };

  /** Set when a probe is due while a draw is in flight: the draw starts it when done. */
  let probeWaiting = false;

  const runWaitingProbe = () => {
    if (drawing || !probeWaiting) return;
    probeWaiting = false;
    loop(false);
  };

  /**
   * The probe loop: the next probe starts one interval after the previous one started, never two at once, and never
   * while a draw is in flight: the bar's own HTTP traffic would delay the answer and inflate the reading.
   */
  const loop = (first: boolean) => {
    if (stopped) return;
    if (drawing) {
      probeWaiting = true;
      return;
    }
    const started = Date.now();
    let warmup = false;
    probe(urlFor(settings.host))
      .then((ms) => {
        if (stopped) return;
        if (first) {
          // The intro waits for this answer to show the connection as made.
          replied = true;
          replyOk = ms !== null;
          // The first probe also pays for the connection setup: it is dropped unless it failed, and the next one
          // follows right away, so a long period does not leave the screen empty.
          warmup = ms !== null;
          if (warmup) return;
        }
        // The log records when the host stops answering and when it is back, not every lost probe.
        if (ms === null && !hostDown) {
          hostDown = true;
          console.error(`${APP}: ${settings.host} stopped answering${lastProbeError ? ` (${lastProbeError})` : ""}`);
        } else if (ms !== null && hostDown) {
          hostDown = false;
          console.error(`${APP}: ${settings.host} answers again`);
        }
        lastProbeError = "";
        history.push(ms);
        pushed++;
        if (history.length > W) history.shift();
        draw();
      })
      .catch((err) => {
        // Quitting aborts the probe in flight: that is not an error worth a log line.
        if (!stopped && !(err instanceof Error && err.message === "aborted")) report(err, "probe loop");
      })
      .then(() => {
        if (stopped) return;
        const wait = warmup ? 0 : Math.max(0, settings.intervalMs - (Date.now() - started));
        probeTimer = setTimeout(() => loop(false), wait);
      });
  };

  const unbind = listen("input", (event) => {
    if (stopped) return;
    if (event.key === "encoder") {
      if (!intro) turnScale(event.delta);
      return;
    }
    if (event.action !== "short") return;
    if (event.key === "start") {
      // Start clears the graph; the scale stays as it is.
      history.length = 0;
      rowsStale = true;
      draw();
      return;
    }
    if (event.key !== "back") return;
    stopped = true;
    if (introTimer !== undefined) clearTimeout(introTimer);
    if (scaleTimer !== undefined) clearTimeout(scaleTimer);
    if (probeTimer !== undefined) clearTimeout(probeTimer);
    // The unbind is the last handle: schedule it so this callback returns first.
    setTimeout(unbind, 0);
  });

  loadSettings()
    .then((s) => {
      settings = s;
    })
    .catch((err) => report(err, "settings"))
    .then(() => {
      if (stopped) return;
      runIntro();
      loop(true);
    });
}

main();
