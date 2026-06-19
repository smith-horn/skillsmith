/**
 * Client-side JavaScript for the Create Skill webview panel (SMI-5313 / GH #1454).
 *
 * `getCreateScript(nonce)` returns the JS *body* string (NOT a `<script>` tag);
 * create-panel-html.ts wraps it in `<script nonce="${nonce}">…</script>`. The
 * nonce is accepted for signature parity with the html-split convention but is
 * not referenced inside the body (the wrapping tag carries it).
 *
 * Hard rules (from the design review):
 *  - Every getElementById is null-guarded.
 *  - cliOutput chunks are appended via `textContent +=` — NEVER innerHTML (H3/M5).
 *  - All dynamic text uses textContent (no innerHTML anywhere).
 */

/** Generate the webview JS body for the Create Skill panel. */
export function getCreateScript(nonce: string): string {
  void nonce // carried by the wrapping <script nonce> tag in create-panel-html.ts
  return `
        const vscode = acquireVsCodeApi();

        const form = document.getElementById('createForm');
        const authorInput = document.getElementById('author');
        const nameInput = document.getElementById('name');
        const descriptionInput = document.getElementById('description');
        const createBtn = document.getElementById('createBtn');
        const nameValidity = document.getElementById('nameValidity');
        const authorError = document.getElementById('authorError');
        const nameError = document.getElementById('nameError');
        const descriptionError = document.getElementById('descriptionError');
        const typeError = document.getElementById('typeError');
        const failedBanner = document.getElementById('failedBanner');
        const cliLog = document.getElementById('cliLog');

        function selectedType() {
            const checked = document.querySelector('input[name="type"]:checked');
            return checked ? checked.value : 'basic';
        }

        function setText(el, text) {
            if (el) { el.textContent = text; }
        }

        function clearErrors() {
            setText(authorError, '');
            setText(nameError, '');
            setText(descriptionError, '');
            setText(typeError, '');
        }

        function setFormDisabled(disabled) {
            [authorInput, nameInput, descriptionInput, createBtn].forEach(function (el) {
                if (el) { el.disabled = disabled; }
            });
            document.querySelectorAll('input[name="type"]').forEach(function (el) {
                el.disabled = disabled;
            });
        }

        // Live name validation (debounced).
        if (nameInput) {
            let nameTimer;
            nameInput.addEventListener('input', function () {
                clearTimeout(nameTimer);
                const value = nameInput.value;
                nameTimer = setTimeout(function () {
                    vscode.postMessage({ command: 'validateName', value: value });
                }, 250);
            });
        }

        if (createBtn) {
            createBtn.addEventListener('click', function () {
                vscode.postMessage({
                    command: 'submit',
                    fields: {
                        author: authorInput ? authorInput.value : '',
                        name: nameInput ? nameInput.value : '',
                        description: descriptionInput ? descriptionInput.value : '',
                        type: selectedType(),
                    },
                });
            });
        }

        window.addEventListener('message', function (event) {
            const msg = event.data;
            if (!msg || typeof msg.command !== 'string') { return; }
            switch (msg.command) {
                case 'nameValidity':
                    if (nameValidity) {
                        if (msg.valid) {
                            nameValidity.textContent = '✓ Available name';
                            nameValidity.className = 'name-validity valid';
                        } else {
                            nameValidity.textContent = msg.message || '';
                            nameValidity.className = 'name-validity invalid';
                        }
                    }
                    return;
                case 'submitError': {
                    const errors = msg.errors || {};
                    setText(authorError, errors.author || '');
                    setText(nameError, errors.name || '');
                    setText(descriptionError, errors.description || '');
                    setText(typeError, errors.type || '');
                    return;
                }
                case 'creating':
                    clearErrors();
                    setText(failedBanner, '');
                    setFormDisabled(true);
                    if (form) { form.setAttribute('aria-busy', 'true'); }
                    if (createBtn) { createBtn.textContent = 'Creating…'; }
                    return;
                case 'cliOutput':
                    // H3/M5: append RAW chunk as text only — NEVER innerHTML.
                    if (cliLog && typeof msg.chunk === 'string') {
                        cliLog.textContent += msg.chunk;
                        cliLog.scrollTop = cliLog.scrollHeight;
                    }
                    return;
                case 'createFailed':
                    setFormDisabled(false);
                    if (form) { form.setAttribute('aria-busy', 'false'); }
                    if (createBtn) { createBtn.textContent = 'Create Skill'; }
                    setText(failedBanner, msg.message || 'Create failed.');
                    return;
            }
        });
    `
}
