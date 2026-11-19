// Centred confirm / text boxes in the app's own style, instead of the browser's confirm() and prompt().
// Both return a promise: ask() -> true/false, askText() -> the typed text, or null if cancelled.
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const ICONS = {
  trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16v4zM14 6l4 4"/>',
  question: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 114 2c-.9.6-1.5 1.1-1.5 2.2M12 17h.01"/>',
};

function box({ title, name, text, ok = "OK", cancel = "Cancel", danger = false, icon, input }) {
  return new Promise((resolve) => {
    const dlg = document.createElement("dialog");
    dlg.className = "ask" + (danger ? " danger" : "");
    dlg.setAttribute("aria-labelledby", "askTitle");
    const ic = icon || (danger ? "trash" : "question");
    dlg.innerHTML = `<form method="dialog">
      <div class="ask-ic" aria-hidden="true"><svg viewBox="0 0 24 24">${ICONS[ic] || ICONS.question}</svg></div>
      <h2 id="askTitle">${esc(title)}</h2>
      ${name ? `<p class="ask-name">${esc(name)}</p>` : ""}
      ${text ? `<p class="ask-text">${esc(text)}</p>` : ""}
      ${input ? `<input class="in ask-in" value="${esc(input.value || "")}" aria-label="${esc(input.label || title)}" autocomplete="off" required>` : ""}
      <div class="ask-btns">
        <button class="btn" value="cancel" type="button" data-cancel>${esc(cancel)}</button>
        <button class="btn ${danger ? "danger-fill" : "primary"}" value="ok" type="submit">${esc(ok)}</button>
      </div>
    </form>`;
    document.body.appendChild(dlg);

    const field = dlg.querySelector(".ask-in");
    let result = input ? null : false;
    const finish = () => { dlg.remove(); resolve(result); };

    dlg.querySelector("form").addEventListener("submit", (e) => {
      e.preventDefault();
      if (field) { const v = field.value.trim(); if (!v) { field.focus(); return; } result = v; }
      else result = true;
      dlg.close();
    });
    dlg.querySelector("[data-cancel]").addEventListener("click", () => dlg.close());
    dlg.addEventListener("click", (e) => { if (e.target === dlg) dlg.close(); });   // tap outside = cancel
    dlg.addEventListener("close", finish, { once: true });                         // Esc = cancel

    dlg.showModal();
    // Safer default for deletes: focus lands on Cancel, so a stray Enter doesn't delete.
    if (field) { field.focus(); field.select(); }
    else dlg.querySelector(danger ? "[data-cancel]" : '[value="ok"]').focus();
  });
}

export const ask = (opts) => box(opts);
export const askText = (opts) => box({ icon: "edit", ok: "Save", ...opts, input: { value: opts.value, label: opts.label } });
