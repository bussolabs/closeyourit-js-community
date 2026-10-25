// Entry of `dist/helpdesk.min.js` (CYRA-942): one `<script>` line shows the button.
// The settings are the data attributes of the tag itself. `currentScript` is read
// while the file runs: later it is null.

import { mountHelpdesk, mountHelpdeskFromScript } from './helpdesk'

const script = typeof document === 'undefined' ? null : document.currentScript

if (typeof document !== 'undefined') {
  if (document.body) mountHelpdeskFromScript(script)
  else
    document.addEventListener('DOMContentLoaded', () => mountHelpdeskFromScript(script))
}

export { mountHelpdesk as mount }
