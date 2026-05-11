/**
 * Reusable modal popup with backdrop, Escape-to-close, and click-outside-to-close.
 *
 * The popup attaches a fixed-position overlay to `document.body` (so it can
 * cover the entire viewport regardless of where its host element is in the
 * grid). When closed, the overlay is detached entirely — no hidden display
 * style hack — which keeps the DOM tidy and avoids capturing pointer events.
 *
 * The caller owns the content DOM (passed to `open()`). The popup just
 * arranges chrome (backdrop, close button, content scroll container) and
 * routes Escape / outside-click into `close()`. A single `onClose` callback
 * lets the consumer clear the selection (or whatever) when the user
 * dismisses the popup via the X / Escape / backdrop.
 *
 * One-time style injection on first use keeps the popup module
 * self-contained: callers do not need to know to add CSS to index.html.
 */

export interface Popup {
  readonly isOpen: boolean;
  open(content: HTMLElement, title?: string): void;
  close(): void;
  /** Replace the content node inside an already-open popup. No-op if closed. */
  setContent(content: HTMLElement, title?: string): void;
  destroy(): void;
}

export interface PopupOpts {
  /** Called when the popup is dismissed by the user (X / Esc / backdrop). */
  readonly onClose?: () => void;
}

const STYLE_ID = 'popup-styles';

