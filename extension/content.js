/**
 * AnimeOn Skipper — Content Script (v2.2.0)
 * Пропуск опенингов и эндингов на AnimeOn и Kodik.
 *
 * Нововведения v2.2.0:
 * 1. Интегрированный HUD / Overlay Editor для ручной разметки прямо в плеере.
 * 2. Полная поддержка полноэкранного режима (Fullscreen).
 * 3. Горячие клавиши на лету: [ / ] для OP, { / } для ED, Alt+M для вызова редактора.
 * 4. Мгновенный предпросмотр диапазонов на шкале таймлайна в реальном времени.
 * 5. Валидация диапазонов и сохранение в базу Cloudflare Worker.
 */

(function () {
  'use strict';

  // =========================================================================
  // 1. КОНФИГУРАЦИЯ И НАСТРОЙКИ (Settings Manager)
  // =========================================================================
  const settings = {
    autoSkipOp: true,
    autoSkipEd: true,
    offsetSeconds: 0,
    showTimelineMarkers: true,
    showQuickMarkBar: true
  };

  async function initSettings() {
    try {
      const data = await chrome.storage.local.get([
        'autoSkipOp',
        'autoSkipEd',
        'offsetSeconds',
        'showTimelineMarkers',
        'showQuickMarkBar'
      ]);
      Object.assign(settings, data);

      if (settings.autoSkipOp === undefined || settings.autoSkipOp === null) {
        settings.autoSkipOp = true;
        chrome.storage.local.set({ autoSkipOp: true });
      }
      if (settings.autoSkipEd === undefined || settings.autoSkipEd === null) {
        settings.autoSkipEd = true;
        chrome.storage.local.set({ autoSkipEd: true });
      }
      if (settings.showTimelineMarkers === undefined) {
        settings.showTimelineMarkers = true;
        chrome.storage.local.set({ showTimelineMarkers: true });
      }
    } catch (e) {
      console.warn('[AnimeOn Skipper] Ошибка чтения настроек:', e);
    }
  }

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local') {
      let shouldRefreshUI = false;
      for (const [key, change] of Object.entries(changes)) {
        if (key in settings) {
          settings[key] = change.newValue;
          shouldRefreshUI = true;
        }
      }
      if (shouldRefreshUI) {
        playbackSession.recalculateAndRender();
      }
    }
  });

  // =========================================================================
  // 2. ОПРЕДЕЛЕНИЕ ТАЙТЛА И СЕРИИ (Page Context Extractor)
  // =========================================================================
  const pageContext = {
    malId: null,
    episode: 1,
    title: '',
    isManualEpisode: false,
    manualEpisode: null,

    extract() {
      let detectedId = null;
      const decodedPath = decodeURIComponent(window.location.pathname);

      // Паттерн 1: /anime/slug-12345
      const matchSlug = decodedPath.match(/\/anime\/[^\/]+?-(\d+)(?:[/?#]|$)/i);
      if (matchSlug) detectedId = matchSlug[1];

      // Паттерн 2: /anime/12345
      if (!detectedId) {
        const matchDirect = decodedPath.match(/\/anime\/(\d+)(?:[/?#]|$)/i);
        if (matchDirect) detectedId = matchDirect[1];
      }

      // Паттерн 3: последнее число в сегментах пути
      if (!detectedId && decodedPath.includes('/anime/')) {
        const segments = decodedPath.split('/').filter(Boolean);
        for (const seg of segments) {
          const m = seg.match(/(\d{2,7})$/);
          if (m) {
            detectedId = m[1];
            break;
          }
        }
      }

      // Паттерн 4: из JSON-LD микроразметки
      if (!detectedId) {
        const ldScripts = document.querySelectorAll('script[type="application/ld+json"]');
        for (const s of ldScripts) {
          try {
            const m = s.textContent.match(/\/anime\/[^\/"]*?-(\d+)/);
            if (m) {
              detectedId = m[1];
              break;
            }
          } catch (e) {}
        }
      }

      // Если тайтл сменился, сбрасываем ручной оверрайд серии
      if (detectedId && this.malId && detectedId !== this.malId) {
        this.isManualEpisode = false;
        this.manualEpisode = null;
      }

      this.malId = detectedId || this.malId;

      // Определение названия тайтла
      const titleEl = document.querySelector('h1');
      if (titleEl && titleEl.textContent.trim()) {
        this.title = titleEl.textContent.trim();
      } else {
        const og = document.querySelector('meta[property="og:title"]')?.content;
        this.title = (og || document.title).split('—')[0].split('|')[0].trim();
      }

      // Определение сезона из названия
      const sMatch = this.title.match(/(?:(?:[-(]\s*)?(\d{1,2})\s*(?:сезон|season|th season|nd season|rd season|st season)|(?:ТВ|TV)-?(\d{1,2}))/i);
      this.season = sMatch ? parseInt(sMatch[1] || sMatch[2], 10) : 1;

      // Определение общего количества серий на странице AnimeOn
      let maxEp = 0;
      const epButtons = document.querySelectorAll('button[data-episode]');
      epButtons.forEach(btn => {
        const num = parseInt(btn.getAttribute('data-episode'), 10);
        if (!isNaN(num) && num > maxEp) maxEp = num;
      });
      if (maxEp > 0) this.totalEpisodes = maxEp;

      if (this.isManualEpisode && this.manualEpisode) {
        this.episode = this.manualEpisode;
      } else {
        const ep = this.detectActiveEpisode();
        if (ep) this.episode = ep;
      }

      return { malId: this.malId, episode: this.episode, title: this.title, season: this.season, totalEpisodes: this.totalEpisodes || null };
    },

    detectActiveEpisode() {
      // Если включена ручная корректировка, возвращаем её
      if (this.isManualEpisode && this.manualEpisode) {
        return this.manualEpisode;
      }

      // 0. ПРИОРИТЕТ 0: Параметры текущего URL (search query, hash и path)
      try {
        const urlParams = new URLSearchParams(window.location.search);
        const qEp = urlParams.get('episode') || urlParams.get('ep') || urlParams.get('series') || urlParams.get('e');
        if (qEp && !isNaN(parseInt(qEp, 10))) {
          const num = parseInt(qEp, 10);
          if (num > 0 && num <= 2000) return num;
        }

        const hash = window.location.hash || '';
        const hMatch = hash.match(/(?:episode|ep|серия|series)[-_=]?(\d+)/i);
        if (hMatch && hMatch[1]) {
          const num = parseInt(hMatch[1], 10);
          if (num > 0 && num <= 2000) return num;
        }

        const path = decodeURIComponent(window.location.pathname);
        const mPath = path.match(/\/(?:anime|watch|title)\/[^\/]+?\/(\d+)(?:[/?#]|$)/i) ||
                      path.match(/\/(?:episode|series|ep|выпуск|серия)[-\/]?(\d+)(?:[/?#]|$)/i);
        if (mPath && mPath[1]) {
          const num = parseInt(mPath[1], 10);
          if (num > 0 && num <= 2000) return num;
        }
      } catch (e) {}

      // 1. ПРИОРИТЕТ 1: Точный бейдж текущей серии на AnimeOn
      // Пример из разметки страницы: <span data-slot="badge" ...>2 эпизод</span>
      const badges = document.querySelectorAll('span[data-slot="badge"], [data-slot="badge"], .badge');
      for (const b of badges) {
        const txt = (b.textContent || '').trim();
        if (txt.includes('серий') || txt.includes('из') || txt.includes('всего') || txt.includes('сезон')) continue;
        const m = txt.match(/^(\d{1,4})\s*(?:эпизод|серия|выпуск)/i) ||
                  txt.match(/(?:эпизод|серия|выпуск)\s*(\d{1,4})/i);
        if (m && m[1]) {
          const ep = parseInt(m[1], 10);
          if (ep > 0 && ep <= 2000) return ep;
        }
      }

      // 2. ПРИОРИТЕТ 2: Активная кнопка серии в списке AnimeOn
      const epBtns = Array.from(document.querySelectorAll('button[data-episode], [data-episode]'));
      if (epBtns.length > 0) {
        // Шаг 2.1: Точное обнаружение активной серии по признакам активного состояния
        for (const btn of epBtns) {
          const cls = (btn.className || '').toLowerCase();
          const hasWatchedBar = !!btn.querySelector('[class*="h-[2px]"], [class*="bottom-0"]');

          // Главный признак активной серии на AnimeOn: полноразмерная заливка inset-0
          const hasFullFill = !!btn.querySelector('[class*="inset-0"]');

          // Признак 2: Неоновая тень/свечение активной кнопки (shadow-[...])
          const hasShadow = cls.includes('shadow-') && !hasWatchedBar;

          // Признак 3: ARIA и data-атрибуты активного элемента
          const hasActiveAttr = btn.getAttribute('aria-selected') === 'true' ||
                                btn.getAttribute('aria-current') === 'true' ||
                                btn.getAttribute('aria-current') === 'page' ||
                                btn.getAttribute('data-state') === 'active' ||
                                btn.getAttribute('data-active') === 'true' ||
                                btn.getAttribute('data-selected') === 'true';

          // Признак 4: Отдельный класс active/selected/current (без учета фонов истории bg-violet-500/10)
          const hasExactActiveClass = /\b(active|selected|current)\b/i.test(cls);

          if (hasFullFill || hasShadow || hasActiveAttr || hasExactActiveClass) {
            const ep = parseInt(btn.getAttribute('data-episode'), 10);
            if (!isNaN(ep) && ep > 0 && ep <= 2000) return ep;
          }
        }

        // Шаг 2.2: Запасной вариант — поиск кнопки с ярким белым текстом (без прозрачности)
        for (const btn of epBtns) {
          const span = btn.querySelector('span');
          const spanCls = (span?.className || '').toLowerCase();
          const hasWhiteText = spanCls.includes('text-white') && !spanCls.includes('text-white/');
          const hasWatchedBar = !!btn.querySelector('[class*="h-[2px]"], [class*="bottom-0"]');

          if (hasWhiteText && !hasWatchedBar) {
            const ep = parseInt(btn.getAttribute('data-episode'), 10);
            if (!isNaN(ep) && ep > 0 && ep <= 2000) return ep;
          }
        }
      }

      // 3. Любая кнопка с aria-label="Серия N" (если нет data-episode)
      const ariaBtns = Array.from(document.querySelectorAll('button[aria-label*="ерия"], button[aria-label*="пизод"]'));
      for (const btn of ariaBtns) {
        const cls = (btn.className || '').toLowerCase();
        const hasWatchedBar = !!btn.querySelector('[class*="h-[2px]"], [class*="bottom-0"]');
        const hasFullFill = !!btn.querySelector('[class*="inset-0"]');
        const hasShadow = cls.includes('shadow-') && !hasWatchedBar;
        const hasActiveAttr = btn.getAttribute('aria-selected') === 'true' ||
                              btn.getAttribute('aria-current') === 'true' ||
                              btn.getAttribute('data-state') === 'active';
        const hasExactActive = /\b(active|selected|current)\b/i.test(cls);

        if (hasFullFill || hasShadow || hasActiveAttr || hasExactActive) {
          const m = btn.getAttribute('aria-label').match(/\d+/);
          if (m) {
            const ep = parseInt(m[0], 10);
            if (ep > 0 && ep <= 2000) return ep;
          }
        }
      }

      // 4. Поиск по другим текстовым меткам вблизи плеера
      const textNodes = document.querySelectorAll('[class*="tag"], [class*="badge"]');
      for (const el of textNodes) {
        if (el.children.length > 2) continue;
        const txt = (el.textContent || '').trim();
        if (txt.length > 25 || txt.includes('серий') || txt.includes('из') || txt.includes('всего') || txt.includes('сезон')) continue;
        const m = txt.match(/^(\d{1,4})\s*(?:эпизод|серия)$/i);
        if (m && m[1]) {
          const ep = parseInt(m[1], 10);
          if (ep > 0 && ep <= 2000) return ep;
        }
      }

      // 5. sessionStorage — только если номер серии еще ни разу не был определен
      if (!this.episode && this.malId) {
        try {
          const saved = sessionStorage.getItem(`aon_ep_${this.malId}`);
          if (saved && !isNaN(parseInt(saved, 10))) return parseInt(saved, 10);
        } catch (e) {}
      }

      return this.episode || 1;
    }
  };

  // =========================================================================
  // 3. SINGLE SOURCE OF TRUTH: ИНТЕРВАЛЫ И ПРИОРИТЕТЫ
  // =========================================================================
  class IntervalStore {
    constructor() {
      this.external = { op: null, ed: null, source: null };
      this.resolved = { op: null, ed: null };
    }

    reset() {
      this.external = { op: null, ed: null, source: null };
      this.resolved = { op: null, ed: null };
    }

    setExternal(op, ed, source = 'cloudflare') {
      this.external = {
        op: (Array.isArray(op) && op.length === 2 && op[1] > op[0]) ? [op[0], op[1]] : null,
        ed: (Array.isArray(ed) && ed.length === 2 && ed[1] > ed[0]) ? [ed[0], ed[1]] : null,
        source: source
      };
      this.resolve();
    }

    resolve() {
      let op = null;
      if (this.external.op) {
        op = {
          start: this.external.op[0],
          end: this.external.op[1],
          type: 'op',
          source: this.external.source || 'cloudflare'
        };
      }

      let ed = null;
      if (this.external.ed) {
        ed = {
          start: this.external.ed[0],
          end: this.external.ed[1],
          type: 'ed',
          source: this.external.source || 'cloudflare'
        };
      }

      this.resolved.op = op;
      this.resolved.ed = ed;
      return this.resolved;
    }
  }

  // =========================================================================
  // 4. РЕНДЕРИНГ НА ТАЙМЛАЙНЕ (Timeline UI Renderer с поддержкой предпросмотра)
  // =========================================================================
  class TimelineRenderer {
    constructor() {
      this.activeTrack = null;
      this.activeScrubber = null;
      this.tooltip = null;
      this.onMouseMove = this.handleMouseMove.bind(this);
      this.onMouseLeave = this.handleMouseLeave.bind(this);
    }

    findScrubberAndTrack(container) {
      const root = container || document.body;
      const scrubber = root.querySelector('[class*="group/scrubber"]') ||
                       root.querySelector('[class*="scrubber"]') ||
                       document.querySelector('[class*="group/scrubber"]') ||
                       document.querySelector('[class*="scrubber"]');

      if (!scrubber) return null;

      const track = scrubber.querySelector('[class*="origin-center"]') ||
                    scrubber.querySelector('[class*="overflow-hidden"]') ||
                    scrubber.querySelector('.absolute.left-0.right-0') ||
                    scrubber.firstElementChild ||
                    scrubber;

      return { scrubber, track };
    }

    cleanup() {
      if (this.activeTrack) {
        this.activeTrack.querySelectorAll('.aon-timeline-marker').forEach((el) => el.remove());
      }
      if (this.activeScrubber) {
        this.activeScrubber.removeEventListener('mousemove', this.onMouseMove);
        this.activeScrubber.removeEventListener('mouseleave', this.onMouseLeave);
        this.activeScrubber.querySelector('.aon-timeline-tooltip')?.remove();
        this.activeScrubber.removeAttribute('data-aon-tooltip-attached');
      }
      this.activeTrack = null;
      this.activeScrubber = null;
      this.tooltip = null;
    }

    render(container, duration, resolved, preview = null) {
      const els = this.findScrubberAndTrack(container);
      if (!els || !els.track) {
        this.cleanup();
        return;
      }

      const { scrubber, track } = els;

      if (this.activeTrack !== track) {
        this.cleanup();
        this.activeTrack = track;
        this.activeScrubber = scrubber;
      }

      // Очищаем существующие маркеры
      track.querySelectorAll('.aon-timeline-marker').forEach((el) => el.remove());

      if (!settings.showTimelineMarkers || !duration || duration <= 0) {
        return;
      }

      const segments = [];

      // Если активен предпросмотр из HUD-редактора, отображаем его с наивысшим приоритетом
      if (preview && (preview.op || preview.ed)) {
        if (preview.op && preview.op[1] > preview.op[0]) {
          segments.push({ start: preview.op[0], end: preview.op[1], type: 'op', isPreview: true });
        }
        if (preview.ed && preview.ed[1] > preview.ed[0]) {
          segments.push({ start: preview.ed[0], end: preview.ed[1], type: 'ed', isPreview: true });
        }
      } else {
        // Обычный рендер сохраненных таймингов из базы
        if (resolved.op) segments.push(resolved.op);
        if (resolved.ed) segments.push(resolved.ed);
      }

      for (const seg of segments) {
        const leftPct = Math.max(0, Math.min(100, (seg.start / duration) * 100));
        const widthPct = Math.max(0.5, Math.min(100 - leftPct, ((seg.end - seg.start) / duration) * 100));

        const marker = document.createElement('div');
        marker.className = `aon-timeline-marker aon-marker-${seg.type}${seg.isPreview ? ' aon-marker-preview' : ''}`;
        marker.style.left = `${leftPct.toFixed(3)}%`;
        marker.style.width = `${widthPct.toFixed(3)}%`;
        marker.dataset.type = seg.type;
        marker.dataset.start = seg.start;
        marker.dataset.end = seg.end;
        marker.title = `${seg.type === 'op' ? 'Опенинг' : 'Эндинг'}${seg.isPreview ? ' [Предпросмотр]' : ''}: ${formatTime(seg.start)} — ${formatTime(seg.end)}`;

        track.appendChild(marker);
      }

      this.attachTooltip(scrubber);
    }

    attachTooltip(scrubber) {
      if (scrubber.hasAttribute('data-aon-tooltip-attached')) return;

      let tip = scrubber.querySelector('.aon-timeline-tooltip');
      if (!tip) {
        tip = document.createElement('div');
        tip.className = 'aon-timeline-tooltip';
        tip.innerHTML = `
          <span class="aon-timeline-badge"></span>
          <span class="aon-hover-time">00:00</span>
          <span class="aon-segment-range"></span>
        `;
        scrubber.appendChild(tip);
      }
      this.tooltip = tip;

      scrubber.addEventListener('mousemove', this.onMouseMove);
      scrubber.addEventListener('mouseleave', this.onMouseLeave);
      scrubber.setAttribute('data-aon-tooltip-attached', 'true');
    }

    handleMouseMove(e) {
      const video = playbackSession.video;
      if (!video || !video.duration || !this.tooltip) return;

      const scrubber = this.activeScrubber;
      if (!scrubber) return;

      const rect = scrubber.getBoundingClientRect();
      if (rect.width <= 0) return;

      const posX = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
      const hoverTime = (posX / rect.width) * video.duration;

      // Проверяем предпросмотр или итоговые интервалы
      const preview = hudEditor ? hudEditor.getPreviewIntervals() : null;
      const res = (preview && (preview.op || preview.ed))
        ? {
            op: preview.op ? { start: preview.op[0], end: preview.op[1], type: 'op' } : null,
            ed: preview.ed ? { start: preview.ed[0], end: preview.ed[1], type: 'ed' } : null
          }
        : playbackSession.intervals.resolved;

      let activeSeg = null;

      if (res.op && hoverTime >= res.op.start - 1 && hoverTime <= res.op.end + 1) {
        activeSeg = res.op;
      } else if (res.ed && hoverTime >= res.ed.start - 1 && hoverTime <= res.ed.end + 1) {
        activeSeg = res.ed;
      }

      if (activeSeg) {
        const badge = this.tooltip.querySelector('.aon-timeline-badge');
        const hoverTimeEl = this.tooltip.querySelector('.aon-hover-time');
        const rangeEl = this.tooltip.querySelector('.aon-segment-range');

        badge.textContent = activeSeg.type === 'op' ? 'Опенинг' : 'Эндинг';
        badge.className = `aon-timeline-badge aon-badge-${activeSeg.type}`;
        hoverTimeEl.textContent = formatTime(Math.round(hoverTime));
        rangeEl.textContent = `${formatTime(activeSeg.start)} - ${formatTime(activeSeg.end)}`;

        this.tooltip.style.left = `${posX}px`;
        this.tooltip.classList.add('aon-tooltip-visible');
      } else {
        this.tooltip.classList.remove('aon-tooltip-visible');
      }
    }

    handleMouseLeave() {
      if (this.tooltip) {
        this.tooltip.classList.remove('aon-tooltip-visible');
      }
    }
  }

  // =========================================================================
  // 5. АВТОСКИП И МЕХАНИКА ПЕРЕМОТКИ (Playback & AutoSkip Engine)
  // =========================================================================
  class PlaybackController {
    constructor() {
      this.video = null;
      this.skipped = {
        op: false,
        ed: false
      };

      this.onTimeUpdate = this.handleTimeUpdate.bind(this);
      this.onSeeked = this.handleSeeked.bind(this);
      this.onSeeking = this.handleSeeking.bind(this);
      this.onLoadedMetadata = this.handleLoadedMetadata.bind(this);
    }

    resetSkipFlags() {
      this.skipped.op = false;
      this.skipped.ed = false;
    }

    attach(video) {
      if (this.video === video) return;
      this.detach();

      this.video = video;
      this.resetSkipFlags();

      video.addEventListener('timeupdate', this.onTimeUpdate);
      video.addEventListener('seeked', this.onSeeked);
      video.addEventListener('seeking', this.onSeeking);
      video.addEventListener('loadedmetadata', this.onLoadedMetadata);
      video.addEventListener('durationchange', this.onLoadedMetadata);

      console.log('[AnimeOn Skipper] Подключен видеоплеер:', video);
    }

    detach() {
      if (!this.video) return;
      this.video.removeEventListener('timeupdate', this.onTimeUpdate);
      this.video.removeEventListener('seeked', this.onSeeked);
      this.video.removeEventListener('seeking', this.onSeeking);
      this.video.removeEventListener('loadedmetadata', this.onLoadedMetadata);
      this.video.removeEventListener('durationchange', this.onLoadedMetadata);
      this.video = null;
      this.resetSkipFlags();
    }

    handleLoadedMetadata() {
      playbackSession.recalculateAndRender();
    }

    handleSeeking() {
      floatingButton.hide();
    }

    handleSeeked() {
      if (!this.video) return;
      const time = this.video.currentTime;
      const res = playbackSession.intervals.resolved;

      if (res.op && time < res.op.start - 0.5) {
        this.skipped.op = false;
      }
      if (res.ed && time < res.ed.start - 0.5) {
        this.skipped.ed = false;
      }
    }

    handleTimeUpdate() {
      if (!this.video) return;

      const currentTime = this.video.currentTime;
      const duration = this.video.duration || 0;
      const res = playbackSession.intervals.resolved;
      let shouldShowButton = false;

      // 1. ОПЕНИНГ (OP)
      if (res.op) {
        const { start, end } = res.op;

        if (currentTime < start) {
          this.skipped.op = false;
        } else if (currentTime >= start && currentTime < (end - 0.5)) {
          if (settings.autoSkipOp) {
            if (!this.skipped.op) {
              this.skipped.op = true;
              console.log(`[AnimeOn Skipper] Вход в опенинг [${start} - ${end}]: переход на ${end}с`);
              this.video.currentTime = end;
              nativeSync.clickNativeButton('op');
              floatingButton.hide();
              toast.show('⏩ Опенинг автоматически пропущен');
              return;
            }
          } else {
            floatingButton.show('Опенинг', end);
            shouldShowButton = true;
          }
        }
      }

      // 2. ЭНДИНГ (ED)
      if (res.ed) {
        const { start, end } = res.ed;

        if (currentTime < start) {
          this.skipped.ed = false;
        } else if (currentTime >= start && currentTime < (end - 0.5)) {
          if (settings.autoSkipEd) {
            if (!this.skipped.ed) {
              this.skipped.ed = true;
              const targetEnd = (duration > 0 && end > duration) ? duration : end;
              console.log(`[AnimeOn Skipper] Вход в эндинг [${start} - ${end}]: переход строго на ${targetEnd}с`);
              this.video.currentTime = targetEnd;
              nativeSync.clickNativeButton('ed');
              floatingButton.hide();
              toast.show('⏩ Эндинг автоматически пропущен');
              return;
            }
          } else {
            floatingButton.show('Эндинг', end);
            shouldShowButton = true;
          }
        }
      }

      // 3. СИНХРОННЫЙ АВТОКЛИК НАТИВНЫХ КНОПОК САЙТА
      if (settings.autoSkipOp && !this.skipped.op && duration > 0 && currentTime < duration * 0.5) {
        if (!res.op || currentTime >= res.op.start) {
          const clicked = nativeSync.clickNativeButton('op');
          if (clicked) {
            this.skipped.op = true;
            floatingButton.hide();
            toast.show('⏩ Опенинг пропущен');
            return;
          }
        }
      }

      if (settings.autoSkipEd && !this.skipped.ed && duration > 0 && currentTime > duration * 0.6) {
        if (!res.ed || currentTime >= res.ed.start) {
          const clicked = nativeSync.clickNativeButton('ed');
          if (clicked) {
            this.skipped.ed = true;
            floatingButton.hide();
            toast.show('⏩ Эндинг пропущен');
            return;
          }
        }
      }

      if (!shouldShowButton) {
        floatingButton.hide();
      }
    }
  }

  // =========================================================================
  // 6. СИНХРОНИЗАЦИЯ С НАТИВНЫМИ ТУМБЛЕРАМИ И КНОПКАМИ (Native DOM Sync)
  // =========================================================================
  class NativeDOMSync {
    constructor() {
      this.observer = null;
    }

    init() {
      this.observer = new MutationObserver(() => {
        this.syncSwitches();
      });

      this.observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['data-state', 'aria-checked']
      });

      document.addEventListener('click', (e) => {
        const target = e.target.closest('div, button, label, [role="menuitem"]');
        if (!target) return;
        const txt = (target.textContent || '').toLowerCase();
        if (txt.includes('опенинг') || txt.includes('эндинг') || txt.includes('титр') || target.getAttribute('role') === 'switch') {
          setTimeout(() => this.syncSwitches(), 50);
          setTimeout(() => this.syncSwitches(), 200);
        }
      }, true);
    }

    destroy() {
      if (this.observer) {
        this.observer.disconnect();
        this.observer = null;
      }
    }

    getSwitchTarget(sw) {
      if (!sw) return null;
      if (sw.offsetWidth === 0 && sw.offsetHeight === 0 && !sw.offsetParent) return null;

      let txt = sw.previousElementSibling ? (sw.previousElementSibling.textContent || '') : '';
      if (!txt && sw.parentElement) {
        txt = sw.parentElement.textContent || '';
      }
      const t = txt.toLowerCase();
      const isOp = (t.includes('опенинг') || t.includes('opening') || t.includes('intro')) && !t.includes('эндинг') && !t.includes('титр');
      const isEd = (t.includes('эндинг') || t.includes('ending') || t.includes('титр') || t.includes('outro')) && !t.includes('опенинг');
      if (isOp) return 'op';
      if (isEd) return 'ed';
      return null;
    }

    isSwitchChecked(sw) {
      if (!sw) return false;
      const aria = sw.getAttribute('aria-checked');
      if (aria === 'true') return true;
      if (aria === 'false') return false;

      const dataState = sw.getAttribute('data-state');
      if (dataState === 'checked') return true;
      if (dataState === 'unchecked') return false;

      const innerSpan = sw.querySelector('span[data-state]');
      if (innerSpan) {
        const s = innerSpan.getAttribute('data-state');
        if (s === 'checked') return true;
        if (s === 'unchecked') return false;
      }

      const cls = sw.className || '';
      return cls.includes('bg-primary') || cls.includes('bg-violet') || cls.includes('bg-purple');
    }

    syncSwitches() {
      const switches = document.querySelectorAll('button[role="switch"], [role="switch"]');
      for (const sw of switches) {
        if (sw.offsetWidth === 0 && sw.offsetHeight === 0 && !sw.offsetParent) continue;

        const target = this.getSwitchTarget(sw);
        if (!target) continue;

        const checked = this.isSwitchChecked(sw);

        if (target === 'op' && settings.autoSkipOp !== checked) {
          console.log(`[AnimeOn Skipper] Нативный тумблер опенинга изменен: ${checked}`);
          settings.autoSkipOp = checked;
          chrome.storage.local.set({ autoSkipOp: checked });
        } else if (target === 'ed' && settings.autoSkipEd !== checked) {
          console.log(`[AnimeOn Skipper] Нативный тумблер эндинга изменен: ${checked}`);
          settings.autoSkipEd = checked;
          chrome.storage.local.set({ autoSkipEd: checked });
        }
      }
    }

    clickNativeButton(type) {
      try {
        const container = (playbackSession && playbackSession.video) ? getActivePlayerContainer(playbackSession.video) : document;
        const btns = (container || document).querySelectorAll('button:not(.aon-skip-btn), [role="button"]:not(.aon-skip-btn)');
        for (const b of btns) {
          if (b.offsetWidth === 0 && b.offsetHeight === 0 && !b.offsetParent) continue;

          const raw = ((b.textContent || '') + ' ' + (b.getAttribute('aria-label') || '') + ' ' + (b.getAttribute('title') || '')).toLowerCase();
          if (type === 'op') {
            if ((raw.includes('пропустить') || raw.includes('skip')) && (raw.includes('опенинг') || raw.includes('opening') || raw.includes('intro'))) {
              b.click();
              return true;
            }
          } else if (type === 'ed') {
            if (
              ((raw.includes('пропустить') || raw.includes('skip')) && (raw.includes('эндинг') || raw.includes('ending') || raw.includes('титр') || raw.includes('outro'))) ||
              ((raw.includes('пропустить') || raw.includes('skip')) && !raw.includes('опенинг'))
            ) {
              b.click();
              return true;
            }
          }
        }
      } catch (e) {}
      return false;
    }
  }

  // =========================================================================
  // 7. КОНТЕЙНЕР ПЛЕЕРА И ПОЛНОЭКРАННЫЙ РЕЖИМ
  // =========================================================================
  function getActivePlayerContainer(video) {
    const fsEl = document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement;
    if (fsEl) {
      if (fsEl.tagName === 'VIDEO') {
        return fsEl.parentElement || fsEl;
      }
      return fsEl;
    }

    if (!video) return document.body;

    // 1. Ищем специализированный контейнер aspect-video (нативный плеер AnimeOn)
    const aspectBox = video.closest('[class*="aspect-video"]');
    if (aspectBox) return aspectBox;

    // 2. Ищем общий контейнер видео и скруббера/панели управления (100% реальный плеер)
    const scrubber = document.querySelector('[class*="group/scrubber"], [class*="scrubber"]');
    if (scrubber) {
      let p = video.parentElement;
      while (p && p !== document.body && p !== document.documentElement) {
        if (p.contains(scrubber)) {
          return p;
        }
        p = p.parentElement;
      }
    }

    // 3. Селекторы плееров Kodik / AnimeOn
    const playerBox = video.closest('.player-video-container') ||
                      video.closest('.player-container') ||
                      video.closest('[data-player]') ||
                      video.closest('#player') ||
                      video.closest('.player');
    if (playerBox) return playerBox;

    // 4. Непосредственный родитель видео
    return video.parentElement || document.body;
  }

  // =========================================================================
  // 8. ПЛАВАЮЩАЯ КНОПКА ПРОПУСКА (Floating Skip Button)
  // =========================================================================
  class FloatingSkipButton {
    constructor() {
      this.button = null;
      this.currentTarget = null;
    }

    ensure() {
      if (this.button && this.button.isConnected) return;

      const btn = document.createElement('button');
      btn.className = 'aon-skip-btn';
      btn.setAttribute('type', 'button');
      btn.innerHTML = `
        <svg class="aon-skip-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polygon points="5 4 15 12 5 20 5 4" fill="currentColor"></polygon>
          <line x1="19" y1="5" x2="19" y2="19" stroke-width="2.5"></line>
        </svg>
        <span class="aon-skip-label">Пропустить</span>
      `;

      const stop = (e) => {
        e.stopPropagation();
        e.stopImmediatePropagation();
      };
      ['mousedown', 'mouseup', 'dblclick', 'pointerdown', 'pointerup'].forEach((evt) => {
        btn.addEventListener(evt, stop, true);
      });

      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (playbackSession.video && this.currentTarget !== null) {
          playbackSession.video.currentTime = this.currentTarget;
          this.hide();
        }
      });

      this.button = btn;
    }

    show(typeLabel, targetTime) {
      this.ensure();
      this.currentTarget = targetTime;

      const container = getActivePlayerContainer(playbackSession.video);
      if (container && this.button.parentElement !== container) {
        container.style.position = container.style.position || 'relative';
        container.appendChild(this.button);
      }

      const label = this.button.querySelector('.aon-skip-label');
      if (label) label.textContent = `Пропустить ${typeLabel.toLowerCase()}`;

      this.button.classList.add('aon-visible');
    }

    hide() {
      if (this.button) {
        this.button.classList.remove('aon-visible');
        this.currentTarget = null;
      }
    }
  }

  // =========================================================================
  // 9. ВСТРОЕННЫЙ HUD / OVERLAY РЕДАКТОР РАЗМЕТКИ ТАЙМИНГОВ
  // =========================================================================
  class PlayerHudEditor {
    constructor() {
      this.triggerBtn = null;
      this.overlay = null;
      this.isOpen = false;
      this.preview = { op: null, ed: null };

      this.inputs = {
        opStart: null,
        opEnd: null,
        edStart: null,
        edEnd: null,
      };

      this.elements = {
        opDur: null,
        edDur: null,
        opError: null,
        edError: null,
        saveBtn: null,
        saveStatus: null,
        metaBadge: null
      };
    }

    ensure() {
      if (!settings.showQuickMarkBar) return;
      const container = getActivePlayerContainer(playbackSession.video);
      if (!container) return;

      container.style.position = container.style.position || 'relative';

      // 1. Создаем кнопку-триггер в верхнем углу плеера
      if (!this.triggerBtn || !this.triggerBtn.isConnected) {
        const trig = document.createElement('button');
        trig.className = 'aon-hud-trigger';
        trig.setAttribute('type', 'button');
        trig.title = 'Разметка таймингов (Alt + M)';
        trig.innerHTML = `
          <svg class="aon-hud-trigger-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="10"></circle>
            <polyline points="12 6 12 12 16 14"></polyline>
          </svg>
        `;

        this.isolateEvents(trig);
        trig.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          this.toggle();
        });

        container.appendChild(trig);
        this.triggerBtn = trig;
      } else if (this.triggerBtn.parentElement !== container) {
        container.appendChild(this.triggerBtn);
      }

      // 2. Создаем всплывающий оверлей HUD
      if (!this.overlay || !this.overlay.isConnected) {
        const hud = document.createElement('div');
        hud.className = 'aon-hud-overlay';
        hud.innerHTML = `
          <div class="aon-hud-header" id="aon-hud-drag-header">
            <div class="aon-hud-title-group">
              <span class="aon-hud-title">⏱ Разметка</span>
              <div class="aon-hud-ep-picker" title="Ручная корректировка серии">
                <button type="button" class="aon-hud-ep-arrow" id="aon-hud-ep-prev" title="Предыдущая серия">‹</button>
                <div class="aon-hud-ep-box">
                  <span class="aon-hud-ep-txt">Серия</span>
                  <input type="number" class="aon-hud-ep-num" id="aon-hud-ep-input" min="1" max="2000" value="1" title="Нажмите, чтобы ввести номер серии вручную">
                </div>
                <button type="button" class="aon-hud-ep-arrow" id="aon-hud-ep-next" title="Следующая серия">›</button>
              </div>
            </div>
            <button class="aon-hud-close" id="aon-hud-btn-close" title="Закрыть (Alt + M)">&times;</button>
          </div>

          <!-- Блок Опенинга (OP) -->
          <div class="aon-hud-section aon-hud-section-op">
            <div class="aon-hud-sec-header">
              <span class="aon-hud-sec-title">Опенинг (OP)</span>
              <span class="aon-hud-duration" id="aon-op-dur">—</span>
            </div>
            <div class="aon-hud-row">
              <span class="aon-hud-label">Начало:</span>
              <div class="aon-hud-inputs">
                <input type="text" class="aon-hud-time-input" id="aon-op-start" placeholder="00:00" spellcheck="false" maxlength="5" inputmode="numeric" autocomplete="off">
                <button type="button" class="aon-hud-btn" id="aon-btn-set-op-start" title="Засечь текущее время видео [клавиша [ ]">
                  ⏱ Текущее
                </button>
              </div>
            </div>
            <div class="aon-hud-row">
              <span class="aon-hud-label">Конец:</span>
              <div class="aon-hud-inputs">
                <input type="text" class="aon-hud-time-input" id="aon-op-end" placeholder="00:00" spellcheck="false" maxlength="5" inputmode="numeric" autocomplete="off">
                <button type="button" class="aon-hud-btn" id="aon-btn-set-op-end" title="Засечь текущее время видео [клавиша ] ]">
                  ⏱ Текущее
                </button>
              </div>
            </div>
            <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 4px;">
              <button type="button" class="aon-hud-btn aon-hud-btn-subtle" id="aon-btn-op-89" title="Отмерить стандартные 89 секунд от начала">
                ⏩ +89с
              </button>
              <button type="button" class="aon-hud-btn aon-hud-btn-subtle" id="aon-btn-clear-op">
                ✕ Сброс OP
              </button>
            </div>
            <div class="aon-hud-error-msg" id="aon-op-error"></div>
          </div>

          <!-- Блок Эндинга (ED) -->
          <div class="aon-hud-section aon-hud-section-ed">
            <div class="aon-hud-sec-header">
              <span class="aon-hud-sec-title">Эндинг (ED)</span>
              <span class="aon-hud-duration" id="aon-ed-dur">—</span>
            </div>
            <div class="aon-hud-row">
              <span class="aon-hud-label">Начало:</span>
              <div class="aon-hud-inputs">
                <input type="text" class="aon-hud-time-input" id="aon-ed-start" placeholder="00:00" spellcheck="false" maxlength="5" inputmode="numeric" autocomplete="off">
                <button type="button" class="aon-hud-btn" id="aon-btn-set-ed-start" title="Засечь текущее время видео [клавиша { ]">
                  ⏱ Текущее
                </button>
              </div>
            </div>
            <div class="aon-hud-row">
              <span class="aon-hud-label">Конец:</span>
              <div class="aon-hud-inputs">
                <input type="text" class="aon-hud-time-input" id="aon-ed-end" placeholder="00:00" spellcheck="false" maxlength="5" inputmode="numeric" autocomplete="off">
                <button type="button" class="aon-hud-btn" id="aon-btn-set-ed-end" title="Засечь текущее время видео [клавиша } ]">
                  ⏱ Текущее
                </button>
              </div>
            </div>
            <div style="display: flex; justify-content: flex-end; margin-top: 4px;">
              <button type="button" class="aon-hud-btn aon-hud-btn-subtle" id="aon-btn-clear-ed">
                ✕ Сброс ED
              </button>
            </div>
            <div class="aon-hud-error-msg" id="aon-ed-error"></div>
          </div>

          <!-- Легенда горячих клавиш -->
          <div class="aon-hud-hotkeys">
            ⌨️ Хоткеи: <kbd>[</kbd> / <kbd>]</kbd> — OP, <kbd>{</kbd> / <kbd>}</kbd> — ED, <kbd>Alt+M</kbd> — закрыть
          </div>

          <!-- Кнопка сохранения -->
          <button type="button" class="aon-hud-save-btn" id="aon-btn-save-timings">
            💾 Сохранить в Cloudflare
          </button>
          <div class="aon-hud-save-status" id="aon-save-status"></div>
        `;

        this.isolateEvents(hud);
        container.appendChild(hud);
        this.overlay = hud;

        // Связываем ссылки на DOM элементы
        this.inputs.opStart = hud.querySelector('#aon-op-start');
        this.inputs.opEnd = hud.querySelector('#aon-op-end');
        this.inputs.edStart = hud.querySelector('#aon-ed-start');
        this.inputs.edEnd = hud.querySelector('#aon-ed-end');

        this.elements.opDur = hud.querySelector('#aon-op-dur');
        this.elements.edDur = hud.querySelector('#aon-ed-dur');
        this.elements.opError = hud.querySelector('#aon-op-error');
        this.elements.edError = hud.querySelector('#aon-ed-error');
        this.elements.saveBtn = hud.querySelector('#aon-btn-save-timings');
        this.elements.saveStatus = hud.querySelector('#aon-save-status');
        this.elements.metaBadge = hud.querySelector('#aon-hud-meta');
        this.elements.epInput = hud.querySelector('#aon-hud-ep-input');
        this.elements.epPrev = hud.querySelector('#aon-hud-ep-prev');
        this.elements.epNext = hud.querySelector('#aon-hud-ep-next');

        this.attachListeners(hud, container);
        this.populateFromCurrent();
      } else {
        if (this.overlay.parentElement !== container) {
          container.appendChild(this.overlay);
        }
        const onTimingChange = () => this.updatePreview();
        [this.inputs.opStart, this.inputs.opEnd, this.inputs.edStart, this.inputs.edEnd].forEach(inp => {
          this.setupTimeInputMask(inp, onTimingChange);
        });
      }
    }

    isolateEvents(el) {
      const stop = (e) => {
        e.stopPropagation();
      };
      ['mousedown', 'mouseup', 'click', 'dblclick', 'keydown', 'keyup', 'keypress', 'pointerdown', 'pointerup', 'touchstart', 'touchend'].forEach((evt) => {
        el.addEventListener(evt, stop);
      });
    }

    attachListeners(hud, container) {
      // Закрытие
      hud.querySelector('#aon-hud-btn-close')?.addEventListener('click', () => this.hide());

      // Ручная корректировка серии (стрелки и прямой ввод)
      this.elements.epPrev?.addEventListener('click', () => {
        const cur = parseInt(this.elements.epInput?.value, 10) || pageContext.episode || 1;
        if (cur > 1) {
          playbackSession.changeEpisode(cur - 1, true);
        }
      });

      this.elements.epNext?.addEventListener('click', () => {
        const cur = parseInt(this.elements.epInput?.value, 10) || pageContext.episode || 1;
        if (cur < 2000) {
          playbackSession.changeEpisode(cur + 1, true);
        }
      });

      const commitManualEp = () => {
        if (!this.elements.epInput) return;
        const val = parseInt(this.elements.epInput.value, 10);
        if (!isNaN(val) && val >= 1 && val <= 2000) {
          playbackSession.changeEpisode(val, true);
        } else {
          this.elements.epInput.value = pageContext.episode || 1;
        }
      };

      this.elements.epInput?.addEventListener('change', commitManualEp);
      this.elements.epInput?.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') {
          e.preventDefault();
          commitManualEp();
          this.elements.epInput.blur();
        }
      });

      // Установка текущего времени по кнопкам
      hud.querySelector('#aon-btn-set-op-start')?.addEventListener('click', () => {
        if (playbackSession.video) this.markOpStart(playbackSession.video.currentTime);
      });
      hud.querySelector('#aon-btn-set-op-end')?.addEventListener('click', () => {
        if (playbackSession.video) this.markOpEnd(playbackSession.video.currentTime);
      });
      hud.querySelector('#aon-btn-set-ed-start')?.addEventListener('click', () => {
        if (playbackSession.video) this.markEdStart(playbackSession.video.currentTime);
      });
      hud.querySelector('#aon-btn-set-ed-end')?.addEventListener('click', () => {
        if (playbackSession.video) this.markEdEnd(playbackSession.video.currentTime);
      });

      // Быстрое +89с для OP
      hud.querySelector('#aon-btn-op-89')?.addEventListener('click', () => {
        if (playbackSession.video) this.quickOp89();
      });

      // Сброс
      hud.querySelector('#aon-btn-clear-op')?.addEventListener('click', () => this.clearOp());
      hud.querySelector('#aon-btn-clear-ed')?.addEventListener('click', () => this.clearEd());

      // Строгая маска ввода времени (MM:SS) на лету для всех полей
      const onTimingChange = () => this.updatePreview();
      [this.inputs.opStart, this.inputs.opEnd, this.inputs.edStart, this.inputs.edEnd].forEach(inp => {
        this.setupTimeInputMask(inp, onTimingChange);
      });

      // Сохранение
      this.elements.saveBtn?.addEventListener('click', () => this.saveTimings());

      // Поддержка перетаскивания за шапку (Draggable)
      this.makeDraggable(hud.querySelector('#aon-hud-drag-header'), hud, container);
    }

    makeDraggable(handle, target, container) {
      if (!handle || !target || !container) return;

      let isDragging = false;
      let startX = 0, startY = 0;
      let initialLeft = 0, initialTop = 0;

      const onMouseDown = (e) => {
        if (e.target.closest('button')) return;
        isDragging = true;
        startX = e.clientX;
        startY = e.clientY;

        const rect = target.getBoundingClientRect();
        const contRect = container.getBoundingClientRect();

        initialLeft = rect.left - contRect.left;
        initialTop = rect.top - contRect.top;

        target.style.right = 'auto';
        target.style.left = `${initialLeft}px`;
        target.style.top = `${initialTop}px`;
        handle.style.cursor = 'grabbing';

        document.addEventListener('mousemove', onMouseMove, true);
        document.addEventListener('mouseup', onMouseUp, true);
      };

      const onMouseMove = (e) => {
        if (!isDragging) return;
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;

        const contRect = container.getBoundingClientRect();
        const targetRect = target.getBoundingClientRect();

        let newLeft = Math.max(8, Math.min(contRect.width - targetRect.width - 8, initialLeft + dx));
        let newTop = Math.max(8, Math.min(contRect.height - targetRect.height - 8, initialTop + dy));

        target.style.left = `${newLeft}px`;
        target.style.top = `${newTop}px`;
      };

      const onMouseUp = () => {
        isDragging = false;
        handle.style.cursor = 'grab';
        document.removeEventListener('mousemove', onMouseMove, true);
        document.removeEventListener('mouseup', onMouseUp, true);
      };

      handle.addEventListener('mousedown', onMouseDown);
    }

    show() {
      this.ensure();
      if (this.overlay) {
        this.overlay.classList.add('aon-hud-visible');
        this.isOpen = true;
        this.populateFromCurrent();
        this.updateMeta();
      }
      if (this.triggerBtn) {
        this.triggerBtn.classList.add('aon-active');
      }
    }

    hide() {
      if (this.overlay) {
        this.overlay.classList.remove('aon-hud-visible');
        this.isOpen = false;
      }
      if (this.triggerBtn) {
        this.triggerBtn.classList.remove('aon-active');
      }
      // Очищаем предпросмотр на таймлайне при закрытии без сохранения
      this.preview = { op: null, ed: null };
      playbackSession.recalculateAndRender();
    }

    toggle() {
      if (this.isOpen) this.hide();
      else this.show();
    }

    resetPosition() {
      if (this.overlay) {
        this.overlay.style.left = 'auto';
        this.overlay.style.right = '12px';
        this.overlay.style.top = '46px';
      }
    }

    updateMeta() {
      if (this.elements.epInput) {
        this.elements.epInput.value = pageContext.episode || 1;
      }
      if (this.elements.metaBadge) {
        this.elements.metaBadge.textContent = `Серия ${pageContext.episode || 1}`;
      }
    }

    populateFromCurrent() {
      const res = playbackSession.intervals.resolved;
      if (this.inputs.opStart && res.op) {
        this.inputs.opStart.value = formatTime(res.op.start);
        this.inputs.opEnd.value = formatTime(res.op.end);
      }
      if (this.inputs.edStart && res.ed) {
        this.inputs.edStart.value = formatTime(res.ed.start);
        this.inputs.edEnd.value = formatTime(res.ed.end);
      }
      this.updatePreview();
    }

    setupTimeInputMask(input, onChange) {
      if (!input || input.dataset.aonMasked === '1') return;
      input.dataset.aonMasked = '1';

      input.maxLength = 5;
      input.setAttribute('inputmode', 'numeric');
      input.setAttribute('autocomplete', 'off');

      let isDeleting = false;

      input.addEventListener('keydown', (e) => {
        isDeleting = (e.key === 'Backspace' || e.key === 'Delete');

        const isControl = [
          'Backspace', 'Delete', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown',
          'Tab', 'Home', 'End', 'Enter', 'Escape'
        ].includes(e.key) || e.ctrlKey || e.metaKey || e.altKey;

        // Если пользователь нажал ':'
        if (e.key === ':') {
          e.preventDefault();
          const digits = input.value.replace(/\D/g, '');
          if (digits.length === 1) {
            input.value = `0${digits}:`;
            input.selectionStart = input.selectionEnd = 3;
            onChange();
          } else if (digits.length >= 2) {
            if (!input.value.includes(':')) {
              input.value = `${digits.slice(0, 2)}:${digits.slice(2)}`;
            }
            input.selectionStart = input.selectionEnd = 3;
            onChange();
          }
          return;
        }

        // Блокируем любые нецифровые символы (буквы, знаки препинания и мусор)
        if (!isControl && !/^\d$/.test(e.key)) {
          e.preventDefault();
          return;
        }

        // Жесткий лимит: максимум 4 цифры
        if (/^\d$/.test(e.key)) {
          const digits = input.value.replace(/\D/g, '');
          const hasSelection = input.selectionStart !== input.selectionEnd;
          if (digits.length >= 4 && !hasSelection) {
            e.preventDefault();
            return;
          }
        }

        // Плавный Backspace через двоеточие: если курсор на позиции 3 ("05:|"), стираем 2-ю цифру
        if (e.key === 'Backspace' && input.selectionStart === input.selectionEnd) {
          if (input.selectionStart === 3 && input.value[2] === ':') {
            e.preventDefault();
            const val = input.value;
            input.value = val.slice(0, 1);
            input.selectionStart = input.selectionEnd = 1;
            onChange();
            return;
          }
        }
      });

      // Обработка вставки из буфера (например 1234 или 12:34)
      input.addEventListener('paste', (e) => {
        e.preventDefault();
        const pasted = (e.clipboardData || window.clipboardData)?.getData('text') || '';
        const digits = pasted.replace(/\D/g, '').slice(0, 4);
        if (!digits) return;
        let formatted = '';
        if (digits.length <= 2) {
          formatted = `${digits}:00`;
        } else {
          const mins = digits.slice(0, 2);
          let secs = digits.slice(2);
          if (parseInt(secs, 10) > 59) secs = '59';
          if (secs.length === 1) secs = `0${secs}`;
          formatted = `${mins}:${secs}`;
        }
        input.value = formatted;
        input.selectionStart = input.selectionEnd = formatted.length;
        onChange();
      });

      input.addEventListener('input', (e) => {
        const isDelete = (e && e.inputType && e.inputType.startsWith('delete')) || isDeleting;
        isDeleting = false;

        const raw = input.value;
        const prevPos = input.selectionStart;
        const wasAtEnd = prevPos === null || prevPos >= raw.length;

        const digits = raw.replace(/\D/g, '').slice(0, 4);

        if (isDelete && digits.length <= 2) {
          input.value = digits;
          input.selectionStart = input.selectionEnd = digits.length;
          onChange();
          return;
        }

        let formatted = '';
        if (digits.length === 0) {
          formatted = '';
        } else if (digits.length < 2) {
          formatted = digits;
        } else if (digits.length === 2) {
          formatted = isDelete ? digits : `${digits}:`;
        } else {
          const mins = digits.slice(0, 2);
          let secs = digits.slice(2);
          // Секунды не могут быть больше 59
          if (secs.length === 2 && parseInt(secs, 10) > 59) {
            secs = '59';
          }
          formatted = `${mins}:${secs}`;
        }

        input.value = formatted;

        if (wasAtEnd) {
          input.selectionStart = input.selectionEnd = formatted.length;
        } else {
          const digitsBefore = raw.slice(0, prevPos).replace(/\D/g, '').length;
          let newPos = formatted.length;
          let count = 0;
          for (let i = 0; i < formatted.length; i++) {
            if (/\d/.test(formatted[i])) {
              count++;
              if (count === digitsBefore) {
                newPos = (i + 1 < formatted.length && formatted[i + 1] === ':') ? i + 2 : i + 1;
                break;
              }
            }
          }
          input.selectionStart = input.selectionEnd = newPos;
        }

        onChange();
      });

      input.addEventListener('blur', () => {
        const val = input.value.trim();
        if (!val) return;
        const digits = val.replace(/\D/g, '').slice(0, 4);
        if (!digits) {
          input.value = '';
          onChange();
          return;
        }
        let normalized = '';
        if (digits.length === 1) normalized = `0${digits}:00`;
        else if (digits.length === 2) normalized = `${digits}:00`;
        else if (digits.length === 3) {
          let s = digits[2];
          if (parseInt(s, 10) > 5) s = '5';
          normalized = `${digits.slice(0, 2)}:0${s}`;
        } else {
          let mins = digits.slice(0, 2);
          let secs = digits.slice(2);
          if (parseInt(secs, 10) > 59) secs = '59';
          normalized = `${mins}:${secs}`;
        }
        if (normalized !== input.value) {
          input.value = normalized;
          onChange();
        }
      });
    }

    parseInput(str) {
      if (typeof str === 'number') return Math.max(0, Math.floor(str));
      if (!str || typeof str !== 'string') return null;
      const s = str.trim();
      if (!s) return null;

      // Строгий парсинг MM:SS или M:SS
      if (s.includes(':')) {
        const parts = s.split(':');
        const m = parseInt(parts[0], 10);
        const sec = parseInt(parts[1], 10);
        if (!isNaN(m) && !isNaN(sec) && sec >= 0 && sec <= 59) {
          return m * 60 + sec;
        }
      }
      return null;
    }

    getValues() {
      return {
        opStart: this.parseInput(this.inputs.opStart?.value),
        opEnd: this.parseInput(this.inputs.opEnd?.value),
        edStart: this.parseInput(this.inputs.edStart?.value),
        edEnd: this.parseInput(this.inputs.edEnd?.value),
      };
    }

    validate() {
      const vals = this.getValues();
      const video = playbackSession.video;
      const duration = (video && video.duration > 0) ? video.duration : 99999;

      let opValid = false;
      let opHasError = false;
      let edValid = false;
      let edHasError = false;

      const opStartStr = this.inputs.opStart?.value.trim() || '';
      const opEndStr = this.inputs.opEnd?.value.trim() || '';
      const edStartStr = this.inputs.edStart?.value.trim() || '';
      const edEndStr = this.inputs.edEnd?.value.trim() || '';

      // 1. Проверка Опенинга
      if (opStartStr || opEndStr) {
        const startComplete = /^\d{2}:\d{2}$/.test(opStartStr);
        const endComplete = /^\d{2}:\d{2}$/.test(opEndStr);

        if (opStartStr && !startComplete) {
          this.showError('op', 'Введите время начала в формате ММ:СС (например, 01:20)', this.inputs.opStart);
          opHasError = true;
        } else if (opEndStr && !endComplete) {
          this.showError('op', 'Введите время окончания в формате ММ:СС (например, 02:50)', this.inputs.opEnd);
          opHasError = true;
        } else if (vals.opStart !== null && vals.opEnd !== null) {
          if (vals.opStart >= vals.opEnd) {
            this.showError('op', 'Конец должен быть больше начала', this.inputs.opEnd);
            opHasError = true;
          } else if (vals.opEnd > duration) {
            this.showError('op', 'Выходит за пределы длительности видео', this.inputs.opEnd);
            opHasError = true;
          } else {
            this.clearError('op');
            const dur = vals.opEnd - vals.opStart;
            if (this.elements.opDur) this.elements.opDur.textContent = `${dur} сек`;
            opValid = true;
          }
        } else if (vals.opStart !== null || vals.opEnd !== null) {
          this.clearError('op');
          if (this.elements.opDur) this.elements.opDur.textContent = 'неполный';
        }
      } else {
        this.clearError('op');
        if (this.elements.opDur) this.elements.opDur.textContent = '—';
      }

      // 2. Проверка Эндинга
      if (edStartStr || edEndStr) {
        const startComplete = /^\d{2}:\d{2}$/.test(edStartStr);
        const endComplete = /^\d{2}:\d{2}$/.test(edEndStr);

        if (edStartStr && !startComplete) {
          this.showError('ed', 'Введите время начала в формате ММ:СС (например, 22:05)', this.inputs.edStart);
          edHasError = true;
        } else if (edEndStr && !endComplete) {
          this.showError('ed', 'Введите время окончания в формате ММ:СС (например, 23:35)', this.inputs.edEnd);
          edHasError = true;
        } else if (vals.edStart !== null && vals.edEnd !== null) {
          if (vals.edStart >= vals.edEnd) {
            this.showError('ed', 'Конец должен быть больше начала', this.inputs.edEnd);
            edHasError = true;
          } else if (vals.edEnd > duration) {
            this.showError('ed', 'Выходит за пределы длительности видео', this.inputs.edEnd);
            edHasError = true;
          } else {
            this.clearError('ed');
            const dur = vals.edEnd - vals.edStart;
            if (this.elements.edDur) this.elements.edDur.textContent = `${dur} сек`;
            edValid = true;
          }
        } else if (vals.edStart !== null || vals.edEnd !== null) {
          this.clearError('ed');
          if (this.elements.edDur) this.elements.edDur.textContent = 'неполный';
        }
      } else {
        this.clearError('ed');
        if (this.elements.edDur) this.elements.edDur.textContent = '—';
      }

      const canSave = (opValid || edValid) && !opHasError && !edHasError;
      if (this.elements.saveBtn) {
        this.elements.saveBtn.disabled = !canSave;
      }

      return {
        op: opValid ? [vals.opStart, vals.opEnd] : null,
        ed: edValid ? [vals.edStart, vals.edEnd] : null,
        canSave
      };
    }

    showError(type, msg, targetInput = null) {
      const el = type === 'op' ? this.elements.opError : this.elements.edError;
      const inputTarget = targetInput || (type === 'op' ? this.inputs.opEnd : this.inputs.edEnd);
      if (el) {
        el.textContent = `⚠️ ${msg}`;
        el.classList.add('aon-active');
      }
      if (inputTarget) inputTarget.classList.add('aon-input-error');
    }

    clearError(type) {
      const el = type === 'op' ? this.elements.opError : this.elements.edError;
      if (el) el.classList.remove('aon-active');
      if (type === 'op') {
        this.inputs.opStart?.classList.remove('aon-input-error');
        this.inputs.opEnd?.classList.remove('aon-input-error');
      } else {
        this.inputs.edStart?.classList.remove('aon-input-error');
        this.inputs.edEnd?.classList.remove('aon-input-error');
      }
    }

    updatePreview() {
      const validated = this.validate();
      this.preview = {
        op: validated.op,
        ed: validated.ed
      };

      // Перерисовываем маркеры на таймлайне с пометкой предпросмотра
      playbackSession.recalculateAndRender(this.preview);
    }

    getPreviewIntervals() {
      return (this.isOpen && (this.preview.op || this.preview.ed)) ? this.preview : null;
    }

    // Хоткеи и кнопки «Поставить текущее»
    markOpStart(time) {
      this.show();
      const sec = Math.max(0, Math.floor(time));
      if (this.inputs.opStart) this.inputs.opStart.value = formatTime(sec);
      this.updatePreview();
      toast.show(`⏱ Опенинг: начало зафиксировано на ${formatTime(sec)}`);
    }

    markOpEnd(time) {
      this.show();
      const sec = Math.max(0, Math.floor(time));
      if (this.inputs.opEnd) this.inputs.opEnd.value = formatTime(sec);
      this.updatePreview();
      toast.show(`⏱ Опенинг: конец зафиксирован на ${formatTime(sec)}`);
    }

    markEdStart(time) {
      this.show();
      const sec = Math.max(0, Math.floor(time));
      if (this.inputs.edStart) this.inputs.edStart.value = formatTime(sec);
      this.updatePreview();
      toast.show(`⏱ Эндинг: начало зафиксировано на ${formatTime(sec)}`);
    }

    markEdEnd(time) {
      this.show();
      const sec = Math.max(0, Math.floor(time));
      if (this.inputs.edEnd) this.inputs.edEnd.value = formatTime(sec);
      this.updatePreview();
      toast.show(`⏱ Эндинг: конец зафиксирован на ${formatTime(sec)}`);
    }

    quickOp89() {
      const video = playbackSession.video;
      if (!video) return;
      const start = this.parseInput(this.inputs.opStart?.value) ?? Math.floor(video.currentTime);
      const end = start + 89;

      if (this.inputs.opStart) this.inputs.opStart.value = formatTime(start);
      if (this.inputs.opEnd) this.inputs.opEnd.value = formatTime(end);

      this.updatePreview();
      toast.show(`⏩ Опенинг: задано 89 сек (${formatTime(start)} — ${formatTime(end)})`);
    }

    clearOp() {
      if (this.inputs.opStart) this.inputs.opStart.value = '';
      if (this.inputs.opEnd) this.inputs.opEnd.value = '';
      this.clearError('op');
      this.updatePreview();
    }

    clearEd() {
      if (this.inputs.edStart) this.inputs.edStart.value = '';
      if (this.inputs.edEnd) this.inputs.edEnd.value = '';
      this.clearError('ed');
      this.updatePreview();
    }

    // Сохранение в Cloudflare Worker
    async saveTimings() {
      const validated = this.validate();
      if (!validated.canSave) return;

      if (!pageContext.malId) pageContext.extract();
      if (!pageContext.malId) {
        toast.show('⚠️ Не удалось определить ID аниме');
        return;
      }

      const saveBtn = this.elements.saveBtn;
      const statusEl = this.elements.saveStatus;

      saveBtn.disabled = true;
      saveBtn.innerHTML = `⏳ Сохранение в базу…`;
      if (statusEl) statusEl.textContent = 'Отправка в Cloudflare Worker…';

      const op = validated.op;
      const ed = validated.ed;

      try {
        // Обновляем локальный стор интервалов
        playbackSession.intervals.setExternal(op, ed, 'custom');

        // Отправка в фоновый скрипт (сохранение в chrome.storage.local + Cloudflare Worker API)
        chrome.runtime.sendMessage(
          {
            type: 'SAVE_CUSTOM_SKIP',
            malId: pageContext.malId,
            episode: pageContext.episode,
            op,
            ed,
            title: pageContext.title,
            season: pageContext.season || 1,
            totalEpisodes: pageContext.totalEpisodes || null
          },
          (res) => {
            saveBtn.disabled = false;
            saveBtn.innerHTML = `💾 Сохранить в Cloudflare`;

            if (res && res.needAuth) {
              toast.show('🔒 Для отправки меток войдите в аккаунт в расширении');
              if (statusEl) {
                statusEl.innerHTML = '<span style="color: #f59e0b;">🔒 Требуется вход. Откройте значок расширения в браузере.</span>';
              }
              return;
            }

            if (res && res.success) {
              this.preview = { op: null, ed: null };
              playbackSession.recalculateAndRender();

              const cf = res.cloudflare?.json;
              if (cf?.instant) {
                toast.show('⚡ Метка опубликована в официальную базу!');
                if (statusEl) {
                  statusEl.innerHTML = '<span style="color: #38bdf8;">⚡ Опубликовано мгновенно (Редактор)</span>';
                }
              } else if (cf?.consensusReached) {
                toast.show('🎉 Консенсус достигнут! Метка утверждена!');
                if (statusEl) {
                  statusEl.innerHTML = '<span style="color: #10b981;">🎉 Консенсус достигнут (3/3)!</span>';
                }
              } else if (cf?.queued) {
                toast.show(`⏳ Метка отправлена на проверку (${cf.votes}/3)`);
                if (statusEl) {
                  statusEl.innerHTML = `<span style="color: #c4b5fd;">⏳ Голос учтен! На проверке: ${cf.votes}/3 голосов</span>`;
                }
              } else {
                toast.show('✅ Тайминги успешно сохранены!');
                if (statusEl) {
                  statusEl.innerHTML = '<span style="color: #10b981;">✅ Успешно сохранено!</span>';
                }
              }
              setTimeout(() => { if (statusEl) statusEl.textContent = ''; }, 4500);
            } else {
              const errMsg = res?.error || 'Сервер недоступен';
              toast.show('❌ ' + errMsg);
              if (statusEl) {
                statusEl.innerHTML = `<span style="color: #ef4444;">❌ ${errMsg}</span>`;
              }
            }
          }
        );
      } catch (e) {
        saveBtn.disabled = false;
        saveBtn.innerHTML = `💾 Сохранить в Cloudflare`;
        if (statusEl) statusEl.textContent = 'Ошибка: ' + e.message;
      }
    }
  }

  const toast = {
    timer: null,
    show(text) {
      const container = getActivePlayerContainer(playbackSession.video);
      let el = container.querySelector('.aon-toast') || document.querySelector('.aon-toast');
      if (!el) {
        el = document.createElement('div');
        el.className = 'aon-toast';
        container.appendChild(el);
      } else if (el.parentElement !== container) {
        container.appendChild(el);
      }

      el.textContent = text;
      el.classList.add('aon-toast-visible');

      clearTimeout(this.timer);
      this.timer = setTimeout(() => {
        el.classList.remove('aon-toast-visible');
      }, 2500);
    }
  };

  function formatTime(seconds) {
    if (seconds === undefined || seconds === null || isNaN(seconds)) return '00:00';
    const total = Math.max(0, Math.floor(seconds));
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${m < 10 ? '0' : ''}${m}:${s < 10 ? '0' : ''}${s}`;
  }

  // =========================================================================
  // 10. СЕССИЯ ВОСПРОИЗВЕДЕНИЯ И УПРАВЛЕНИЕ (Playback Session Coordinator)
  // =========================================================================
  class PlaybackSession {
    constructor() {
      this.video = null;
      this.intervals = new IntervalStore();
      this.renderer = new TimelineRenderer();
      this.controller = new PlaybackController();
      this.currentEpisodeKey = null;
      this.loadRequestId = 0;
    }

    attachVideo(video) {
      this.video = video;
      this.controller.attach(video);
      if (!pageContext.isManualEpisode) {
        const detected = pageContext.detectActiveEpisode();
        if (detected && detected !== pageContext.episode) {
          pageContext.episode = detected;
        }
      }
      this.loadTimings();
      this.reportSession();
    }

    detachVideo() {
      this.controller.detach();
      this.renderer.cleanup();
      this.video = null;
    }

    changeEpisode(newEp, isManual = false) {
      if (isManual) {
        pageContext.isManualEpisode = true;
        pageContext.manualEpisode = newEp;
      }
      if (pageContext.episode === newEp && this.currentEpisodeKey === `${pageContext.malId}:${newEp}`) {
        if (isManual) {
          toast.show(`📺 Серия ${newEp} (ручная фиксация)`);
        }
        return;
      }
      console.log(`[AnimeOn Skipper] Переключение на серию ${newEp}${isManual ? ' (вручную)' : ''}`);
      pageContext.episode = newEp;
      if (isManual) {
        pageContext.isManualEpisode = true;
        pageContext.manualEpisode = newEp;
      }
      if (pageContext.malId) {
        try {
          sessionStorage.setItem(`aon_ep_${pageContext.malId}`, newEp);
        } catch (e) {}
      }

      // Аннулируем все предыдущие незавершенные сетевые запросы
      this.loadRequestId++;
      this.currentEpisodeKey = `${pageContext.malId}:${newEp}`;

      // МГНОВЕННО очищаем таймлайн и стор интервалов от предыдущей серии!
      this.intervals.reset();
      this.recalculateAndRender();
      this.controller.resetSkipFlags();

      if (hudEditor) {
        hudEditor.updateMeta();
        hudEditor.clearOp();
        hudEditor.clearEd();
      }

      toast.show(isManual ? `📺 Серия ${newEp} (ручная коррекция)` : `📺 Серия ${newEp}`);
      this.loadTimings();
      this.reportSession();
    }

    reportSession() {
      if (pageContext.malId) {
        chrome.runtime.sendMessage({
          type: 'REGISTER_TAB_ANIME',
          malId: pageContext.malId,
          episode: pageContext.episode,
          title: pageContext.title,
          hasVideo: !!this.video
        });
      }
    }

    loadTimings() {
      if (!pageContext.malId) pageContext.extract();
      if (!pageContext.malId) return;

      const targetMalId = pageContext.malId;
      const targetEp = pageContext.episode;
      const key = `${targetMalId}:${targetEp}`;
      this.currentEpisodeKey = key;
      const requestId = ++this.loadRequestId;

      // 1. Приоритет 1: Опрашиваем облачную базу Cloudflare Worker
      chrome.runtime.sendMessage(
        {
          type: 'FETCH_TIMINGS',
          malId: targetMalId,
          episode: targetEp
        },
        (response) => {
          // Если за время сетевого запроса серия переключилась — полностью игнорируем старый ответ
          if (requestId !== this.loadRequestId || this.currentEpisodeKey !== key) {
            return;
          }

          if (!chrome.runtime.lastError && response && response.success && response.found && (response.op || response.ed)) {
            this.intervals.setExternal(response.op, response.ed, 'cloudflare');
            toast.show('☁️ Таймкоды загружены из базы Cloudflare');
            console.log(`[AnimeOn Skipper] Загружены таймкоды из Cloudflare [${key}]`);
            this.recalculateAndRender();
            if (hudEditor) hudEditor.populateFromCurrent();
            return;
          }

          // 2. Приоритет 2: Если в Cloudflare пусто, проверяем локальный кэш пользователя
          chrome.storage.local.get(['customSkips'], (res) => {
            if (requestId !== this.loadRequestId || this.currentEpisodeKey !== key) {
              return;
            }

            const custom = res.customSkips?.[key];
            if (custom && (custom.op || custom.ed)) {
              this.intervals.setExternal(custom.op, custom.ed, 'custom');
              console.log(`[AnimeOn Skipper] Загружены пользовательские таймкоды [${key}]`);
            } else {
              this.intervals.reset();
            }
            this.recalculateAndRender();
            if (hudEditor) hudEditor.populateFromCurrent();
          });
        }
      );
    }

    recalculateAndRender(preview = null) {
      const duration = (this.video && !isNaN(this.video.duration) && this.video.duration > 0)
        ? this.video.duration
        : 1420;

      const container = getActivePlayerContainer(this.video);
      const els = this.renderer.findScrubberAndTrack(container);
      const track = els ? els.track : null;

      const resolved = this.intervals.resolve();
      this.renderer.render(container, duration, resolved, preview);
    }
  }

  // =========================================================================
  // 11. ИНИЦИАЛИЗАЦИЯ И УПРАВЛЕНИЕ ЖИЗНЕННЫМ ЦИКЛОМ (Entry Point)
  // =========================================================================
  const playbackSession = new PlaybackSession();
  const nativeSync = new NativeDOMSync();
  const floatingButton = new FloatingSkipButton();
  const hudEditor = new PlayerHudEditor();

  // Отслеживание появления тега <video> в DOM
  function initVideoLifecycle() {
    const findVideo = () => document.querySelector('video.player-video') || document.querySelector('video');

    let detachTimer = null;
    const check = () => {
      const v = findVideo();
      if (v) {
        if (detachTimer) {
          clearTimeout(detachTimer);
          detachTimer = null;
        }
        if (v !== playbackSession.video) {
          playbackSession.attachVideo(v);
          hudEditor.ensure();
        }
      } else if (playbackSession.video && !detachTimer) {
        detachTimer = setTimeout(() => {
          if (!findVideo()) {
            playbackSession.detachVideo();
          }
          detachTimer = null;
        }, 1500);
      }
    };

    check();

    const videoObserver = new MutationObserver(() => check());
    videoObserver.observe(document.documentElement, {
      childList: true,
      subtree: true
    });
  }

  // Полноэкранный режим
  function handleFullscreen() {
    playbackSession.recalculateAndRender();
    if (hudEditor) {
      hudEditor.ensure();
      hudEditor.resetPosition();
    }
    setTimeout(() => {
      playbackSession.recalculateAndRender();
      if (hudEditor) {
        hudEditor.ensure();
        hudEditor.resetPosition();
      }
    }, 150);
  }
  document.addEventListener('fullscreenchange', handleFullscreen);
  document.addEventListener('webkitfullscreenchange', handleFullscreen);
  document.addEventListener('mozfullscreenchange', handleFullscreen);

  // Периодическая проверка смены серии и поддержание HUD в контейнере
  setInterval(() => {
    if (pageContext.isManualEpisode) {
      playbackSession.recalculateAndRender();
      if (hudEditor && playbackSession.video) {
        hudEditor.ensure();
      }
      return;
    }
    const ep = pageContext.detectActiveEpisode();
    if (ep && ep !== pageContext.episode) {
      playbackSession.changeEpisode(ep, false);
    } else {
      playbackSession.recalculateAndRender();
    }
    if (hudEditor && playbackSession.video) {
      hudEditor.ensure();
    }
  }, 2000);

  // Слушатель кликов по переключателям серий
  document.addEventListener('click', (e) => {
    const el = e.target.closest('button, a, [role="button"], [role="tab"], div[class*="cursor-pointer"]');
    if (!el) return;

    let ep = null;
    if (el.hasAttribute('data-episode')) {
      ep = parseInt(el.getAttribute('data-episode'), 10);
    } else if (el.getAttribute('aria-label')) {
      const m = el.getAttribute('aria-label').match(/(\d+)\s*(?:сери|эпизод)/i) ||
                el.getAttribute('aria-label').match(/(?:сери|эпизод)\s*(\d+)/i) ||
                el.getAttribute('aria-label').match(/\d+/);
      if (m) ep = parseInt(m[1] || m[0], 10);
    }

    if (!ep || isNaN(ep)) {
      const txt = (el.textContent || '').trim();
      const match = txt.match(/^(\d{1,4})$/) ||
                    txt.match(/^(\d{1,4})\s*(?:серия|эпизод|выпуск)$/i) ||
                    txt.match(/^(?:серия|эпизод)\s*(\d{1,4})$/i);
      if (match && txt.length <= 15) {
        const num = parseInt(match[1], 10);
        if (num >= 1 && num <= 2000) {
          // Проверяем, что элемент находится в списке серий (есть соседи с числами)
          const parent = el.parentElement;
          const container = parent?.parentElement || parent;
          if (container) {
            const siblings = container.querySelectorAll('button, a, [role="button"], [role="tab"]');
            let isEpisodeList = false;
            for (const sib of siblings) {
              if (sib !== el) {
                const sTxt = (sib.textContent || '').trim();
                const sMatch = sTxt.match(/^(\d{1,4})$/) ||
                               sTxt.match(/^(\d{1,4})\s*(?:серия|эпизод|выпуск)$/i) ||
                               sTxt.match(/^(?:серия|эпизод)\s*(\d{1,4})$/i);
                if (sMatch) {
                  const sNum = parseInt(sMatch[1], 10);
                  if (!isNaN(sNum) && Math.abs(sNum - num) <= 2) {
                    isEpisodeList = true;
                    break;
                  }
                }
              }
            }
            if (isEpisodeList || siblings.length >= 2) {
              ep = num;
            }
          }
        }
      }
    }

    if (ep && ep > 0 && ep <= 2000 && ep !== pageContext.episode) {
      console.log(`[AnimeOn Skipper] Переключение на серию ${ep} по клику пользователя`);
      pageContext.isManualEpisode = false;
      pageContext.manualEpisode = null;
      playbackSession.changeEpisode(ep, false);
    }
  }, true);

  // Обработка сообщений от всплывающего окна (popup.js)
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'QUERY_PAGE_STATUS') {
      if (!pageContext.isManualEpisode) {
        const ep = pageContext.detectActiveEpisode();
        if (ep) pageContext.episode = ep;
      }

      const res = playbackSession.intervals.resolved;
      const source = res.op?.source || res.ed?.source || null;

      sendResponse({
        malId: pageContext.malId,
        episode: pageContext.episode,
        title: pageContext.title,
        skipData: {
          op: res.op ? [res.op.start, res.op.end] : null,
          ed: res.ed ? [res.ed.start, res.ed.end] : null,
          source: source
        },
        hasVideo: !!playbackSession.video
      });
      return false;
    }

    if (msg.type === 'SET_MANUAL_EPISODE') {
      if (msg.episode && msg.episode > 0) {
        playbackSession.changeEpisode(msg.episode, true);
        sendResponse({ success: true, episode: pageContext.episode });
      }
      return false;
    }

    if (msg.type === 'REFRESH_TIMINGS') {
      playbackSession.intervals.reset();
      playbackSession.recalculateAndRender();
      playbackSession.loadTimings();
      sendResponse({ success: true });
      return false;
    }
  });

  // =========================================================================
  // 12. ГОРЯЧИЕ КЛАВИШИ УПРАВЛЕНИЯ И БЫСТРОЙ РАЗМЕТКИ
  // =========================================================================
  window.addEventListener('keydown', (e) => {
    // Игнорируем нажатия, если фокус находится в текстовом поле
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || document.activeElement?.isContentEditable) {
      return;
    }

    // Alt + M или Ctrl + Shift + M -> Открытие / закрытие HUD редактора
    if (
      (e.altKey && (e.key === 'm' || e.key === 'M' || e.key === 'ь' || e.key === 'Ь')) ||
      (e.ctrlKey && e.shiftKey && (e.key === 'm' || e.key === 'M' || e.key === 'ь' || e.key === 'Ь'))
    ) {
      e.preventDefault();
      e.stopPropagation();
      hudEditor.toggle();
      return;
    }

    const v = playbackSession.video;
    if (!v) return;

    // [ или русская х -> Засечь Start для OP
    if (e.key === '[' || e.key === 'х') {
      e.preventDefault();
      e.stopPropagation();
      hudEditor.markOpStart(v.currentTime);
      return;
    }

    // ] или русская ъ -> Засечь End для OP
    if (e.key === ']' || e.key === 'ъ') {
      e.preventDefault();
      e.stopPropagation();
      hudEditor.markOpEnd(v.currentTime);
      return;
    }

    // { (Shift + [) или русская Х -> Засечь Start для ED
    if (e.key === '{' || e.key === 'Х') {
      e.preventDefault();
      e.stopPropagation();
      hudEditor.markEdStart(v.currentTime);
      return;
    }

    // } (Shift + ]) или русская Ъ -> Засечь End для ED
    if (e.key === '}' || e.key === 'Ъ') {
      e.preventDefault();
      e.stopPropagation();
      hudEditor.markEdEnd(v.currentTime);
      return;
    }

    // S или русская Ы -> Быстрый пропуск текущей заставки до end
    if (e.key === 's' || e.key === 'S' || e.key === 'ы' || e.key === 'Ы') {
      const res = playbackSession.intervals.resolved;
      if (res.op && v.currentTime < res.op.end) {
        v.currentTime = res.op.end;
        toast.show('⏩ Опенинг пропущен (S)');
      } else if (res.ed && v.currentTime < res.ed.end) {
        v.currentTime = res.ed.end;
        toast.show('⏩ Эндинг пропущен (S)');
      } else {
        v.currentTime += 89;
        toast.show('⏩ Перемотка +89с (S)');
      }
    }
  }, true);

  // Наблюдатель за изменениями бейджа серии и кнопок в DOM в реальном времени
  function initEpisodeObserver() {
    let throttleTimer = null;
    const check = () => {
      if (pageContext.isManualEpisode) return;
      const ep = pageContext.detectActiveEpisode();
      if (ep && ep !== pageContext.episode) {
        console.log(`[AnimeOn Skipper] Наблюдатель DOM зафиксировал серию: ${ep}`);
        playbackSession.changeEpisode(ep, false);
      }
    };

    const observer = new MutationObserver(() => {
      if (throttleTimer) return;
      throttleTimer = setTimeout(() => {
        throttleTimer = null;
        check();
      }, 100);
    });

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true
    });
  }

  // Старт расширения
  initSettings().then(() => {
    pageContext.extract();
    nativeSync.init();
    initVideoLifecycle();
    initEpisodeObserver();
    console.log('[AnimeOn Skipper v2.2.0] Модуль запущен: HUD редактор и Cloudflare Sync готовы.');
  });
})();
