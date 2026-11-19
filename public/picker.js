// A small multi-select dropdown: chips for what's picked, type to filter, tap to toggle.
// Used for hosts (can add a new name) and porters (has an "Everyone" option).
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

let openPicker = null;
document.addEventListener("pointerdown", (e) => {
  if (openPicker && !openPicker.root.contains(e.target) && !openPicker.list.contains(e.target)) openPicker.close();
}, true);
window.addEventListener("resize", () => openPicker?.place());

/**
 * root: an empty element to draw into.
 * opts.options: names to choose from
 * opts.selected: names already picked
 * opts.everyone: true to offer "Everyone" (opts.everyoneOn = currently picked)
 * opts.allowNew: true to offer "Add “…”" for a name that isn't in the list
 * opts.onChange({ values, everyone })
 */
export function multiPicker(root, opts) {
  let options = [...(opts.options || [])];
  let values = [...(opts.selected || [])];
  let everyone = Boolean(opts.everyoneOn);
  const placeholder = opts.placeholder || "Choose…";

  root.classList.add("picker");
  root.innerHTML = `<div class="pk-box"><span class="pk-chips"></span><input class="pk-in" autocomplete="off" enterkeyhint="done" aria-label="${esc(opts.label || placeholder)}"></div>`;
  const box = root.querySelector(".pk-box");
  const chips = root.querySelector(".pk-chips");
  const input = root.querySelector(".pk-in");
  const list = document.createElement("div");
  list.className = "pk-list";
  list.hidden = true;
  list.setAttribute("role", "listbox");

  const emit = () => opts.onChange?.({ values: [...values], everyone });
  const has = (n) => values.some((v) => v.toLowerCase() === n.toLowerCase());

  function drawChips() {
    chips.innerHTML = everyone
      ? `<span class="pk-chip all">Everyone<button type="button" data-rm="__all" aria-label="Remove Everyone">×</button></span>`
      : values.map((v) => `<span class="pk-chip">${esc(v)}<button type="button" data-rm="${esc(v)}" aria-label="Remove ${esc(v)}">×</button></span>`).join("");
    input.placeholder = everyone || values.length ? "" : placeholder;
  }

  function drawList() {
    const q = input.value.trim().toLowerCase();
    const match = options.filter((o) => !q || o.toLowerCase().includes(q));
    let html = "";
    if (opts.everyone && (!q || "everyone".includes(q))) {
      html += `<button type="button" class="pk-opt all" data-v="__all" aria-selected="${everyone}"><span class="pk-tick"></span>Everyone</button>`;
    }
    html += match.map((o) => `<button type="button" class="pk-opt" data-v="${esc(o)}" aria-selected="${!everyone && has(o)}"><span class="pk-tick"></span>${esc(o)}</button>`).join("");
    if (opts.allowNew && q && !options.some((o) => o.toLowerCase() === q)) {
      html += `<button type="button" class="pk-opt new" data-new="${esc(input.value.trim())}">+ Add “${esc(input.value.trim())}”</button>`;
    }
    if (!html) html = `<div class="pk-empty">No match</div>`;
    list.innerHTML = html;
  }

  function place() {
    const r = box.getBoundingClientRect();
    const below = window.innerHeight - r.bottom;
    list.style.left = `${Math.max(8, r.left)}px`;
    list.style.width = `${Math.max(220, r.width)}px`;
    if (below < 240 && r.top > below) { list.style.top = ""; list.style.bottom = `${window.innerHeight - r.top + 4}px`; }
    else { list.style.bottom = ""; list.style.top = `${r.bottom + 4}px`; }
    list.style.maxHeight = `${Math.min(300, Math.max(below, r.top) - 16)}px`;
  }

  function open() {
    if (openPicker && openPicker !== api) openPicker.close();
    (root.closest("dialog") || document.body).appendChild(list);
    drawList();
    list.hidden = false;
    place();
    openPicker = api;
    root.classList.add("open");
  }
  function close() {
    list.hidden = true;
    list.remove();
    input.value = "";
    root.classList.remove("open");
    if (openPicker === api) openPicker = null;
  }

  function toggle(v) {
    if (v === "__all") {
      everyone = !everyone;
      if (everyone) values = [];
    } else {
      everyone = false;
      values = has(v) ? values.filter((x) => x.toLowerCase() !== v.toLowerCase()) : [...values, v];
    }
    input.value = "";
    drawChips(); drawList(); place(); emit();
  }

  box.addEventListener("click", (e) => {
    const rm = e.target.closest("[data-rm]");
    if (rm) {
      if (rm.dataset.rm === "__all") everyone = false;
      else values = values.filter((v) => v !== rm.dataset.rm);
      drawChips(); if (!list.hidden) { drawList(); place(); }
      emit();
      return;
    }
    input.focus();
    if (list.hidden) open();
  });
  input.addEventListener("focus", () => { if (list.hidden) open(); });
  input.addEventListener("input", () => { if (list.hidden) open(); drawList(); });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { close(); input.blur(); }
    else if (e.key === "Backspace" && !input.value && (values.length || everyone)) {
      if (everyone) everyone = false; else values.pop();
      drawChips(); drawList(); emit();
    } else if (e.key === "Enter") {
      e.preventDefault();
      const first = list.querySelector(".pk-opt");
      if (first && input.value.trim()) first.click();
    }
  });
  // pointerdown + preventDefault keeps the keyboard up on phones while picking several
  list.addEventListener("pointerdown", (e) => { if (e.target.closest(".pk-opt")) e.preventDefault(); });
  list.addEventListener("click", (e) => {
    const b = e.target.closest(".pk-opt");
    if (!b) return;
    if (b.dataset.new) {
      const name = b.dataset.new;
      if (!options.some((o) => o.toLowerCase() === name.toLowerCase())) options = [...options, name].sort((a, b) => a.localeCompare(b));
      if (!has(name)) toggle(name); else { input.value = ""; drawList(); }
      return;
    }
    toggle(b.dataset.v);
  });

  const api = {
    root, list, close, place,
    get value() { return { values: [...values], everyone }; },
    set(next) {
      values = [...(next.values || [])];
      everyone = Boolean(next.everyone);
      drawChips();
      if (!list.hidden) drawList();
    },
    setOptions(next) { options = [...next]; if (!list.hidden) drawList(); },
    isOpen: () => !list.hidden,
  };
  drawChips();
  return api;
}
