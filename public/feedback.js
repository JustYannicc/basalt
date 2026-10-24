// Signalbox feedback. One button on every page opens a dialog that sends a note, an image the
// person picks, the page path and recent error codes. The server reads the account from the
// session cookie; nothing here names one. No dependencies, so every page can carry it, and it
// does nothing until the server says feedback is on.
(() => {
  "use strict";
  const installed = Symbol.for("signalbox.feedback");
  if (window[installed]) return;
  window[installed] = true;

  const submitPath = "/feedback/v1/submit";
  const errorPath = "/feedback/v1/error";
  const statusPath = "/feedback/v1/status";
  const messageMax = 4000;
  const screenshotMax = 2 * 1024 * 1024;
  const nativeFetch = window.fetch.bind(window);

  // Error codes only, never messages, stacks, URLs or file names. Memory only, so the next
  // person on a shared browser never inherits them; sign-in and sign-out also clear them.
  const recent = [];
  const reported = new Set();
  function record(code) {
    recent.push(code);
    if (recent.length > 10) recent.shift();
    const page = location.pathname;
    const key = `${code} ${page}`;
    if (reported.has(key) || reported.size >= 5) return;
    reported.add(key);
    nativeFetch(errorPath, {
      method: "POST", credentials: "same-origin", keepalive: true,
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code, page }),
    }).catch(() => {});
  }
  function capture() {
    addEventListener("error", (event) => {
      const target = event.target;
      if (target instanceof Element) {
        // Avatars and other images fail routinely; a missing script or stylesheet breaks the page.
        if (target.localName === "script" || (target.localName === "link" && /\bstylesheet\b/i.test(target.rel)))
          record("resource_error");
        return;
      }
      record("script_error");
    }, true);
    addEventListener("unhandledrejection", () => record("unhandled_rejection"));
    window.fetch = function fetch(input, init) {
      const response = nativeFetch(input, init);
      let path = null;
      try {
        const url = new URL(input instanceof Request ? input.url : String(input), location.href);
        if (url.origin === location.origin) path = url.pathname;
      } catch {}
      if (path === null || path.startsWith("/feedback/")) return response;
      if (/\/sign-(?:in|out)(?:\/|$)/.test(path)) recent.length = 0;
      return response.then((result) => {
        if (result.status >= 500) record("http_5xx");
        return result;
      });
    };
  }

  const icons = {
    message: '<path d="M8 13.5h8M8 8.5h4"/><path d="M6.1 19.5c-1.3-.1-2.3-.5-3-1.3C2 17 2 15.2 2 11.5v-.5c0-3.7 0-5.6 1.2-6.8C4.4 3 6.2 3 10 3h4c3.8 0 5.6 0 6.8 1.2C22 5.4 22 7.3 22 11v.5c0 3.7 0 5.6-1.2 6.8C19.6 19.5 17.8 19.5 14 19.5c-.6 0-.8 0-1.3.2-1.4.6-2.7 1.8-3.4 2.1-.7.3-1-.1-.9-.7l.4-1.6"/>',
    close: '<path d="M18 6 6 18M6 6l12 12"/>',
    image: '<path d="M2.5 12c0-4.5 0-6.7 1.4-8.1C5.3 2.5 7.5 2.5 12 2.5s6.7 0 8.1 1.4c1.4 1.4 1.4 3.6 1.4 8.1s0 6.7-1.4 8.1c-1.4 1.4-3.6 1.4-8.1 1.4s-6.7 0-8.1-1.4C2.5 18.7 2.5 16.5 2.5 12Z"/><circle cx="16.5" cy="7.5" r="1.5"/><path d="m2.5 17 4.6-4.2c.8-.7 2-.7 2.8 0l4.6 4.2m-1-1 2.4-2.1c.8-.7 1.9-.7 2.6-.1l2.5 2.2"/>',
    check: '<path d="m5 13 4 4L19 7"/>',
    spinner: '<path d="M12 3a9 9 0 1 0 9 9"/>',
  };
  const icon = (name) =>
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name]}</svg>`;

  // The dashboard's own tokens when the page defines them, else its light and dark defaults.
  const style = `
