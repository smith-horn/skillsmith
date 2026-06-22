/**
 * Client-side JavaScript for SkillDetailPanel webview
 * Extracted from skill-panel-html.ts (SMI-3728) to stay under 500-line limit.
 */

/**
 * Generate the client-side JavaScript for the webview.
 * Returns a complete HTML fragment (`<script nonce="...">...</script>` tag),
 * not raw JavaScript — the caller inserts this directly into the HTML body.
 */
export function getScript(nonce: string): string {
  return `
    <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();

        // C1: null-guard every getElementById. The Install button is absent on
        // the installed-skill view; an unguarded lookup throws and kills every
        // listener wired after it (uninstall/open would be dead).
        const installBtn = document.getElementById('installBtn');
        if (installBtn) {
            installBtn.addEventListener('click', function() {
                vscode.postMessage({ command: 'install' });
            });
        }

        const uninstallBtn = document.getElementById('uninstallBtn');
        if (uninstallBtn) {
            uninstallBtn.addEventListener('click', function() {
                vscode.postMessage({ command: 'uninstall' });
            });
        }

        const openSkillFileBtn = document.getElementById('openSkillFileBtn');
        if (openSkillFileBtn) {
            openSkillFileBtn.addEventListener('click', function() {
                vscode.postMessage({ command: 'openSkillFile' });
            });
        }

        const openFolderBtn = document.getElementById('openFolderBtn');
        if (openFolderBtn) {
            openFolderBtn.addEventListener('click', function() {
                vscode.postMessage({ command: 'openFolder' });
            });
        }

        const diffBtn = document.getElementById('diffBtn');
        if (diffBtn) {
            diffBtn.addEventListener('click', function() {
                vscode.postMessage({ command: 'diffSkill' });
            });
        }

        const repoBtn = document.getElementById('repoBtn');
        if (repoBtn) {
            repoBtn.addEventListener('click', function() {
                const url = this.getAttribute('data-url');
                if (url) {
                    vscode.postMessage({ command: 'openRepository', url: url });
                }
            });
        }

        document.querySelectorAll('.repository-link').forEach(function(link) {
            link.addEventListener('click', function() {
                const url = this.getAttribute('data-url');
                if (url) {
                    vscode.postMessage({ command: 'openRepository', url: url });
                }
            });
            link.addEventListener('keydown', function(e) {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    this.click();
                }
            });
        });

        const expandBtn = document.getElementById('expandContentBtn');
        if (expandBtn) {
            expandBtn.addEventListener('click', function() {
                vscode.postMessage({ command: 'expandContent' });
            });
        }

        // Intercept all link clicks in rendered markdown content
        document.addEventListener('click', function(e) {
            const link = e.target.closest('.skill-content a[href], .description a[href]');
            if (link) {
                e.preventDefault();
                const url = link.getAttribute('href');
                if (url && (url.startsWith('https://') || url.startsWith('http://'))) {
                    vscode.postMessage({ command: 'openExternal', url: url });
                }
            }
        });
    </script>`
}
