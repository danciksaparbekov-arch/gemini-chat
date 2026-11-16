// Чат с Gemini прямо из браузера. Ключ вводит пользователь, хранится в localStorage
// и уходит только в generativelanguage.googleapis.com. Бэкенда нет.
(function () {
  const API = "https://generativelanguage.googleapis.com/v1beta/";
  const $ = id => document.getElementById(id);
  const log = $("log"), input = $("input"), thumbs = $("thumbs"), sel = $("model");
  const MAX_SIDE = 1600, MAX_IMAGES = 6;

  let key = "", history = [], pending = [], busy = false;
  const store = {
    get(k) { try { return localStorage.getItem(k) || sessionStorage.getItem(k) || ""; } catch (e) { return ""; } },
    set(k, v, persist) { try { (persist ? localStorage : sessionStorage).setItem(k, v); } catch (e) {} },
    del(k) { try { localStorage.removeItem(k); sessionStorage.removeItem(k); } catch (e) {} }
  };

  // --- безопасный мини-markdown: сначала экранирование ---
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const inl = s => esc(s).replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>").replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>");
  function md(text) {
    const out = []; let list = null, code = null;
    const flush = () => { if (list) { out.push("<ul>" + list.map(x => "<li>" + inl(x) + "</li>").join("") + "</ul>"); list = null; } };
    for (const line of String(text).replace(/\r/g, "").split("\n")) {
      if (line.trim().startsWith("```")) { if (code) { out.push("<pre><code>" + esc(code.join("\n")) + "</code></pre>"); code = null; } else { flush(); code = []; } continue; }
      if (code) { code.push(line); continue; }
      const t = line.trim();
      if (/^[-*] /.test(t)) { (list = list || []).push(t.slice(2)); continue; }
      flush();
      if (/^#{1,6} /.test(t)) out.push("<p><strong>" + inl(t.replace(/^#+ /, "")) + "</strong></p>");
      else if (t) out.push("<p>" + inl(t) + "</p>");
    }
    if (code) out.push("<pre><code>" + esc(code.join("\n")) + "</code></pre>");
    flush();
    return out.join("");
  }

  // --- режимы, системный промпт и база знаний (kb/) ---
  const modeSel = $("mode"), searchChk = $("search");
  let sysText = null, kbChunks = null;
  async function loadText(url) {
    const r = await fetch(url, { cache: "no-cache" });
    if (!r.ok) throw new Error(url + ": HTTP " + r.status);
    return r.text();
  }
  async function getSystem() {
    if (sysText === null) { try { sysText = await loadText("prompts/3dsmax.md"); } catch (e) { sysText = ""; } }
    return sysText;
  }
  // Стем по префиксу — грубо, но работает для русского и английского без словарей
  const stems = s => (String(s).toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) || []).map(w => w.slice(0, 5));
  async function getChunks() {
    if (kbChunks) return kbChunks;
    kbChunks = [];
    try {
      const idx = JSON.parse(await loadText("kb/index.json"));
      for (const f of idx.files || []) {
        let txt = "";
        try { txt = await loadText("kb/" + f.file); } catch (e) { continue; }
        for (const part of txt.split(/^## /m).slice(1)) {
          const nl = part.indexOf("\n");
          const head = (nl < 0 ? part : part.slice(0, nl)).trim();
          const body = nl < 0 ? "" : part.slice(nl + 1).trim();
          if (!body) continue;
          kbChunks.push({ title: (f.title || f.file) + " → " + head, text: body, head: new Set(stems(head)), set: new Set(stems(head + " " + body)) });
        }
      }
    } catch (e) { /* базы нет — работаем без неё */ }
    return kbChunks;
  }
  async function retrieve(query) {
    const q = [...new Set(stems(query))];
    if (!q.length) return [];
    const scored = (await getChunks()).map(c => ({ c, s: q.reduce((a, w) => a + (c.set.has(w) ? 1 : 0) + (c.head.has(w) ? 2 : 0), 0) }))
      .filter(x => x.s > 0).sort((a, b) => b.s - a.s).slice(0, 4);
    const out = []; let size = 0;
    for (const { c } of scored) { if (size + c.text.length > 8000) break; size += c.text.length; out.push(c); }
    return out;
  }
  modeSel.value = store.get("gc-mode") || "3dsmax";
  modeSel.addEventListener("change", () => store.set("gc-mode", modeSel.value, true));
  searchChk.checked = store.get("gc-search") === "1";
  searchChk.addEventListener("change", () => store.set("gc-search", searchChk.checked ? "1" : "0", true));

  function bubble(role, text, cls, images, meta, sources) {
    const d = document.createElement("div");
    d.className = "msg " + role + (cls ? " " + cls : "");
    if (images) images.forEach(im => { const i = document.createElement("img"); i.src = "data:" + im.mime + ";base64," + im.data; i.alt = "вложение"; d.appendChild(i); });
    const body = document.createElement("div");
    body.innerHTML = role === "model" && cls !== "error" && cls !== "pending" ? md(text) : esc(text).replace(/\n/g, "<br>");
    d.appendChild(body);
    if (meta) { const m = document.createElement("div"); m.className = "meta"; m.textContent = meta; d.appendChild(m); }
    if (sources && sources.length) {
      const s = document.createElement("div"); s.className = "meta"; s.append("Источники: ");
      sources.forEach((x, i) => {
        if (!/^https?:\/\//i.test(x.uri || "")) return;
        const a = document.createElement("a"); a.href = x.uri; a.target = "_blank"; a.rel = "noopener noreferrer";
        a.textContent = x.title || x.uri; if (i) s.append(" · "); s.appendChild(a);
      });
      d.appendChild(s);
    }
    log.appendChild(d); log.scrollTop = log.scrollHeight;
    return d;
  }
  const intro = () => bubble("model", key ? "Выберите модель и задавайте вопрос. Скриншот можно вставить через Ctrl+V, перетащить в окно или добавить кнопкой 📎." : "Чтобы начать, нажмите «🔑 Ключ» и вставьте свой Gemini API key.");

  // --- ключ и модели ---
  function setKey(k, persist) {
    key = k.trim();
    store.del("gc-key");
    if (key) store.set("gc-key", key, persist);
  }
  // API не сообщает цену, поэтому «бесплатные» определяем по имени: Flash / Flash-Lite / Gemma / Hydrogen.
  // Исключаем Pro, генерацию картинок/видео/музыки, голос, Live, Computer Use, эмбеддинги.
  const isFree = name => /(flash|gemma|hydrogen)/i.test(name) &&
    !/(pro|image|imagen|veo|lyria|tts|audio|live|native|computer|embedding|robotics|omni)/i.test(name);
  async function loadModels() {
    if (!key) { sel.disabled = true; sel.innerHTML = "<option>Сначала введите ключ</option>"; return; }
    sel.disabled = true; sel.innerHTML = "<option>Загрузка моделей…</option>";
    try {
      let models = [], token = "";
      do {
        const r = await fetch(API + "models?pageSize=1000" + (token ? "&pageToken=" + encodeURIComponent(token) : ""), { headers: { "x-goog-api-key": key } });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error((d.error && d.error.message) || "HTTP " + r.status);
        models = models.concat(d.models || []); token = d.nextPageToken || "";
      } while (token);
      models = models.filter(m => (m.supportedGenerationMethods || []).includes("generateContent") && isFree(m.name))
        .sort((a, b) => b.name.localeCompare(a.name));
      if (!models.length) throw new Error("нет бесплатных моделей");
      sel.innerHTML = "";
      models.forEach(m => { const o = document.createElement("option"); o.value = m.name.replace(/^models\//, ""); o.textContent = (m.displayName || o.value) + " — " + o.value; sel.appendChild(o); });
      const saved = store.get("gc-model");
      if (saved && [...sel.options].some(o => o.value === saved)) sel.value = saved;
      sel.disabled = false;
    } catch (e) {
      sel.innerHTML = "<option>Не удалось загрузить</option>";
      bubble("model", "Ошибка загрузки моделей: " + e.message, "error");
    }
  }
  sel.addEventListener("change", () => store.set("gc-model", sel.value, true));
  $("refresh").onclick = loadModels;

  const dlg = $("key-dlg");
  $("key-btn").onclick = () => { $("key-input").value = key; dlg.showModal(); };
  $("key-form").addEventListener("submit", e => {
    if (e.submitter && e.submitter.value === "ok") {
      setKey($("key-input").value, $("key-remember").checked);
      history = []; log.innerHTML = ""; intro(); loadModels();
    }
  });

  // --- вложения ---
  function readImage(file) {
    return new Promise((res, rej) => {
      const url = URL.createObjectURL(file), img = new Image();
      img.onload = () => {
        const k = Math.min(1, MAX_SIDE / Math.max(img.width, img.height));
        const c = document.createElement("canvas"); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
        c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        const png = file.type === "image/png" && k === 1 && file.size < 1.5e6;
        const mime = png ? "image/png" : "image/jpeg";
        res({ mime, data: c.toDataURL(mime, 0.9).split(",")[1] });
      };
      img.onerror = () => { URL.revokeObjectURL(url); rej(new Error("не удалось прочитать изображение")); };
      img.src = url;
    });
  }
  async function addFiles(files) {
    for (const f of files) {
      if (!f.type.startsWith("image/")) continue;
      if (pending.length >= MAX_IMAGES) { bubble("model", "Не больше " + MAX_IMAGES + " изображений за раз.", "error"); break; }
      try { pending.push(await readImage(f)); } catch (e) { bubble("model", e.message, "error"); }
    }
    drawThumbs();
  }
  function drawThumbs() {
    thumbs.innerHTML = "";
    pending.forEach((im, i) => {
      const w = document.createElement("div"); w.className = "th";
      const g = document.createElement("img"); g.src = "data:" + im.mime + ";base64," + im.data;
      const b = document.createElement("button"); b.type = "button"; b.textContent = "×"; b.onclick = () => { pending.splice(i, 1); drawThumbs(); };
      w.append(g, b); thumbs.appendChild(w);
    });
  }
  $("attach").onclick = () => $("file").click();
  $("file").onchange = e => { addFiles([...e.target.files]); e.target.value = ""; };
  document.addEventListener("paste", e => {
    const fs = [...(e.clipboardData ? e.clipboardData.files : [])].filter(f => f.type.startsWith("image/"));
    if (fs.length) { e.preventDefault(); addFiles(fs); }
  });
  let dragN = 0; const drop = $("drop");
  const hasFiles = e => e.dataTransfer && [...e.dataTransfer.types].includes("Files");
  document.addEventListener("dragenter", e => { if (hasFiles(e)) { dragN++; drop.hidden = false; } });
  document.addEventListener("dragleave", e => { if (hasFiles(e) && --dragN <= 0) { dragN = 0; drop.hidden = true; } });
  document.addEventListener("dragover", e => { if (hasFiles(e)) e.preventDefault(); });
  document.addEventListener("drop", e => { if (hasFiles(e)) { e.preventDefault(); dragN = 0; drop.hidden = true; addFiles([...e.dataTransfer.files]); } });

  // --- отправка ---
  input.addEventListener("input", () => { input.style.height = "auto"; input.style.height = Math.min(input.scrollHeight, 180) + "px"; });
  input.addEventListener("keydown", e => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); $("form").requestSubmit(); } });
  $("clear").onclick = () => { history = []; pending = []; drawThumbs(); log.innerHTML = ""; intro(); };

  $("form").addEventListener("submit", async e => {
    e.preventDefault();
    if (busy) return;
    const text = input.value.trim();
    if (!text && !pending.length) return;
    if (!key) { dlg.showModal(); return; }
    if (sel.disabled) { bubble("model", "Модель не выбрана — проверьте ключ.", "error"); return; }
    const model = sel.value, imgs = pending;
    pending = []; drawThumbs(); input.value = ""; input.style.height = "auto";
    bubble("user", text, "", imgs);
    // Картинки хранятся в истории только в памяти страницы; в запрос уходят из последних 3 реплик с картинками
    history.push({ role: "user", text, imgs });
    const wait = bubble("model", "Думаю…", "pending");
    busy = true; $("send").disabled = true;
    try {
      let withImg = 0;
      const contents = history.slice(-20).reverse().map(m => {
        const parts = [];
        if (m.imgs && m.imgs.length && withImg < 3) { withImg++; m.imgs.forEach(i => parts.push({ inlineData: { mimeType: i.mime, data: i.data } })); }
        else if (m.imgs && m.imgs.length) parts.push({ text: "[изображение опущено]" });
        parts.push({ text: m.text || "(см. изображение)" });
        return { role: m.role, parts };
      }).reverse();
      // Системный промпт режима + найденные фрагменты базы знаний
      let system = "", used = [];
      if (modeSel.value === "3dsmax") {
        system = await getSystem();
        const prevUser = history.slice(0, -1).reverse().find(m => m.role === "user");
        used = await retrieve(text + " " + (prevUser ? prevUser.text : ""));
        if (used.length) system += "\n\nСправочные материалы (из базы знаний пользователя):\n" + used.map(c => "### " + c.title + "\n" + c.text).join("\n\n");
      }
      const payload = { contents };
      if (system) payload.systemInstruction = { parts: [{ text: system }] };
      if (searchChk.checked) payload.tools = [{ google_search: {} }];
      const r = await fetch(API + "models/" + encodeURIComponent(model) + ":generateContent", {
        method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify(payload)
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error((d.error && d.error.message) || "HTTP " + r.status);
      const cand = d.candidates && d.candidates[0];
      const reply = ((cand && cand.content && cand.content.parts) || []).filter(p => !p.thought).map(p => p.text || "").join("").trim();
      if (!reply) throw new Error(d.promptFeedback && d.promptFeedback.blockReason ? "запрос заблокирован: " + d.promptFeedback.blockReason : "пустой ответ модели");
      wait.remove();
      const src = ((cand.groundingMetadata && cand.groundingMetadata.groundingChunks) || []).map(c => c.web).filter(Boolean);
      const meta = (d.modelVersion || model) + (used.length ? " · база знаний: " + used.length : "");
      bubble("model", reply, "", null, meta, src);
      history.push({ role: "model", text: reply });
    } catch (err) {
      wait.remove(); history.pop();
      bubble("model", "Ошибка: " + err.message, "error");
    } finally { busy = false; $("send").disabled = false; input.focus(); }
  });

  key = store.get("gc-key");
  intro(); loadModels();
})();
