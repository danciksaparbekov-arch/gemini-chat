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

  function bubble(role, text, cls, images, meta) {
    const d = document.createElement("div");
    d.className = "msg " + role + (cls ? " " + cls : "");
    if (images) images.forEach(im => { const i = document.createElement("img"); i.src = "data:" + im.mime + ";base64," + im.data; i.alt = "вложение"; d.appendChild(i); });
    const body = document.createElement("div");
    body.innerHTML = role === "model" && cls !== "error" && cls !== "pending" ? md(text) : esc(text).replace(/\n/g, "<br>");
    d.appendChild(body);
    if (meta) { const m = document.createElement("div"); m.className = "meta"; m.textContent = meta; d.appendChild(m); }
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
      const r = await fetch(API + "models/" + encodeURIComponent(model) + ":generateContent", {
        method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify({ contents })
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error((d.error && d.error.message) || "HTTP " + r.status);
      const cand = d.candidates && d.candidates[0];
      const reply = ((cand && cand.content && cand.content.parts) || []).filter(p => !p.thought).map(p => p.text || "").join("").trim();
      if (!reply) throw new Error(d.promptFeedback && d.promptFeedback.blockReason ? "запрос заблокирован: " + d.promptFeedback.blockReason : "пустой ответ модели");
      wait.remove();
      bubble("model", reply, "", null, d.modelVersion || model);
      history.push({ role: "model", text: reply });
    } catch (err) {
      wait.remove(); history.pop();
      bubble("model", "Ошибка: " + err.message, "error");
    } finally { busy = false; $("send").disabled = false; input.focus(); }
  });

  key = store.get("gc-key");
  intro(); loadModels();
})();
