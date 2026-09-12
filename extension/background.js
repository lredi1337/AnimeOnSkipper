/**
 * AnimeOn Skipper — Service Worker (Background) v2.3.0
 * Управляет сессиями вкладок и взаимодействием с Cloudflare Worker API.
 * Поддерживает аутентификацию пользователей, токены и систему консенсуса.
 */

// Единый адрес облачного бэкенда базы данных
const CLOUDFLARE_WORKER_URL = 'https://animeon-skipp.ruscadred.workers.dev';

// Управление сессиями активных вкладок
async function saveTabSession(tabId, data) {
  if (!tabId) return;
  try {
    const key = `session_tab_${tabId}`;
    await chrome.storage.local.set({ [key]: { ...data, updatedAt: Date.now() } });
  } catch (e) {
    console.warn('[AnimeOn Skipper] Ошибка сохранения сессии вкладки:', e);
  }
}

async function getTabSession(tabId) {
  if (!tabId) return null;
  try {
    const key = `session_tab_${tabId}`;
    const res = await chrome.storage.local.get([key]);
    return res[key] || null;
  } catch (e) {
    return null;
  }
}

// Запрос к Cloudflare Worker API для получения таймкода серии (доступно всем без авторизации)
async function fetchFromCloudflare(workerUrl, malId, episode) {
  try {
    if (!workerUrl) return null;
    const cleanUrl = workerUrl.trim().replace(/\/+$/, '');
    const apiUrl = `${cleanUrl}/api/skip?malId=${malId}&episode=${episode}`;

    const res = await fetch(apiUrl, { cache: 'no-cache' });
    if (!res.ok) return null;
    const json = await res.json();
    return json;
  } catch (e) {
    console.warn('[AnimeOn Skipper] Ошибка запроса к Cloudflare Worker:', e);
    return null;
  }
}

// Отправка таймкода в Cloudflare Worker API (требует apiToken)
async function pushToCloudflare(workerUrl, data, apiToken) {
  try {
    if (!workerUrl) return { success: false, reason: 'no_url' };
    const cleanUrl = workerUrl.trim().replace(/\/+$/, '');
    const apiUrl = `${cleanUrl}/api/skip`;

    const headers = {
      'Content-Type': 'application/json',
    };
    if (apiToken) {
      headers['Authorization'] = `Bearer ${apiToken.trim()}`;
    }

    const res = await fetch(apiUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(data),
    });

    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      return {
        success: false,
        status: res.status,
        needAuth: res.status === 401 || !!json.needAuth,
        error: json.error || `Ошибка сервера (${res.status})`
      };
    }

    return { success: true, json };
  } catch (e) {
    console.warn('[AnimeOn Skipper] Ошибка отправки в Cloudflare Worker:', e);
    return { success: false, error: e.message };
  }
}

// Проверка токена пользователя через /api/auth/me
async function verifyUserToken(workerUrl, token) {
  if (!workerUrl || !token) return { success: false, error: 'Укажите адрес сервера и токен' };
  try {
    const cleanUrl = workerUrl.trim().replace(/\/+$/, '');
    const res = await fetch(`${cleanUrl}/api/auth/me`, {
      headers: { 'Authorization': `Bearer ${token.trim()}` }
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.authenticated && data.user) {
      await chrome.storage.local.set({
        apiToken: token.trim(),
        currentUser: data.user
      });
      return { success: true, user: data.user };
    }
    return { success: false, error: data.error || 'Неверный или недействительный токен' };
  } catch (e) {
    return { success: false, error: e.message || 'Ошибка подключения к серверу' };
  }
}

// Запрос таймингов напрямую из AniSkip (через Worker с прямым fallback на API)
async function fetchFromAniSkip(workerUrl, malId, episode) {
  if (!malId || !episode) return { found: false };
  // 1. Пробуем через прокси Cloudflare Worker (с встроенной валидацией)
  try {
    const cleanUrl = (workerUrl || '').trim().replace(/\/+$/, '');
    if (cleanUrl) {
      const res = await fetch(`${cleanUrl}/api/aniskip/query?malId=${malId}&episode=${episode}`);
      if (res.ok) {
        const data = await res.json();
        if (data && data.found && (data.op || data.ed)) {
          return { found: true, op: data.op, ed: data.ed };
        }
      }
    }
  } catch (e) {
    console.warn('[AnimeOn Skipper] Запрос AniSkip через Worker не удался:', e);
  }

  // 2. Прямой fallback на api.aniskip.com
  try {
    const res = await fetch(`https://api.aniskip.com/v2/skip-times/${malId}/${episode}?types%5B%5D=op&types%5B%5D=ed&episodeLength=0`);
    if (res.ok) {
      const data = await res.json();
      if (data && data.found && Array.isArray(data.results)) {
        let op = null;
        let ed = null;
        for (const r of data.results) {
          if (r.skipType === 'op' && r.interval) {
            op = [Math.floor(r.interval.startTime), Math.floor(r.interval.endTime)];
          } else if (r.skipType === 'ed' && r.interval) {
            ed = [Math.floor(r.interval.startTime), Math.floor(r.interval.endTime)];
          }
        }
        if (op || ed) {
          return { found: true, op, ed };
        }
      }
    }
  } catch (e) {
    console.warn('[AnimeOn Skipper] Прямой запрос к AniSkip API не удался:', e);
  }

  return { found: false };
}

// Автоматическая фоновая синхронизация профиля при запуске
chrome.runtime.onStartup.addListener(() => {
  chrome.storage.local.get(['apiToken'], (res) => {
    if (res.apiToken) verifyUserToken(CLOUDFLARE_WORKER_URL, res.apiToken);
  });
});
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get(['apiToken'], (res) => {
    if (res.apiToken) verifyUserToken(CLOUDFLARE_WORKER_URL, res.apiToken);
  });
});

