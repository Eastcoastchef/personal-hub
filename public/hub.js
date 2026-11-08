// Shared helpers for the hub's tool pages: data API, dates, money, forms.
(function () {
  const H = {};

  // ---- API ----
  H.api = async function (method, path, body) {
    const res = await fetch("/api/" + path, {
      method,
      headers: method === "GET" ? {} : { "Content-Type": "application/json", "X-Hub": "1" },
      body: body ? JSON.stringify(body) : undefined,
      credentials: "same-origin",
    });
    if (res.status === 401) { location.href = "/"; throw new Error("Logged out"); }
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Could not save");
    return res.json();
  };
  H.list = (col) => H.api("GET", col);
  H.create = (col, data) => H.api("POST", col, data);
  H.update = (col, id, data) => H.api("PUT", col + "/" + id, data);
  H.remove = (col, id) => H.api("DELETE", col + "/" + id);

  // ---- Dates (all as local YYYY-MM-DD) ----
  H.today = function () { const d = new Date(); d.setHours(0, 0, 0, 0); return d; };
  H.parse = function (s) { if (!s) return null; const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
  H.iso = function (d) { return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); };
  H.days = function (d) { return Math.round((d - H.today()) / 864e5); };
  H.addDays = function (d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
  H.addMonths = function (d, n) {
    const x = new Date(d.getFullYear(), d.getMonth() + n, 1);
    const last = new Date(x.getFullYear(), x.getMonth() + 1, 0).getDate();
    x.setDate(Math.min(d.getDate(), last));
    return x;
  };
  const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  H.short = function (d) { return d.getDate() + " " + MON[d.getMonth()]; };
  H.long = function (d) { return d.getDate() + " " + MON[d.getMonth()] + " " + d.getFullYear(); };
  H.whenBadge = function (d) {
    const n = H.days(d);
    if (n === 0) return '<div class="when"><b>Today</b><span>' + H.short(d) + "</span></div>";
    if (n < 0) return '<div class="when"><b>' + Math.abs(n) + "</b><span>days late</span></div>";
    return '<div class="when"><b>' + n + "</b><span>" + (n === 1 ? "day" : "days") + "</span></div>";
  };

  // ---- Bill frequencies ----
  H.FREQ = {
    weekly: { label: "Weekly", perMonth: 52 / 12, step: (d) => H.addDays(d, 7) },
    fourweekly: { label: "Every 4 weeks", perMonth: 13 / 12, step: (d) => H.addDays(d, 28) },
    monthly: { label: "Monthly", perMonth: 1, step: (d) => H.addMonths(d, 1) },
    quarterly: { label: "Quarterly", perMonth: 1 / 3, step: (d) => H.addMonths(d, 3) },
    yearly: { label: "Yearly", perMonth: 1 / 12, step: (d) => H.addMonths(d, 12) },
  };
  // Next date on or after today for a repeating date.
  H.nextDue = function (first, freq) {
    let d = H.parse(first);
    const f = H.FREQ[freq] || H.FREQ.monthly;
    if (!d) return null;
    let guard = 0;
    while (d < H.today() && guard++ < 1000) d = f.step(d);
    return d;
  };

  // ---- Money ----
  H.money = function (n) {
    const v = Number(n) || 0;
    return "£" + v.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  };

  // ---- Text ----
  H.esc = function (s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  };

  // ---- Toast ----
  H.toast = function (msg, isErr) {
    document.querySelectorAll(".toast").forEach((x) => x.remove());
    const t = document.createElement("div");
    t.className = "toast" + (isErr ? " err" : "");
    t.setAttribute("role", "status");
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 2600);
  };

  // ---- Form dialog ----
  // fields: [{name,label,type,options,required,step,placeholder,full,value}]
  H.form = function ({ title, fields, values = {}, submitLabel = "Save", onSubmit, onDelete }) {
    const dlg = document.createElement("dialog");
    const rows = [];
    let pair = [];
    const flush = () => { if (pair.length) { rows.push(pair.length === 2 ? '<div class="grid2">' + pair.join("") + "</div>" : pair[0]); pair = []; } };
    fields.forEach((f) => {
      const v = values[f.name] != null ? values[f.name] : f.value != null ? f.value : "";
      const id = "f_" + f.name;
      let ctl;
      if (f.type === "select") {
        ctl = '<select id="' + id + '" name="' + f.name + '">' + f.options.map((o) => '<option value="' + H.esc(o[0]) + '"' + (String(v) === String(o[0]) ? " selected" : "") + ">" + H.esc(o[1]) + "</option>").join("") + "</select>";
      } else if (f.type === "textarea") {
        ctl = '<textarea id="' + id + '" name="' + f.name + '">' + H.esc(v) + "</textarea>";
      } else if (f.type === "checkbox") {
        const html = '<label class="check"><input type="checkbox" id="' + id + '" name="' + f.name + '"' + (v ? " checked" : "") + "> " + H.esc(f.label) + "</label>";
        flush(); rows.push(html); return;
      } else {
        ctl = '<input id="' + id + '" name="' + f.name + '" type="' + (f.type || "text") + '"' + (f.step ? ' step="' + f.step + '"' : "") + (f.type === "number" ? ' inputmode="decimal"' : "") + (f.placeholder ? ' placeholder="' + H.esc(f.placeholder) + '"' : "") + (f.required ? " required" : "") + ' value="' + H.esc(v) + '">';
      }
      const html = '<label class="f" for="' + id + '">' + H.esc(f.label) + ctl + "</label>";
      if (f.full) { flush(); rows.push(html); } else { pair.push(html); if (pair.length === 2) flush(); }
    });
    flush();
    dlg.innerHTML = '<form method="dialog"><h2>' + H.esc(title) + "</h2>" + rows.join("") +
      '<div class="formbar">' + (onDelete ? '<button type="button" class="danger" data-act="del">Delete</button>' : "") +
      '<div class="right"><button type="button" class="ghost" data-act="cancel">Cancel</button><button type="submit" class="copper">' + H.esc(submitLabel) + "</button></div></div></form>";
    document.body.appendChild(dlg);
    const form = dlg.querySelector("form");
    let confirmDel = false;
    dlg.addEventListener("click", async (e) => {
      const act = e.target.getAttribute && e.target.getAttribute("data-act");
      if (act === "cancel") dlg.close();
      if (act === "del") {
        if (!confirmDel) { confirmDel = true; e.target.textContent = "Tap again to delete"; return; }
        try { await onDelete(); dlg.close(); } catch (err) { H.toast(err.message, true); }
      }
    });
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const out = {};
      fields.forEach((f) => {
        const el = form.elements[f.name];
        if (f.type === "checkbox") out[f.name] = el.checked;
        else if (f.type === "number") out[f.name] = el.value === "" ? null : Number(el.value);
        else out[f.name] = el.value.trim();
      });
      const btn = form.querySelector('button[type="submit"]');
      btn.disabled = true;
      try { await onSubmit(out); dlg.close(); } catch (err) { H.toast(err.message, true); btn.disabled = false; }
    });
    dlg.addEventListener("close", () => dlg.remove());
    dlg.showModal();
    const first = form.querySelector("input,select,textarea");
    if (first) first.focus();
  };

  window.Hub = H;
})();
