import * as internals from "./playerScreenContext.js";
import { createPlayerVideoLifecycleHandlers } from "./playerVideoLifecycleHandlers.js";
import { createPlayerVideoEventHandlers } from "./playerVideoEventHandlers.js";
import { Platform } from "../../../platform/index.js";
import { shouldJumpVidaaBufferGap, timeRangesToArray } from "../../../platform/vidaa/vidaaBufferGap.js";
import { shouldDisableVidaaInitialTextTrack } from "../../../platform/vidaa/vidaaVideo.js";

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
        // The new source started loading: from now on timeupdate belongs to it.
        bindings.push([
          "loadstart",
          () => {
            if (this.pendingPlaybackRestore?.awaitingNewSource) {
              this.pendingPlaybackRestore.awaitingNewSource = false;
            }
          }
        ]);
        // A resume seek can leave currentTime in front of the first buffered keyframe, where
        // playback never starts. Step over that small gap and keep playing unless paused.
        // Only armed for a short while after a resume restore or a seek (see seekPlaybackSeconds).
        const onBufferGap = () => {
          const armed = this.vidaaBufferGapArm;
          if (!armed) return;
          const now = Date.now();
          if (now > armed.until) {
            this.vidaaBufferGapArm = null;
            return;
          }
          const target = shouldJumpVidaaBufferGap({
            armed,
            now,
            currentTime: video.currentTime,
            ranges: timeRangesToArray(video.buffered),
            seeking: video.seeking,
            scrubbing: this.seekPreviewSeconds != null
          });
          if (target === null) return;
          vidaaPlayerDebug(`GAP-SPRUNG ${video.currentTime.toFixed(2)} -> ${target.toFixed(2)}`);
          this.vidaaBufferGapArm = null;
          video.currentTime = target;
          if (!this.paused) video.play()?.catch?.(() => {});
        };
        ["waiting", "progress", "canplay", "seeked"].forEach((eventName) => bindings.push([eventName, onBufferGap]));
        // TEMP (pages-test only): report whether this browser can switch audio tracks.
        const reportAudioTrackSupport = () => {
          const list = video.audioTracks;
          if (!list) {
            console.warn(
              "[Nuvio audio] video.audioTracks NICHT verfuegbar - Tonspuren koennen nicht gewechselt werden. Chrome: chrome://flags/#enable-experimental-web-platform-features aktivieren und Chrome neu starten."
            );
            vidaaPlayerDebug("AUDIOTRACKS: nicht verfuegbar (Chrome-Flag fehlt?)");
            return;
          }
          const tracks = Array.from(list).map((t, i) => `${i}:${t.enabled ? "*" : ""}${t.language || "?"}/${t.label || "-"}`);
          console.info(`[Nuvio audio] video.audioTracks verfuegbar - ${list.length} Spur(en): ${tracks.join(", ")}`);
          vidaaPlayerDebug(`AUDIOTRACKS: ${list.length} [${tracks.join(" ")}]`);
        };
        bindings.push(["loadedmetadata", reportAudioTrackSupport]);
        if (video.audioTracks && !video.__nuvioAudioDebugBound) {
          video.__nuvioAudioDebugBound = true;
          video.audioTracks.addEventListener?.("change", () => {
            console.info("[Nuvio audio] Tonspur gewechselt");
            reportAudioTrackSupport();
          });
        }
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
              `TICK t=${v.currentTime.toFixed(2)} rs=${v.readyState} paused=${v.paused} audioBytes=${v.webkitAudioDecodedByteCount ?? "?"} videoBytes=${v.webkitVideoDecodedByteCount ?? "?"} frames=${q ? q.totalVideoFrames : "?"} muted=${v.muted} gate=${Boolean(internals.PlayerController?.startupAudioGateActive)}`
            );
          }, 3000);
        }
        ["loadedmetadata", "waiting", "stalled", "seeking", "seeked", "canplay", "playing", "error", "abort", "emptied"].forEach(
          (eventName) => bindings.push([eventName, onDebugState])
        );

        // VIDAA renders the first embedded subtitle track as soon as it appears, while its
        // mode reads "disabled". When Nuvio shows no built-in subtitle, turn it off for
        // real (setNativeTextTrack(-1) toggles it, see selectVidaaTextTrack). A track
        // Nuvio picked itself, an addon or manifest subtitle is left alone.
        const textTrackList = this.getVideoTextTrackList();
        if (textTrackList && typeof textTrackList.addEventListener === "function") {
          const onVidaaTextTrackAdded = () => {
            setTimeout(() => {
              if (!shouldDisableVidaaInitialTextTrack(this)) return;
              PlayerController.setNativeTextTrack?.(-1);
            }, 0);
          };
          textTrackList.addEventListener("addtrack", onVidaaTextTrackAdded);
          this.videoListeners.push({ target: textTrackList, eventName: "addtrack", handler: onVidaaTextTrackAdded });
        }
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
