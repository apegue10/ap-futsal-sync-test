
/* AP FUTSAL — sincronización en la nube
   Rama de pruebas: session-auto-refresh-test
*/
(() => {
  'use strict';

  const AP_CLOUD_URL = 'https://hzcqbmrefjxpuchshgkr.supabase.co';
  const AP_CLOUD_KEY = 'sb_publishable_-URM75mTiyLMbOh112uhgw_f-cM6LGF';
  const SESSION_KEY = 'ap-futsal-cloud-session-v1';
  const TEAM_KEY = 'ap-futsal-cloud-team-v1';
  const PENDING_KEY = 'ap-futsal-cloud-pending-matches-v1';

  let refreshInFlight = null;
  let syncInFlight = null;
  let syncTimer = null;

  function getSession() {
    try {
      return JSON.parse(localStorage.getItem(SESSION_KEY) || 'null');
    } catch (_) {
      return null;
    }
  }

  function getTeam() {
    try {
      return JSON.parse(localStorage.getItem(TEAM_KEY) || 'null');
    } catch (_) {
      return null;
    }
  }

  function pendingMatches() {
    try {
      const value = JSON.parse(localStorage.getItem(PENDING_KEY) || '[]');
      return Array.isArray(value) ? value : [];
    } catch (_) {
      return [];
    }
  }

  function savePendingMatches(matches) {
    localStorage.setItem(PENDING_KEY, JSON.stringify(matches));
  }

  function status(id, message) {
    const element = document.getElementById(id);
    if (element) element.textContent = message;
  }

  function input(id) {
    const element = document.getElementById(id);
    return element ? element.value.trim() : '';
  }

  function saveSession(session) {
    if (!session || !session.access_token) {
      throw new Error('No se recibió una sesión válida.');
    }

    const saved = {
      ...(getSession() || {}),
      ...session,
      expires_at: session.expires_at ||
        (session.expires_in
          ? Math.floor(Date.now() / 1000) + Number(session.expires_in)
          : null)
    };

    localStorage.setItem(SESSION_KEY, JSON.stringify(saved));
    return saved;
  }

  async function refreshSession() {
    if (refreshInFlight) return refreshInFlight;

    refreshInFlight = (async () => {
      const session = getSession();

      if (!session || !session.refresh_token) {
        throw new Error(
          'La sesión ha caducado. Conéctate a Internet e inicia sesión de nuevo.'
        );
      }

      const response = await fetch(
        AP_CLOUD_URL.replace(/\/$/, '') +
          '/auth/v1/token?grant_type=refresh_token',
        {
          method: 'POST',
          headers: {
            apikey: AP_CLOUD_KEY,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            refresh_token: session.refresh_token
          })
        }
      );

      const data = await response.json().catch(() => null);

      if (!response.ok || !data || !data.access_token) {
        throw new Error(
          data?.message ||
          data?.msg ||
          'No se pudo renovar la sesión. Inicia sesión de nuevo.'
        );
      }

      return saveSession(data);
    })();

    try {
      return await refreshInFlight;
    } finally {
      refreshInFlight = null;
    }
  }

  async function request(path, options = {}) {
    if (
      !AP_CLOUD_URL || AP_CLOUD_URL.startsWith('__') ||
      !AP_CLOUD_KEY || AP_CLOUD_KEY.startsWith('__')
    ) {
      throw new Error(
        'La conexión con Supabase todavía no está configurada.'
      );
    }

    const isAuthFlow =
      path.startsWith('/auth/v1/token?grant_type=password') ||
      path.startsWith('/auth/v1/signup') ||
      path.startsWith('/auth/v1/token?grant_type=refresh_token');

    let session = getSession();

    if (
      !isAuthFlow &&
      session?.refresh_token &&
      session.expires_at &&
      Number(session.expires_at) * 1000 <= Date.now() + 60000
    ) {
      session = await refreshSession();
    }

    async function send() {
      const headers = {
        apikey: AP_CLOUD_KEY,
        'Content-Type': 'application/json',
        ...(session?.access_token
          ? { Authorization: 'Bearer ' + session.access_token }
          : {}),
        ...(options.headers || {})
      };

      const response = await fetch(
        AP_CLOUD_URL.replace(/\/$/, '') + path,
        { ...options, headers }
      );

      const raw = await response.text();
      let data;

      try {
        data = raw ? JSON.parse(raw) : null;
      } catch (_) {
        data = raw;
      }

      return { response, data };
    }

    let result = await send();

    if (
      result.response.status === 401 &&
      !isAuthFlow &&
      session?.refresh_token
    ) {
      session = await refreshSession();
      result = await send();
    }

    if (!result.response.ok) {
      const data = result.data;
      throw new Error(
        data?.message ||
        data?.msg ||
        data?.error_description ||
        data?.details ||
        (typeof data === 'string' && data
          ? data
          : 'Error HTTP ' + result.response.status)
      );
    }

    return result.data;
  }

  function requireSession() {
    const session = getSession();

    if (!session || !session.access_token || !session.user || !session.user.id) {
      throw new Error('Inicia sesión primero.');
    }

    return session;
  }

  function refreshStatus() {
    const session = getSession();
    const team = getTeam();

    if (session && session.access_token) {
      status(
        'cloud-auth-status',
        'Sesión iniciada: ' + (session.user?.email || 'cuenta')
      );
    }

    if (team && team.id) {
      status(
        'cloud-team-status',
        'Equipo seleccionado: ' + team.name +
        ' · Código: ' + team.invite_code
      );
    }
  }

  async function cloudSignIn() {
    try {
      const email = input('cloud-email');
      const password = document.getElementById('cloud-password')?.value || '';

      if (!email || !password) {
        throw new Error('Escribe el correo y la contraseña.');
      }

      const data = await request('/auth/v1/token?grant_type=password', {
        method: 'POST',
        body: JSON.stringify({ email, password })
      });

      if (!data || !data.access_token) {
        throw new Error('No se recibió una sesión válida.');
      }

      saveSession(data);
      status('cloud-auth-status', 'Sesión iniciada: ' + (data.user?.email || email));
      refreshStatus();
      syncPendingMatches();
    } catch (error) {
      status('cloud-auth-status', 'Error al iniciar sesión: ' + error.message);
    }
  }

  async function cloudSignUp() {
    try {
      const email = input('cloud-email');
      const password = document.getElementById('cloud-password')?.value || '';

      if (!email || password.length < 6) {
        throw new Error('Escribe un correo y una contraseña de al menos 6 caracteres.');
      }

      const data = await request('/auth/v1/signup', {
        method: 'POST',
        body: JSON.stringify({ email, password })
      });

      if (data && data.access_token) {
        saveSession(data);
        status('cloud-auth-status', 'Cuenta creada y sesión iniciada: ' + email);
        refreshStatus();
      } else {
        status(
          'cloud-auth-status',
          'Cuenta creada. Revisa tu correo para confirmarla y después inicia sesión.'
        );
      }
    } catch (error) {
      status('cloud-auth-status', 'Error al crear la cuenta: ' + error.message);
    }
  }

  async function cloudSignOut() {
    try {
      const session = getSession();

      if (session && session.access_token) {
        await request('/auth/v1/logout', { method: 'POST' });
      }
    } catch (_) {
      // Se cierra la sesión local aunque falle la petición remota.
    }

    localStorage.removeItem(SESSION_KEY);
    status('cloud-auth-status', 'Sesión cerrada. Los datos locales se conservan.');
  }

  async function loadTeam(id) {
    const rows = await request(
      '/rest/v1/teams?id=eq.' + encodeURIComponent(id) +
      '&select=id,name,invite_code'
    );

    if (!Array.isArray(rows) || !rows.length) {
      throw new Error('No se pudo recuperar el equipo. Comprueba los permisos.');
    }

    localStorage.setItem(TEAM_KEY, JSON.stringify(rows[0]));
    refreshStatus();
    return rows[0];
  }

  function resultId(result, rpcName) {
    if (typeof result === 'string') return result;

    if (Array.isArray(result)) {
      const first = result[0];
      return typeof first === 'string'
        ? first
        : first && (first.id || first[rpcName]);
    }

    return result && (result.id || result[rpcName]);
  }

  async function cloudCreateTeam() {
    try {
      requireSession();

      const name = input('cloud-team-name');
      if (!name) throw new Error('Escribe el nombre del equipo.');

      const result = await request('/rest/v1/rpc/create_team', {
        method: 'POST',
        body: JSON.stringify({ team_name: name })
      });

      const id = resultId(result, 'create_team');
      if (!id) throw new Error('No se recibió el identificador del equipo.');

      const team = await loadTeam(id);
      status(
        'cloud-team-status',
        'Equipo creado: ' + team.name + ' · Código: ' + team.invite_code
      );
    } catch (error) {
      status('cloud-team-status', 'Error al crear el equipo: ' + error.message);
    }
  }

  async function cloudJoinTeam() {
    try {
      requireSession();

      const code = input('cloud-invite-code').toUpperCase();
      if (!code) throw new Error('Introduce el código de invitación.');

      const result = await request('/rest/v1/rpc/join_team', {
        method: 'POST',
        body: JSON.stringify({ invite_code_input: code })
      });

      const id = resultId(result, 'join_team');
      if (!id) throw new Error('No se recibió el identificador del equipo.');

      const team = await loadTeam(id);
      status(
        'cloud-team-status',
        'Te has unido a: ' + team.name + ' · Código: ' + team.invite_code
      );
    } catch (error) {
      status('cloud-team-status', 'Error al unirte al equipo: ' + error.message);
    }
  }

  async function uploadState() {
    const session = requireSession();
    const team = getTeam();

    if (!team || !team.id) {
      throw new Error('Crea un equipo o únete a uno primero.');
    }

    if (
      typeof S === 'undefined' ||
      typeof STORAGE_KEY === 'undefined' ||
      typeof TEMPLATE_KEY === 'undefined'
    ) {
      throw new Error('La aplicación principal todavía no está conectada.');
    }

    if (!navigator.onLine) {
      throw new Error('No hay conexión. El partido permanece guardado en este dispositivo.');
    }

    const existing = await request(
      '/rest/v1/team_app_data?team_id=eq.' +
      encodeURIComponent(team.id) + '&select=updated_by'
    );

    if (
      Array.isArray(existing) &&
      existing.length &&
      existing[0].updated_by &&
      existing[0].updated_by !== session.user.id
    ) {
      throw new Error(
        'La nube fue actualizada por otra cuenta. No se han subido cambios para evitar sobrescribir sus datos.'
      );
    }

    const templateRaw = localStorage.getItem(TEMPLATE_KEY);
    const payload = {
      format: 1,
      state: S,
      template: templateRaw ? JSON.parse(templateRaw) : null
    };

    await request('/rest/v1/team_app_data?on_conflict=team_id', {
      method: 'POST',
      headers: {
        Prefer: 'resolution=merge-duplicates,return=minimal'
      },
      body: JSON.stringify({
        team_id: team.id,
        payload,
        updated_by: session.user.id,
        updated_at: new Date().toISOString()
      })
    });
  }

  async function cloudPush() {
    try {
      requireSession();
      const team = getTeam();

      if (!team || !team.id) {
        throw new Error('Crea un equipo o únete a uno primero.');
      }

      if (!confirm(
        'Se compartirán los datos actuales del partido y la plantilla con el equipo. ¿Continuar?'
      )) return;

      await uploadState();
      savePendingMatches([]);
      status('cloud-team-status', 'Datos subidos correctamente.');
    } catch (error) {
      status('cloud-team-status', 'Error al subir los datos: ' + error.message);
    }
  }

  async function cloudPull() {
    try {
      requireSession();

      const team = getTeam();
      if (!team || !team.id) {
        throw new Error('Crea un equipo o únete a uno primero.');
      }

      if (pendingMatches().length) {
        throw new Error(
          'Hay partidos pendientes de subir. Conéctate a Internet y sincronízalos antes de descargar datos.'
        );
      }

      if (!confirm(
        'ATENCIÓN: descargar reemplazará los datos locales por los compartidos. ' +
        'Haz antes una copia JSON. ¿Continuar?'
      )) return;

      const rows = await request(
        '/rest/v1/team_app_data?team_id=eq.' +
        encodeURIComponent(team.id) + '&select=payload,updated_at'
      );

      if (!Array.isArray(rows) || !rows.length) {
        throw new Error('Todavía no hay datos compartidos. Súbelos primero desde el otro dispositivo.');
      }

      const payload = rows[0].payload;
      if (!payload || !payload.state) {
        throw new Error('Los datos de la nube no tienen el formato esperado.');
      }

      if (
        typeof STORAGE_KEY === 'undefined' ||
        typeof TEMPLATE_KEY === 'undefined' ||
        typeof load !== 'function' ||
        typeof renderAll !== 'function'
      ) {
        throw new Error('La aplicación principal todavía no está conectada.');
      }

      localStorage.setItem(STORAGE_KEY, JSON.stringify(payload.state));

      if (payload.template) {
        localStorage.setItem(TEMPLATE_KEY, JSON.stringify(payload.template));
      }

      load();
      renderAll();

      status('cloud-team-status', 'Datos descargados correctamente.');
    } catch (error) {
      status('cloud-team-status', 'Error al descargar los datos: ' + error.message);
    }
  }

  function queueArchivedMatch(matchId) {
    if (!matchId) return;

    const pending = pendingMatches();
    if (!pending.includes(matchId)) {
      pending.push(matchId);
      savePendingMatches(pending);
    }

    if (!navigator.onLine) {
      status(
        'cloud-team-status',
        'Partido guardado en este dispositivo. Se sincronizará al recuperar Internet.'
      );
      return;
    }

    clearTimeout(syncTimer);
    syncTimer = setTimeout(syncPendingMatches, 1200);
  }

  async function syncPendingMatches() {
    if (syncInFlight) return syncInFlight;
    if (!navigator.onLine || !pendingMatches().length) return;

    syncInFlight = (async () => {
      const batch = pendingMatches().slice();

      try {
        await uploadState();

        const remaining = pendingMatches().filter(id => !batch.includes(id));
        savePendingMatches(remaining);

        status(
          'cloud-team-status',
          remaining.length
            ? 'Partido sincronizado. Quedan partidos pendientes.'
            : 'Partidos pendientes sincronizados correctamente.'
        );
      } catch (error) {
        status(
          'cloud-team-status',
          'Partido guardado localmente. Pendiente de sincronizar: ' + error.message
        );
      }
    })();

    try {
      await syncInFlight;
    } finally {
      syncInFlight = null;
    }
  }

  function installMatchQueue() {
    function wrapArchiveFunction(name) {
      const original = window[name];
      if (typeof original !== 'function' || original.__apCloudWrapped) return;

      const wrapped = function (...args) {
        const before = new Set(
          Array.isArray(S?.matchHistory)
            ? S.matchHistory.map(match => match && match.id).filter(Boolean)
            : []
        );

        const result = original.apply(this, args);

        const history = Array.isArray(S?.matchHistory) ? S.matchHistory : [];
        history.forEach(match => {
          if (match && match.id && !before.has(match.id)) {
            queueArchivedMatch(match.id);
          }
        });

        return result;
      };

      wrapped.__apCloudWrapped = true;
      window[name] = wrapped;
    }

    wrapArchiveFunction('archiveCurrentMatch');
    wrapArchiveFunction('saveCurrentMatch');
  }

  window.cloudSignIn = cloudSignIn;
  window.cloudSignUp = cloudSignUp;
  window.cloudSignOut = cloudSignOut;
  window.cloudCreateTeam = cloudCreateTeam;
  window.cloudJoinTeam = cloudJoinTeam;
  window.cloudPush = cloudPush;
  window.cloudPull = cloudPull;

  window.addEventListener('online', syncPendingMatches);

  window.addEventListener('load', () => {
    refreshStatus();
    installMatchQueue();
    syncPendingMatches();
  });

  // Permite instalar la cola también si este archivo se carga después del evento load.
  if (document.readyState === 'complete') {
    installMatchQueue();
    syncPendingMatches();
  }
})();
       
