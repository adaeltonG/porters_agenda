// 24-hour time box ("13:00"). The browser's own time picker follows the phone/PC language and
// can show AM/PM, so this is a plain text box that tidies whatever is typed:
// "1300" / "13.00" / "13 00" -> "13:00", "9" -> "09:00", "930" -> "09:30", "1:30pm" -> "13:30".

export function toHHMM(raw) {
  const v = String(raw || "").trim().toLowerCase().replace(/\s+/g, " ");
  if (!v) return "";
  const m = /^(\d{1,2})(?:\s?[:.h ]?\s?(\d{2}))?\s*(am|pm|a|p)?$/.exec(v);
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2] || 0);
  const mer = m[3]?.[0];
  if (mer === "p" && h < 12) h += 12;
  if (mer === "a" && h === 12) h = 0;
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

export const timeInputHTML = (name, value, label) =>
  `<input class="in time24" type="text" inputmode="numeric" maxlength="7" placeholder="HH:MM" autocomplete="off" name="${name}" value="${value}" aria-label="${label}">`;

/** Tidies the time boxes in a form as you leave each one; a time that makes no sense blocks Save. */
export function wireTimeInputs(form) {
  for (const el of form.querySelectorAll("input.time24")) {
    const fix = () => {
      const t = toHHMM(el.value);
      if (t === null) {
        el.setCustomValidity("Use 24-hour time, e.g. 13:00");
      } else {
        el.setCustomValidity("");
        el.value = t;
      }
    };
    el.addEventListener("blur", fix);
    el.addEventListener("input", () => el.setCustomValidity(""));
    // runs before the form's own save handler
    form.addEventListener("submit", (e) => {
      fix();
      if (!el.checkValidity()) {
        e.preventDefault();
        e.stopImmediatePropagation();
        el.reportValidity();
      }
    }, { capture: true });
  }
}
