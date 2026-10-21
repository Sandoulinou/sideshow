// Push-to-talk button for the session head.
//
// Hold the button — or hold the SPACE key — like pi-voicekit: the take only
// arms after holding ≥ HOLD_MS, and the button shows a Bootstrap-style
// animated-stripes progress bar filling up while you wait. Release before
// the threshold and nothing is recorded. Once capture starts the bar is
// replaced by the pulsing live dot.
//
// On release the full pipeline runs server-side and the button mirrors its
// thinking steps as a spinner label: saving → publishing the audio card →
// transcribing (same Parakeet model as pi-voicekit) → upgrading the note with
// transcript + mp3 → handing the transcript to Pi (pi-sideshow-voice →
// pi.sendUserMessage, the same path as pi-voicekit auto-submit).
import { createSignal, onMount, onCleanup } from "solid-js";
import { api } from "./api.ts";
import { selected } from "./state.ts";

type Phase = "idle" | "arming" | "starting" | "recording" | "working";

// Same deliberate-hold default pi-voicekit ships (voice.holdThresholdMs).
const HOLD_MS = 700;
const POLL_MS = 600;
const WORK_TIMEOUT_MS = 120_000;
const DONE_SHOW_MS = 2500;
const ERROR_SHOW_MS = 5000;

// Solid types the style prop as a kebab-case CSSProperties, but the runtime
// setter needs the camelCase `animationDuration`. A plain (non-literal) object
// sidesteps the excess-property check without changing what reaches the DOM.
const PTT_FILL_STYLE = { animationDuration: `${HOLD_MS}ms, 800ms` };

interface JobView {
  id: string;
  state: "running" | "done" | "error";
  step: string;
  transcript?: string;
  error?: string;
  sentToPi?: boolean;
}

// TEMP DEBUG: gesture timing for capture-duration forensics (dev console).
const dbg = { pressAt: 0, startAt: 0, stopSentAt: 0 };
const dbgLog = (what: string, extra?: Record<string, unknown>) =>
  console.info(
    "[ptt]", what,
    {
      pressAt: dbg.pressAt,
      startedAt: dbg.startAt,
      stopSentAt: dbg.stopSentAt,
      heldMs: dbg.pressAt ? Date.now() - dbg.pressAt : undefined,
      recMs: dbg.startAt ? Date.now() - dbg.startAt : undefined,
      ...extra,
    },
    new Date().toISOString(),
  );

