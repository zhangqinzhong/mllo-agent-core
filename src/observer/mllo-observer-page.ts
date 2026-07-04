export function renderMlloObserverPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>mllo Observer</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f7f7f5;
      --panel: #ffffff;
      --border: #e5e2dc;
      --muted: #7d7972;
      --text: #23211e;
      --accent: #e66d45;
      --accent-soft: #fff0ea;
      --code: #f1efeb;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      color: var(--text);
      background: var(--bg);
      font: 14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    .shell { display: grid; grid-template-columns: 320px 1fr; min-height: 100vh; }
    aside { border-right: 1px solid var(--border); background: #fbfaf8; padding: 18px; }
    main { display: grid; grid-template-rows: auto 1fr; min-width: 0; }
    header { padding: 22px 26px; border-bottom: 1px solid var(--border); background: var(--panel); }
    h1 { margin: 0 0 4px; font-size: 20px; letter-spacing: 0; }
    .muted { color: var(--muted); }
    .toolbar { display: flex; gap: 8px; margin-top: 14px; }
    button {
      border: 1px solid var(--border);
      background: var(--panel);
      border-radius: 8px;
      padding: 7px 10px;
      color: var(--text);
      cursor: pointer;
    }
    button.active { background: var(--accent-soft); border-color: #edb39c; color: #923915; }
    .sessions { display: flex; flex-direction: column; gap: 8px; margin-top: 18px; }
    .session {
      border: 1px solid var(--border);
      background: var(--panel);
      border-radius: 8px;
      padding: 10px;
      text-align: left;
      width: 100%;
    }
    .session.active { border-color: #ed9d7d; background: var(--accent-soft); }
    .session-title { font-weight: 650; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .session-meta { color: var(--muted); font-size: 12px; margin-top: 4px; }
    .side-section-title { margin: 18px 0 8px; color: var(--muted); font-size: 12px; font-weight: 650; text-transform: uppercase; }
    .content { padding: 22px 26px; min-width: 0; overflow: auto; }
    .grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(360px, 42%); gap: 16px; }
    .wide-panel { margin-top: 16px; }
    .panel { border: 1px solid var(--border); background: var(--panel); border-radius: 8px; min-width: 0; }
    .panel h2 { margin: 0; padding: 12px 14px; font-size: 14px; border-bottom: 1px solid var(--border); }
    .entries { display: flex; flex-direction: column; gap: 10px; padding: 12px; }
    .entry { border: 1px solid var(--border); border-radius: 8px; overflow: hidden; background: #fff; }
    .entry-title { display: flex; justify-content: space-between; gap: 12px; padding: 8px 10px; background: #fbfaf8; color: var(--muted); font-size: 12px; }
    pre { margin: 0; padding: 10px; overflow: auto; background: var(--code); font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; }
    .empty { padding: 22px; color: var(--muted); }
    @media (max-width: 920px) {
      .shell { grid-template-columns: 1fr; }
      aside { border-right: 0; border-bottom: 1px solid var(--border); }
      .grid { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <div class="shell">
    <aside>
      <h1>mllo Observer</h1>
      <div class="muted" id="status">Connecting...</div>
      <div class="toolbar">
        <button id="refresh">Refresh</button>
        <button id="includeArchived">Archived</button>
      </div>
      <div class="side-section-title">Sessions</div>
      <div class="sessions" id="sessions"></div>
      <div class="side-section-title">External Traces</div>
      <div class="sessions" id="externalTraces"></div>
    </aside>
    <main>
      <header>
        <h1 id="title">Select a session</h1>
        <div class="muted" id="summary">Read-only local trace viewer.</div>
      </header>
      <div class="content">
        <div class="grid">
          <section class="panel">
            <h2>Timeline</h2>
            <div class="entries" id="timeline"></div>
          </section>
          <section class="panel">
            <h2>Prompt Inspector</h2>
            <div class="entries" id="prompts"></div>
          </section>
        </div>
        <section class="panel wide-panel">
          <h2 id="externalTraceTitle">External Trace</h2>
          <div class="entries" id="externalTraceEntries"></div>
        </section>
      </div>
    </main>
  </div>
  <script>
    const state = { sessions: [], traces: [], selectedId: null, selectedTraceSource: null, includeArchived: false };
    const $ = (id) => document.getElementById(id);
    const fmtTime = (ms) => ms ? new Date(ms).toLocaleString() : '-';
    const label = (entry) => [entry.kind || entry.type || 'jsonl', entry.timestamp || ''].filter(Boolean).join(' · ');

    async function loadSessions() {
      const archived = state.includeArchived ? '&includeArchived=1' : '';
      const response = await fetch('/api/sessions?limit=200' + archived);
      const data = await response.json();
      state.sessions = data.sessions || [];
      if (!state.selectedId && state.sessions[0]) state.selectedId = state.sessions[0].id;
      renderSessions();
      await loadExternalTraces();
      if (state.selectedId) await loadSession(state.selectedId);
    }

    async function loadExternalTraces() {
      const response = await fetch('/api/external-traces');
      const data = await response.json();
      state.traces = data.traces || [];
      if (!state.selectedTraceSource && state.traces[0]) state.selectedTraceSource = state.traces[0].source;
      renderExternalTraceSources();
      if (state.selectedTraceSource) await loadExternalTrace(state.selectedTraceSource);
    }

    function renderSessions() {
      $('sessions').innerHTML = state.sessions.map((session) => {
        const active = session.id === state.selectedId ? ' active' : '';
        return '<button class="session' + active + '" data-id="' + session.id + '">' +
          '<div class="session-title">' + escapeHtml(session.title || session.id) + '</div>' +
          '<div class="session-meta">' + escapeHtml(session.runStatus || session.source) + ' · ' + fmtTime(session.updatedAtMs) + '</div>' +
          '<div class="session-meta">' + escapeHtml(session.cwd || '') + '</div>' +
          '</button>';
      }).join('');
      for (const node of document.querySelectorAll('.session')) {
        node.addEventListener('click', () => {
          state.selectedId = node.dataset.id;
          renderSessions();
          void loadSession(state.selectedId);
        });
      }
    }

    function renderExternalTraceSources() {
      if (state.traces.length === 0) {
        $('externalTraces').innerHTML = '<div class="empty">No external traces.</div>';
        return;
      }
      $('externalTraces').innerHTML = state.traces.map((trace) => {
        const active = trace.source === state.selectedTraceSource ? ' active' : '';
        return '<button class="session' + active + '" data-source="' + trace.source + '">' +
          '<div class="session-title">' + escapeHtml(trace.source) + '</div>' +
          '<div class="session-meta">' + escapeHtml(String(trace.fileBytes)) + ' bytes · ' + fmtTime(trace.updatedAtMs) + '</div>' +
          '</button>';
      }).join('');
      for (const node of document.querySelectorAll('[data-source]')) {
        node.addEventListener('click', () => {
          state.selectedTraceSource = node.dataset.source;
          renderExternalTraceSources();
          void loadExternalTrace(state.selectedTraceSource);
        });
      }
    }

    async function loadSession(id) {
      const response = await fetch('/api/sessions/' + encodeURIComponent(id) + '?limit=300');
      const detail = await response.json();
      if (!response.ok) return;
      $('title').textContent = detail.session.title || detail.session.id;
      $('summary').textContent = [detail.session.cwd, detail.session.model, detail.session.runStatus].filter(Boolean).join(' · ');
      renderEntries('timeline', detail.transcript);
      renderEntries('prompts', detail.prompts);
    }

    async function loadExternalTrace(source) {
      const response = await fetch('/api/external-traces/' + encodeURIComponent(source) + '?limit=200');
      const detail = await response.json();
      if (!response.ok) return;
      $('externalTraceTitle').textContent = 'External Trace · ' + source;
      renderEntries('externalTraceEntries', detail);
    }

    function renderEntries(targetId, readResult) {
      if (!readResult.exists) {
        $(targetId).innerHTML = '<div class="empty">No file: ' + escapeHtml(readResult.path) + '</div>';
        return;
      }
      if (readResult.entries.length === 0) {
        $(targetId).innerHTML = '<div class="empty">No entries.</div>';
        return;
      }
      $(targetId).innerHTML = readResult.entries.map((entry) =>
        '<article class="entry">' +
          '<div class="entry-title"><span>' + escapeHtml(label(entry)) + '</span><span>#' + entry.ordinal + '</span></div>' +
          '<pre>' + escapeHtml(entry.json) + '</pre>' +
        '</article>'
      ).join('');
    }

    function escapeHtml(value) {
      return String(value)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#039;');
    }

    $('refresh').addEventListener('click', () => void loadSessions());
    $('includeArchived').addEventListener('click', () => {
      state.includeArchived = !state.includeArchived;
      $('includeArchived').classList.toggle('active', state.includeArchived);
      void loadSessions();
    });
    const events = new EventSource('/events');
    events.addEventListener('sessions', (event) => {
      $('status').textContent = 'Live · ' + new Date().toLocaleTimeString();
      state.sessions = JSON.parse(event.data).sessions || [];
      renderSessions();
      void loadExternalTraces();
    });
    events.onerror = () => { $('status').textContent = 'Reconnecting...'; };
    void loadSessions();
  </script>
</body>
</html>`;
}
