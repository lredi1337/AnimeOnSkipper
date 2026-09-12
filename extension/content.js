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
    totalEpisodes: null,
    isManualEpisode: false,
    manualEpisode: null,
    lastPathname: '',
    lastHref: '',

    extract(force = false) {
      const decodedPath = decodeURIComponent(window.location.pathname);
      const isPathChanged = this.lastPathname && this.lastPathname !== decodedPath;
      this.lastPathname = decodedPath;
      this.lastHref = window.location.href;

      // Если изменился путь страницы (переход на другой тайтл в SPA) — сбрасываем старый контекст
      if (isPathChanged) {
        console.log(`[AnimeOn Skipper] SPA переход на новый URL: ${decodedPath}`);
        this.isManualEpisode = false;
        this.manualEpisode = null;
        this.totalEpisodes = null;
        this.malId = null;
      }

      let detectedId = null;

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

      // Паттерн 4: Поиск внешних ссылок на странице (Shikimori, MyAnimeList)
      if (!detectedId) {
        const extLinks = document.querySelectorAll('a[href*="shikimori."], a[href*="myanimelist.net/anime/"]');
        for (const a of extLinks) {
          const href = a.getAttribute('href') || '';
          const mShiki = href.match(/shikimori\.[a-z]+\/animes\/(?:[zi])?(\d+)/i);
          if (mShiki) { detectedId = mShiki[1]; break; }
          const mMal = href.match(/myanimelist\.net\/anime\/(\d+)/i);
          if (mMal) { detectedId = mMal[1]; break; }
        }
      }

      // Паттерн 5: из Next.js данных (__NEXT_DATA__)
      if (!detectedId) {
        const nextScript = document.getElementById('__NEXT_DATA__');
        if (nextScript) {
          try {
            const nextData = JSON.parse(nextScript.textContent);
            const p = nextData?.props?.pageProps;
            const aid = p?.anime?.mal_id || p?.anime?.shikimori_id || p?.anime?.id || p?.id;
            if (aid && !isNaN(aid) && Number(aid) > 0) detectedId = String(aid);
          } catch (e) {}
        }
      }

      // Паттерн 6: из JSON-LD микроразметки
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

      if (detectedId) {
        if (this.malId !== detectedId) {
          console.log(`[AnimeOn Skipper] Обнаружен актуальный MAL ID: ${detectedId} (ранее: ${this.malId})`);
          this.malId = detectedId;
          this.isManualEpisode = false;
          this.manualEpisode = null;
        }
      } else if (isPathChanged) {
        console.warn(`[AnimeOn Skipper] Внимание: не удалось автоматически извлечь ID для пути ${decodedPath}`);
      }

      // Определение актуального названия тайтла (всегда читаем свежий заголовок из DOM)
      const titleEl = document.querySelector('h1');
      if (titleEl && titleEl.textContent.trim()) {
        this.title = titleEl.textContent.trim();
      } else {
        const og = document.querySelector('meta[property="og:title"]')?.content;
        this.title = (og || document.title).split('—')[0].split('|')[0].trim();
      }

      // Определение общего количества серий на странице AnimeOn
      let maxEp = 0;
      const allEpBtns = document.querySelectorAll('button[data-episode], [data-episode], button[aria-label*="ери" i], button[aria-label*="пизод" i]');
      allEpBtns.forEach(btn => {
        const num = parseInt(btn.getAttribute('data-episode') || (btn.getAttribute('aria-label') || '').match(/\d+/)?.[0] || btn.textContent.trim(), 10);
        if (!isNaN(num) && num > maxEp && num <= 2000) maxEp = num;
      });
      if (maxEp <= 1) {
        const pageText = document.body?.innerText || '';
        const mEp = pageText.match(/(?:всего|серий|эпизодов|серии)\s*[:—\-]?\s*(\d{1,4})/i) ||
                    pageText.match(/\b\d{1,4}\s*(?:из|\/)\s*(\d{1,4})\s*(?:серий|эп|выпусков)/i);
        if (mEp && mEp[1]) {
          const num = parseInt(mEp[1], 10);
          if (num > 0 && num <= 2000) maxEp = num;
        }
      }
      if (maxEp > 0) this.totalEpisodes = maxEp;

      if (this.isManualEpisode && this.manualEpisode) {
        this.episode = this.manualEpisode;
      } else {
        const ep = this.detectActiveEpisode();
        if (ep) this.episode = ep;
      }

      return { malId: this.malId, episode: this.episode, title: this.title, totalEpisodes: this.totalEpisodes || null };
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
        this.activeScrubber.querySelectorAll('.aon-timeline-tooltip').forEach((el) => el.remove());
        this.activeScrubber.removeAttribute('data-aon-tooltip-attached');
      }
      this.activeTrack = null;
      this.activeScrubber = null;
      this.tooltip = null;
    }

    hasNative(scrubber = null, resolved = null) {
      const scr = scrubber || this.activeScrubber || document.querySelector('[class*="group/scrubber"], [class*="scrubber"]');
      if (scr) {
        const hasNativeElements = !!scr.querySelector('div[class*="bg-purple"], div[class*="bg-violet"], div[class*="bg-blue"], div[class*="bg-sky"]');
        if (hasNativeElements) return true;
      }
      const res = resolved || (playbackSession && playbackSession.intervals ? playbackSession.intervals.resolved : null);
      const opSrc = res?.op?.source;
      const edSrc = res?.ed?.source;
      if (opSrc === 'native' || edSrc === 'native' || opSrc === 'animeon_native' || edSrc === 'animeon_native') {
        return true;
      }
      if (playbackSession && playbackSession.intervals && playbackSession.intervals.native) {
        return true;
      }
      return false;
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

      // Всегда очищаем наши наложенные маркеры
      track.querySelectorAll('.aon-timeline-marker').forEach((el) => el.remove());

      // Если у аниме есть свои нативные метки в плеере (и не запущен ручной предпросмотр в HUD):
      // ПОЛНОСТЬЮ убираем весь наш визуал (маркеры и всплывающий тултип), чтобы не дублировать нативную разметку AnimeOn
      const hasNative = this.hasNative(scrubber, resolved);
      if (hasNative && !preview) {
        scrubber.querySelectorAll('.aon-timeline-tooltip').forEach((el) => el.remove());
        if (this.tooltip) {
          this.tooltip.classList.remove('aon-tooltip-visible');
          this.tooltip.remove();
          this.tooltip = null;
        }
        return;
      }

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
      const preview = hudEditor ? hudEditor.getPreviewIntervals() : null;
      if (this.hasNative(scrubber) && !preview) {
        scrubber.querySelectorAll('.aon-timeline-tooltip').forEach((el) => el.remove());
        if (this.tooltip) {
          this.tooltip.remove();
          this.tooltip = null;
        }
        return;
      }

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

      const preview = hudEditor ? hudEditor.getPreviewIntervals() : null;
      const resolved = playbackSession.intervals.resolved;

      // Если у аниме есть нативные метки в плеере (и нет активного предпросмотра в HUD) — не показываем наш тултип!
      if (this.hasNative(scrubber, resolved) && !preview) {
        this.tooltip.classList.remove('aon-tooltip-visible');
        scrubber.querySelectorAll('.aon-timeline-tooltip').forEach((el) => el.remove());
        return;
      }

      const rect = scrubber.getBoundingClientRect();
      if (rect.width <= 0) return;

      const posX = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
      const hoverTime = (posX / rect.width) * video.duration;

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
      if (playbackSession.checkAndApplyNativeTimings()) {
        return;
      }
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
            // Не показываем нашу всплывающую кнопку, если тайминги нативные (на сайте есть своя)
            const hasNative = (playbackSession && playbackSession.renderer && playbackSession.renderer.hasNative()) ||
                              res.op.source === 'native' || res.op.source === 'animeon_native' ||
                              nativeSync.hasNativeButton('op');
            if (!hasNative) {
              floatingButton.show('Опенинг', end);
              shouldShowButton = true;
            }
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
            // Не показываем нашу всплывающую кнопку, если тайминги нативные
            const hasNative = (playbackSession && playbackSession.renderer && playbackSession.renderer.hasNative()) ||
                              res.ed.source === 'native' || res.ed.source === 'animeon_native' ||
                              nativeSync.hasNativeButton('ed');
            if (!hasNative) {
              floatingButton.show('Эндинг', end);
              shouldShowButton = true;
            }
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
        attributeFilter: ['data-state', 'aria-checked', 'style']
      });

      // Периодическая проверка появления нативных меток на шкале времени
      setInterval(() => {
        if (playbackSession && playbackSession.video) {
          const res = playbackSession.intervals.resolved;
          if (!res.op || !res.ed || (res.op.source !== 'native' && res.ed.source !== 'native')) {
            playbackSession.checkAndApplyNativeTimings();
          }
        }
      }, 1500);

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

    hasNativeButton(type) {
      try {
        const container = (playbackSession && playbackSession.video) ? getActivePlayerContainer(playbackSession.video) : document;
        const btns = (container || document).querySelectorAll('button:not(.aon-skip-btn), [role="button"]:not(.aon-skip-btn)');
        for (const b of btns) {
          if (b.offsetWidth === 0 && b.offsetHeight === 0 && !b.offsetParent) continue;

          const raw = ((b.textContent || '') + ' ' + (b.getAttribute('aria-label') || '') + ' ' + (b.getAttribute('title') || '')).toLowerCase();
          if (type === 'op') {
            if ((raw.includes('пропустить') || raw.includes('skip')) && (raw.includes('опенинг') || raw.includes('opening') || raw.includes('intro'))) {
              return true;
            }
          } else if (type === 'ed') {
            if (
              ((raw.includes('пропустить') || raw.includes('skip')) && (raw.includes('эндинг') || raw.includes('ending') || raw.includes('титр') || raw.includes('outro'))) ||
              ((raw.includes('пропустить') || raw.includes('skip')) && !raw.includes('опенинг'))
            ) {
              return true;
            }
          }
        }
      } catch (e) {}
      return false;
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
            <div style="display: flex; align-items: center; gap: 6px;">
              <button type="button" class="aon-hud-btn aon-hud-btn-subtle" id="aon-btn-crawl-header" title="Автоперенос нативных таймингов всех серий в базу Cloudflare" style="background: rgba(139, 92, 246, 0.25); border: 1px solid rgba(139, 92, 246, 0.5); color: #c4b5fd; padding: 2px 7px; font-size: 11px; font-weight: 600;">⚡ Внести всё</button>
              <button type="button" class="aon-hud-btn aon-hud-btn-subtle aon-hud-btn-aniskip" id="aon-btn-fetch-aniskip" title="Загрузить черновик таймингов из AniSkip для этой серии" style="display: none; padding: 2px 7px; font-size: 11px;">📥 AniSkip</button>
              <button class="aon-hud-close" id="aon-hud-btn-close" title="Закрыть (Alt + M)">&times;</button>
            </div>
          </div>
          <div class="aon-hud-title-display" id="aon-hud-title-display" style="font-size: 11px; color: #a78bfa; padding: 3px 14px 6px 14px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; border-bottom: 1px solid rgba(255,255,255,0.06); font-family: monospace;"></div>

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
              <div style="display: flex; gap: 6px;">
                <button type="button" class="aon-hud-btn aon-hud-btn-subtle" id="aon-btn-op-89" title="Отмерить 89 секунд от начала">
                  ⏩ +89с
                </button>
                <button type="button" class="aon-hud-btn aon-hud-btn-subtle" id="aon-btn-op-90" title="Отмерить 90 секунд от начала">
                  ⏩ +90с
                </button>
              </div>
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
            <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 4px;">
              <div style="display: flex; gap: 6px;">
                <button type="button" class="aon-hud-btn aon-hud-btn-subtle" id="aon-btn-ed-89" title="Отмерить 89 секунд от начала">
                  ⏩ +89с
                </button>
                <button type="button" class="aon-hud-btn aon-hud-btn-subtle" id="aon-btn-ed-90" title="Отмерить 90 секунд от начала">
                  ⏩ +90с
                </button>
              </div>
              <button type="button" class="aon-hud-btn aon-hud-btn-subtle" id="aon-btn-clear-ed">
                ✕ Сброс ED
              </button>
            </div>
            <div class="aon-hud-error-msg" id="aon-ed-error"></div>
          </div>

          <!-- Легенда горячих клавиш -->
          <div class="aon-hud-hotkeys">
            ⌨️ Хоткеи: <kbd>Б</kbd> / <kbd>Ю</kbd> — серия, <kbd>[</kbd> / <kbd>]</kbd> — OP, <kbd>{</kbd> / <kbd>}</kbd> — ED, <kbd>Alt+M</kbd> — закрыть
          </div>

          <!-- Кнопка автопереноса всех серий тайтла -->
          <button type="button" class="aon-hud-crawl-btn" id="aon-btn-hud-crawl-main">
            🚀 Внести все серии в базу (Автоперенос)
          </button>

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
        this.elements.btnAniSkip = hud.querySelector('#aon-btn-fetch-aniskip');
        this.elements.btnCrawlHeader = hud.querySelector('#aon-btn-crawl-header');
        this.elements.btnCrawlMain = hud.querySelector('#aon-btn-hud-crawl-main');
        this.elements.titleDisplay = hud.querySelector('#aon-hud-title-display');

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

      // Кнопка ручной подгрузки из AniSkip (только для редакторов и админов)
      const btnAniSkip = hud.querySelector('#aon-btn-fetch-aniskip');
      if (btnAniSkip) {
        chrome.storage.local.get(['currentUser'], (res) => {
          const role = res.currentUser?.role;
          if (role === 'admin' || role === 'trusted') {
            btnAniSkip.style.display = 'inline-flex';
          }
        });

        btnAniSkip.addEventListener('click', () => {
          pageContext.extract(true);
          const malId = pageContext.malId;
          const ep = parseInt(this.elements.epInput?.value, 10) || pageContext.episode || 1;
          if (!malId) {
            toast.show('⚠️ Не удалось определить ID аниме');
            return;
          }
          btnAniSkip.disabled = true;
          btnAniSkip.textContent = '⏳ …';
          chrome.runtime.sendMessage({
            type: 'FETCH_ANISKIP_TIMINGS',
            malId,
            episode: ep
          }, (resp) => {
            btnAniSkip.disabled = false;
            btnAniSkip.textContent = '📥 AniSkip';
            if (!chrome.runtime.lastError && resp && resp.success && resp.found && (resp.op || resp.ed)) {
              this.applyAniSkipData(resp.op, resp.ed);
            } else {
              toast.show(`В базе AniSkip нет таймингов для серии ${ep}`);
            }
          });
        });
      }

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

      // Быстрое +89с и +90с для OP
      hud.querySelector('#aon-btn-op-89')?.addEventListener('click', () => {
        if (playbackSession.video) this.quickOp89();
      });
      hud.querySelector('#aon-btn-op-90')?.addEventListener('click', () => {
        if (playbackSession.video) this.quickOp90();
      });

      // Быстрое +89с и +90с для ED
      hud.querySelector('#aon-btn-ed-89')?.addEventListener('click', () => {
        if (playbackSession.video) this.quickEd89();
      });
      hud.querySelector('#aon-btn-ed-90')?.addEventListener('click', () => {
        if (playbackSession.video) this.quickEd90();
      });

      // Сброс
      hud.querySelector('#aon-btn-clear-op')?.addEventListener('click', () => this.clearOp());
      hud.querySelector('#aon-btn-clear-ed')?.addEventListener('click', () => this.clearEd());

      // Строгая маска ввода времени (MM:SS) на лету для всех полей
      const onTimingChange = () => this.updatePreview();
      [this.inputs.opStart, this.inputs.opEnd, this.inputs.edStart, this.inputs.edEnd].forEach(inp => {
        this.setupTimeInputMask(inp, onTimingChange);
      });

      // Ручной запуск автопереноса нативных таймингов всех серий в базу
      const triggerCrawl = () => {
        this.hide();
        if (typeof nativeTransferManager !== 'undefined') {
          if (pageContext.malId) {
            try {
              sessionStorage.removeItem(nativeTransferManager.declinedPrefix + pageContext.malId);
              sessionStorage.removeItem(nativeTransferManager.completedPrefix + pageContext.malId);
            } catch (e) {}
          }
          toast.show('🚀 Запуск проверки и переноса всех серий...');
          nativeTransferManager.startCrawl();
        } else {
          toast.show('⚠️ Модуль автопереноса не найден');
        }
      };

      this.elements.btnCrawlHeader?.addEventListener('click', triggerCrawl);
      this.elements.btnCrawlMain?.addEventListener('click', triggerCrawl);

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
        if (this.elements.btnAniSkip) {
          chrome.storage.local.get(['currentUser'], (res) => {
            const role = res.currentUser?.role;
            this.elements.btnAniSkip.style.display = (role === 'admin' || role === 'trusted') ? 'inline-flex' : 'none';
          });
        }
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
      if (this.elements.titleDisplay) {
        const titleStr = pageContext.title || 'Аниме';
        const idStr = pageContext.malId ? `MAL: ${pageContext.malId}` : 'ID не определен';
        this.elements.titleDisplay.textContent = `📺 ${titleStr} (${idStr})`;
        this.elements.titleDisplay.title = `${titleStr} [${idStr}]`;
      }
    }

    populateFromCurrent() {
      this.updateMeta();
      const res = playbackSession.intervals.resolved;
      if (this.inputs.opStart) {
        this.inputs.opStart.value = res.op ? formatTime(res.op.start) : '';
        this.inputs.opEnd.value = res.op ? formatTime(res.op.end) : '';
      }
      if (this.inputs.edStart) {
        this.inputs.edStart.value = res.ed ? formatTime(res.ed.start) : '';
        this.inputs.edEnd.value = res.ed ? formatTime(res.ed.end) : '';
      }
      this.updatePreview();
    }

    setupTimeInputMask(input, onChange) {
      if (!input || input.dataset.aonMasked === '1') return;
      input.dataset.aonMasked = '1';

      input.maxLength = 5;
      input.setAttribute('inputmode', 'numeric');
      input.setAttribute('autocomplete', 'off');

      input.addEventListener('keydown', (e) => {
        const isControl = [
          'Backspace', 'Delete', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown',
          'Tab', 'Home', 'End', 'Enter', 'Escape'
        ].includes(e.key) || e.ctrlKey || e.metaKey || e.altKey;

        if (isControl) return;

        // Поддержка ввода разделителя (двоеточие, точка, запятая, точка с запятой)
        if (e.key === ':' || e.key === '.' || e.key === ',' || e.key === ';') {
          e.preventDefault();
          const val = input.value;
          const digits = val.replace(/\D/g, '');
          if (!val.includes(':')) {
            if (digits.length === 0) {
              input.value = '';
            } else if (digits.length === 1) {
              input.value = `0${digits}:`;
            } else {
              input.value = `${digits.slice(0, 2)}:`;
            }
            onChange();
          }
          return;
        }

        // Блокируем любые нецифровые символы
        if (!/^\d$/.test(e.key)) {
          e.preventDefault();
          return;
        }

        // Ограничение: не более 4 цифр
        const digits = input.value.replace(/\D/g, '');
        const hasSelection = input.selectionStart !== input.selectionEnd;
        if (digits.length >= 4 && !hasSelection) {
          e.preventDefault();
        }
      });

      input.addEventListener('input', (e) => {
        let val = input.value;

        // Если поле пустое — оставляем абсолютно пустым
        if (!val || !val.trim()) {
          input.value = '';
          onChange();
          return;
        }

        // Удаляем любые лишние символы и схлопываем множественные двоеточия (например :::)
        val = val.replace(/[^0-9:]/g, '').replace(/:+/g, ':');

        // Если остался только знак двоеточия — очищаем поле в пустую строку
        if (val === ':') {
          input.value = '';
          onChange();
          return;
        }

        const isDelete = e && e.inputType && e.inputType.startsWith('delete');
        if (isDelete) {
          input.value = val.slice(0, 5);
          onChange();
          return;
        }

        // Автоматическая расстановка двоеточия при наборе
        const digits = val.replace(/\D/g, '').slice(0, 4);
        if (!val.includes(':') && digits.length >= 2) {
          const mins = digits.slice(0, 2);
          const secs = digits.slice(2);
          val = `${mins}:${secs}`;
        } else if (val.includes(':')) {
          const parts = val.split(':');
          const mins = parts[0].slice(0, 2);
          let secs = (parts[1] || '').replace(/\D/g, '').slice(0, 2);
          if (secs.length === 2 && parseInt(secs, 10) > 59) {
            secs = '59';
          }
          val = `${mins}:${secs}`;
        }

        input.value = val.slice(0, 5);
        onChange();
      });

      // Нормализация при потере фокуса
      input.addEventListener('blur', () => {
        let val = input.value.trim();
        if (!val || val === ':') {
          input.value = '';
          onChange();
          return;
        }

        const digits = val.replace(/\D/g, '');
        if (!digits) {
          input.value = '';
          onChange();
          return;
        }

        let normalized = '';
        if (val.includes(':')) {
          const parts = val.split(':');
          const m = parts[0].replace(/\D/g, '').padStart(2, '0').slice(-2);
          let s = (parts[1] || '').replace(/\D/g, '');
          if (s.length === 0) s = '00';
          else if (s.length === 1) s = s + '0';
          else s = s.slice(0, 2);
          if (parseInt(s, 10) > 59) s = '59';
          normalized = `${m}:${s}`;
        } else {
          if (digits.length <= 2) {
            normalized = `${digits.padStart(2, '0')}:00`;
          } else {
            const m = digits.slice(0, 2);
            let s = digits.slice(2).padEnd(2, '0').slice(0, 2);
            if (parseInt(s, 10) > 59) s = '59';
            normalized = `${m}:${s}`;
          }
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
      if (!opStartStr && !opEndStr) {
        this.clearError('op');
        if (this.elements.opDur) this.elements.opDur.textContent = '—';
      } else if (opStartStr && !opEndStr) {
        this.showError('op', 'Укажите время окончания опенинга или нажмите «Сброс OP»', this.inputs.opEnd);
        opHasError = true;
        if (this.elements.opDur) this.elements.opDur.textContent = 'неполный';
      } else if (!opStartStr && opEndStr) {
        this.showError('op', 'Укажите время начала опенинга или нажмите «Сброс OP»', this.inputs.opStart);
        opHasError = true;
        if (this.elements.opDur) this.elements.opDur.textContent = 'неполный';
      } else {
        const startComplete = /^\d{2}:\d{2}$/.test(opStartStr);
        const endComplete = /^\d{2}:\d{2}$/.test(opEndStr);

        if (!startComplete) {
          this.showError('op', 'Введите время начала в формате ММ:СС (например, 01:20)', this.inputs.opStart);
          opHasError = true;
        } else if (!endComplete) {
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
        }
      }

      // 2. Проверка Эндинга
      if (!edStartStr && !edEndStr) {
        this.clearError('ed');
        if (this.elements.edDur) this.elements.edDur.textContent = '—';
      } else if (edStartStr && !edEndStr) {
        this.showError('ed', 'Укажите время окончания эндинга или нажмите «Сброс ED»', this.inputs.edEnd);
        edHasError = true;
        if (this.elements.edDur) this.elements.edDur.textContent = 'неполный';
      } else if (!edStartStr && edEndStr) {
        this.showError('ed', 'Укажите время начала эндинга или нажмите «Сброс ED»', this.inputs.edStart);
        edHasError = true;
        if (this.elements.edDur) this.elements.edDur.textContent = 'неполный';
      } else {
        const startComplete = /^\d{2}:\d{2}$/.test(edStartStr);
        const endComplete = /^\d{2}:\d{2}$/.test(edEndStr);

        if (!startComplete) {
          this.showError('ed', 'Введите время начала в формате ММ:СС (например, 22:05)', this.inputs.edStart);
          edHasError = true;
        } else if (!endComplete) {
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
        }
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

    quickOp90() {
      const video = playbackSession.video;
      if (!video) return;
      const start = this.parseInput(this.inputs.opStart?.value) ?? Math.floor(video.currentTime);
      const end = start + 90;

      if (this.inputs.opStart) this.inputs.opStart.value = formatTime(start);
      if (this.inputs.opEnd) this.inputs.opEnd.value = formatTime(end);

      this.updatePreview();
      toast.show(`⏩ Опенинг: задано 90 сек (${formatTime(start)} — ${formatTime(end)})`);
    }

    quickEd89() {
      const video = playbackSession.video;
      if (!video) return;
      const start = this.parseInput(this.inputs.edStart?.value) ?? Math.floor(video.currentTime);
      const end = start + 89;

      if (this.inputs.edStart) this.inputs.edStart.value = formatTime(start);
      if (this.inputs.edEnd) this.inputs.edEnd.value = formatTime(end);

      this.updatePreview();
      toast.show(`⏩ Эндинг: задано 89 сек (${formatTime(start)} — ${formatTime(end)})`);
    }

    quickEd90() {
      const video = playbackSession.video;
      if (!video) return;
      const start = this.parseInput(this.inputs.edStart?.value) ?? Math.floor(video.currentTime);
      const end = start + 90;

      if (this.inputs.edStart) this.inputs.edStart.value = formatTime(start);
      if (this.inputs.edEnd) this.inputs.edEnd.value = formatTime(end);

      this.updatePreview();
      toast.show(`⏩ Эндинг: задано 90 сек (${formatTime(start)} — ${formatTime(end)})`);
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

    // Подстановка данных из AniSkip в редактор для быстрой проверки и корректировки
    applyAniSkipData(op, ed) {
      this.show();
      if (op && op.length === 2) {
        if (this.inputs.opStart) this.inputs.opStart.value = formatTime(op[0]);
        if (this.inputs.opEnd) this.inputs.opEnd.value = formatTime(op[1]);
      }
      if (ed && ed.length === 2) {
        if (this.inputs.edStart) this.inputs.edStart.value = formatTime(ed[0]);
        if (this.inputs.edEnd) this.inputs.edEnd.value = formatTime(ed[1]);
      }
      this.clearError('op');
      this.clearError('ed');
      this.updatePreview();
      toast.show('✨ Тайминги AniSkip подставлены в редактор. Проверьте и сохраните!');
    }

    // Сохранение в Cloudflare Worker
    async saveTimings() {
      const validated = this.validate();
      if (!validated.canSave) return;

      // ВСЕГДА принудительно обновляем контекст перед отправкой, чтобы исключить сохранение в старый тайтл
      pageContext.extract(true);
      if (!pageContext.malId) {
        toast.show('⚠️ Не удалось определить ID аниме');
        if (this.elements.saveStatus) {
          this.elements.saveStatus.innerHTML = '<span style="color: #ef4444;">⚠️ Не удалось определить ID аниме. Перезагрузите страницу.</span>';
        }
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

    detectNativeTimings() {
      let videoEl = (typeof nativeTransferManager !== 'undefined' && nativeTransferManager.getLiveVideo)
        ? nativeTransferManager.getLiveVideo()
        : null;
      if (!videoEl || !videoEl.isConnected) {
        videoEl = this.video;
      }
      if (!videoEl || !videoEl.isConnected || !videoEl.duration || videoEl.duration <= 0) {
        const found = document.querySelector('video.player-video') || document.querySelector('video');
        if (found && found.isConnected) videoEl = found;
      }
      if (!videoEl || !videoEl.duration || isNaN(videoEl.duration) || videoEl.duration <= 0) {
        return null;
      }
      const duration = videoEl.duration;
      const container = getActivePlayerContainer(videoEl) || document.body;
      const scrubber = container.querySelector('[class*="group/scrubber"], [class*="scrubber"]') ||
                       document.querySelector('[class*="group/scrubber"], [class*="scrubber"]');
      if (!scrubber) return null;

      // На AnimeOn:
      // Опенинг — фиолетовый блок на шкале: bg-purple-500/50 или bg-violet
      const opEl = scrubber.querySelector('div[class*="bg-purple"], div[class*="bg-violet"]');
      // Эндинг — синий блок на шкале: bg-blue-500/50 или bg-sky
      const edEl = scrubber.querySelector('div[class*="bg-blue"], div[class*="bg-sky"]');

      if (!opEl && !edEl) return null;

      const parsePct = (val) => {
        if (!val) return 0;
        const m = val.match(/([\d.]+)%/);
        return m ? parseFloat(m[1]) : 0;
      };

      let op = null;
      if (opEl && opEl.style) {
        const left = parsePct(opEl.style.left);
        const width = parsePct(opEl.style.width);
        if (width > 0) {
          const start = Math.round(duration * (left / 100));
          const end = Math.round(duration * ((left + width) / 100));
          if (end > start && (end - start) >= 20 && (end - start) <= 160) {
            op = [start, end];
          }
        }
      }

      let ed = null;
      if (edEl && edEl.style) {
        const left = parsePct(edEl.style.left);
        const width = parsePct(edEl.style.width);
        if (width > 0) {
          const start = Math.round(duration * (left / 100));
          const end = Math.round(duration * ((left + width) / 100));
          if (end > start && (end - start) >= 20 && (end - start) <= 160) {
            ed = [start, end];
          }
        }
      }

      if (!op && !ed) return null;
      return { op, ed };
    }

    checkAndApplyNativeTimings() {
      // КРИТИЧЕСКАЯ ЗАЩИТА: во время активного автопереноса краулером блокируем фоновую автоотправку,
      // чтобы фоновые события плеера не отправляли остаточные тайминги предыдущей серии
      if (typeof nativeTransferManager !== 'undefined' && nativeTransferManager.isCrawling) {
        return false;
      }

      const native = this.detectNativeTimings();
      if (!native) return false;

      const current = this.intervals.resolved;
      const alreadyNative = (current.op?.source === 'native' || current.ed?.source === 'native');

      if (!alreadyNative) {
        console.log(`[AnimeOn Skipper] ⚡ Обнаружены нативные тайминги AnimeOn: OP=${JSON.stringify(native.op)}, ED=${JSON.stringify(native.ed)}`);
        this.intervals.setExternal(native.op, native.ed, 'native');
        this.recalculateAndRender();
        if (hudEditor) hudEditor.populateFromCurrent();
        toast.show('⚡ Обнаружены нативные тайминги AnimeOn');
        this.autoSubmitNativeTimings(native);
      }

      if (typeof nativeTransferManager !== 'undefined') {
        nativeTransferManager.checkAndPrompt();
      }

      return true;
    }

    autoSubmitNativeTimings(native, targetEp = null) {
      // Во время работы краулера разрешаем отправку ТОЛЬКО с явным targetEp от краулера!
      if (typeof nativeTransferManager !== 'undefined' && nativeTransferManager.isCrawling && !targetEp) {
        return;
      }

      const ep = targetEp || pageContext.episode;
      if (!pageContext.malId || !ep || (!native.op && !native.ed)) return;
      const key = `${pageContext.malId}:${ep}`;
      if (!this.submittedNativeKeys) this.submittedNativeKeys = new Set();
      if (this.submittedNativeKeys.has(key)) return;
      this.submittedNativeKeys.add(key);

      chrome.runtime.sendMessage({
        type: 'AUTO_SUBMIT_NATIVE_TIMINGS',
        malId: pageContext.malId,
        episode: ep,
        title: pageContext.title || '',
        totalEpisodes: pageContext.totalEpisodes || null,
        op: native.op,
        ed: native.ed,
        overwrite: true
      }, (res) => {
        if (res && res.saved) {
          toast.show(`⚡ Нативные тайминги серии ${ep} внесены в базу!`);
          console.log(`[AnimeOn Skipper] ⚡ Нативные тайминги серии ${ep} отправлены в базу Cloudflare:`, res);
        }
      });
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

      // Удаляем всплывающее предложение AniSkip от предыдущей серии
      const oldPrompt = document.querySelector('.aon-aniskip-prompt');
      if (oldPrompt) oldPrompt.remove();

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
      pageContext.extract(false);
      if (!pageContext.malId) return;

      // 0. ПРИОРИТЕТ 0: Нативные тайминги со страницы плеера AnimeOn
      if (this.checkAndApplyNativeTimings()) {
        return;
      }

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
            this.intervals.setExternal(response.op, response.ed, response.source || 'cloudflare');
            toast.show('☁️ Таймкоды загружены из базы Cloudflare');
            console.log(`[AnimeOn Skipper] Загружены таймкоды из Cloudflare [${key}], source: ${response.source || 'cloudflare'}`);
            this.recalculateAndRender();
            if (hudEditor) hudEditor.populateFromCurrent();
            return;
          }

          // 2. Приоритет 2: Если в Cloudflare пусто, проверяем локальный кэш пользователя
          chrome.storage.local.get(['customSkips', 'currentUser'], (res) => {
            if (requestId !== this.loadRequestId || this.currentEpisodeKey !== key) {
              return;
            }

            const custom = res.customSkips?.[key];
            if (custom && (custom.op || custom.ed)) {
              this.intervals.setExternal(custom.op, custom.ed, 'custom');
              console.log(`[AnimeOn Skipper] Загружены пользовательские таймкоды [${key}]`);
              this.recalculateAndRender();
              if (hudEditor) hudEditor.populateFromCurrent();
              return;
            } else {
              this.intervals.reset();
            }
            this.recalculateAndRender();
            if (hudEditor) hudEditor.populateFromCurrent();

            // 3. АВТОПОИСК В ANISKIP ДЛЯ РЕДАКТОРОВ И АДМИНИСТРАТОРОВ
            // Если меток нет в нашей базе, ищем их в AniSkip и предлагаем добавить/скорректировать
            const role = res.currentUser?.role;
            if (role === 'admin' || role === 'trusted') {
              this.checkAniSkipForEditor(targetMalId, targetEp, requestId);
            }
          });
        }
      );
    }

    checkAniSkipForEditor(malId, episode, requestId) {
      if (!malId || !episode) return;
      chrome.runtime.sendMessage({
        type: 'FETCH_ANISKIP_TIMINGS',
        malId,
        episode
      }, (resp) => {
        if (requestId !== this.loadRequestId || this.currentEpisodeKey !== `${malId}:${episode}`) {
          return;
        }
        if (!chrome.runtime.lastError && resp && resp.success && resp.found && (resp.op || resp.ed)) {
          this.showAniSkipPrompt(malId, episode, resp.op, resp.ed);
        }
      });
    }

    showAniSkipPrompt(malId, episode, op, ed) {
      const container = getActivePlayerContainer(this.video);
      if (!container) return;

      const existing = container.querySelector('.aon-aniskip-prompt') || document.querySelector('.aon-aniskip-prompt');
      if (existing) existing.remove();

      const opStr = (op && op.length === 2) ? `${formatTime(op[0])} — ${formatTime(op[1])}` : null;
      const edStr = (ed && ed.length === 2) ? `${formatTime(ed[0])} — ${formatTime(ed[1])}` : null;

      const promptEl = document.createElement('div');
      promptEl.className = 'aon-aniskip-prompt';
      promptEl.innerHTML = `
        <div class="aon-aniskip-header">
          <div class="aon-aniskip-title-wrap">
            <span class="aon-aniskip-badge">⚡ AniSkip</span>
            <span class="aon-aniskip-title">Найдены тайминги для <strong>${episode} серии</strong></span>
          </div>
          <button type="button" class="aon-aniskip-close" title="Скрыть">&times;</button>
        </div>
        <div class="aon-aniskip-times">
          ${opStr ? `<div class="aon-aniskip-time-pill op"><span class="pill-tag">OP</span> ${opStr}</div>` : ''}
          ${edStr ? `<div class="aon-aniskip-time-pill ed"><span class="pill-tag">ED</span> ${edStr}</div>` : ''}
        </div>
        <div class="aon-aniskip-actions">
          <button type="button" class="aon-aniskip-btn-apply">✏️ Применить и скорректировать</button>
          <button type="button" class="aon-aniskip-btn-dismiss">Скрыть</button>
        </div>
      `;

      // Изолируем клики от плеера
      const stopProp = (e) => e.stopPropagation();
      promptEl.addEventListener('click', stopProp);
      promptEl.addEventListener('mousedown', stopProp);
      promptEl.addEventListener('keydown', stopProp);

      const dismiss = () => {
        promptEl.classList.remove('aon-visible');
        setTimeout(() => promptEl.remove(), 300);
      };

      const closeBtn = promptEl.querySelector('.aon-aniskip-close');
      if (closeBtn) closeBtn.addEventListener('click', dismiss);
      const dismissBtn = promptEl.querySelector('.aon-aniskip-btn-dismiss');
      if (dismissBtn) dismissBtn.addEventListener('click', dismiss);

      const applyBtn = promptEl.querySelector('.aon-aniskip-btn-apply');
      if (applyBtn) {
        applyBtn.addEventListener('click', () => {
          dismiss();
          if (hudEditor) {
            hudEditor.applyAniSkipData(op, ed);
          }
        });
      }

      container.appendChild(promptEl);
      requestAnimationFrame(() => {
        promptEl.classList.add('aon-visible');
      });
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

  // =========================================================================
  // 11.1 АВТОМАТИЧЕСКИЙ ПЕРЕНОС НА ВСЕ СЕРИИ ТАЙТЛА (Native Transfer Crawler)
  // =========================================================================
  class NativeTransferManager {
    constructor() {
      this.promptEl = null;
      this.progressEl = null;
      this.isPromptOpen = false;
      this.isCrawling = false;
      this.isCancelled = false;
      this.declinedPrefix = 'aon_native_declined_';
      this.completedPrefix = 'aon_native_completed_';
    }

    isDeclinedForCurrentAnime() {
      if (!pageContext.malId) return false;
      try {
        return sessionStorage.getItem(this.declinedPrefix + pageContext.malId) === 'true';
      } catch (e) {
        return false;
      }
    }

    isCompletedForCurrentAnime() {
      if (!pageContext.malId) return false;
      try {
        return sessionStorage.getItem(this.completedPrefix + pageContext.malId) === 'true';
      } catch (e) {
        return false;
      }
    }

    markDeclined() {
      if (pageContext.malId) {
        try {
          sessionStorage.setItem(this.declinedPrefix + pageContext.malId, 'true');
        } catch (e) {}
      }
    }

    markCompleted() {
      if (pageContext.malId) {
        try {
          sessionStorage.setItem(this.completedPrefix + pageContext.malId, 'true');
        } catch (e) {}
      }
    }

    checkAndPrompt() {
      if (!pageContext.malId) return;
      if (this.isPromptOpen || this.isCrawling) return;
      if (this.isDeclinedForCurrentAnime() || this.isCompletedForCurrentAnime()) return;

      this.showPrompt();
    }

    showPrompt() {
      if (this.isPromptOpen) return;
      this.isPromptOpen = true;

      document.getElementById('aon-native-prompt')?.remove();

      const container = getActivePlayerContainer(playbackSession.video) || document.body;

      const total = pageContext.totalEpisodes || null;
      const totalStr = total ? ` (все ${total} серий)` : '';

      const el = document.createElement('div');
      el.id = 'aon-native-prompt';
      el.className = 'aon-native-prompt aon-native-prompt-enter';
      el.innerHTML = `
        <div class="aon-np-content">
          <div class="aon-np-header">
            <div class="aon-np-badge">⚡ AnimeOn Native</div>
            <button type="button" class="aon-np-close" id="aon-np-close" title="Закрыть">×</button>
          </div>
          <div class="aon-np-body">
            <div class="aon-np-title">Обнаружены нативные тайминги!</div>
            <div class="aon-np-desc">
              В плеере есть официальная разметка опенинга/эндинга. Перенести тайминги всех серий\${totalStr} этого аниме в базу Cloudflare автоматически?
            </div>
          </div>
          <div class="aon-np-actions">
            <button type="button" class="aon-np-btn aon-np-btn-yes" id="aon-np-yes">
              <span>🚀 Да, внести всё</span>
            </button>
            <button type="button" class="aon-np-btn aon-np-btn-no" id="aon-np-no">
              <span>Нет</span>
            </button>
          </div>
        </div>
      `;

      ['mousedown', 'mouseup', 'click', 'dblclick', 'keydown'].forEach(evt => {
        el.addEventListener(evt, (e) => e.stopPropagation());
      });

      container.appendChild(el);
      this.promptEl = el;

      document.getElementById('aon-np-yes')?.addEventListener('click', () => {
        this.closePrompt();
        this.startCrawl();
      });

      const onDecline = () => {
        this.markDeclined();
        this.closePrompt();
      };

      document.getElementById('aon-np-no')?.addEventListener('click', onDecline);
      document.getElementById('aon-np-close')?.addEventListener('click', onDecline);
    }

    closePrompt() {
      this.isPromptOpen = false;
      if (this.promptEl) {
        this.promptEl.classList.remove('aon-native-prompt-enter');
        this.promptEl.classList.add('aon-native-prompt-exit');
        setTimeout(() => {
          this.promptEl?.remove();
          this.promptEl = null;
        }, 250);
      }
    }

    getLiveVideo() {
      const videos = Array.from(document.querySelectorAll('video')).filter(v => v.isConnected);
      if (videos.length === 0) return null;
      if (videos.length === 1) return videos[0];
      return videos.find(v => !v.paused) ||
             videos.find(v => v.duration && !isNaN(v.duration) && v.duration > 0) ||
             videos.find(v => v.currentSrc || v.src) ||
             videos[0];
    }

    ensureVideoPlaying(v) {
      if (!v) return;
      try {
        v.muted = true;
        v.defaultMuted = true;
        v.volume = 0;
        if (v.paused) {
          v.play().catch(() => {});
          const playBtn = document.querySelector('[class*="play-button"], [class*="player-play"], button[aria-label*="play" i], button[aria-label*="Play"], button[aria-label*="оспроиз" i], .vjs-big-play-button, button[data-slot="play-button"], svg.lucide-play');
          if (playBtn) {
            try { (playBtn.closest('button') || playBtn).click(); } catch (e) {}
          }
        }
      } catch (e) {}
    }

    detectPlayerEpisode() {
      // Ищем бейдж серии ИСКЛЮЧИТЕЛЬНО внутри контейнера плеера (например, "Эпизод 2")
      const video = this.getLiveVideo() || playbackSession.video;
      const container = getActivePlayerContainer(video) || document.querySelector('[class*="player"]');
      if (!container) return null;

      const badges = container.querySelectorAll('span, div, [data-slot="badge"], .badge');
      for (const b of badges) {
        if (b.closest('[class*="scrubber"]') || b.closest('[class*="timeline"]')) continue;
        const txt = (b.textContent || '').trim();
        if (txt.length > 25) continue;
        if (txt.includes('серий') || txt.includes('из') || txt.includes('всего') || txt.includes('сезон')) continue;
        const m = txt.match(/^(?:эпизод|серия)\s*(\d{1,4})$/i) ||
                  txt.match(/^(\d{1,4})\s*(?:эпизод|серия)$/i);
        if (m && m[1]) {
          const num = parseInt(m[1], 10);
          if (num > 0 && num <= 2000) return num;
        }
      }
      return null;
    }

    getScrubberFingerprint() {
      const videoEl = this.getLiveVideo() || playbackSession.video;
      const container = getActivePlayerContainer(videoEl) || document.body;
      const scrubber = container.querySelector('[class*="group/scrubber"], [class*="scrubber"]') ||
                       document.querySelector('[class*="group/scrubber"], [class*="scrubber"]');
      if (!scrubber) return 'no_scrubber';
      const opEl = scrubber.querySelector('div[class*="bg-purple"], div[class*="bg-violet"]');
      const edEl = scrubber.querySelector('div[class*="bg-blue"], div[class*="bg-sky"]');
      const opStyle = opEl ? (opEl.getAttribute('style') || '').trim() : 'none';
      const edStyle = edEl ? (edEl.getAttribute('style') || '').trim() : 'none';
      return `OP:${opStyle}|ED:${edStyle}`;
    }

    async startCrawl() {
      if (this.isCrawling) return;
      this.isCrawling = true;
      this.isCancelled = false;

      const malId = pageContext.malId;
      const startEp = pageContext.episode || 1;
      const title = pageContext.title || 'Аниме';

      // Очищаем ключи отправленных серий для повторного запуска
      if (playbackSession.submittedNativeKeys) {
        playbackSession.submittedNativeKeys.clear();
      }

      // 1. Ищем максимальное число серий через кнопки, вкладки диапазонов и pageContext.totalEpisodes
      let total = pageContext.totalEpisodes || 0;
      const tabs = document.querySelectorAll('button, a, [role="tab"], [role="button"], div[class*="tab"]');
      tabs.forEach(t => {
        const m = (t.textContent || '').match(/(\d+)\s*[-—–]\s*(\d+)/);
        if (m) {
          const maxInTab = parseInt(m[2], 10);
          if (maxInTab > total && maxInTab <= 2000) total = maxInTab;
        }
      });
      const allEpBtns = document.querySelectorAll('button[data-episode], [data-episode], button[aria-label*="ери" i], button[aria-label*="пизод" i]');
      allEpBtns.forEach(btn => {
        const num = parseInt(btn.getAttribute('data-episode') || (btn.getAttribute('aria-label') || '').match(/\d+/)?.[0] || btn.textContent.trim(), 10);
        if (!isNaN(num) && num > total && num <= 2000) total = num;
      });
      if (total <= 0) total = 24;

      const episodesList = Array.from({ length: total }, (_, i) => i + 1);

      this.showProgressHUD(title, episodesList.length);

      const liveInit = this.getLiveVideo();
      const originalMuted = liveInit?.muted ?? playbackSession.video?.muted;

      // Сторожевой интервал: каждые 400мс держим плеер в рабочем muted состоянии, не давая ему заснуть на паузе
      const unpauseInterval = setInterval(() => {
        if (this.isCancelled) return;
        const liveV = this.getLiveVideo();
        if (liveV) {
          this.ensureVideoPlaying(liveV);
        }
      }, 400);

      let savedCount = 0;
      let lastProcessedFingerprint = null;

      try {
        for (let i = 0; i < episodesList.length; i++) {
          if (this.isCancelled) break;
          const ep = episodesList[i];
          const pct = Math.round(((i + 1) / episodesList.length) * 100);

          this.updateProgressHUD({
            ep,
            idx: i + 1,
            total: episodesList.length,
            savedCount,
            pct,
            status: `Серия ${ep}: переключение плеера...`
          });

          // Проверяем, нужно ли переключать серию на сайте
          const currentSiteEp = pageContext.detectActiveEpisode();
          const currentPlayerEp = this.detectPlayerEpisode();
          const needsSwitch = (currentSiteEp !== ep || (currentPlayerEp && currentPlayerEp !== ep));

          if (needsSwitch) {
            await switchToSiteEpisode(ep);

            // Обязательная пауза ожидания смены HLS-стрима и прорисовки нового скраббера:
            // Даем плееру минимум 3.5 секунды, удерживая воспроизведение, прежде чем считывать маркеры
            const waitSwitchStart = Date.now();
            while (Date.now() - waitSwitchStart < 3500) {
              if (this.isCancelled) break;
              const liveV = this.getLiveVideo();
              if (liveV) this.ensureVideoPlaying(liveV);
              await new Promise(r => setTimeout(r, 200));
            }
          }

          const liveV = this.getLiveVideo();
          if (liveV) {
            this.ensureVideoPlaying(liveV);
          }

          // Ожидаем появления нативных таймингов именно для серии ep, передавая lastProcessedFingerprint
          const result = await this.waitForEpisodeTimings(ep, lastProcessedFingerprint, 12000);
          lastProcessedFingerprint = this.getScrubberFingerprint();

          if (result && (result.op || result.ed)) {
            savedCount++;
            this.updateProgressHUD({
              ep,
              idx: i + 1,
              total: episodesList.length,
              savedCount,
              pct,
              status: `Серия ${ep}: тайминги сохранены ✅`
            });
            playbackSession.autoSubmitNativeTimings(result, ep);
          } else {
            this.updateProgressHUD({
              ep,
              idx: i + 1,
              total: episodesList.length,
              savedCount,
              pct,
              status: `Серия ${ep}: без нативных меток ⏭`
            });
          }

          if (i < episodesList.length - 1 && !this.isCancelled) {
            await new Promise(r => setTimeout(r, 400));
          }
        }
      } finally {
        clearInterval(unpauseInterval);
        const finalV = this.getLiveVideo() || playbackSession.video;
        if (finalV && originalMuted !== undefined) {
          try { finalV.muted = originalMuted; } catch (e) {}
        }
      }

      this.hideProgressHUD();
      this.isCrawling = false;

      if (this.isCancelled) {
        toast.show(`⏹ Автоперенос остановлен. Сохранено: ${savedCount} серий`);
      } else {
        this.markCompleted();
        toast.show(`🎉 Все серии проверены! Сохранено: ${savedCount} серий в базу!`);
      }

      // Возвращаем пользователя на исходную серию
      if (pageContext.episode !== startEp) {
        await switchToSiteEpisode(startEp);
      }
    }

    async waitForEpisodeTimings(expectedEp, prevFingerprint = null, maxWaitMs = 12000) {
      const startTime = Date.now();
      let stableCandidate = null;
      let candidateFirstSeen = 0;

      // Если есть отпечаток предыдущей серии, даем React и плееру минимум 2000мс на смену потока
      const MIN_TRANSITION_WAIT_MS = prevFingerprint ? 2000 : 600;

      while (Date.now() - startTime < maxWaitMs) {
        if (this.isCancelled) return null;

        const video = this.getLiveVideo() || playbackSession.video;
        if (video) {
          if (video !== playbackSession.video) {
            playbackSession.attachVideo(video);
          }
          this.ensureVideoPlaying(video);
        }

        const elapsed = Date.now() - startTime;

        // 1. Проверяем бейдж плеера — если он явно показывает другую серию, продолжаем ждать!
        const playerEp = this.detectPlayerEpisode();
        if (playerEp && playerEp !== expectedEp) {
          await new Promise(r => setTimeout(r, 200));
          continue;
        }

        const siteEp = pageContext.detectActiveEpisode();
        const isEpisodeConfirmed = (!playerEp || playerEp === expectedEp) && (!siteEp || siteEp === expectedEp);

        // 2. Проверяем готовность видео (duration должно быть валидным и readyState >= 1)
        const isVideoReady = video && video.duration && !isNaN(video.duration) && video.duration > 0 && video.readyState >= 1;

        // 3. Получаем отпечаток маркеров на скраббере
        const currentFingerprint = this.getScrubberFingerprint();

        // 4. Проверяем, не является ли отпечаток остаточным от предыдущей серии
        const isStaleFromPrev = prevFingerprint &&
                                currentFingerprint !== 'no_scrubber' &&
                                currentFingerprint !== 'OP:none|ED:none' &&
                                currentFingerprint === prevFingerprint;

        // Если прошло меньше минимального времени смены серии, или отпечаток все еще старый — ждем
        const isStillOldStream = (elapsed < MIN_TRANSITION_WAIT_MS) || (isStaleFromPrev && elapsed < 6500);

        if (isEpisodeConfirmed && isVideoReady && !isStillOldStream) {
          const native = playbackSession.detectNativeTimings();
          if (native && (native.op || native.ed)) {
            const candidateKey = JSON.stringify(native);
            if (candidateKey === stableCandidate) {
              // Кандидат должен удерживаться стабильным не менее 400мс
              if (Date.now() - candidateFirstSeen >= 400) {
                console.log(`[AnimeOn Skipper] ✅ Подтверждены тайминги серии ${expectedEp}: OP=${JSON.stringify(native.op)}, ED=${JSON.stringify(native.ed)} (fingerprint=${currentFingerprint})`);
                return native;
              }
            } else {
              stableCandidate = candidateKey;
              candidateFirstSeen = Date.now();
            }
          }
        }

        // Если скраббер найден, но длительность видео еще не определена — стимулируем воспроизведение
        const scrubber = document.querySelector('[class*="group/scrubber"], [class*="scrubber"]');
        if (scrubber && video && (!video.duration || isNaN(video.duration) || video.duration <= 0)) {
          this.ensureVideoPlaying(video);
        }

        await new Promise(r => setTimeout(r, 200));
      }

      // Таймаут истек: если за 12 сек скраббер так и не выдал новых меток
      const finalNative = playbackSession.detectNativeTimings();
      if (finalNative && (finalNative.op || finalNative.ed)) {
        return finalNative;
      }

      return null;
    }

    showProgressHUD(title, totalCount) {
      document.getElementById('aon-crawl-hud')?.remove();
      const container = getActivePlayerContainer(playbackSession.video) || document.body;

      const el = document.createElement('div');
      el.id = 'aon-crawl-hud';
      el.className = 'aon-crawl-hud';
      el.innerHTML = `
        <div class="aon-ch-card">
          <div class="aon-ch-top">
            <div class="aon-ch-title-wrap">
              <span class="aon-ch-indicator"></span>
              <span class="aon-ch-title">Автоперенос таймингов</span>
            </div>
            <span class="aon-ch-count" id="aon-ch-count">0 / \${totalCount}</span>
          </div>
          <div class="aon-ch-bar-bg">
            <div class="aon-ch-bar-fill" id="aon-ch-bar-fill" style="width: 0%;"></div>
          </div>
          <div class="aon-ch-bottom">
            <span class="aon-ch-status" id="aon-ch-status">Инициализация...</span>
            <button type="button" class="aon-ch-btn-stop" id="aon-ch-btn-stop">⏹ Остановить</button>
          </div>
        </div>
      `;

      ['mousedown', 'mouseup', 'click', 'dblclick', 'keydown'].forEach(evt => {
        el.addEventListener(evt, (e) => e.stopPropagation());
      });

      container.appendChild(el);
      this.progressEl = el;

      document.getElementById('aon-ch-btn-stop')?.addEventListener('click', () => {
        this.isCancelled = true;
        const statusEl = document.getElementById('aon-ch-status');
        if (statusEl) statusEl.textContent = 'Остановка автопереноса...';
      });
    }

    updateProgressHUD({ ep, idx, total, savedCount, pct, status }) {
      const countEl = document.getElementById('aon-ch-count');
      if (countEl) countEl.textContent = `\${idx} / \${total} (\${pct}%) • Сохранено: \${savedCount}`;
      const fillEl = document.getElementById('aon-ch-bar-fill');
      if (fillEl) fillEl.style.width = `\${pct}%`;
      const statusEl = document.getElementById('aon-ch-status');
      if (statusEl) statusEl.textContent = status;
    }

    hideProgressHUD() {
      if (this.progressEl) {
        this.progressEl.remove();
        this.progressEl = null;
      }
    }
  }

  const nativeTransferManager = new NativeTransferManager();

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
  async function switchEpisodeRangeTab(targetEp) {
    if (!targetEp) return false;

    // 1. Проверяем наличие выпадающего списка серий <select>
    const selects = document.querySelectorAll('select');
    for (const sel of selects) {
      for (let i = 0; i < sel.options.length; i++) {
        const optText = (sel.options[i].textContent || '').replace(/\s+/g, ' ').trim();
        const m = optText.match(/(\d+)\s*[-—–]\s*(\d+)/);
        if (m) {
          const from = parseInt(m[1], 10);
          const to = parseInt(m[2], 10);
          if (targetEp >= from && targetEp <= to) {
            if (sel.selectedIndex !== i) {
              sel.selectedIndex = i;
              sel.dispatchEvent(new Event('change', { bubbles: true }));
              console.log(`[AnimeOn Skipper] Выбран диапазон ${from}-${to} через <select>`);
              await new Promise(r => setTimeout(r, 600));
              return true;
            } else {
              return true;
            }
          }
        }
      }
    }

    // 2. Ищем кнопки, вкладки или элементы переключения диапазонов (например, "1-12", "13-24")
    const candidates = document.querySelectorAll('button, a, [role="tab"], [role="button"], div[class*="tab"], div[class*="range"], li');
    for (const el of candidates) {
      const txt = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (txt.length > 50) continue;
      const m = txt.match(/^(\d+)\s*[-—–]\s*(\d+)$/) ||
                txt.match(/(?:серии|эпизоды|эп\.?)\s*(\d+)\s*[-—–]\s*(\d+)/i) ||
                txt.match(/(\d+)\s*[-—–]\s*(\d+)\s*(?:серии|эпизоды|эп\.?)/i) ||
                txt.match(/^(\d+)\s*[-—–]\s*(\d+)/);
      if (m) {
        const from = parseInt(m[1], 10);
        const to = parseInt(m[2], 10);
        if (targetEp >= from && targetEp <= to) {
          const cls = (el.className || '').toLowerCase();
          const isCurrent = el.getAttribute('aria-selected') === 'true' ||
                            el.getAttribute('data-state') === 'active' ||
                            el.getAttribute('aria-current') === 'page' ||
                            el.getAttribute('aria-current') === 'true' ||
                            cls.includes('active') ||
                            cls.includes('selected') ||
                            cls.includes('current');
          if (!isCurrent) {
            console.log(`[AnimeOn Skipper] Клик по вкладке диапазона серий: ${from}-${to}`);
            try { el.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch (e) {}
            el.click();
            await new Promise(r => setTimeout(r, 600));
            return true;
          } else {
            return true;
          }
        }
      }
    }

    return false;
  }

  async function switchToSiteEpisode(targetEp) {
    if (!targetEp || targetEp < 1) {
      toast.show('⚠️ Это первая серия');
      return false;
    }

    const findTargetButton = () => {
      // 1. По data-episode="${targetEp}"
      let btn = document.querySelector(`button[data-episode="${targetEp}"], [data-episode="${targetEp}"]`);
      if (btn) return btn;

      // 2. По aria-label="Серия ${targetEp}"
      const ariaBtns = document.querySelectorAll('button[aria-label*="ерия"], button[aria-label*="пизод"], a[aria-label*="ерия"], a[aria-label*="пизод"]');
      for (const b of ariaBtns) {
        const m = (b.getAttribute('aria-label') || '').match(/\d+/);
        if (m && parseInt(m[0], 10) === targetEp) {
          return b;
        }
      }

      // 3. По тексту кнопки в списке серий (пропуская ссылки на франшизу)
      const allBtns = document.querySelectorAll('button, a, [role="button"], [role="tab"]');
      for (const b of allBtns) {
        if (b.tagName === 'A' && (b.getAttribute('href')?.includes('/anime') || b.querySelector('h4, img'))) continue;
        const txt = (b.textContent || '').trim();
        if (txt === String(targetEp) || txt === `${targetEp} серия` || txt === `Серия ${targetEp}` || txt === `${targetEp} эпизод`) {
          return b;
        }
      }

      return null;
    };

    let targetBtn = findTargetButton();

    // Если кнопка не найдена в текущем DOM — переключаем диапазон серий (например, с "1-12" на "13-24")!
    if (!targetBtn) {
      await switchEpisodeRangeTab(targetEp);
      for (let attempt = 0; attempt < 8; attempt++) {
        targetBtn = findTargetButton();
        if (targetBtn) break;
        await new Promise(r => setTimeout(r, 200));
      }
    }

    // Запасной вариант: кнопка "Следующая серия" в плеере AnimeOn при последовательном обходе
    if (!targetBtn && targetEp === (pageContext.episode + 1)) {
      const nextBtn = document.querySelector('button[title*="ледующ" i], [aria-label*="ледующ" i], button[class*="next" i]');
      if (nextBtn) {
        console.log('[AnimeOn Skipper] Переключение на следующую серию через кнопку плеера ⏭');
        nextBtn.click();
        pageContext.episode = targetEp;
        toast.show(`📺 Серия ${targetEp}`);
        return true;
      }
    }

    if (targetBtn) {
      console.log(`[AnimeOn Skipper] Переключение на серию ${targetEp} через клик по кнопке сайта`);
      try {
        targetBtn.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
      } catch (e) {}
      targetBtn.click();
      pageContext.episode = targetEp;
      toast.show(`📺 Серия ${targetEp}`);

      // Ожидаем подтверждения смены активной серии в DOM сайта до 2.5 секунд
      const waitStart = Date.now();
      while (Date.now() - waitStart < 2500) {
        const detected = pageContext.detectActiveEpisode();
        if (detected === targetEp) break;
        await new Promise(r => setTimeout(r, 100));
      }

      return true;
    } else {
      console.log(`[AnimeOn Skipper] Кнопка серии ${targetEp} не найдена в DOM, применяем смену серии в плеере`);
      playbackSession.changeEpisode(targetEp, true);
      toast.show(`📺 Серия ${targetEp}`);
      return true;
    }
  }

  window.addEventListener('message', (e) => {
    if (e.data?.type === 'AON_SWITCH_EPISODE') {
      const delta = e.data.delta || 0;
      const curEp = pageContext.detectActiveEpisode() || pageContext.episode || 1;
      const target = e.data.targetEp || (curEp + delta);
      switchToSiteEpisode(target);
    }
  });

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

    // Б (русская) или < / , (Comma) -> Предыдущая серия на сайте
    const isPrevEp = !e.ctrlKey && !e.altKey && !e.metaKey && (
      e.code === 'Comma' || e.key === 'б' || e.key === 'Б' || e.key === ',' || e.key === '<'
    );
    if (isPrevEp) {
      e.preventDefault();
      e.stopPropagation();
      const curEp = pageContext.detectActiveEpisode() || pageContext.episode || 1;
      const targetEp = curEp - 1;
      if (window !== window.top) {
        window.top.postMessage({ type: 'AON_SWITCH_EPISODE', delta: -1, targetEp }, '*');
      } else {
        switchToSiteEpisode(targetEp);
      }
      return;
    }

    // Ю (русская) или > / . (Period) -> Следующая серия на сайте
    const isNextEp = !e.ctrlKey && !e.altKey && !e.metaKey && (
      e.code === 'Period' || e.key === 'ю' || e.key === 'Ю' || e.key === '.' || e.key === '>'
    );
    if (isNextEp) {
      e.preventDefault();
      e.stopPropagation();
      const curEp = pageContext.detectActiveEpisode() || pageContext.episode || 1;
      const targetEp = curEp + 1;
      if (window !== window.top) {
        window.top.postMessage({ type: 'AON_SWITCH_EPISODE', delta: 1, targetEp }, '*');
      } else {
        switchToSiteEpisode(targetEp);
      }
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
      // Синхронизируем контекст с DOM
      pageContext.extract(false);

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

  // Наблюдатель за сменой URL в SPA-приложении AnimeOn (Next.js / HTML5 History)
  function initUrlObserver() {
    let lastHref = window.location.href;

    const handleUrlTransition = () => {
      const currentHref = window.location.href;
      if (currentHref !== lastHref) {
        const oldHref = lastHref;
        lastHref = currentHref;
        console.log(`[AnimeOn Skipper] SPA переход по URL: ${oldHref} -> ${currentHref}`);

        const oldMalId = pageContext.malId;
        pageContext.extract(true);

        if (playbackSession) {
          if (oldMalId && oldMalId !== pageContext.malId) {
            console.log(`[AnimeOn Skipper] Сменился тайтл (${oldMalId} -> ${pageContext.malId}), сбрасываем интервалы`);
            playbackSession.intervals.clear();
            playbackSession.currentEpisodeKey = null;
          }
          playbackSession.loadTimings();
          playbackSession.reportSession();
        }

        if (hudEditor) {
          hudEditor.populateFromCurrent();
        }
      }
    };

    // Перехват pushState и replaceState
    const wrapHistory = (type) => {
      const orig = history[type];
      return function (...args) {
        const res = orig.apply(this, args);
        try {
          window.dispatchEvent(new Event('aon-locationchange'));
        } catch (e) {}
        return res;
      };
    };

    history.pushState = wrapHistory('pushState');
    history.replaceState = wrapHistory('replaceState');

    window.addEventListener('popstate', handleUrlTransition);
    window.addEventListener('hashchange', handleUrlTransition);
    window.addEventListener('aon-locationchange', () => setTimeout(handleUrlTransition, 50));

    // Регулярный фоновый опрос каждые 250 мс для 100% гарантии реакции
    setInterval(handleUrlTransition, 250);
  }

  // Старт расширения
  initSettings().then(() => {
    pageContext.extract(true);
    nativeSync.init();
    initVideoLifecycle();
    initUrlObserver();
    initEpisodeObserver();
    console.log('[AnimeOn Skipper v2.2.0] Модуль запущен: HUD редактор, Cloudflare Sync и SPA URL Observer готовы.');
  });
})();
