// Builds a tool page from a list of sections. Each section is one data list
// (a D1 collection) with its own fields, how a row looks, and what counts as due.
// Needs hub.js first.
(function () {
  const H = window.Hub;
  H.PEOPLE = [["carl", "Carl"], ["caley", "Caley"], ["jessica", "Jessica"], ["ben", "Ben"], ["everyone", "Everyone"]];
  H.PERSON = Object.fromEntries(H.PEOPLE);

  // Next date for a "do it every N days" task.
  H.nextEvery = function (it) { const l = H.parse(it.last); return l ? H.addDays(l, Number(it.every) || 30) : null; };
  // Pill for something due on date d, warning `warn` days ahead.
  H.duePill = function (d, warn, words) {
    const w = words || {};
    if (!d) return '<span class="pill flat">' + (w.none || "No date") + "</span>";
    const n = H.days(d);
    if (n < 0) return '<span class="pill late">' + (w.late || "Overdue") + "</span>";
    if (n <= warn) return '<span class="pill soon">' + (w.soon || "Due soon") + "</span>";
    return '<span class="pill ok">' + (w.ok || "Fine") + "</span>";
  };

  H.tool = function ({ sections, stats, intro }) {
    const app = document.getElementById("app");
    const data = {};
    sections.forEach((s) => (data[s.col] = []));

    app.innerHTML = (stats ? '<div class="stats" id="stats"></div>' : "") + (intro ? '<p class="meta" style="margin:0 0 6px">' + intro + "</p>" : "") +
      sections.map((s) =>
        '<section aria-labelledby="h-' + s.col + '"><div class="label" id="h-' + s.col + '">' + H.esc(s.title) + "</div>" +
        '<div class="titlebar"><span class="meta">' + H.esc(s.intro || "") + '</span><button class="copper" data-add="' + s.col + '">+ ' + H.esc(s.addLabel || "Add") + "</button></div>" +
        '<div id="sec-' + s.col + '"><div class="empty"><b>Loading…</b></div></div></section>').join("");

    function renderStats() {
      if (!stats) return;
      document.getElementById("stats").innerHTML = stats(data).map((x) =>
        '<div class="stat"><div class="k">' + H.esc(x.k) + '</div><div class="v">' + H.esc(x.v) + '</div><div class="s">' + H.esc(x.s || " ") + "</div></div>").join("");
    }

    function renderSection(s) {
      const el = document.getElementById("sec-" + s.col);
      let rows = data[s.col].slice();
      if (!rows.length) {
        el.innerHTML = '<div class="empty"><b>' + H.esc(s.emptyTitle || "Nothing here yet") + "</b>" + H.esc(s.emptyText || "") +
          (s.starter ? '<br><button class="copper" data-starter="' + s.col + '">' + H.esc(s.starter.label) + "</button>" : "") + "</div>";
        return;
      }
      if (s.sort) rows.sort((a, b) => s.sort(a, b, data));
      el.innerHTML = '<div class="list">' + rows.map((it) => {
        const v = s.row(it, data);
        const left = v.date !== undefined ? (v.date ? H.whenBadge(v.date) : '<div class="when"><b>?</b><span>no date</span></div>')
          : v.dayBadge ? '<div class="when"><b>' + v.dayBadge[0] + "</b><span>" + H.esc(v.dayBadge[1]) + "</span></div>"
          : '<div class="ico-badge">' + H.esc((v.initials || it.name || "?").slice(0, 2).toUpperCase()) + "</div>";
        const acts = (s.actions || []).filter((a) => !a.show || a.show(it)).map((a, i) =>
          '<button class="ghost" data-run="' + s.col + "|" + it.id + "|" + i + '">' + H.esc(a.label) + "</button>").join("");
        return '<div class="item">' + left +
          '<div class="main"><b>' + H.esc(v.title) + (v.pill ? " " + v.pill : "") + "</b>" + (v.sub ? '<div class="sub">' + H.esc(v.sub) + "</div>" : "") + (v.subHtml || "") + "</div>" +
          (v.right ? '<div class="amt">' + H.esc(v.right) + (v.rightSub ? "<small>" + H.esc(v.rightSub) + "</small>" : "") + "</div>" : "") +
          '<div class="actions">' + acts + '<button class="ghost" data-edit="' + s.col + "|" + it.id + '">Edit</button></div></div>';
      }).join("") + "</div>";
    }

    function renderAll() { sections.forEach(renderSection); renderStats(); }

    function fieldsFor(s) {
      return s.fields.map((f) => (typeof f.options === "function" ? { ...f, options: f.options(data) } : f));
    }

    function openForm(s, it) {
      H.form({
        title: (it ? "Edit " : "Add ") + (s.noun || "entry"),
        fields: fieldsFor(s),
        values: it || (s.defaults ? s.defaults(data) : {}),
        onSubmit: async (vals) => {
          if (it) { const saved = await H.update(s.col, it.id, { ...it, ...vals }); data[s.col] = data[s.col].map((x) => (x.id === it.id ? saved : x)); H.toast("Saved"); }
          else { data[s.col].push(await H.create(s.col, vals)); H.toast("Added"); }
          renderAll();
        },
        onDelete: it ? async () => { await H.remove(s.col, it.id); data[s.col] = data[s.col].filter((x) => x.id !== it.id); renderAll(); H.toast("Deleted"); } : null,
      });
    }

    const ctx = {
      data,
      render: renderAll,
      async save(col, it, changes) { const s = await H.update(col, it.id, { ...it, ...changes }); data[col] = data[col].map((x) => (x.id === it.id ? s : x)); return s; },
      async add(col, vals) { const s = await H.create(col, vals); data[col].push(s); return s; },
    };

    document.addEventListener("click", async (e) => {
      const el = e.target.closest("[data-add],[data-edit],[data-run],[data-starter]");
      if (!el) return;
      if (el.dataset.add) openForm(sections.find((s) => s.col === el.dataset.add), null);
      else if (el.dataset.edit) { const [c, id] = el.dataset.edit.split("|"); openForm(sections.find((s) => s.col === c), data[c].find((x) => x.id === id)); }
      else if (el.dataset.run) {
        const [c, id, i] = el.dataset.run.split("|"); const s = sections.find((x) => x.col === c);
        try { el.disabled = true; await s.actions[Number(i)].run(data[c].find((x) => x.id === id), ctx); renderAll(); }
        catch (err) { H.toast(err.message, true); } finally { el.disabled = false; }
      } else if (el.dataset.starter) {
        const s = sections.find((x) => x.col === el.dataset.starter);
        try { el.disabled = true; for (const v of s.starter.items) await ctx.add(s.col, v); renderAll(); H.toast(s.starter.done || "Added"); }
        catch (err) { H.toast(err.message, true); el.disabled = false; }
      }
    });

    Promise.all(sections.map((s) => H.list(s.col))).then((res) => {
      sections.forEach((s, i) => (data[s.col] = res[i]));
      renderAll();
    }).catch((err) => {
      app.insertAdjacentHTML("afterbegin", '<div class="empty" style="margin-bottom:12px"><b>Could not load</b>' + H.esc(err.message) + ". Reload to try again.</div>");
    });
    return ctx;
  };
})();
