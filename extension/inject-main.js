// inject-main.js - Runs in the MAIN page world
// Intercepts requestFullscreen on <video> elements to redirect it to the player container,
// ensuring that overlays (Skip button, markers, quick marker) stay in the top layer.

(function () {
  'use strict';

  function getPlayerContainer(video) {
    if (!video) return null;
    return (
      video.closest('.player-container') ||
      video.closest('[data-player]') ||
      video.closest('#player') ||
      video.closest('.player') ||
      video.closest('[class*="aspect-video"]') ||
      video.closest('.relative') ||
      video.parentElement
    );
  }

  const origElReqFs = Element.prototype.requestFullscreen;
  const origElWebkitFs = Element.prototype.webkitRequestFullscreen;
  const origVideoReqFs = HTMLVideoElement.prototype.requestFullscreen;
  const origVideoWebkitFs = HTMLVideoElement.prototype.webkitRequestFullscreen;

  function patchRequestFs(origFn) {
    return function (options) {
      if (this instanceof HTMLVideoElement || this.tagName === 'VIDEO' || this.classList.contains('player-video')) {
        const container = getPlayerContainer(this);
        if (container && container !== document.body) {
          container.setAttribute('data-aon-fullscreen', 'true');
          const containerFs = container.requestFullscreen || container.webkitRequestFullscreen;
          if (containerFs) {
            console.log('[AnimeOn Skipper MAIN] Redirecting fullscreen to container:', container);
            return containerFs.call(container, options);
          }
        }
      }
      return origFn ? origFn.call(this, options) : Promise.reject();
    };
  }

  if (origElReqFs) {
    Element.prototype.requestFullscreen = patchRequestFs(origElReqFs);
  }
  if (origElWebkitFs) {
    Element.prototype.webkitRequestFullscreen = patchRequestFs(origElWebkitFs);
  }
  if (origVideoReqFs) {
    HTMLVideoElement.prototype.requestFullscreen = patchRequestFs(origVideoReqFs);
  }
  if (origVideoWebkitFs) {
    HTMLVideoElement.prototype.webkitRequestFullscreen = patchRequestFs(origVideoWebkitFs);
  }

  // Reactive listener in main world
  function onFsChange() {
    const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
    if (fsEl && (fsEl.tagName === 'VIDEO' || fsEl.classList.contains('player-video'))) {
      console.log('[AnimeOn Skipper MAIN] Video is in fullscreen, switching to container');
      const container = getPlayerContainer(fsEl);
      if (container && container !== document.body) {
        document.exitFullscreen().then(() => {
          const fs = container.requestFullscreen || container.webkitRequestFullscreen;
          if (fs) fs.call(container).catch(() => {});
        }).catch(() => {});
      }
    }
  }

  document.addEventListener('fullscreenchange', onFsChange, true);
  document.addEventListener('webkitfullscreenchange', onFsChange, true);

  console.log('[AnimeOn Skipper] Main world fullscreen interceptor initialized.');
})();
