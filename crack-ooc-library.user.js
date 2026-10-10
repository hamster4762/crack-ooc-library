// ==UserScript==
// @name         Crack OOC 보관함
// @namespace    crack.ooc.library
// @version      1.0.0.0
// @description  OOC를 단축어 목록에 표시하고 기기 또는 Firebase DB에 저장 (version 관리방식: 데이터구조버전.크랙UI변경.기능추가및수정.버그수정)
// @match        https://crack.wrtn.ai/*
// @icon         data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2064%2064%22%3E%3Crect%20x%3D%224%22%20y%3D%224%22%20width%3D%2256%22%20height%3D%2256%22%20rx%3D%2214%22%20fill%3D%22%23ef4444%22%2F%3E%3Cg%20fill%3D%22none%22%20stroke%3D%22%23fff%22%20stroke-width%3D%223%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%3E%3Crect%20x%3D%2215%22%20y%3D%2219%22%20width%3D%229%22%20height%3D%2225%22%20rx%3D%222%22%2F%3E%3Crect%20x%3D%2227%22%20y%3D%2215%22%20width%3D%229%22%20height%3D%2229%22%20rx%3D%222%22%2F%3E%3Cpath%20d%3D%22m39%2022%207-2%207%2023-7%202zM13%2049h40M18%2026h3M30%2022h3%22%2F%3E%3C%2Fg%3E%3C%2Fsvg%3E
// @grant        none
// @run-at       document-idle
// ==/UserScript==

/* 데이터 구조:
 * {
 *    schemaVersion: 1,
 *    updatedAt: 0,
 *    categories: [
 *      { "카테고리": [{ "OOC 이름": "내용\n내용" }] }
 *    ],
 *    extras: [
 *      { "미분류 OOC": "내용" }]
 *    }
 */