const ensureStyles = (): void => {
  if (document.getElementById(STYLE_ID) !== null) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    .popup-backdrop {
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.65);
      backdrop-filter: blur(2px);
      -webkit-backdrop-filter: blur(2px);
      z-index: 1000;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 32px;
    }
    .popup-card {
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 6px;
      box-shadow: 0 12px 48px rgba(0, 0, 0, 0.6);
      width: min(960px, 100%);
      max-height: 100%;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      color: var(--text);
      font-family: 'Iowan Old Style', 'Palatino', 'Georgia', serif;
      font-size: 13px;
    }
    .popup-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 10px 16px;
      background: var(--panel-2);
      border-bottom: 1px solid var(--border);
      gap: 16px;
    }
    .popup-title {
      margin: 0;
      color: var(--accent-bright);
      font-size: 15px;
      letter-spacing: 0.04em;
      flex: 1 1 auto;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .popup-close {
      background: transparent;
      color: var(--muted);
      border: 1px solid var(--border);
      border-radius: 3px;
      padding: 2px 10px;
      font-size: 16px;
      cursor: pointer;
      font-family: inherit;
      line-height: 1.2;
    }
    .popup-close:hover {
      color: var(--accent-bright);
      border-color: var(--accent);
    }
    .popup-body {
      overflow-y: auto;
      padding: 16px 20px 20px 20px;
      flex: 1 1 auto;
    }
    .popup-section {
      margin-bottom: 18px;
    }
    .popup-section:last-child {
      margin-bottom: 0;
    }
    .popup-section-title {
      font-size: 11px;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--accent);
      margin: 0 0 6px 0;
      padding-bottom: 4px;
      border-bottom: 1px solid var(--border);
    }
    .popup-cols {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
      gap: 12px 18px;
    }
    .popup-kv {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 2px 12px;
      font-variant-numeric: tabular-nums;
    }
    .popup-kv .k {
      color: var(--muted);
    }
    .popup-kv .v {
      color: var(--text);
      text-align: right;
    }
    .popup-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 12px;
    }
    .popup-table th,
    .popup-table td {
      padding: 3px 8px;
      text-align: left;
      font-variant-numeric: tabular-nums;
      border-bottom: 1px solid var(--border);
    }
    .popup-table th {
      color: var(--muted);
      font-weight: normal;
      font-size: 11px;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      background: var(--panel-2);
    }
    .popup-table td.num {
      text-align: right;
    }
    .popup-table tr:last-child td {
      border-bottom: none;
    }
    .popup-table tr:hover td {
      background: rgba(210, 164, 75, 0.05);
    }
    .popup-pyramid {
      display: grid;
      gap: 1px;
    }
    .popup-pyramid-row {
      display: grid;
      grid-template-columns: 1fr 64px 1fr;
      align-items: center;
      gap: 6px;
      font-size: 11px;
      font-variant-numeric: tabular-nums;
    }
    .popup-pyramid-row .age {
      color: var(--muted);
      text-align: center;
    }
    .popup-pyramid-bar {
      height: 12px;
      display: flex;
    }
    .popup-pyramid-bar.male {
      justify-content: flex-end;
    }
    .popup-pyramid-bar .seg {
      background: var(--accent);
      height: 100%;
    }
    .popup-pyramid-bar.male .seg {
      background: #6f8aae;
    }
    .popup-pyramid-bar .lbl {
      color: var(--muted);
      font-size: 10px;
      padding: 0 4px;
      align-self: center;
    }
    .popup-link {
      background: transparent;
      color: var(--accent-bright);
      border: none;
      padding: 0;
      cursor: pointer;
      font-family: inherit;
      font-size: inherit;
      text-decoration: underline dotted;
    }
    .popup-link:hover {
      color: var(--accent);
    }
    .popup-chip {
      display: inline-block;
      background: var(--panel-2);
      border: 1px solid var(--border);
      color: var(--text);
      padding: 1px 8px;
      margin: 0 4px 4px 0;
      border-radius: 10px;
      font-size: 11px;
    }
    .popup-empty {
      color: var(--muted);
      font-style: italic;
      font-size: 12px;
    }
    .popup-event-list {
      max-height: 220px;
      overflow-y: auto;
      font-family: ui-monospace, 'SF Mono', monospace;
      font-size: 11px;
      line-height: 1.5;
    }
    .popup-event-list .row {
      color: var(--muted);
      padding: 1px 0;
    }
    .popup-event-list .row .day {
      color: var(--accent);
      margin-right: 6px;
    }
  `;
  document.head.appendChild(style);
};

export const createPopup = (opts: PopupOpts = {}): Popup => {
  ensureStyles();

  let backdrop: HTMLDivElement | null = null;
  let card: HTMLDivElement | null = null;
  let body: HTMLDivElement | null = null;
  let titleEl: HTMLHeadingElement | null = null;
  let isOpen = false;

  const handleKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape' && isOpen) {
      e.stopPropagation();
      // Stop the global Escape handler from also clearing the selection
      // before close() invokes onClose itself.
      e.preventDefault();
      close();
    }
  };

  const close = (): void => {
    if (!isOpen) return;
    isOpen = false;
    if (backdrop !== null && backdrop.parentNode !== null) {
      backdrop.parentNode.removeChild(backdrop);
    }
    backdrop = null;
    card = null;
    body = null;
    titleEl = null;
    window.removeEventListener('keydown', handleKey, true);
    opts.onClose?.();
  };

  const open = (content: HTMLElement, title?: string): void => {
    if (isOpen) {
      setContent(content, title);
      return;
    }
    isOpen = true;

    backdrop = document.createElement('div');
    backdrop.className = 'popup-backdrop';
    backdrop.addEventListener('click', (e) => {
      // Only close if the click is on the backdrop itself, not on a child.
      if (e.target === backdrop) close();
    });

    card = document.createElement('div');
    card.className = 'popup-card';

    const header = document.createElement('div');
    header.className = 'popup-header';
    titleEl = document.createElement('h2');
    titleEl.className = 'popup-title';
    titleEl.textContent = title ?? '';
    header.appendChild(titleEl);

    const closeBtn = document.createElement('button');
    closeBtn.className = 'popup-close';
    closeBtn.type = 'button';
    closeBtn.setAttribute('aria-label', 'Close');
    closeBtn.textContent = '×';
    closeBtn.addEventListener('click', () => close());
    header.appendChild(closeBtn);

    body = document.createElement('div');
    body.className = 'popup-body';
    body.appendChild(content);

    card.appendChild(header);
    card.appendChild(body);
    backdrop.appendChild(card);
    document.body.appendChild(backdrop);

    // Use capture so we run BEFORE the app's global Escape handler. Without
    // this, the global handler would clear the selection first, which would
    // independently fire our onClose and could lead to double-firing.
    window.addEventListener('keydown', handleKey, true);
  };

  const setContent = (content: HTMLElement, title?: string): void => {
    if (!isOpen || body === null) return;
    body.replaceChildren(content);
    if (titleEl !== null && title !== undefined) {
      titleEl.textContent = title;
    }
  };

  const destroy = (): void => {
    close();
  };

  return {
    get isOpen(): boolean {
      return isOpen;
    },
    open,
    close,
    setContent,
    destroy,
  };
};

// --- DOM construction helpers (reused by all popup content modules) --------

export const popupSection = (title: string): HTMLDivElement => {
  const root = document.createElement('div');
  root.className = 'popup-section';
  const h = document.createElement('h3');
  h.className = 'popup-section-title';
  h.textContent = title;
  root.appendChild(h);
  return root;
};

export const popupKv = (entries: readonly (readonly [string, string | Node])[]): HTMLDivElement => {
  const root = document.createElement('div');
  root.className = 'popup-kv';
  for (const [k, v] of entries) {
    const ke = document.createElement('div');
    ke.className = 'k';
    ke.textContent = k;
    const ve = document.createElement('div');
    ve.className = 'v';
    if (typeof v === 'string') ve.textContent = v;
    else ve.appendChild(v);
    root.appendChild(ke);
    root.appendChild(ve);
  }
  return root;
};

export const popupEmpty = (msg: string): HTMLDivElement => {
  const d = document.createElement('div');
  d.className = 'popup-empty';
  d.textContent = msg;
  return d;
};

export const popupCols = (children: readonly HTMLElement[]): HTMLDivElement => {
  const root = document.createElement('div');
  root.className = 'popup-cols';
  for (const c of children) root.appendChild(c);
  return root;
};