:host{all:initial;position:fixed;z-index:40;right:max(16px,env(safe-area-inset-right));bottom:max(16px,env(safe-area-inset-bottom));
--b:var(--background,#fff);--f:var(--foreground,#111);--p:var(--primary,#0a0a0a);--pf:var(--primary-foreground,#fff);--m:var(--muted-foreground,#666);
--a:var(--accent,#f5f5f5);--d:var(--destructive,#b4261a);--bd:var(--border,#eaeaea);--i:var(--input,#d4d4d4);--r:var(--ring,#888);
font:14px/1.5 var(--font-sans,"Geist",ui-sans-serif,system-ui,sans-serif);letter-spacing:-.011em;color:var(--f);-webkit-font-smoothing:antialiased}
@media (prefers-color-scheme:dark){:host{--b:var(--background,#0a0a0a);--f:var(--foreground,#ededed);--p:var(--primary,#fff);--pf:var(--primary-foreground,#0a0a0a);
--m:var(--muted-foreground,#9a9a9a);--a:var(--accent,#1a1a1a);--d:var(--destructive,#e0726a);--bd:var(--border,#242424);--i:var(--input,#333);--r:var(--ring,#777)}}
@media print{:host{display:none}}
*,*::before,*::after{box-sizing:border-box}
[hidden]{display:none!important}
svg{width:16px;height:16px;flex:none}
h2,p{margin:0}
a{color:inherit;text-decoration:underline;text-underline-offset:4px}
a:focus-visible{outline:2px solid var(--r);outline-offset:3px;border-radius:2px}
.sr{position:absolute;width:1px;height:1px;margin:-1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
button{font:inherit;letter-spacing:inherit;color:inherit;margin:0;-webkit-tap-highlight-color:transparent;touch-action:manipulation}
.btn{position:relative;display:inline-flex;align-items:center;justify-content:center;gap:8px;height:36px;padding:0 16px;border:1px solid transparent;border-radius:6px;
background:transparent;font-size:14px;font-weight:500;white-space:nowrap;cursor:pointer;outline:none;transition:background-color .15s,border-color .15s,box-shadow .15s}
.btn:focus-visible{border-color:var(--r);box-shadow:0 0 0 3px color-mix(in srgb,var(--r) 50%,transparent)}
.btn:disabled,.btn[aria-disabled=true]{opacity:.5;cursor:default}
.sm{height:32px;gap:6px;padding:0 12px}
.icon{width:32px;height:32px;padding:0}
.primary{background:var(--p);color:var(--pf)}
.primary:not(:disabled,[aria-disabled=true]):hover{background:color-mix(in srgb,var(--p) 90%,transparent)}
.outline{background:var(--b);border-color:var(--bd);box-shadow:0 1px 2px rgb(0 0 0/.05)}
.outline:not(:disabled):hover,.ghost:not(:disabled):hover{background:var(--a)}
@media (prefers-color-scheme:dark){.outline{border-color:var(--i);background:color-mix(in srgb,var(--i) 30%,var(--b))}
.outline:not(:disabled):hover{background:color-mix(in srgb,var(--i) 50%,var(--b))}}
.btn[data-loading] .label{opacity:0}
.btn[data-loading]::after{content:"";position:absolute;inset:0;margin:auto;width:14px;height:14px;border:2px solid currentColor;border-right-color:transparent;border-radius:50%;animation:spin .7s linear infinite}
@keyframes spin{to{transform:rotate(1turn)}}
.trigger{box-shadow:0 1px 2px rgb(0 0 0/.06),0 4px 12px rgb(0 0 0/.08)}
dialog{width:calc(100% - 2rem);max-width:32rem;max-height:calc(100dvh - 2rem);margin:auto;padding:0;overflow:auto;overscroll-behavior:contain;
border:1px solid var(--bd);border-radius:8px;background:var(--b);color:var(--f);box-shadow:0 10px 15px -3px rgb(0 0 0/.1),0 4px 6px -4px rgb(0 0 0/.1);
opacity:1;transform:none;transition:opacity .2s cubic-bezier(.16,1,.3,1),transform .2s cubic-bezier(.16,1,.3,1),overlay .2s allow-discrete,display .2s allow-discrete}
dialog:not([open]){opacity:0;transform:scale(.95)}
dialog::backdrop{background:rgb(0 0 0/0);transition:background-color .2s,overlay .2s allow-discrete,display .2s allow-discrete}
dialog[open]::backdrop{background:rgb(0 0 0/.5)}
@starting-style{dialog[open]{opacity:0;transform:scale(.95)}dialog[open]::backdrop{background:rgb(0 0 0/0)}}
form{position:relative;display:grid;gap:16px;padding:24px}
.head{display:grid;gap:8px;padding-right:32px}
.body{display:grid;gap:16px}
h2{display:flex;align-items:center;gap:8px;font-size:18px;line-height:1;font-weight:600}
h2 svg{width:18px;height:18px}
.muted{color:var(--m)}
.close{position:absolute;top:16px;right:16px;color:var(--m)}
.field{display:grid;gap:8px}
label,.legend{font-size:14px;line-height:1;font-weight:500}
.legend span{margin-left:2px;font-size:12px;font-weight:400;color:var(--m)}
textarea{display:block;width:100%;min-height:120px;resize:vertical;margin:0;padding:8px 12px;border:1px solid var(--i);border-radius:6px;background:transparent;color:inherit;
font:inherit;font-size:16px;letter-spacing:inherit;box-shadow:0 1px 2px rgb(0 0 0/.05);outline:none}
textarea::placeholder{color:var(--m)}
textarea:focus-visible{border-color:var(--r);box-shadow:0 0 0 3px color-mix(in srgb,var(--r) 50%,transparent)}
textarea[aria-invalid=true]{border-color:var(--d)}
.small{font-size:12px;line-height:1.4}
.problem{font-size:13px;line-height:1.4;color:var(--d)}
.shot{display:grid;gap:8px;justify-items:start}
.preview{display:grid;grid-template-columns:64px minmax(0,1fr) auto;align-items:center;gap:12px;width:100%;padding:8px;border:1px solid var(--bd);border-radius:6px}
.preview img{display:block;width:64px;height:40px;object-fit:cover;border:1px solid var(--bd);border-radius:4px;background:var(--a)}
.preview .name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px}
.alert{display:grid;gap:4px;padding:12px 16px;border:1px solid var(--bd);border-radius:8px;color:var(--d);font-size:14px}
.actions{display:flex;justify-content:flex-end;gap:8px}
@media (min-width:768px){textarea{font-size:14px}}
@media (max-width:740px){.btn{min-height:44px}.icon{min-width:44px}.trigger{width:44px;padding:0}.trigger .label{display:none}}
@media (max-width:639px){.head{text-align:center;padding:0 32px}h2{justify-content:center}.actions{flex-direction:column-reverse}.actions .btn{width:100%}}
@media (prefers-reduced-motion:reduce){dialog,dialog::backdrop,.btn{transition:none}.btn[data-loading]::after{animation-duration:2.4s}}`;

  const markup = `
<style>${style}</style>
<button type="button" class="btn outline sm trigger" aria-haspopup="dialog" aria-label="Send feedback">${icon("message")}<span class="label">Feedback</span></button>
<dialog aria-labelledby="sb-title" aria-describedby="sb-description">
  <form novalidate>
    <div class="head">
      <h2 id="sb-title"><span class="done-mark" hidden>${icon("check")}</span><span class="title">Send feedback</span></h2>
      <p id="sb-description" class="muted description">Tell the Signalbox team what went wrong or what would help.</p>
    </div>
    <button type="button" class="btn ghost icon close" aria-label="Close">${icon("close")}</button>
    <div class="body">
      <div class="field">
        <label for="sb-message">Your feedback</label>
        <textarea id="sb-message" name="message" rows="5" maxlength="${messageMax}" aria-describedby="sb-message-problem sb-count" placeholder="What were you doing, and what happened or would help?"></textarea>
        <p id="sb-message-problem" class="problem" hidden></p>
        <p id="sb-count" class="small muted" aria-live="polite" hidden></p>
      </div>
      <div class="shot" role="group" aria-labelledby="sb-shot-label">
        <p id="sb-shot-label" class="legend">Screenshot <span>Optional</span></p>
        <button type="button" class="btn outline sm choose">${icon("image")}<span>Choose screenshot</span></button>
        <div class="preview" hidden>
          <img alt="Screenshot you chose">
          <div><p class="name"></p><p class="small muted size"></p></div>
          <button type="button" class="btn ghost sm remove" aria-label="Remove screenshot">Remove</button>
        </div>
        <p id="sb-shot-hint" class="small muted">PNG or JPEG up to 2 MB. Choose a file or paste an image. Signalbox never takes one for you.</p>
        <p class="problem shot-problem" role="alert" hidden></p>
        <input type="file" accept="image/png,image/jpeg" hidden tabindex="-1" aria-hidden="true">
      </div>
      <p class="small muted context"></p>
    </div>
    <div class="alert" role="alert" hidden><p class="alert-text"></p><p class="alert-action" hidden><a href="/login" target="_blank" rel="noopener">Open sign-in in a new tab</a></p></div>
    <div class="actions">
      <button type="button" class="btn outline cancel">Cancel</button>
      <button type="submit" class="btn primary send"><span class="label">Send feedback</span></button>
    </div>
  </form>
  <p class="sr" role="status"></p>
</dialog>`;

  function mount() {
    const host = document.createElement("div");
    host.setAttribute("data-signalbox-feedback-root", "");
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = markup;
    const $ = (selector) => root.querySelector(selector);
    const trigger = $(".trigger"), dialog = $("dialog"), form = $("form"), body = $(".body");
    const title = $(".title"), description = $(".description"), doneMark = $(".done-mark");
    const message = $("textarea"), messageProblem = $("#sb-message-problem"), count = $("#sb-count");
    const choose = $(".choose"), preview = $(".preview"), image = $(".preview img");
    const shotName = $(".preview .name"), shotSize = $(".preview .size"), remove = $(".remove");
    const hint = $("#sb-shot-hint"), shotProblem = $(".shot-problem"), file = $("input[type=file]");
    const context = $(".context"), alert = $(".alert"), alertText = $(".alert-text"), alertAction = $(".alert-action");
    const cancel = $(".cancel"), send = $(".send"), sendLabel = $(".send .label"), status = $("[role=status]");

    let screenshot = null;
    let sending = false;
    let sent = false;

    const show = (element, text) => {
      element.textContent = text ?? "";
      element.hidden = !text;
    };
    const sizeLabel = (bytes) => bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    function describeContext() {
      const errors = recent.length;
      context.textContent = errors === 0 ? "Signalbox also gets this page's address. It's linked to the account you're signed in with."
        : `Signalbox also gets this page's address and the codes of ${errors} recent ${errors === 1 ? "error" : "errors"} in this tab, never their text. It's linked to the account you're signed in with.`;
    }
    function updateCount() {
      const left = messageMax - message.value.length;
      show(count, left <= 400 ? `${left} ${left === 1 ? "character" : "characters"} left` : "");
    }

    function setScreenshot(next) {
      if (screenshot) URL.revokeObjectURL(screenshot.url);
      screenshot = next;
      preview.hidden = !next;
      choose.hidden = Boolean(next);
      hint.hidden = Boolean(next);
      if (next) {
        image.src = next.url;
        shotName.textContent = next.label;
        shotName.title = next.label;
        shotSize.textContent = sizeLabel(next.bytes.length);
      } else image.removeAttribute("src");
    }
    async function attach(picked, label) {
      show(shotProblem, "");
      if (picked.size > screenshotMax) return show(shotProblem, "That image is over 2 MB. Choose a smaller one or crop it.");
      let bytes;
      try { bytes = new Uint8Array(await picked.arrayBuffer()); }
      catch { return show(shotProblem, "That image couldn't be read. Try another one."); }
      // The bytes decide the type, as the server checks them too; a file's own label can lie.
      const png = bytes.length > 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((byte, i) => bytes[i] === byte);
      const jpeg = bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
      if (!png && !jpeg) return show(shotProblem, "That file isn't a PNG or JPEG. Choose a different image.");
      const type = png ? "image/png" : "image/jpeg";
      setScreenshot({ bytes, type, label, url: URL.createObjectURL(new Blob([bytes], { type })) });
      status.textContent = "Screenshot added";
      remove.focus();
    }
    function base64(bytes) {
      let text = "";
      for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      return btoa(text);
    }

    function setSending(next) {
      sending = next;
      form.setAttribute("aria-busy", String(next));
      message.readOnly = next;
      // Disabling the focused button would drop focus out of the dialog.
      send.setAttribute("aria-disabled", String(next));
      choose.disabled = next;
      remove.disabled = next;
      if (next) send.setAttribute("data-loading", ""); else send.removeAttribute("data-loading");
    }
    function fail(text, signIn = false) {
      alertText.textContent = text;
      alertAction.hidden = !signIn || location.pathname === "/login";
      alert.hidden = false;
    }
    function showSent(next) {
      sent = next;
      body.hidden = next;
      cancel.hidden = next;
      doneMark.hidden = !next;
      title.textContent = next ? "Feedback sent" : "Send feedback";
      description.textContent = next ? "Thanks for telling us. The Signalbox team has it now."
        : "Tell the Signalbox team what went wrong or what would help.";
      sendLabel.textContent = next ? "Done" : "Send feedback";
      send.type = next ? "button" : "submit";
    }

    async function submit() {
      if (sending) return;
      alert.hidden = true;
      const text = message.value.trim();
      if (!text) {
        message.setAttribute("aria-invalid", "true");
        show(messageProblem, "Write some feedback first.");
        message.focus();
        return;
      }
      setSending(true);
      status.textContent = "Sending feedback";
      const payload = { message: text, page: location.pathname };
      // A generic name: the file's own name can carry personal details.
      if (screenshot) payload.screenshot = { name: screenshot.type === "image/png" ? "screenshot.png" : "screenshot.jpg", type: screenshot.type, data: base64(screenshot.bytes) };
      if (recent.length) payload.errors = recent.map((code) => ({ code }));
      const timeout = new AbortController();
      const timer = setTimeout(() => timeout.abort(), 30_000);
      let response = null;
      try {
        response = await nativeFetch(submitPath, {
          method: "POST", credentials: "same-origin", signal: timeout.signal,
          headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
        });
      } catch {}
      clearTimeout(timer);
      setSending(false);
      if (response?.ok) {
        message.value = "";
        updateCount();
        setScreenshot(null);
        recent.length = 0;
        showSent(true);
        status.textContent = "Feedback sent";
        send.focus();
        return;
      }
      status.textContent = "";
      const code = response?.status ?? 0;
      if (code === 401 || code === 403) fail("You're signed out. Sign in, then send it again. What you wrote stays here.", true);
      else if (code === 413) fail("The screenshot is too large to send. Remove it or choose one under 2 MB.");
      else if (code === 429) fail("That's a lot of feedback in a short time. Wait a minute, then try again.");
      else if (code >= 400 && code < 500) fail("Signalbox couldn't accept this feedback. Check it and try again.");
      else {
        record("feedback_submit_failed");
        sendLabel.textContent = "Try again";
        fail("Your feedback didn't send. Check your connection and try again.");
      }
      describeContext();
    }

    function open() {
      if (sent) showSent(false);
      alert.hidden = true;
      if (!sending) sendLabel.textContent = "Send feedback";
      describeContext();
      dialog.showModal();
      message.focus();
    }
    const close = () => dialog.close();

    trigger.addEventListener("click", open);
    dialog.addEventListener("close", () => trigger.focus({ preventScroll: true }));
    // A click on the backdrop lands on the dialog itself; the form fills everything inside it.
    dialog.addEventListener("click", (event) => { if (event.target === dialog) close(); });
    $(".close").addEventListener("click", close);
    cancel.addEventListener("click", close);
    send.addEventListener("click", () => { if (sent) close(); });
    form.addEventListener("submit", (event) => { event.preventDefault(); void submit(); });
    message.addEventListener("input", () => {
      if (message.value.trim()) { message.removeAttribute("aria-invalid"); show(messageProblem, ""); }
      updateCount();
    });
    message.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void submit(); }
    });
    choose.addEventListener("click", () => file.click());
    file.addEventListener("change", () => {
      const picked = file.files?.[0];
      file.value = "";
      if (picked) void attach(picked, picked.name || "Screenshot");
    });
    remove.addEventListener("click", () => {
      setScreenshot(null);
      status.textContent = "Screenshot removed";
      choose.focus();
    });
    // Pasting an image is a deliberate choice too. Rich text with a picture still pastes as text.
    dialog.addEventListener("paste", (event) => {
      const data = event.clipboardData;
      if (!data || sending || sent || data.types.includes("text/plain")) return;
      const pasted = [...data.files].find((item) => item.type === "image/png" || item.type === "image/jpeg");
      if (!pasted) return;
      event.preventDefault();
      void attach(pasted, "Pasted image");
    });

    document.body.append(host);
  }

  // A deployment without a feedback destination answers false, and the page stays untouched:
  // no button, no listeners, no wrapped fetch.
  nativeFetch(statusPath, { credentials: "same-origin", cache: "no-store" })
    .then((response) => (response.ok ? response.json() : null))
    .then((status) => {
      if (status?.enabled !== true) return;
      capture();
      if (document.body) mount();
      else document.addEventListener("DOMContentLoaded", mount, { once: true });
    })
    .catch(() => {});
})();