(() => {
  'use strict';
  const STORAGE_KEY = 'crack-ooc-library.connection';
  const fresh = () => ({ schemaVersion: 1, updatedAt: 0, categories: [], extras: [] });
  const copy = value => JSON.parse(JSON.stringify(value));
  const one = value => Object.entries(value)[0];
  const named = (name, value) => Object.fromEntries([[name, value]]);
  let library = null, editing = null, pendingRead = null, database = null, saving = false;
  let settings = { mode: 'local' }, manager = null, selectedInput = null, drag = null;
  const expanded = new Set(), attached = new Map();
  const dropAreas = new WeakMap();
  try { settings = JSON.parse(localStorage.getItem(STORAGE_KEY)) || settings; } catch { /* 설정이 없거나 손상되었으면 로컬로 시작한다. */ }

  function check(value) {
    if (!value || value.schemaVersion !== 1 || !Number.isSafeInteger(value.updatedAt) || value.updatedAt < 0 ||
        !Array.isArray(value.categories) || !Array.isArray(value.extras)) throw Error('데이터 형식이 올바르지 않습니다.');
    const single = item => {
      if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).length !== 1) throw Error('항목 형식이 올바르지 않습니다.');
      return one(item);
    };
    const items = list => list.map(item => {
      const [name, content] = single(item);
      if (!name.trim() || Array.from(name).length > 20 || typeof content !== 'string') throw Error('OOC 이름 또는 내용이 올바르지 않습니다.');
      return named(name, content);
    });
    return { schemaVersion: 1, updatedAt: value.updatedAt,
      categories: value.categories.map(item => {
        const [name, children] = single(item);
        if (!name.trim() || !Array.isArray(children)) throw Error('카테고리 형식이 올바르지 않습니다.');
        return named(name, items(children));
      }), extras: items(value.extras) };
  }
  function transport(value, direction) {
    const itemPair = item => {
      if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).length !== 1) throw Error('Firebase 항목 형식이 올바르지 않습니다.');
      return one(item);
    };
    const key = direction === 'write' ? name => 'k_' + encodeURIComponent(name).replace(/[.!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase()) : name => {
      if (!name.startsWith('k_')) throw Error('Firebase 데이터의 이름 형식이 올바르지 않습니다.');
      return decodeURIComponent(name.slice(2));
    };
    const list = values => {
      if (values == null) return [];
      if (!Array.isArray(values)) throw Error('Firebase 목록 형식이 올바르지 않습니다.');
      return values.map(item => { const [name, text] = itemPair(item); return named(key(name), text); });
    };
    if (value.categories != null && !Array.isArray(value.categories)) throw Error('Firebase 카테고리 형식이 올바르지 않습니다.');
    return { schemaVersion: value.schemaVersion, updatedAt: value.updatedAt,
      categories: (value.categories || []).map(item => {
        const [name, children] = itemPair(item);
        const entries = direction === 'read' && children === false ? [] : list(children);
        return named(key(name), direction === 'write' && !entries.length ? false : entries);
      }),
      extras: list(value.extras) };
  }
  async function localData(value) {
    if (!database) database = new Promise((resolve, reject) => {
      const opening = indexedDB.open('crack-ooc-library', 1);
      opening.onupgradeneeded = () => opening.result.createObjectStore('library');
      opening.onsuccess = () => resolve(opening.result);
      opening.onerror = () => { database = null; reject(Error('로컬 저장소를 열 수 없습니다.')); };
    });
    const db = await database;
    return new Promise((resolve, reject) => {
      const transaction = db.transaction('library', value ? 'readwrite' : 'readonly');
      const store = transaction.objectStore('library');
      const operation = value ? store.put(value, 'library') : store.get('library');
      transaction.oncomplete = () => {
        try { resolve(value || (operation.result === undefined ? fresh() : check(operation.result))); } catch (error) { reject(error); }
      };
      transaction.onabort = transaction.onerror = () => reject(Error('로컬 저장소의 읽기 또는 저장에 실패했습니다.'));
    });
  }
  function configFrom(text) {
    const json = text.trim().replace(/^(?:const|let|var)\s+firebaseConfig\s*=\s*/, '').replace(/;\s*$/, '')
      .replace(/([{,]\s*)([\w$]+)\s*:/g, '$1"$2":').replace(/,\s*}/g, '}');
    let config;
    try { config = JSON.parse(json); } catch { throw Error('Firebase config를 중괄호까지 복사하세요.'); }
    if (typeof config?.apiKey !== 'string' || !config.apiKey.trim() || typeof config.projectId !== 'string' || !/^[a-z][a-z0-9-]{4,62}$/.test(config.projectId)) throw Error('apiKey와 projectId를 확인하세요.');
    let address;
    try { address = new URL(config.databaseURL); } catch { throw Error('연동 가이드 2단계의 databaseURL을 확인하세요.'); }
    const project = config.projectId;
    const regional = new RegExp(`^${project}(?:-default-rtdb)?\\.[a-z0-9-]+\\.firebasedatabase\\.app$`);
    if (address.protocol !== 'https:' || address.username || address.password || address.port || address.search || address.hash || address.pathname !== '/' ||
        ![`${project}.firebaseio.com`, `${project}-default-rtdb.firebaseio.com`].includes(address.hostname) && !regional.test(address.hostname)) throw Error('같은 프로젝트의 공식 Realtime Database 주소를 입력하세요.');
    return { apiKey: config.apiKey.trim(), projectId: project, databaseURL: address.origin };
  }
  async function http(address, method = 'GET', body, form = false) {
    const abort = new AbortController(), timeout = setTimeout(() => abort.abort(), 25000);
    try {
      const response = await fetch(address, { method, credentials: 'omit', cache: 'no-store', signal: abort.signal,
        headers: body === undefined ? undefined : { 'Content-Type': form ? 'application/x-www-form-urlencoded' : 'application/json' },
        body: body === undefined ? undefined : form ? body : JSON.stringify(body) });
      const text = await response.text(), data = text ? JSON.parse(text) : null;
      if (!response.ok) {
        const reason = data?.error?.message || data?.error;
        if (['INVALID_LOGIN_CREDENTIALS', 'EMAIL_NOT_FOUND', 'INVALID_PASSWORD'].includes(reason)) throw Error('이메일과 비밀번호를 확인하세요.');
        if (reason === 'Permission denied') throw Error('DB 접근이 거부되었습니다. 연동 가이드 5단계의 보안 규칙을 확인하세요.');
        throw Error(`Firebase 요청 실패 (${response.status}). 로그인과 보안 규칙을 확인하세요.`);
      }
      return data;
    } catch (error) {
      if (error.name === 'AbortError') throw Error('요청 시간이 초과되었습니다. 저장 요청이었다면 저장 여부를 확인한 뒤 다시 시도하세요.');
      if (error instanceof TypeError) throw Error('Firebase에 연결하지 못했습니다. 네트워크 또는 사이트의 연결 차단을 확인하세요.');
      throw error;
    } finally { clearTimeout(timeout); }
  }
  async function idToken(connection) {
    if (!connection.auth?.refreshToken) throw Error('DB 설정에서 로그인하세요.');
    if (connection.auth.until <= Date.now() + 60000) {
      const response = await http(`https://securetoken.googleapis.com/v1/token?key=${encodeURIComponent(connection.config.apiKey)}`, 'POST',
        new URLSearchParams({ grant_type: 'refresh_token', refresh_token: connection.auth.refreshToken }).toString(), true);
      connection.auth = { uid: response.user_id, token: response.id_token, refreshToken: response.refresh_token, until: Date.now() + Number(response.expires_in) * 1000 };
      if (connection === settings) localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    }
    return connection.auth.token;
  }
  async function firebase(connection, method = 'GET', path = '', value) {
    // 주소는 configFrom()을 통과한 Firebase DB로만 한정한다.
    const token = await idToken(connection);
    return http(`${connection.config.databaseURL}/oocLibrary${path}.json?auth=${encodeURIComponent(token)}${method === 'PUT' ? '&print=silent' : ''}`, method, value);
  }
  async function readLibrary() {
    if (library) return library;
    if (!pendingRead) pendingRead = (async () => {
      if (settings.mode === 'firebase') {
        settings.config = configFrom(JSON.stringify(settings.config));
        const value = await firebase(settings);
        library = value === null ? fresh() : check(transport(value, 'read'));
      } else library = await localData();
      return library;
    })().finally(() => { pendingRead = null; });
    return pendingRead;
  }
  function change(update) {
    if (saving) return;
    const next = copy(editing || library); update(next); check(next);
    if (JSON.stringify(next) === JSON.stringify(editing || library)) return;
    editing = next; drawManager();
  }
  async function saveLibrary() {
    if (!editing || saving) return;
    saving = true; drawManager();
    try {
      const value = check(copy(editing));
      if (settings.mode === 'firebase') {
        const stamp = await firebase(settings, 'GET', '/updatedAt');
        if (stamp !== null && (!Number.isSafeInteger(stamp) || stamp < 0)) throw Error('Firebase 수정 시각이 올바르지 않습니다.');
        if ((stamp || 0) !== library.updatedAt && !await confirm('덮어쓰기 확인', '다른 기기에서 변경한 자료가 있습니다. 저장하면 Firebase의 기존 자료를 현재 편집 내용으로 덮어씁니다.', '덮어쓰기')) return;
        value.updatedAt = Math.max(Date.now(), (stamp || 0) + 1);
        await firebase(settings, 'PUT', '', transport(value, 'write'));
      } else { value.updatedAt = Math.max(Date.now(), library.updatedAt + 1); await localData(value); }
      library = value; editing = null; drawPanels();
    } finally { saving = false; drawManager(); }
  }

  const paths = {
    plus: '<path d="M12 5v14M5 12h14"/>',
    folder: '<path d="M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>',
    folderPlus: '<path d="M3 9V7a2 2 0 0 1 2-2h4l2 3h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z M17 1v6M14 4h6"/>',
    file: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9ZM14 3v6h6M8 13h8M8 17h5"/>',
    edit: '<path d="m15 4 5 5M4 20l4-1L21 6a2.8 2.8 0 0 0-4-4L4 15Z"/>',
    trash: '<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"/>',
    grip: '<path d="M5 8h14M5 12h14M5 16h14"/>',
    close: '<path d="m6 6 12 12M6 18 18 6"/>',
    save: '<path d="M20 7v13H4V4h13ZM8 4v6h8V4M8 20v-6h8v6"/>',
    gear: '<path d="m9 3-1 3-3 1 1 3-2 2 2 2-1 3 3 1 1 3h6l1-3 3-1-1-3 2-2-2-2 1-3-3-1-1-3Z"/><circle cx="12" cy="12" r="3"/>',
    local: '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 4 16 4 16 0V5M4 12c0 4 16 4 16 0"/>',
    flame: '<path d="M12 2c1 5 6 6 6 11a6 6 0 0 1-12 0c0-3 2-5 3-7 0 3 1 4 2 4 2-2 2-5 1-8Z"/><path d="M12 12c-2 2-3 3-3 5a3 3 0 0 0 6 0c0-2-2-3-3-5Z"/>',
    search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
    chevron: '<path d="m9 5 7 7-7 7"/>',
    help: '<circle cx="12" cy="12" r="9"/><path d="M9 9a3 3 0 0 1 6 0c0 2-3 2-3 4M12 17h.01"/>',
    copy: '<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V3H3v13h5"/>'
  };
  const svg = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name]}</svg>`;
  function node(tag, css, text) { const element = document.createElement(tag); if (css) element.className = css; if (text !== undefined) element.textContent = text; return element; }
  function action(text, handler, icon, css = '') {
    const element = node('button', icon ? `oa-icon ${css}` : `oa-button ${css}`, icon ? undefined : text);
    element.type = 'button'; element.title = text; element.setAttribute('aria-label', text);
    if (icon) element.innerHTML = svg(icon);
    element.addEventListener('click', async event => {
      event.preventDefault(); event.stopPropagation(); if (element.disabled) return;
      element.disabled = true;
      try { await handler(); } catch (error) { alert(error.message); }
      finally { element.disabled = false; }
    });
    return element;
  }
  function dialog(title, width = 'small') {
    const root = node('dialog', `oa-dialog oa-${width}`), header = node('header', 'oa-header');
    root.setAttribute('aria-label', title); const label = node('strong', '', title); header.append(label);
    const body = node('div', 'oa-body'), footer = node('footer', 'oa-footer'); root.append(header, body, footer); document.body.append(root);
    const view = { root, header, label, body, footer, close: () => root.close() };
    root.addEventListener('close', () => root.remove()); root.addEventListener('cancel', event => event.preventDefault()); root.showModal(); return view;
  }
  function closeWithEscape(view) { view.root.addEventListener('cancel', () => { if (!view.root.querySelector('[aria-busy="true"]')) view.close(); }); }
  function alert(message) {
    const view = dialog('안내'); view.body.append(node('p', 'oa-message', message)); view.footer.append(action('확인', view.close)); closeWithEscape(view);
  }
  function confirm(title, message, accept) {
    return new Promise(resolve => {
      const view = dialog(title); view.body.append(node('p', 'oa-message oa-warning', message));
      const finish = answer => { view.close(); resolve(answer); };
      view.footer.append(action('취소', () => finish(false)), action(accept, () => finish(true), null, 'oa-primary'));
      view.root.addEventListener('cancel', () => finish(false));
    });
  }
  function field(view, title, tag = 'input', value = '') {
    const wrap = node('label', 'oa-field'); wrap.append(node('span', '', title)); const input = node(tag); input.value = value; input.setAttribute('aria-label', title); wrap.append(input); view.append(wrap); return input;
  }
  const contents = (data, category) => category < 0 ? data.extras : one(data.categories[category])[1];
  const total = data => data.extras.length + data.categories.reduce((sum, item) => sum + one(item)[1].length, 0);
  function backup(data) {
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    const anchor = node('a'); anchor.href = url; anchor.download = `OOC-${new Date().toISOString().slice(0, 10)}.json`; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function showManager() {
    await readLibrary(); if (manager) return;
    manager = dialog('OOC 보관함', 'large'); drawManager();
    manager.root.addEventListener('cancel', () => { if (!saving) exitManager().catch(error => alert(error.message)); });
  }
  async function exitManager() {
    if (saving) return;
    if (editing && !await confirm('미저장 변경', '저장하지 않은 변경을 버리고 닫을까요?', '버리고 닫기')) return;
    editing = null; manager.close(); manager = null; expanded.clear();
  }
  function drawManager() {
    if (!manager) return;
    const view = manager, query = view.body.querySelector('input[type="search"]')?.value || '';
    view.header.replaceChildren(view.label);
    if (editing) { const dot = node('span', 'oa-dot'); dot.title = '미저장 변경'; dot.setAttribute('aria-label', '미저장 변경'); view.header.append(dot); }
    const buttons = node('div', 'oa-actions');
    buttons.append(action('DB 연동', showConnection, settings.mode === 'firebase' ? 'flame' : 'local'), action('설정', showBackup, 'gear'), action('저장', saveLibrary, 'save'), action('닫기', exitManager, 'close'));
    buttons.querySelectorAll('button').forEach(button => { button.disabled = saving; });
    buttons.children[2].disabled = saving || !editing; view.header.append(buttons); view.body.replaceChildren(); view.footer.hidden = true;
    const toolbar = node('div', 'oa-toolbar'), search = node('div', 'oa-search'); search.innerHTML = svg('search');
    const input = node('input'); input.type = 'search'; input.placeholder = '검색'; input.setAttribute('aria-label', '검색'); input.value = query; search.append(input);
    const rows = node('div', 'oa-tree'); input.addEventListener('input', () => drawTree(rows, input.value));
    toolbar.append(search, action('OOC 추가', () => editOoc(), 'plus'), action('카테고리 추가', () => editFolder(), 'folderPlus'));
    toolbar.querySelectorAll('button').forEach(button => { button.disabled = saving; }); view.body.append(toolbar, rows); drawTree(rows, query);
  }
  function row(title, location, edit, remove) {
    const root = node('div', 'oa-row'); root.dataset.kind = location.kind;
    const symbol = node('span', 'oa-symbol'); symbol.innerHTML = svg(location.kind === 'folder' ? 'folder' : 'file'); root.append(symbol, node('span', 'oa-name', title));
    const tools = node('div', 'oa-row-actions'); const handle = action('순서 변경', () => {}, 'grip'); handle.dataset.sort = '';
    handle.addEventListener('pointerdown', event => startDrag(event, root, location));
    tools.append(handle, action('편집', edit, 'edit'), action('삭제', remove, 'trash'));
    tools.querySelectorAll('button').forEach(button => { button.disabled = saving; }); root.append(tools); return root;
  }
  function drawTree(root, query) {
    root.replaceChildren(); const data = editing || library, needle = query.trim().toLocaleLowerCase();
    const matches = item => one(item).some(value => value.toLocaleLowerCase().includes(needle));
    data.categories.forEach((folder, category) => {
      const [name, items] = one(folder), folderMatch = name.toLocaleLowerCase().includes(needle);
      if (needle && !folderMatch && !items.some(matches)) return;
      const group = node('section', 'oa-group'); const header = row(name, { kind: 'folder', category }, () => editFolder(category), () => deleteEntry(category));
      const toggle = node('button', 'oa-toggle'); toggle.type = 'button'; toggle.innerHTML = svg('chevron'); toggle.setAttribute('aria-label', `${name} 펼치기`);
      const open = expanded.has(category) || !!needle; group.classList.toggle('oa-open', open); toggle.setAttribute('aria-expanded', String(open));
      header.prepend(toggle); const children = node('div', 'oa-children'); children.hidden = !open;
      toggle.onclick = () => { if (expanded.has(category)) expanded.delete(category); else expanded.add(category); drawTree(root, query); };
      header.querySelector('.oa-name').onclick = toggle.onclick;
      const count = node('span', 'oa-count', String(items.length)); header.insertBefore(count, header.lastChild);
      items.forEach((item, index) => { if (!needle || folderMatch || matches(item)) {
        const element = row(one(item)[0], { kind: 'ooc', category, index }, () => editOoc(category, index), () => deleteEntry(category, index)); children.append(element); dropTarget(element, { kind: 'ooc', category, index });
      } });
      if (!items.length) children.append(node('div', 'oa-empty'));
      dropTarget(header, { kind: 'folder', category }); dropTarget(children, { kind: 'ooc', category, index: items.length }, true);
      // 접힌 카테고리 위에 OOC를 놓으면 그 카테고리 마지막으로 이동한다.
      dropTarget(header, { kind: 'ooc', category, index: items.length }, true);
      group.append(header, children); root.append(group);
    });
    const extras = node('section', 'oa-extras');
    data.extras.forEach((item, index) => { if (matches(item)) {
      const element = row(one(item)[0], { kind: 'ooc', category: -1, index }, () => editOoc(-1, index), () => deleteEntry(-1, index)); extras.append(element); dropTarget(element, { kind: 'ooc', category: -1, index });
    } });
    if (!data.extras.length) extras.append(node('div', 'oa-empty')); dropTarget(extras, { kind: 'ooc', category: -1, index: data.extras.length }, true); root.append(extras);
  }
  function clearDrag() {
    drag?.events.abort(); drag?.ghost?.remove();
    document.querySelectorAll('.oa-before,.oa-after,.oa-dragging').forEach(element => element.classList.remove('oa-before', 'oa-after', 'oa-dragging')); drag = null;
  }
  function dropTarget(element, target, end = false) {
    const areas = dropAreas.get(element) || {}; areas[target.kind] = { target, end }; dropAreas.set(element, areas);
  }
  function startDrag(event, element, location) {
    if (event.button !== 0 || saving || manager.body.querySelector('input[type="search"]').value) return;
    event.preventDefault(); event.stopPropagation();
    const startX = event.clientX, startY = event.clientY, rect = element.getBoundingClientRect(), events = new AbortController();
    drag = { ...location, element, events, ghost: null, destination: null };
    document.addEventListener('pointermove', move => {
      if (move.pointerId !== event.pointerId || !drag) return;
      if (!drag.ghost && Math.hypot(move.clientX - startX, move.clientY - startY) < 4) return;
      move.preventDefault();
      if (!drag.ghost) {
        drag.ghost = element.cloneNode(true); drag.ghost.classList.add('oa-ghost');
        Object.assign(drag.ghost.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px` });
        manager.root.append(drag.ghost); element.classList.add('oa-dragging');
      }
      drag.ghost.style.transform = `translate(${move.clientX - startX}px,${move.clientY - startY}px)`;
      document.querySelectorAll('.oa-before,.oa-after').forEach(item => item.classList.remove('oa-before', 'oa-after'));
      drag.destination = null;
      for (const hit of document.elementsFromPoint(move.clientX, move.clientY)) {
        const area = dropAreas.get(hit)?.[drag.kind]; if (!area || hit === element) continue;
        const after = area.end || move.clientY > hit.getBoundingClientRect().top + hit.offsetHeight / 2;
        const target = area.target;
        drag.destination = { ...target, [drag.kind === 'folder' ? 'category' : 'index']: (drag.kind === 'folder' ? target.category : target.index) + (!area.end && after ? 1 : 0) };
        hit.classList.add(after ? 'oa-after' : 'oa-before'); break;
      }
    }, { signal: events.signal, passive: false });
    document.addEventListener('pointerup', finish => {
      if (finish.pointerId !== event.pointerId) return;
      const target = drag?.destination; if (target) moveDrag(target); else clearDrag();
    }, { signal: events.signal });
    document.addEventListener('pointercancel', clearDrag, { signal: events.signal });
  }
  function moveDrag(target) {
    const source = drag; clearDrag(); if (!source) return;
    change(data => {
      if (source.kind === 'folder') {
        const item = data.categories.splice(source.category, 1)[0]; data.categories.splice(target.category - (source.category < target.category ? 1 : 0), 0, item); expanded.clear();
      } else {
        const from = contents(data, source.category), to = contents(data, target.category); const item = from.splice(source.index, 1)[0];
        to.splice(target.index - (source.category === target.category && source.index < target.index ? 1 : 0), 0, item);
      }
    });
  }
  function editFolder(category) {
    if (saving) return; const data = editing || library, view = dialog(category === undefined ? '카테고리 추가' : '카테고리 편집');
    const input = field(view.body, '이름', 'input', category === undefined ? '' : one(data.categories[category])[0]);
    view.footer.append(action('취소', view.close), action('적용', () => {
      const name = input.value.trim(); if (!name) throw Error('카테고리 이름을 입력하세요.');
      change(data => { if (category === undefined) data.categories.push(named(name, [])); else data.categories[category] = named(name, one(data.categories[category])[1]); }); view.close();
    }, null, 'oa-primary')); closeWithEscape(view); input.focus();
  }
  function editOoc(category = -1, index) {
    if (saving) return; const data = editing || library, current = index === undefined ? ['', ''] : one(contents(data, category)[index]);
    const view = dialog(index === undefined ? 'OOC 추가' : 'OOC 편집');
    const name = field(view.body, '이름', 'input', current[0]), body = field(view.body, '내용', 'textarea', current[1]), folder = field(view.body, '카테고리', 'select'); body.rows = 9;
    folder.append(new Option('미분류', '-1')); data.categories.forEach((item, index) => folder.append(new Option(one(item)[0], String(index)))); folder.value = String(category);
    view.footer.append(action('취소', view.close), action('적용', () => {
      const title = name.value.trim(); if (!title || Array.from(title).length > 20) throw Error('이름은 1~20자로 입력하세요.');
      change(data => {
        const to = Number(folder.value), value = named(title, body.value);
        if (index === undefined) contents(data, to).push(value);
        else if (to === category) contents(data, category)[index] = value;
        else { contents(data, category).splice(index, 1); contents(data, to).push(value); }
      }); view.close();
    }, null, 'oa-primary')); closeWithEscape(view); name.focus();
  }
  async function deleteEntry(category, index) {
    if (saving) return;
    if (!await confirm('삭제 확인', index === undefined ? '카테고리와 안에 있는 모든 OOC를 삭제할까요?' : '이 OOC를 삭제할까요?', '삭제')) return;
    change(data => { if (index === undefined) { data.categories.splice(category, 1); expanded.clear(); } else contents(data, category).splice(index, 1); });
  }
  function showBackup() {
    const view = dialog('설정'); const heading = node('h3', '', '백업'); const buttons = node('div', 'oa-backup');
    const file = node('input'); file.type = 'file'; file.accept = '.json,application/json'; file.hidden = true;
    file.addEventListener('change', async () => {
      if (!file.files[0]) return;
      try {
        const data = check(JSON.parse(await file.files[0].text()));
        if (!await confirm('전체 복원', `현재 전체 자료와 미저장 변경을 백업의 OOC ${total(data)}개로 교체합니다. 저장을 누르면 기존 DB 자료가 덮어써집니다. 계속할까요?`, '복원')) return;
        data.updatedAt = library.updatedAt; editing = data; expanded.clear(); drawManager(); view.close();
      } catch (error) { alert(`복원 실패: ${error.message}`); }
    });
    buttons.append(action('전체 백업', () => backup(editing || library)), action('전체 복원', () => file.click())); view.body.append(heading, buttons, file);
    view.header.append(action('닫기', view.close, 'close')); view.footer.hidden = true; closeWithEscape(view);
  }

  function showConnection() {
    if (editing) throw Error('변경을 저장하거나 버린 뒤 DB를 전환하세요.');
    const view = dialog('DB 연동'); let mode = settings.mode, login = null, applying = false;
    const top = node('div', 'oa-db-top'), segment = node('div', 'oa-segment'); segment.setAttribute('role', 'radiogroup'); segment.setAttribute('aria-label', '저장소');
    const firebaseArea = node('div', 'oa-firebase');
    const config = field(firebaseArea, 'Firebase config', 'textarea', settings.config ? JSON.stringify(settings.config, null, 2) : ''); config.rows = 7; config.spellcheck = false;
    const credentials = node('div', 'oa-credentials'), email = node('input'), password = node('input'); email.type = 'email'; email.placeholder = '이메일'; email.autocomplete = 'username'; email.setAttribute('aria-label', '이메일');
    password.type = 'password'; password.placeholder = '비밀번호'; password.autocomplete = 'current-password'; password.setAttribute('aria-label', '비밀번호');
    const state = node('p', 'oa-auth-state', settings.mode === 'firebase' ? '연결됨' : '');
    const loginButton = action('로그인', async () => {
      login = null; const chosenConfig = configFrom(config.value);
      try {
        const auth = await http(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${encodeURIComponent(chosenConfig.apiKey)}`, 'POST', { email: email.value.trim(), password: password.value, returnSecureToken: true });
        login = { mode: 'firebase', config: chosenConfig, auth: { uid: auth.localId, token: auth.idToken, refreshToken: auth.refreshToken, until: Date.now() + Number(auth.expiresIn) * 1000 } }; state.textContent = '로그인됨';
      } finally { password.value = ''; }
    }); credentials.append(email, password, loginButton); firebaseArea.append(credentials, state);
    const guide = action('연동 가이드', () => showGuide(login || (settings.mode === 'firebase' ? settings : null)), 'help', 'oa-guide');
    for (const [value, text] of [['local', '로컬'], ['firebase', 'Firebase']]) {
      const label = node('label'), radio = node('input'); radio.type = 'radio'; radio.name = 'oa-storage-mode'; radio.value = value; radio.checked = mode === value;
      radio.addEventListener('change', () => { mode = value; updateMode(); }); label.append(radio, node('span', '', text)); segment.append(label);
    }
    function updateMode() { firebaseArea.hidden = mode !== 'firebase'; guide.hidden = mode !== 'firebase'; }
    updateMode(); top.append(segment, guide); view.body.append(top, firebaseArea);
    config.addEventListener('input', () => { login = null; state.textContent = ''; });
    const cancel = action('취소', view.close), apply = action('연동 적용', async () => {
      applying = true; view.root.setAttribute('aria-busy', 'true'); cancel.disabled = true;
      view.body.querySelectorAll('input,textarea,button').forEach(control => { control.disabled = true; });
      try {
        if (mode === 'local' && settings.mode === 'local') { view.close(); return; }
        if (mode === 'local') {
          const local = await localData(), choice = await selectSource(local, library, true); if (!choice) return;
          const data = choice === 'local' ? local : copy(library); if (choice === 'firebase') await localData(data);
          const next = { mode: 'local', ...(settings.config ? { config: settings.config } : {}) };
          localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); settings = next; library = data;
        } else {
          const chosen = configFrom(config.value);
          const connection = login || (settings.mode === 'firebase' ? copy(settings) : null);
          if (!connection || JSON.stringify(connection.config) !== JSON.stringify(chosen)) throw Error('현재 config로 먼저 로그인하세요.');
          const raw = await firebase(connection), remote = raw === null ? fresh() : check(transport(raw, 'read'));
          const local = await localData();
          const choice = raw === null ? 'local' : await selectSource(local, remote); if (!choice) return;
          const data = copy(choice === 'local' ? local : remote);
          if (choice === 'local') { data.updatedAt = Math.max(Date.now(), remote.updatedAt + 1); await firebase(connection, 'PUT', '', transport(data, 'write')); }
          else await localData(data);
          localStorage.setItem(STORAGE_KEY, JSON.stringify(connection)); settings = connection; library = data;
        }
        drawManager(); drawPanels(); view.close();
      } finally {
        applying = false; view.root.removeAttribute('aria-busy'); cancel.disabled = false;
        view.body.querySelectorAll('input,textarea,button').forEach(control => { control.disabled = false; });
      }
    }, null, 'oa-primary'); view.footer.append(cancel, apply);
    view.root.addEventListener('cancel', () => { if (!applying && !loginButton.disabled) view.close(); });
  }
  function selectSource(local, remote, disconnect = false) {
    return new Promise(resolve => {
      const view = dialog('사용할 데이터 선택'), choices = node('div', 'oa-source-options'); let source = null;
      view.body.append(node('p', 'oa-message', disconnect ? 'Firebase 원본은 유지됩니다. 로컬에서 사용할 자료를 선택하세요.' : '자료를 합치지 않고 한쪽 전체 자료를 사용합니다. 반대쪽 자료는 삭제·덮어쓰기되며, 백업이 없으면 복구할 수 없습니다.'));
      const warning = node('p', 'oa-message oa-warning'), apply = action('적용', () => finish(source), null, 'oa-primary'); apply.disabled = true;
      for (const [key, title, data] of [['local', '로컬', local], ['firebase', 'Firebase', remote]]) {
        const card = action(title, () => {
          source = key; apply.disabled = false; choices.querySelectorAll('button').forEach(button => button.classList.toggle('oa-selected', button === card));
          warning.textContent = disconnect ? key === 'local' ? '기존 로컬 자료를 그대로 사용합니다. Firebase 원본도 유지합니다.' : '기존 로컬의 모든 자료를 삭제하고 Firebase 자료로 교체합니다. Firebase 원본은 유지합니다.' : key === 'local' ? 'Firebase의 모든 자료를 삭제하고 로컬 자료로 덮어씁니다.' : '로컬의 모든 자료를 삭제하고 Firebase 자료로 덮어씁니다.';
        }, null, 'oa-source'); card.replaceChildren(node('strong', '', title), node('span', '', `카테고리 ${data.categories.length} · OOC ${total(data)}`)); choices.append(card);
      }
      function finish(answer) { view.close(); resolve(answer); }
      view.body.append(choices, warning); view.footer.append(action('취소', () => finish(null)), apply); view.root.addEventListener('cancel', () => finish(null));
    });
  }
  function showGuide(connection) {
    const view = dialog('Firebase 연동 가이드', 'guide');
    const sections = [
      ['1. 내 프로젝트 만들기', ['Firebase 콘솔에서 프로젝트를 만드세요. OOC 보관함 전용 프로젝트를 권장합니다.', '프로젝트 설정 → 일반 → 내 앱 → 웹 앱(</>) 등록. 앱 이름을 정하고 등록하세요. Hosting 설정은 필요 없습니다.', '웹 앱의 SDK 설정에서 구성(Config)을 선택하고 firebaseConfig의 중괄호 안 내용을 중괄호까지 복사하세요.']],
      ['2. 데이터베이스 만들기', ['콘솔 → 빌드(Build) → Realtime Database → 데이터베이스 만들기. Firestore가 아닙니다.', '위치를 선택하고 잠금 모드로 시작하세요. 테스트 모드는 데이터를 공개할 수 있으므로 사용하지 마세요.', '데이터 탭 상단의 https://…firebaseio.com 또는 https://…firebasedatabase.app 주소를 복사하세요.', 'config에 databaseURL이 없다면 아래 형식으로 추가하고 값은 본인 DB 주소로 바꾸세요.']],
      ['3. 로그인 사용자 등록하기', ['콘솔 → Authentication → 시작하기 → 로그인 방법(Sign-in method).', '이메일/비밀번호(Email/Password)를 활성화하고 저장하세요. 이메일 링크 로그인은 켜지 않아도 됩니다.', '사용자(Users) 탭 → 사용자 추가(Add user) → 사용할 이메일과 비밀번호 입력 → 등록.', '메일 계정은 실제로 존재하거나 사용하는 이메일이 아니어도 됩니다. 다른 서비스와 겹치지 않는 임의의 이메일과 비밀번호를 권장합니다.']],
      ['4. 보관함에서 로그인하기', ['가이드를 닫고 DB 연동 → Firebase → config 붙여넣기.', '등록한 이메일과 비밀번호를 입력하고 로그인을 누르세요.', '로그인됨 표시를 확인한 뒤 이 가이드를 다시 열어 아래 보안 규칙을 복사하세요.']],
      ['5. DB 접근 보안 규칙 게시하기', ['로그인한 뒤 아래 본인 UID 전용 규칙을 복사하세요.', '전용 DB라면 Realtime Database → 규칙(Rules)에서 아래 규칙으로 교체하고 게시(Publish)하세요. 기존 프로그램과 공유하는 DB라면 기존 규칙을 백업하고 rules 아래에 oocLibrary 부분만 추가하세요. 상위 경로의 공개 읽기/쓰기 규칙은 하위 규칙보다 우선하므로 그대로 두면 보호되지 않습니다.']],
      ['6. 연결 확인 · 다른 기기에서 사용하기', ['가이드를 닫고 연동 적용을 누르세요. 양쪽에 자료가 있으면 사용할 쪽과 삭제될 쪽을 확인하세요. 중요한 자료는 먼저 설정의 전체 백업으로 보관하세요.', '다른 기기에서도 같은 config와 프로젝트에 등록한 이메일/비밀번호로 연결하세요.']]
    ];
    sections.forEach(([title, steps], index) => {
      const section = node('details', 'oa-guide-section'); section.open = index === 0 || (index === 4 && !!connection?.auth?.uid); section.append(node('summary', '', title));
      const list = node('ol'); steps.forEach(text => list.append(node('li', '', text))); section.append(list);
      if (index === 1) section.append(node('pre', '', 'databaseURL: "복사한 데이터베이스 주소",'));
      if (index === 3) section.append(node('p', 'oa-message', '브라우저 데이터 삭제·비공개 모드·저장 차단 시에는 다시 로그인해야 합니다. 공용 기기에서는 사용하지 않는 것을 권장합니다.'));
      if (index === 4) {
        if (connection?.auth?.uid) {
          const rule = `auth != null && auth.uid === ${JSON.stringify(connection.auth.uid)}`;
          const text = field(section, '보안 규칙', 'textarea', JSON.stringify({ rules: { oocLibrary: { '.read': rule, '.write': rule } } }, null, 2)); text.rows = 8; text.readOnly = true;
          section.append(action('규칙 복사', async () => { await navigator.clipboard.writeText(text.value); }, 'copy'));
          section.append(node('p', 'oa-message', '자료는 /oocLibrary에 공통으로 저장하며, 접근은 위 UID의 사용자만 허용합니다. 개인 전용 프로젝트를 사용하세요.'));
        } else {
          section.append(node('p', 'oa-message', 'DB 연동에서 먼저 로그인하면 본인 UID 전용 보안 규칙이 표시됩니다.'));
        }
      }
      view.body.append(section);
    }); view.header.append(action('닫기', view.close, 'close')); view.footer.hidden = true; closeWithEscape(view);
  }

  function bookmark() {
    const selection = window.getSelection();
    if (!selection?.rangeCount || !selection.isCollapsed) return;
    const range = selection.getRangeAt(0), editor = (range.startContainer.nodeType === Node.ELEMENT_NODE ? range.startContainer : range.startContainer.parentElement)?.closest('.__chat_input_textarea[contenteditable="true"]');
    if (editor) selectedInput = { editor, range: range.cloneRange() };
  }
  document.addEventListener('selectionchange', bookmark);
  function slashRange(saved) {
    const { editor, range } = saved;
    if (!editor.isConnected || !range.collapsed || !editor.contains(range.startContainer)) throw Error('입력창의 / 바로 뒤에 커서를 놓으세요.');
    // 커서 앞의 실제 텍스트 노드를 찾는다. 편집기 내부 상태/전용 API 접근 없음.
    const before = document.createRange(); before.selectNodeContents(editor); before.setEnd(range.startContainer, range.startOffset);
    if (!before.toString().endsWith('/')) throw Error('커서 바로 앞에 /가 있어야 합니다.');
    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT); let previous = null;
    while (walker.nextNode()) {
      const text = walker.currentNode;
      const point = range.comparePoint(text, text.length);
      if (point <= 0 && text.length) previous = { node: text, offset: text.length };
      if (text === range.startContainer) { if (range.startOffset) previous = { node: text, offset: range.startOffset }; break; }
      if (point > 0) break;
    }
    if (!previous || previous.node.data[previous.offset - 1] !== '/') throw Error('커서 위치를 확인하세요.');
    const replacement = document.createRange(); replacement.setStart(previous.node, previous.offset - 1); replacement.setEnd(previous.node, previous.offset); return replacement;
  }
  function useOoc(content) {
    if (!selectedInput) throw Error('입력창에 /를 입력하세요.');
    const replacement = slashRange(selectedInput), editor = selectedInput.editor; editor.focus();
    const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(replacement);
    // 브라우저 편집 명령은 input 이벤트를 발생시켜 Crack의 편집 상태도 갱신한다.
    // Enter/전송 버튼/Crack API는 호출하지 않는다.
    if (!document.execCommand('insertText', false, content.replace(/\r\n?/g, '\n'))) throw Error('텍스트 입력에 실패했습니다.');
    bookmark();
  }
  function drawPanel(panel) {
    panel.body.replaceChildren(); if (!library) return;
    const ooc = item => { const [name, content] = one(item); const button = action(name, () => useOoc(content), null, 'oa-use'); button.addEventListener('pointerdown', event => event.preventDefault()); return button; };
    library.categories.forEach(folder => {
      const [name, entries] = one(folder), section = node('details', 'oa-list-folder'), summary = node('summary');
      summary.innerHTML = svg('chevron') + svg('folder'); summary.append(node('span', '', name)); section.append(summary); entries.forEach(item => section.append(ooc(item))); panel.body.append(section);
    }); library.extras.forEach(item => panel.body.append(ooc(item)));
  }
  function drawPanels() { attached.forEach(panel => { if (panel.active) drawPanel(panel); }); }
  function panelMode(panel, enabled) {
    panel.active = enabled; panel.body.hidden = !enabled; panel.native.forEach(element => { element.classList.toggle('oa-native-hidden', enabled); }); panel.button.classList.toggle('oa-tab-active', enabled); panel.button.setAttribute('aria-pressed', String(enabled));
  }
  function discover() {
    for (const [root, panel] of attached) if (!root.isConnected || !panel.button.isConnected) {
      panelMode(panel, false); panel.body.remove(); panel.button.remove(); panel.config.remove(); attached.delete(root);
    }
    document.querySelectorAll('[role="tablist"]').forEach(tabs => {
      const hub = Array.from(tabs.querySelectorAll('[role="tab"]')).find(tab => tab.textContent.trim() === '단축어 허브'); if (!hub) return;
      const root = tabs.parentElement.parentElement; if (attached.has(root)) return;
      const native = Array.from(root.children).slice(1); if (!native.some(element => element.querySelector('ul'))) return;
      const panel = { native, body: node('div', 'oa-panel-body'), active: false }; panel.body.hidden = true; panel.body.setAttribute('aria-label', 'OOC 목록');
      panel.button = action('OOC 보관함', async () => {
        bookmark(); await readLibrary(); panelMode(panel, true); drawPanel(panel);
      }, null, 'oa-tab'); panel.button.addEventListener('pointerdown', event => { bookmark(); event.preventDefault(); });
      panel.config = action('OOC 설정', showManager, 'gear', 'oa-panel-config'); panel.config.addEventListener('pointerdown', event => { bookmark(); event.preventDefault(); });
      tabs.append(panel.button, panel.config); tabs.classList.add('oa-tabs'); root.append(panel.body); attached.set(root, panel);
      tabs.addEventListener('click', event => { if (event.target.closest('[role="tab"]')) panelMode(panel, false); });
    });
  }
  // OOC 항목의 포커스를 보존하며 기본 단축어의 Enter 선택만 막는다.
  document.addEventListener('keydown', event => {
    const panel = Array.from(attached.values()).find(panel => panel.active && panel.body.isConnected);
    if (!panel || event.isComposing || !event.target.closest?.('.__chat_input_textarea') || !['Enter', 'ArrowDown', 'ArrowUp'].includes(event.key)) return;
    event.preventDefault(); event.stopImmediatePropagation();
    if (event.key !== 'Enter') panel.body.querySelector('summary,button')?.focus();
  }, true);
  const styles = node('style'); styles.textContent = `
    .oa-dialog{--oa-bg:hsl(var(--card,0 0% 9%));--oa-fg:hsl(var(--foreground,0 0% 98%));--oa-muted:hsl(var(--muted-foreground,0 0% 58%));--oa-line:hsl(var(--border,0 0% 22%));--oa-accent:#a5a0f5;color:var(--oa-fg);background:var(--oa-bg);border:1px solid var(--oa-line);border-radius:16px;padding:0;width:min(520px,calc(100vw - 32px));max-height:86vh;box-shadow:0 24px 80px #0007;font:14px/1.5 system-ui}
    .oa-dialog [hidden]{display:none!important}.oa-dialog::backdrop{background:#0007}.oa-dialog.oa-large{width:min(680px,calc(100vw - 32px))}.oa-dialog.oa-guide{width:min(620px,calc(100vw - 32px))}.oa-header{display:flex;align-items:center;gap:8px;height:64px;padding:0 20px;border-bottom:1px solid var(--oa-line)}.oa-header strong{font-size:16px;font-weight:650}.oa-header>.oa-icon{margin-left:auto}.oa-actions{display:flex;gap:4px;margin-left:auto}.oa-dot{width:7px;height:7px;background:#f06b73;border-radius:50%}.oa-body{padding:20px;overflow:auto;max-height:calc(86vh - 142px)}.oa-large .oa-body{min-height:260px;max-height:calc(86vh - 66px)}.oa-footer{display:flex;justify-content:flex-end;gap:8px;padding:12px 20px;border-top:1px solid var(--oa-line)}
    .oa-dialog button{font:inherit;cursor:pointer}.oa-icon{display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;padding:6px;border:0;border-radius:6px;background:transparent;color:var(--oa-muted,currentColor);flex-shrink:0}.oa-icon svg, .oa-symbol svg,.oa-search svg,.oa-toggle svg,.oa-list-folder svg{width:20px;height:20px;display:block;flex-shrink:0}.oa-icon:hover,.oa-toggle:hover{background:#8882;color:var(--oa-fg,inherit)}.oa-dialog button:disabled{opacity:.35;cursor:default}.oa-dialog button:focus-visible,.oa-dialog summary:focus-visible{outline:2px solid var(--oa-accent);outline-offset:2px}.oa-button{border:1px solid var(--oa-line);background:transparent;color:inherit;border-radius:8px;padding:7px 14px}.oa-primary{background:var(--oa-accent);color:#171724;border-color:transparent}.oa-toolbar{display:flex;align-items:center;gap:6px;margin-bottom:14px}.oa-search{display:flex;align-items:center;gap:8px;flex:1;border:1px solid var(--oa-line);border-radius:8px;padding:0 10px;color:var(--oa-muted)}
    .oa-dialog input,.oa-dialog textarea,.oa-dialog select{color:inherit;background:transparent;border:1px solid var(--oa-line);border-radius:8px;padding:9px 10px;font:inherit;width:100%;box-sizing:border-box;min-width:0}.oa-search input{border:0;outline:none;padding:9px 0}.oa-field{display:flex;flex-direction:column;gap:7px;margin-bottom:16px}.oa-field>span{font-size:13px;color:var(--oa-muted)}.oa-dialog textarea{resize:vertical;white-space:pre-wrap}.oa-dialog select option{color:#eee;background:#222}
    .oa-group{margin:8px 0;border:1px solid var(--oa-line);border-radius:10px;overflow:visible}.oa-group>.oa-row{background:#8881;border-radius:9px}.oa-row{position:relative;display:flex;align-items:center;gap:9px;min-height:44px;padding:4px 8px;box-sizing:border-box}.oa-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.oa-group>.oa-row>.oa-name{font-weight:600;cursor:pointer}.oa-symbol{color:var(--oa-muted);flex-shrink:0}.oa-group>.oa-row>.oa-symbol{color:#c4b391}.oa-count{color:var(--oa-muted);font-size:12px}.oa-row-actions{display:flex;gap:2px}.oa-row-actions .oa-icon{width:28px;height:28px;padding:5px}.oa-row-actions .oa-icon[data-sort]{cursor:grab;touch-action:none}.oa-toggle{width:20px;height:28px;border:0;padding:0;background:transparent;color:var(--oa-muted);flex-shrink:0}.oa-toggle svg{width:16px;height:16px;transition:transform .15s}.oa-open .oa-toggle svg{transform:rotate(90deg)}.oa-children{margin:0 12px 10px 30px;padding-left:8px;border-left:2px solid var(--oa-line)}.oa-children .oa-row+.oa-row{border-top:1px solid #8882}.oa-extras{margin-top:14px}.oa-extras>.oa-row{border-bottom:1px solid #8882}.oa-empty{height:28px}.oa-before::before,.oa-after::after{content:'';position:absolute;left:0;right:0;height:3px;background:var(--oa-accent);border-radius:3px;z-index:2;pointer-events:none}.oa-before::before{top:0}.oa-after::after{bottom:0}.oa-children,.oa-extras{position:relative}.oa-dragging{opacity:.3}.oa-ghost{position:fixed;pointer-events:none;z-index:3;background:var(--oa-bg);border:1px solid var(--oa-line);border-radius:8px;box-shadow:0 8px 24px #0006;opacity:.95}
    .oa-message{white-space:pre-line;margin:0 0 14px;line-height:1.7}.oa-warning{color:#ed969e;background:#eb6b7410;border:1px solid #eb6b7440;border-radius:8px;padding:12px}.oa-source-options{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:14px 0}.oa-source{display:flex;flex-direction:column;align-items:flex-start;gap:8px;padding:14px}.oa-source span{font-size:12px;color:var(--oa-muted)}.oa-source.oa-selected{border-color:var(--oa-accent);background:#a5a0f512}.oa-backup{display:flex;gap:8px}.oa-body h3{margin:0 0 14px;font-size:14px}.oa-db-top{display:flex;align-items:center;gap:8px;margin-bottom:16px}.oa-segment{display:flex;padding:3px;border-radius:9px;background:#8882;flex:1}.oa-segment label{flex:1;text-align:center;cursor:pointer}.oa-segment input{position:absolute;opacity:0;width:1px;height:1px}.oa-segment span{display:block;border-radius:6px;padding:7px 12px;color:var(--oa-muted)}.oa-segment input:checked+span{color:var(--oa-fg);background:var(--oa-bg);box-shadow:0 1px 4px #0003}.oa-segment input:focus-visible+span{outline:2px solid var(--oa-accent)}.oa-credentials{display:grid;grid-template-columns:minmax(0,1.2fr) minmax(0,1fr) auto;gap:8px;align-items:center}.oa-credentials .oa-button{padding:9px 12px}.oa-auth-state{font-size:12px;color:var(--oa-muted);min-height:18px;margin:10px 0 0}.oa-guide-section{border-bottom:1px solid var(--oa-line);padding:12px 0}.oa-guide-section:first-child{padding-top:0}.oa-guide-section summary{cursor:pointer;font-weight:600}.oa-guide-section ol{padding-left:23px}.oa-guide-section li{margin:8px 0;line-height:1.7}.oa-guide-section pre{white-space:pre-wrap;background:#8881;border-radius:6px;padding:10px;font-size:12px}.oa-guide-section small{color:var(--oa-muted);overflow-wrap:anywhere}
    .oa-native-hidden{display:none!important}.oa-tabs{overflow-x:auto!important;overflow-y:hidden!important;flex-wrap:nowrap!important}.oa-tab{background:transparent;border:0;border-bottom:2px solid transparent;padding:0 8px 8px;margin-bottom:-1px;flex-shrink:0;font-size:14px;color:inherit;white-space:nowrap;border-radius:0}.oa-tab-active{border-bottom-color:currentColor;font-weight:600}.oa-panel-config{width:28px;height:28px;margin-bottom:6px}.oa-panel-body{min-height:0;flex:1;overflow:auto;padding:8px 16px;font-size:14px}.oa-panel-body[hidden]{display:none}.oa-use{display:block;border:0;background:transparent;color:inherit;padding:8px;width:100%;text-align:left;border-radius:6px;font-size:14px}.oa-use:hover{background:#8882}.oa-list-folder summary{display:flex;align-items:center;gap:8px;padding:8px 0;cursor:pointer;font-weight:600;list-style:none}.oa-list-folder summary::-webkit-details-marker{display:none}.oa-list-folder summary svg:first-child{width:14px;height:14px}.oa-list-folder[open] summary svg:first-child{transform:rotate(90deg)}.oa-list-folder>.oa-use{margin-left:20px;width:calc(100% - 20px);padding-left:12px;border-left:2px solid #8884;border-radius:0}
    @media(max-width:480px){.oa-header{padding:0 12px}.oa-body{padding:14px}.oa-row-actions{gap:0}.oa-children{margin-left:22px}.oa-credentials{gap:5px}.oa-credentials input{padding:8px 6px}.oa-credentials .oa-button{padding:8px}.oa-source-options{gap:6px}.oa-source{padding:10px}}
  `; document.head.append(styles);
  let queued = false;
  const observer = new MutationObserver(() => { if (queued) return; queued = true; requestAnimationFrame(() => { queued = false; discover(); }); });
  observer.observe(document.body, { childList: true, subtree: true }); discover(); bookmark();
})();