export function PushToTalk() {
  const [phase, setPhase] = createSignal<Phase>("idle");
  const [stepLabel, setStepLabel] = createSignal("");
  const [error, setError] = createSignal("");
  let holding = false;
  let armingTimer: ReturnType<typeof setTimeout> | null = null;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let settleTimer: ReturnType<typeof setTimeout> | null = null;
  let working = false;

  const label = () => {
    switch (phase()) {
      case "arming":
        return "Hold…";
      case "starting":
        return "Starting…";
      case "recording":
        return "Listening… release to stop";
      case "working":
        // The detailed Pi step now lives on the voice card's footer
        // (VoiceProgress) — the button just stays quiet while the take lands.
        return "Working…";
      default:
        return error() ? error() : "Push to talk";
    }
  };

  const clearTimers = () => {
    if (armingTimer) clearTimeout(armingTimer);
    armingTimer = null;
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = null;
    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = null;
  };

  const finish = (isError: boolean) => {
    clearTimers();
    working = false;
    settleTimer = setTimeout(() => {
      setPhase("idle");
      setStepLabel("");
      setError("");
    }, isError ? ERROR_SHOW_MS : DONE_SHOW_MS);
  };

  const startCapture = async () => {
    armingTimer = null;
    setPhase("starting");
    dbgLog("start.request");
    try {
      await api("/api/voice/start", { method: "POST", body: "{}" });
      holding = true;
      dbg.startAt = Date.now();
      dbgLog("start.ok (server capture armed)");
      setPhase("recording");
    } catch (e: any) {
      setPhase("idle");
      setError(e?.message ?? "could not start recording");
      setTimeout(() => setError(""), 5000);
    }
  };

  /** Begin an armed hold; the take only starts after HOLD_MS. */
  const arm = () => {
    if (holding || working || armingTimer) return;
    setError("");
    dbg.pressAt = Date.now();
    dbg.startAt = 0;
    dbg.stopSentAt = 0;
    dbgLog("press (arming, hold " + HOLD_MS + "ms)");
    setPhase("arming");
    armingTimer = setTimeout(() => void startCapture(), HOLD_MS);
  };

  /** Any release ends the current gesture: cancel an armed hold, or stop. */
  const release = (reason = "release") => {
    if (armingTimer) {
      clearTimeout(armingTimer);
      armingTimer = null;
      dbgLog(`release before armed (${reason}) — nothing recorded`);
      setPhase("idle");
      return;
    }
    if (holding) {
      dbgLog(`release (${reason})`);
      void stop(reason);
    }
  };

  const stop = async (reason = "stop") => {
    if (!holding) return;
    holding = false;
    dbg.stopSentAt = Date.now();
    dbgLog(`stop.request (${reason})`);
    try {
      const res = await api<{ jobId: string }>(
        "/api/voice/stop",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ session: selected() ?? null }),
        },
      );
      dbgLog("stop.ok — server says:", { res });
      working = true;
      setPhase("working");
      setStepLabel("Saving audio…");
      pollJob(res.jobId, Date.now());
    } catch (e: any) {
      setPhase("idle");
      setError(e?.message ?? "could not finish recording");
      setTimeout(() => setError(""), 5000);
    }
  };

  const pollJob = (jobId: string, startedAt: number) => {
    let cancelled = false;
    const tick = async () => {
      if (cancelled) return;
      try {
        const job = await api<JobView>(`/api/voice/jobs/${jobId}`);
        setStepLabel(job.step);
        if (job.state !== "running") {
          if (job.state === "error") setError(job.error || job.step);
          finish(job.state === "error");
          return;
        }
      } catch {
        /* transient — keep polling */
      }
      if (Date.now() - startedAt > WORK_TIMEOUT_MS) {
        setStepLabel("Still working…");
        finish(false);
        return;
      }
      pollTimer = setTimeout(tick, POLL_MS);
    };
    pollTimer = setTimeout(tick, POLL_MS);
  };

  // SPACE is the primary push-to-talk trigger (button is the fallback).
  // Skipped while typing in a field or while a modal/menu has the user's
  // attention; any release stops on window blur so alt-tab can't leave a
  // take open.
  onMount(() => {
    const inEditable = (t: EventTarget | null) =>
      t instanceof Element &&
      (!!t.closest("input, textarea, select, [contenteditable='true']") ||
        (t as HTMLElement).isContentEditable);

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code !== "Space") return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (inEditable(e.target)) return;
      if (document.querySelector(".modal, [role='menu']")) return;
      if (e.repeat) {
        e.preventDefault();
        return;
      }
      e.preventDefault();
      arm();
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code !== "Space") return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (inEditable(e.target)) return;
      e.preventDefault();
      release("keyup");
    };
    const onBlur = () => release("window blur");
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    onCleanup(() => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
      // Never leave a take open if the component goes away mid-hold.
      clearTimers();
      if (holding) void stop();
    });
  });

  return (
    <button
      class="ptt"
      classList={{
        "ptt-live": phase() === "recording" || phase() === "starting",
        "ptt-arming": phase() === "arming",
        "ptt-working": phase() === "working",
        "ptt-error": error() !== "",
      }}
      aria-label="Push to talk — hold for a moment to record (or hold space)"
      title="Hold to talk (or hold SPACE) — keep holding for a moment to start. The take is published as an audio card, transcribed, and sent to Pi."
      onPointerDown={(e) => {
        e.preventDefault();
        // Don't keep focus — a focused button would swallow spacebar presses
        // (button activation) and the keydown handler below. Space is PTT.
        e.currentTarget.blur();
        try {
          e.currentTarget.setPointerCapture(e.pointerId);
        } catch {
          /* pointer already gone */
        }
        arm();
      }}
      onPointerUp={() => release("pointerup")}
      onPointerCancel={() => release("pointercancel")}
      onContextMenu={(e) => e.preventDefault()}
    >
      {phase() === "working" ? (
        <span class="ptt-spin" aria-hidden="true"></span>
      ) : phase() === "arming" ? (
        <span class="ptt-track" aria-hidden="true">
          <span class="ptt-fill" style={PTT_FILL_STYLE}></span>
        </span>
      ) : (
        <span class="ptt-dot" aria-hidden="true"></span>
      )}
      <span class="ptt-label">{label()}</span>
    </button>
  );
}
