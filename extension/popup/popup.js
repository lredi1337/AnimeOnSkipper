/**
 * AnimeOn Skipper — Popup Settings Controller (v2.1.0)
 */

document.addEventListener('DOMContentLoaded', async () => {
  const showMarkersInput = document.getElementById('show-markers');
  const offsetSlider = document.getElementById('offset-slider');
  const offsetVal = document.getElementById('offset-val');

  const playerStatusDot = document.getElementById('player-status-dot');
  const playerStatusText = document.getElementById('player-status-text');
  const animeTitle = document.getElementById('anime-title');
  const animeMeta = document.getElementById('anime-meta');
  const epDisplay = document.getElementById('ep-display');
  const timingStatus = document.getElementById('timing-status');

  const btnPrevEp = document.getElementById('btn-prev-ep');
  const btnNextEp = document.getElementById('btn-next-ep');
  let currentEpisode = 1;

  const cfStatusBadge = document.getElementById('cf-status-badge');
  const cfHint = document.getElementById('cf-hint');
  const CLOUDFLARE_WORKER_URL = 'https://animeon-skipp.ruscadred.workers.dev';

  if (btnPrevEp) {
    btnPrevEp.addEventListener('click', () => {
      if (currentEpisode > 1) {
        changeEpisode(currentEpisode - 1);
      }
    });
  }

  if (btnNextEp) {
    btnNextEp.addEventListener('click', () => {
      changeEpisode(currentEpisode + 1);
    });
  }

  function changeEpisode(newEp) {
    currentEpisode = newEp;
    if (epDisplay) epDisplay.textContent = `Серия ${newEp}`;
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const activeTab = tabs[0];
      if (activeTab?.id) {
        chrome.tabs.sendMessage(activeTab.id, { type: 'SET_MANUAL_EPISODE', episode: newEp }, () => {
          setTimeout(() => {
            chrome.tabs.sendMessage(activeTab.id, { type: 'QUERY_PAGE_STATUS' }, (res) => {
              if (res) renderAnimeStatus(res);
            });
          }, 150);
        });
      }
    });
  }

  // 1. Загрузка настроек
  const settings = await chrome.storage.local.get([
    'showTimelineMarkers',
    'offsetSeconds',
    'cloudflareWorkerUrl',
    'enableCloudflareSync'
  ]);

  if (showMarkersInput) {
    showMarkersInput.checked = settings.showTimelineMarkers !== false;
    showMarkersInput.addEventListener('change', () => {
      chrome.storage.local.set({ showTimelineMarkers: showMarkersInput.checked });
    });
  }

  const currentOffset = settings.offsetSeconds || 0;
  if (offsetSlider && offsetVal) {
    offsetSlider.value = currentOffset;
    offsetVal.textContent = `${currentOffset > 0 ? '+' : ''}${currentOffset} сек`;

    offsetSlider.addEventListener('input', () => {
      const val = parseFloat(offsetSlider.value);
      offsetVal.textContent = `${val > 0 ? '+' : ''}${val} сек`;
    });

    offsetSlider.addEventListener('change', () => {
      const val = parseFloat(offsetSlider.value);
      chrome.storage.local.set({ offsetSeconds: val });
    });
  }

  // 2. Статус и проверка Cloudflare Worker
  function testCloudflare() {
    if (cfStatusBadge) {
      cfStatusBadge.className = 'cf-status-badge';
      cfStatusBadge.textContent = '⏳ Проверка…';
    }
    if (cfHint) cfHint.textContent = 'Подключение к облачной базе…';

    chrome.runtime.sendMessage({ type: 'TEST_CLOUDFLARE_CONNECTION', workerUrl: CLOUDFLARE_WORKER_URL }, (res) => {
      if (chrome.runtime.lastError || !res || !res.success) {
        if (cfStatusBadge) {
          cfStatusBadge.className = 'cf-status-badge cf-error';
          cfStatusBadge.textContent = '🔴 Ошибка';
        }
        if (cfHint) cfHint.textContent = res?.error || 'Сервер временно недоступен';
      } else {
        if (cfStatusBadge) {
          cfStatusBadge.className = 'cf-status-badge cf-connected';
          cfStatusBadge.textContent = '🟢 Подключено';
        }
        if (cfHint) cfHint.textContent = 'Синхронизация активна. База доступна';
      }
    });
  }

  // Всегда проверяем статус при открытии попапа
  testCloudflare();

  // 3. Управление аккаунтом автора
  const userRoleBadge = document.getElementById('user-role-badge');
  const authGuestView = document.getElementById('auth-guest-view');
  const authLoggedView = document.getElementById('auth-logged-view');
  const userTokenInput = document.getElementById('user-token-input');
  const btnSaveToken = document.getElementById('btn-save-token');
  const userDisplayName = document.getElementById('user-display-name');
  const userStatsText = document.getElementById('user-stats-text');
  const btnUserLogout = document.getElementById('btn-user-logout');
  const linkOpenWebRegister = document.getElementById('link-open-web-register');

  async function updateAuthUI() {
    const data = await chrome.storage.local.get(['apiToken', 'currentUser']);
    if (data.apiToken && data.currentUser) {
      const u = data.currentUser;
      if (authGuestView) authGuestView.style.display = 'none';
      if (authLoggedView) authLoggedView.style.display = 'block';
      if (userDisplayName) userDisplayName.textContent = u.username;
      if (userStatsText) userStatsText.textContent = `Метки: ${u.stats?.submissions || 0} отправлено • ${u.stats?.approved || 0} одобрено`;

      if (userRoleBadge) {
        if (u.role === 'trusted') {
          userRoleBadge.className = 'user-role-badge role-trusted';
          userRoleBadge.textContent = '⭐ Редактор';
        } else if (u.role === 'admin') {
          userRoleBadge.className = 'user-role-badge role-admin';
          userRoleBadge.textContent = '👑 Админ';
        } else {
          userRoleBadge.className = 'user-role-badge role-user';
          userRoleBadge.textContent = 'Автор';
        }
      }
    } else {
      if (authGuestView) authGuestView.style.display = 'block';
      if (authLoggedView) authLoggedView.style.display = 'none';
      if (userRoleBadge) {
        userRoleBadge.className = 'user-role-badge';
        userRoleBadge.textContent = 'Гость (Чтение)';
      }
    }
  }

  await updateAuthUI();

  if (btnSaveToken && userTokenInput) {
    btnSaveToken.addEventListener('click', () => {
      const token = userTokenInput.value.trim();
      if (!token) return;

      btnSaveToken.disabled = true;
      btnSaveToken.textContent = '…';

      chrome.runtime.sendMessage({ type: 'VERIFY_TOKEN', token }, (res) => {
        btnSaveToken.disabled = false;
        btnSaveToken.textContent = 'Войти';

        if (res && res.success) {
          userTokenInput.value = '';
          updateAuthUI();
        } else {
          alert(res?.error || 'Неверный токен. Проверьте правильность ввода.');
        }
      });
    });

    userTokenInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') btnSaveToken.click();
    });
  }

  if (btnUserLogout) {
    btnUserLogout.addEventListener('click', () => {
      chrome.runtime.sendMessage({ type: 'LOGOUT_USER' }, () => {
        updateAuthUI();
      });
    });
  }

  if (linkOpenWebRegister) {
    linkOpenWebRegister.addEventListener('click', (e) => {
      e.preventDefault();
      chrome.tabs.create({ url: CLOUDFLARE_WORKER_URL });
    });
  }

  // 3. Получение информации об активной вкладке
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const activeTab = tabs[0];
    if (!activeTab?.id) return;

    // Сначала опрашиваем вкладку напрямую
    chrome.tabs.sendMessage(activeTab.id, { type: 'QUERY_PAGE_STATUS' }, (res) => {
      if (!chrome.runtime.lastError && res && (res.episode || res.malId || res.title || res.hasVideo)) {
        renderAnimeStatus(res);
        return;
      }

      // Если вкладка не ответила, запрашиваем через background
      chrome.runtime.sendMessage({ type: 'GET_ACTIVE_POPUP_INFO' }, (bgRes) => {
        if (bgRes && bgRes.session) {
          renderAnimeStatus(bgRes.session);
        } else {
          const url = activeTab.url || '';
          if (url.includes('animeon.')) {
            if (animeTitle) animeTitle.textContent = 'Страница открыта, ожидание плеера';
            if (animeMeta) animeMeta.textContent = 'Нажмите «Смотреть» или выберите серию';
            if (playerStatusText) playerStatusText.textContent = 'Ожидание видео';
          } else {
            if (animeTitle) animeTitle.textContent = 'Вкладка не на AnimeOn';
            if (animeMeta) animeMeta.textContent = 'Откройте сайт animeon.cc';
            if (playerStatusText) playerStatusText.textContent = 'Нет активности';
          }
        }
      });
    });
  });

  function renderAnimeStatus(data) {
    if (!data) return;

    if (playerStatusDot && playerStatusText) {
      if (data.hasVideo) {
        playerStatusDot.classList.add('dot-active');
        playerStatusText.textContent = 'Плеер активен';
      } else {
        playerStatusDot.classList.remove('dot-active');
        playerStatusText.textContent = 'Поиск видео…';
      }
    }

    if (animeTitle && data.title) {
      animeTitle.textContent = data.title;
    }

    currentEpisode = data.episode || 1;
    if (epDisplay) {
      epDisplay.textContent = `Серия ${currentEpisode}`;
    }

    if (animeMeta && data.malId) {
      animeMeta.textContent = `ID тайтла: ${data.malId}`;
    }

    // Отображение источника таймкодов
    if (timingStatus) {
      const op = data.skipData?.op;
      const ed = data.skipData?.ed;
      const timeStr = op ? `${formatTime(op[0])} — ${formatTime(op[1])}` : (ed ? `ED: ${formatTime(ed[0])} — ${formatTime(ed[1])}` : '');

      if (data.skipData?.source === 'cloudflare' && (op || ed)) {
        timingStatus.innerHTML = `<span class="timing-tag tag-success">☁️ База Cloudflare ${timeStr ? '(' + timeStr + ')' : ''}</span>`;
      } else if (data.skipData?.source === 'custom' && (op || ed)) {
        timingStatus.innerHTML = `
          <div class="timing-custom-row">
            <span class="timing-tag tag-custom" title="Сохранено в локальной памяти браузера на вашем ПК">💾 Локально: ${timeStr}</span>
            <button class="btn-clear-skip" id="btn-clear-skip" title="Удалить этот локальный таймкод">🗑️ Сбросить</button>
          </div>
        `;
        const btnClear = document.getElementById('btn-clear-skip');
        if (btnClear) {
          btnClear.addEventListener('click', (e) => {
            e.stopPropagation();
            btnClear.disabled = true;
            btnClear.textContent = '…';
            chrome.runtime.sendMessage({
              type: 'CLEAR_CUSTOM_SKIP',
              malId: data.malId,
              episode: data.episode || 1
            }, () => {
              timingStatus.innerHTML = `<span class="timing-tag">Таймкоды не найдены</span>`;
              chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
                if (tabs[0]?.id) {
                  chrome.tabs.sendMessage(tabs[0].id, { type: 'REFRESH_TIMINGS' });
                }
              });
            });
          });
        }
      } else {
        timingStatus.innerHTML = `<span class="timing-tag">Таймкоды не найдены</span>`;
      }
    }
  }

  function formatTime(sec) {
    if (sec === undefined || sec === null || isNaN(sec)) return '00:00';
    const total = Math.max(0, Math.floor(sec));
    const m = Math.floor(total / 60);
    const s = total % 60;
    const mm = m < 10 ? `0${m}` : `${m}`;
    const ss = s < 10 ? `0${s}` : `${s}`;
    return `${mm}:${ss}`;
  }
});
