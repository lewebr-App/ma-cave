/* Version partagée : les données vivent dans Supabase, avec une copie locale pour l'usage hors connexion. */
(function () {
  "use strict";
  var CFG = window.CAVE_SUPABASE || {};
  var TABLES = ["vins", "mouvements", "config"];
  var CACHE_KEY = "cave-cache-v2", QUEUE_KEY = "cave-queue-v2", LEGACY_KEY = "cave-db-v1", LEGACY_DONE = "cave-legacy-sent";
  var sb = null, session = null, store, queue, listeners = [], flushing = false, readyResolve, ready = new Promise(function (r) { readyResolve = r; });

  function lsGet(k, d) { try { var v = JSON.parse(localStorage.getItem(k)); return v == null ? d : v; } catch (e) { return d; } }
  function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } }
  store = lsGet(CACHE_KEY, null) || { vins: {}, mouvements: {}, config: {} };
  TABLES.forEach(function (t) { if (!store[t]) store[t] = {}; });
  queue = lsGet(QUEUE_KEY, []);

  function persist() { lsSet(CACHE_KEY, store); lsSet(QUEUE_KEY, queue); }
  function notify() { setTimeout(function () { listeners.slice().forEach(function (l) { l(); }); }, 0); }
  function err(code, message) { return { code: code, message: message }; }
  function newId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
  function snapDoc(id, data) { var d = data ? JSON.parse(JSON.stringify(data)) : undefined; return { id: id, exists: !!data, data: function () { return d; }, metadata: { fromCache: false, hasPendingWrites: false } }; }

  /* ---------- Bandeau d'état (connexion, envoi en attente) ---------- */
  var banner = document.createElement("div");
  banner.style.cssText = "position:fixed;left:0;right:0;top:env(safe-area-inset-top,0px);z-index:70;text-align:center;font:600 12px/1.4 var(--f-body,system-ui);padding:5px 16px;background:var(--warn-soft,#F6E7CF);color:var(--warn,#A3620A)";
  banner.hidden = true;
  function setBanner(msg) { banner.textContent = msg || ""; banner.hidden = !msg; }
  document.addEventListener("DOMContentLoaded", function () { document.body.appendChild(banner); });
  function refreshBanner() {
    if (!navigator.onLine) setBanner(queue.length ? "Hors connexion : " + queue.length + " modification(s) en attente d'envoi" : "Hors connexion : affichage de la dernière copie");
    else if (queue.length) setBanner("Envoi de " + queue.length + " modification(s)…");
    else setBanner("");
  }

  /* ---------- Synchronisation ---------- */
  function enqueue(op) { queue.push(op); persist(); refreshBanner(); flush(); }
  function flush() {
    if (flushing || !sb || !session || !queue.length || !navigator.onLine) { refreshBanner(); return; }
    flushing = true;
    var op = queue[0];
    var req = op.op === "delete" ? sb.from(op.t).delete().eq("id", op.id) : sb.from(op.t).upsert({ id: op.id, data: op.data, updated_at: new Date().toISOString() });
    Promise.resolve(req).then(function (res) {
      flushing = false;
      if (res && res.error) {
        var e = res.error;
        if (e.code === "42501" || /row-level security/i.test(e.message || "")) {
          queue = []; persist(); setBanner("Ton compte n'a pas le droit de modifier cette cave."); return;
        }
        if (/fetch|network/i.test(e.message || "")) { refreshBanner(); setTimeout(flush, 15000); return; }
        queue.shift(); persist(); setBanner("Une modification a été refusée : " + (e.message || "erreur inconnue")); setTimeout(flush, 0); return;
      }
      queue.shift(); persist(); refreshBanner(); flush();
    }, function () { flushing = false; refreshBanner(); setTimeout(flush, 15000); });
  }
  window.addEventListener("online", flush);
  window.addEventListener("offline", refreshBanner);
  setInterval(flush, 30000);

  function pull() {
    return Promise.all(TABLES.map(function (t) { return sb.from(t).select("id,data"); })).then(function (rs) {
      var bad = rs.filter(function (r) { return r.error; })[0];
      if (bad) throw bad.error;
      var fresh = {};
      TABLES.forEach(function (t, i) { fresh[t] = {}; rs[i].data.forEach(function (row) { fresh[t][row.id] = row.data; }); });
      // les modifications encore en file d'attente priment sur le serveur
      queue.forEach(function (op) { if (op.op === "delete") delete fresh[op.t][op.id]; else fresh[op.t][op.id] = op.data; });
      store = fresh; persist(); notify();
      return { vins: Object.keys(fresh.vins).length };
    });
  }
  var channel = null;
  function subscribe() {
    if (channel) return;
    channel = sb.channel("cave");
    TABLES.forEach(function (t) {
      channel.on("postgres_changes", { event: "*", schema: "public", table: t }, function (p) {
        if (queue.some(function (op) { return op.t === t && op.id === (p.new && p.new.id || p.old && p.old.id); })) return;
        if (p.eventType === "DELETE") { if (p.old && p.old.id) delete store[t][p.old.id]; }
        else if (p.new && p.new.id) store[t][p.new.id] = p.new.data;
        persist(); notify();
      });
    });
    channel.subscribe();
    document.addEventListener("visibilitychange", function () { if (!document.hidden && navigator.onLine) pull().catch(function () {}); });
  }

  /* ---------- Interface attendue par l'appli (même forme que Claude) ---------- */
  function write(t, id, data) {
    store[t] = store[t] || {};
    if (data === null) delete store[t][id]; else store[t][id] = JSON.parse(JSON.stringify(data));
    persist(); notify();
    enqueue(data === null ? { t: t, id: id, op: "delete" } : { t: t, id: id, op: "upsert", data: store[t][id] });
    return Promise.resolve();
  }
  function docRef(t, id) {
    return {
      id: id, path: t + "/" + id,
      get: function () { return Promise.resolve(snapDoc(id, store[t][id])); },
      set: function (d) { return write(t, id, d); },
      update: function (d) {
        if (!store[t][id]) return Promise.reject(err("invalid_argument", "Document absent"));
        var m = JSON.parse(JSON.stringify(store[t][id])); Object.keys(d).forEach(function (k) { m[k] = d[k]; });
        return write(t, id, m);
      },
      delete: function () { return write(t, id, null); },
      onSnapshot: function (next) {
        var l = function () { next(snapDoc(id, store[t][id])); };
        listeners.push(l); ready.then(l);
        return function () { listeners = listeners.filter(function (x) { return x !== l; }); };
      }
    };
  }
  function query(t, ord, lim) {
    return {
      orderBy: function (f, dir) { return query(t, { f: f, dir: dir || "asc" }, lim); },
      limit: function (n) { return query(t, ord, n); },
      doc: function (id) { return docRef(t, id || newId()); },
      add: function (d) { var r = docRef(t, newId()); return r.set(d).then(function () { return r; }); },
      onSnapshot: function (next) {
        var l = function () {
          var all = store[t] || {};
          var docs = Object.keys(all).sort().map(function (k) { return snapDoc(k, all[k]); });
          if (ord) docs.sort(function (a, b) { var x = a.data()[ord.f], y = b.data()[ord.f]; var c = x < y ? -1 : x > y ? 1 : 0; return ord.dir === "desc" ? -c : c; });
          if (lim) docs = docs.slice(0, lim);
          next({ docs: docs, size: docs.length, empty: !docs.length, docChanges: function () { return []; }, metadata: { fromCache: false, hasPendingWrites: !!queue.length } });
        };
        listeners.push(l); ready.then(l);
        return function () { listeners = listeners.filter(function (x) { return x !== l; }); };
      }
    };
  }
  var db = { collection: function (p) { return query(p); }, doc: function (p) { var s = p.split("/"); return docRef(s[0], s[1]); } };

  var assets = {
    upload: function (file) {
      return new Promise(function (res, rej) {
        var img = new Image(), url = URL.createObjectURL(file);
        img.onload = function () {
          var s = Math.min(1, 480 / Math.max(img.width, img.height)), c = document.createElement("canvas");
          c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
          c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
          URL.revokeObjectURL(url); res({ id: newId(), url: c.toDataURL("image/jpeg", 0.72) });
        };
        img.onerror = function () { rej(err("invalid_argument", "Image illisible")); };
        img.src = url;
      });
    }
  };
  function saveFile(filename, data, type) {
    var blob = data instanceof Blob ? data : new Blob([data], { type: type || "text/plain;charset=utf-8" }), file = null;
    try { file = new File([blob], filename, { type: blob.type }); } catch (e) {}
    if (file && navigator.canShare && navigator.canShare({ files: [file] }) && /iPhone|iPad|Android/i.test(navigator.userAgent)) {
      return navigator.share({ files: [file], title: filename }).then(function () { return { status: "saved" }; }, function (e) { return Promise.reject(err("declined", String(e))); });
    }
    var a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = filename;
    document.body.appendChild(a); a.click(); setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    return Promise.resolve({ status: "saved" });
  }
  var downloads = { save: function (r) { return saveFile(r.filename, r.data, /\.csv$/.test(r.filename) ? "text/csv;charset=utf-8" : null); } };
  var user = { can: function () { return Promise.resolve(true); }, isOwner: function () { return Promise.resolve(true); }, canEdit: function () { return Promise.resolve(true); } };

  function importData(d, keepRemotePhotos) {
    var n = 0;
    TABLES.forEach(function (t) {
      Object.keys(d[t] || {}).forEach(function (id) {
        var doc = JSON.parse(JSON.stringify(d[t][id]));
        if (t === "vins" && doc.photo && /^photos\//.test(doc.photo)) { var cur = store.vins[id]; if (cur && cur.photo && keepRemotePhotos) doc.photo = cur.photo; else delete doc.photo; }
        store[t][id] = doc; queue.push({ t: t, id: id, op: "upsert", data: doc }); if (t === "vins") n++;
      });
    });
    persist(); notify(); refreshBanner(); flush();
    return n;
  }

  window.caveLocal = {
    shared: true,
    email: function () { return session && session.user && session.user.email; },
    signOut: function () { return sb.auth.signOut().then(function () { localStorage.removeItem(CACHE_KEY); localStorage.removeItem(QUEUE_KEY); location.reload(); }); },
    exportBackup: function () { return saveFile("cave-sauvegarde-" + new Date().toISOString().slice(0, 10) + ".json", JSON.stringify({ app: "ma-cave", version: 2, date: new Date().toISOString(), data: store }), "application/json"); },
    importBackup: function (file) {
      return file.text().then(function (txt) {
        var j = JSON.parse(txt), d = j && j.data;
        if (!d || typeof d.vins !== "object") throw err("invalid_argument", "Ce fichier n'est pas une sauvegarde de Ma cave.");
        return importData(d, true);
      });
    },
    // Données de l'ancienne version (stockées seulement sur ce téléphone)
    hasLegacy: function () { var l = lsGet(LEGACY_KEY, null); return !!(l && l.vins && !lsGet(LEGACY_DONE, false)); },
    sendLegacy: function () { var n = importData(lsGet(LEGACY_KEY, {}), true); lsSet(LEGACY_DONE, true); return Promise.resolve(n); },
    dismissLegacy: function () { lsSet(LEGACY_DONE, true); }
  };

  /* ---------- Écran de connexion ---------- */
  function loginScreen(msg) {
    var w = document.createElement("div");
    w.id = "login";
    w.style.cssText = "position:fixed;inset:0;z-index:80;background:var(--stone,#ECEEEC);display:flex;align-items:center;justify-content:center;padding:24px max(16px,env(safe-area-inset-right,0px)) 24px max(16px,env(safe-area-inset-left,0px))";
    w.innerHTML = '<form class="f" id="lf" style="width:100%;max-width:360px;display:grid;gap:12px"><h1 style="margin:0 0 4px">Ma cave</h1>' +
      '<p style="margin:0 0 6px;color:var(--muted)">Connecte-toi pour ouvrir la cave partagée.</p>' +
      '<label>E-mail<input id="le" type="email" autocomplete="username" required></label>' +
      '<label>Mot de passe<input id="lp" type="password" autocomplete="current-password" minlength="6" required></label>' +
      '<div id="lm" style="font-size:13px;color:var(--bad,#A8322D);min-height:1em">' + (msg || "") + "</div>" +
      '<button class="btn primary" type="submit" id="lgo">Se connecter</button>' +
      '<button class="btn" type="button" id="lnew">Première fois : créer mon accès</button></form>';
    document.body.appendChild(w);
    var m = w.querySelector("#lm");
    function creds() { return { email: w.querySelector("#le").value.trim(), password: w.querySelector("#lp").value }; }
    w.querySelector("#lf").onsubmit = function (e) {
      e.preventDefault(); m.style.color = ""; m.textContent = "Connexion…";
      sb.auth.signInWithPassword(creds()).then(function (r) {
        if (r.error) { m.style.color = "var(--bad,#A8322D)"; m.textContent = /confirm/i.test(r.error.message) ? "Confirme d'abord ton adresse avec le lien reçu par e-mail." : "E-mail ou mot de passe incorrect."; return; }
        w.remove(); start(r.data.session);
      });
    };
    w.querySelector("#lnew").onclick = function () {
      var c = creds(); if (!c.email || c.password.length < 6) { m.textContent = "Saisis ton e-mail et un mot de passe d'au moins 6 caractères."; return; }
      sb.auth.signUp({ email: c.email, password: c.password, options: { emailRedirectTo: location.href.split("#")[0] } }).then(function (r) {
        if (r.error) { m.style.color = "var(--bad,#A8322D)"; m.textContent = r.error.message; return; }
        if (r.data.session) { w.remove(); start(r.data.session); return; }
        m.style.color = "var(--ok,#2F7D4F)"; m.textContent = "Accès créé. Ouvre le lien reçu par e-mail pour confirmer, puis reviens ici et connecte-toi.";
      });
    };
  }

  function start(s) {
    session = s;
    pull().then(function (r) {
      readyResolve();
      if (!r.vins && !Object.keys(store.config).length) setBanner("Aucune donnée visible : demande qu'on ajoute " + (s.user.email || "ton e-mail") + " à la liste des membres.");
    }, function () { readyResolve(); refreshBanner(); });
    subscribe(); flush();
  }

  var caps = { db: db, assets: assets, downloads: downloads, user: user };
  window.claude = { use: function (n) { return Promise.resolve(caps[n] || null); } };

  if (!window.supabase || !CFG.url || !CFG.key) {
    // Pas de bibliothèque (hors connexion au premier lancement) ou pas encore configuré : copie locale seule.
    readyResolve(); setTimeout(refreshBanner, 0);
  } else {
    sb = window.supabase.createClient(CFG.url, CFG.key, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } });
    sb.auth.getSession().then(function (r) {
      var s = r.data && r.data.session;
      if (s) start(s);
      else if (Object.keys(store.vins).length && !navigator.onLine) readyResolve();
      else { readyResolve(); document.readyState === "loading" ? document.addEventListener("DOMContentLoaded", function () { loginScreen(); }) : loginScreen(); }
    });
  }

  try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) {}
  if ("serviceWorker" in navigator && location.protocol === "https:") {
    window.addEventListener("load", function () { navigator.serviceWorker.register("sw.js").catch(function () {}); });
  }
})();
