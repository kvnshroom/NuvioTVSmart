import * as internals from "./playerScreenContext.js";
import { createPlayerVideoLifecycleHandlers } from "./playerVideoLifecycleHandlers.js";
import { createPlayerVideoEventHandlers } from "./playerVideoEventHandlers.js";
import { Platform } from "../../../platform/index.js";
import { getVidaaBufferGapTarget, timeRangesToArray } from "../../../platform/vidaa/vidaaBufferGap.js";

// TEMP (pages-test only): on-screen player debug.
function vidaaPlayerDebug(line) {
  try {
    let box = document.getElementById("vidaa-player-debug");
    if (!box) {
      box = document.createElement("div");
      box.id = "vidaa-player-debug";
      box.style.cssText =
        "position:fixed;right:10px;top:10px;max-width:60%;z-index:2147483647;background:rgba(0,0,0,.85);color:#0f0;font:14px monospace;padding:8px;white-space:pre-wrap;pointer-events:none";
      document.body.appendChild(box);
    }
    const stamp = new Date().toTimeString().slice(0, 8);
    box.textContent = `${box.textContent}\n${stamp} ${line}`.split("\n").slice(-12).join("\n");
  } catch (_) {}
}

export function createPlayerScreenMethods27() {
  return {
    bindVideoEvents() {
      const { PlayerController, Environment } = internals;
      const video = PlayerController.video;
      if (!video) {
        return;
      }
      // Idempotent bind: re-mounts/episode switches used to stack duplicate
      // timeupdate/subtitle/track handlers, multiplying per-frame work on
      // single-core Tizen. Unbind first; unbindVideoEvents is a no-op when empty.
      try {
        if (typeof this.unbindVideoEvents === "function") {
          this.unbindVideoEvents();
        }
      } catch (_) {}
      const isTizenAvPlayPlayback = () =>
        Boolean(Environment.isTizen() && typeof PlayerController.isUsingAvPlay === "function" && PlayerController.isUsingAvPlay());
      const lifecycleHandlers = createPlayerVideoLifecycleHandlers.call(this, video, isTizenAvPlayPlayback);
      const eventHandlers = createPlayerVideoEventHandlers.call(this, video, isTizenAvPlayPlayback);
      const { onWaiting, onPlaying, onPause, onProgress, onTimeUpdate, onLoadedMetadata, onPlayable, onSeeked, onTrackListChanged } =
        lifecycleHandlers;
      const { onWebOsAudioTrackSelectionChanged, onAvPlaySubtitleChange, onError } = eventHandlers;
      const bindings = [
        ["waiting", onWaiting],
        ["playing", onPlaying],
        ["error", onError],
        ["pause", onPause],
        ["progress", onProgress],
        ["timeupdate", onTimeUpdate],
        ["loadedmetadata", onLoadedMetadata],
        ["loadeddata", onPlayable],
        ["canplay", onPlayable],
        ["seeked", onSeeked],
        ["avplaytrackschanged", onTrackListChanged],
        ["avplaysubtitlechange", onAvPlaySubtitleChange],
        ["webosaudiotrackselectionchanged", onWebOsAudioTrackSelectionChanged],
        [
          "webosaudioconversionchanged",
          () => {
            this.invalidateTrackDialogCaches();
            this.renderAudioDialog();
            this.updateLoadingVisibility();
          }
        ],
        ["hlstrackschanged", onTrackListChanged],
        ["dashtrackschanged", onTrackListChanged]
      ];
      if (Platform.isVidaa()) {
        // A resume seek can leave currentTime in front of the first buffered keyframe, where
        // playback never starts. Step over that small gap and keep playing unless paused.
        const onBufferGap = () => {
          if (video.seeking) return;
          const target = getVidaaBufferGapTarget(video.currentTime, timeRangesToArray(video.buffered));
          if (target === null) return;
          vidaaPlayerDebug(`GAP-SPRUNG ${video.currentTime.toFixed(2)} -> ${target.toFixed(2)}`);
          video.currentTime = target;
          if (!this.paused) video.play()?.catch?.(() => {});
        };
        ["waiting", "progress", "canplay", "seeked"].forEach((eventName) => bindings.push([eventName, onBufferGap]));
        // TEMP (pages-test only): show player state on screen.
        const onDebugState = (event) => {
          const ranges = timeRangesToArray(video.buffered)
            .map(([a, b]) => `${a.toFixed(1)}-${b.toFixed(1)}`)
            .join(" ");
          vidaaPlayerDebug(
            `${event.type} t=${video.currentTime.toFixed(2)} rs=${video.readyState} ns=${video.networkState} paused=${video.paused} seeking=${video.seeking} buf=[${ranges}]${video.error ? ` ERR=${video.error.code}` : ""}`
          );
        };
        // TEMP: every 3s, show whether the clock and the decoders are moving.
        if (!globalThis.__vidaaDebugTicker) {
          globalThis.__vidaaDebugTicker = setInterval(() => {
            const v = document.querySelector("video");
            if (!v || !v.currentSrc) return;
            const q = typeof v.getVideoPlaybackQuality === "function" ? v.getVideoPlaybackQuality() : null;
            vidaaPlayerDebug(
              `TICK t=${v.currentTime.toFixed(2)} rs=${v.readyState} paused=${v.paused} audioBytes=${v.webkitAudioDecodedByteCount ?? "?"} videoBytes=${v.webkitVideoDecodedByteCount ?? "?"} frames=${q ? q.totalVideoFrames : "?"} muted=${v.muted} vol=${v.volume}`
            );
          }, 3000);
        }
        ["loadedmetadata", "waiting", "stalled", "seeking", "seeked", "canplay", "playing", "error", "abort", "emptied"].forEach((eventName) =>
          bindings.push([eventName, onDebugState])
        );
      }

      bindings.forEach(([eventName, handler]) => {
        video.addEventListener(eventName, handler);
        this.videoListeners.push({ target: video, eventName, handler });
      });

      if (typeof window?.addEventListener === "function") {
        const onViewportResize = () => {
          this.applyAspectMode({ showToast: false });
          // applyAspectMode() restores the playback surface. Invalidate the
          // post-play mode before re-applying the Android mini-window geometry.
          this.cancelPostPlayPlayerSurfaceAnimation();
          const viewport = PlayerController.getCssPlayerViewportSize?.() || {
            width: 1920,
            height: 1080
          };
          if (this.isPostPlayVisible()) {
            this.postPlayPlayerSurfaceStateKey = "";
            this.postPlayPlayerSurfaceRect = {
              x: 0,
              y: 0,
              width: Math.max(1, Math.round(Number(viewport.width || 1920))),
              height: Math.max(1, Math.round(Number(viewport.height || 1080)))
            };
          }
          this.syncPostPlayPlayerSurface(this.getPostPlayState());
        };
        window.addEventListener("resize", onViewportResize);
        this.videoListeners.push({
          target: window,
          eventName: "resize",
          handler: onViewportResize
        });
      }

      const trackTargets = [this.getVideoTextTrackList(), this.getVideoAudioTrackList()].filter(Boolean);
      trackTargets.forEach((target) => {
        if (typeof target.addEventListener !== "function") {
          return;
        }
        ["addtrack", "removetrack", "change"].forEach((eventName) => {
          target.addEventListener(eventName, onTrackListChanged);
          this.videoListeners.push({ target, eventName, handler: onTrackListChanged });
        });
      });
    }
  };
}