// Обработчик сообщений расширения
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const tabId = sender?.tab?.id;

  switch (message.type) {
    case 'REGISTER_TAB_ANIME': {
      if (tabId) {
        saveTabSession(tabId, {
          malId: message.malId,
          episode: message.episode,
          title: message.title,
          hasVideo: message.hasVideo || false
        }).then(() => sendResponse({ status: 'ok' }));
        return true;
      }
      sendResponse({ status: 'no_tab' });
      return false;
    }

    case 'GET_TAB_ANIME': {
      getTabSession(tabId).then((session) => {
        sendResponse({ session });
      });
      return true;
    }

    // Запрос таймкодов из собственной базы Cloudflare Worker
    case 'FETCH_TIMINGS': {
      const { malId, episode } = message;
      if (!malId || !episode) {
        sendResponse({ success: false, error: 'Отсутствует malId или episode' });
        return false;
      }

      (async () => {
        const cfData = await fetchFromCloudflare(CLOUDFLARE_WORKER_URL, malId, episode);
        if (cfData && cfData.found && (cfData.op || cfData.ed)) {
          sendResponse({
            success: true,
            source: cfData.source || 'cloudflare',
            found: true,
            op: cfData.op,
            ed: cfData.ed,
            votes: cfData.votes || 1,
            author: cfData.author || null,
            animeonProfile: cfData.animeonProfile || null
          });
          return;
        } else if (cfData && cfData.inReview) {
          sendResponse({
            success: true,
            found: false,
            inReview: true,
            votes: cfData.votes || 0,
            required: cfData.required || 3
          });
          return;
        }

        sendResponse({ success: true, found: false });
      })();

      return true;
    }

    // Запрос таймкодов из базы AniSkip (для автоподсказок редакторам и админам)
    case 'FETCH_ANISKIP_TIMINGS': {
      const { malId, episode } = message;
      fetchFromAniSkip(CLOUDFLARE_WORKER_URL, malId, episode).then((res) => {
        sendResponse({ success: true, ...res });
      }).catch((err) => {
        sendResponse({ success: false, found: false, error: err.message });
      });
      return true;
    }

    // Принудительное обновление роли и профиля пользователя из базы
    case 'REFRESH_USER_PROFILE': {
      chrome.storage.local.get(['apiToken'], async (res) => {
        if (!res.apiToken) {
          sendResponse({ success: false, error: 'Токен отсутствует' });
          return;
        }
        const verifyRes = await verifyUserToken(CLOUDFLARE_WORKER_URL, res.apiToken);
        sendResponse(verifyRes);
      });
      return true;
    }

    // Автоматический экспорт нативных таймингов AnimeOn в базу Cloudflare
    case 'AUTO_SUBMIT_NATIVE_TIMINGS': {
      const { malId, episode, op, ed, title, totalEpisodes } = message;
      if (!malId || !episode || (!op && !ed)) {
        sendResponse({ success: false, reason: 'invalid_payload' });
        return true;
      }

      // 1. Проверяем текущее состояние в базе Cloudflare Worker
      fetchFromCloudflare(CLOUDFLARE_WORKER_URL, malId, episode).then(async (cfData) => {
        // Не перезаписываем только подтвержденные вручную тайминги доверенных пользователей/админов (если не передан флаг overwrite)
        if (!message.overwrite && cfData && cfData.success && cfData.found && cfData.op && cfData.ed && cfData.source !== 'aniskip-pending' && cfData.source !== 'animeon_native') {
          sendResponse({ success: true, alreadyExists: true });
          return;
        }

        chrome.storage.local.get(['apiToken'], async (res) => {
          const token = res.apiToken || '';
          const pushRes = await pushToCloudflare(CLOUDFLARE_WORKER_URL, {
            malId,
            episode,
            title: title || '',
            totalEpisodes: totalEpisodes || null,
            op: op || null,
            ed: ed || null,
            source: 'animeon_native'
          }, token);

          sendResponse({
            success: true,
            saved: !!(pushRes && pushRes.success)
          });
        });
      }).catch(() => {
        sendResponse({ success: false });
      });

      return true;
    }

    // Сохранение кастомного таймкода серии (требует обязательной авторизации)
    case 'SAVE_CUSTOM_SKIP': {
      const { malId, episode, op, ed, title, totalEpisodes } = message;
      const key = `${malId}:${episode}`;

      chrome.storage.local.get([
        'customSkips',
        'apiToken',
        'currentUser'
      ], async (result) => {
        // Проверка авторизации
        if (!result.apiToken) {
          sendResponse({
            success: false,
            needAuth: true,
            error: 'Для отправки меток необходимо авторизоваться. Откройте меню расширения и войдите в аккаунт.'
          });
          return;
        }

        // Сохраняем локально для быстрого отклика
        const customSkips = result.customSkips || {};
        customSkips[key] = {
          op: op || customSkips[key]?.op || null,
          ed: ed || customSkips[key]?.ed || null,
          title: title || customSkips[key]?.title || '',
          totalEpisodes: totalEpisodes || null,
          updatedAt: Date.now()
        };
        await chrome.storage.local.set({ customSkips });

        // Отправка в Cloudflare Worker
        const cfResult = await pushToCloudflare(CLOUDFLARE_WORKER_URL, {
          malId,
          episode,
          op: customSkips[key].op,
          ed: customSkips[key].ed,
          title: customSkips[key].title,
          totalEpisodes: customSkips[key].totalEpisodes
        }, result.apiToken);

        if (cfResult && !cfResult.success && cfResult.needAuth) {
          sendResponse({
            success: false,
            needAuth: true,
            error: cfResult.error || 'Токен авторизации недействителен. Войдите снова.'
          });
          return;
        }

        sendResponse({
          success: true,
          record: customSkips[key],
          cloudflare: cfResult
        });
      });

      return true;
    }

    // Проверка и сохранение API токена пользователя
    case 'VERIFY_TOKEN': {
      const { token } = message;
      verifyUserToken(CLOUDFLARE_WORKER_URL, token).then(sendResponse);
      return true;
    }

    // Выход из аккаунта в расширении
    case 'LOGOUT_USER': {
      chrome.storage.local.remove(['apiToken', 'currentUser'], () => {
        sendResponse({ success: true });
      });
      return true;
    }

    // Сброс локального таймкода текущей серии
    case 'CLEAR_CUSTOM_SKIP': {
      const { malId, episode, key: directKey } = message;
      const key = directKey || `${malId}:${episode}`;
      chrome.storage.local.get(['customSkips'], async (result) => {
        const customSkips = result.customSkips || {};
        delete customSkips[key];
        await chrome.storage.local.set({ customSkips });
        sendResponse({ success: true });
      });
      return true;
    }

    // Сброс всех локальных таймкодов
    case 'CLEAR_ALL_CUSTOM_SKIPS': {
      chrome.storage.local.set({ customSkips: {} }, () => {
        sendResponse({ success: true });
      });
      return true;
    }

    // Тестирование подключения к Cloudflare Worker
    case 'TEST_CLOUDFLARE_CONNECTION': {
      const targetUrl = message.workerUrl || CLOUDFLARE_WORKER_URL;

      (async () => {
        try {
          const cleanUrl = targetUrl.trim().replace(/\/+$/, '');
          const res = await fetch(`${cleanUrl}/api/stats`, { cache: 'no-cache' });
          if (!res.ok) {
            sendResponse({ success: false, status: res.status, error: `Статус ответа ${res.status}` });
            return;
          }
          const data = await res.json();
          sendResponse({ success: true, data });
        } catch (e) {
          sendResponse({ success: false, error: e.message || 'Сервер недоступен' });
        }
      })();

      return true;
    }

    // Получение актуального статуса для popup окна
    case 'GET_ACTIVE_POPUP_INFO': {
      chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
        const activeTab = tabs[0];
        if (!activeTab?.id) {
          sendResponse({ session: null });
          return;
        }

        try {
          chrome.tabs.sendMessage(activeTab.id, { type: 'QUERY_PAGE_STATUS' }, (tabRes) => {
            if (!chrome.runtime.lastError && tabRes && tabRes.malId) {
              sendResponse({ session: tabRes });
              return;
            }

            getTabSession(activeTab.id).then((session) => {
              sendResponse({ session });
            });
          });
        } catch (e) {
          const session = await getTabSession(activeTab.id);
          sendResponse({ session });
        }
      });
      return true;
    }

    default:
      break;
  }
});
