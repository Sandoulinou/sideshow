// Live progress for a voice-note card, rendered in the card footer (.actbar).
// Polls the owning voice job and mirrors its step — transcribing → waiting for
// Pi → "Pi is working…" → done — so the board itself shows where the take is,
// without leaning on the Push-to-talk button. Hides itself once the job
// settles (or is gone, e.g. after a server restart).
import { createSignal, onCleanup, onMount, Show } from "solid-js";
import { api } from "./api.ts";

interface JobView {
  id: string;
  state: "running" | "done" | "error";
  step: string;
  error?: string;
}

const POLL_MS = 1000;
const DONE_HOLD_MS = 2600;
const ERROR_HOLD_MS = 6000;

export function VoiceProgress(props: { jobId: string }) {
  const [job, setJob] = createSignal<JobView | null>(null);
  const [visible, setVisible] = createSignal(true);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stop = false;

  const tick = async () => {
    if (stop) return;
    let next: JobView;
    try {
      next = await api<JobView>(`/api/voice/jobs/${props.jobId}`);
    } catch {
      // Job unknown (server restarted) — nothing left to track.
      setVisible(false);
      setJob(null);
      return;
    }
    setJob(next);
    if (next.state === "running") {
      timer = setTimeout(tick, POLL_MS);
      return;
    }
    // Terminal: hold the outcome briefly so it's readable, then clear the bar.
    timer = setTimeout(
      () => {
        setVisible(false);
        setJob(null);
      },
      next.state === "done" ? DONE_HOLD_MS : ERROR_HOLD_MS,
    );
  };

  onMount(() => {
    void tick();
  });
  onCleanup(() => {
    stop = true;
    if (timer) clearTimeout(timer);
  });

  const state = () => job()?.state ?? "running";
  const label = () => {
    const j = job();
    if (!j) return "Working…";
    if (j.state === "error") return j.error || j.step;
    return j.step;
  };

  return (
    <Show when={visible()}>
      <span
        class="voice-progress"
        classList={{
          "vp-running": state() === "running",
          "vp-done": state() === "done",
          "vp-error": state() === "error",
        }}
        role="status"
        title={label()}
      >
        {state() === "running" ? (
          <span class="vp-spin" aria-hidden="true"></span>
        ) : (
          <span class="vp-glyph" aria-hidden="true">
            {state() === "done" ? "✓" : "!"}
          </span>
        )}
        <span class="vp-label">{label()}</span>
      </span>
    </Show>
  );
}
