/**
 * Session-configuration splash screen.
 *
 * Renders a centered card on top of the viewer host with inputs for seed,
 * map size, settlement counts, and pre-burn-in years. When the user clicks
 * "Start", `onStart` is invoked with the chosen config. The caller is
 * responsible for hiding the splash (via `hide()`), running burn-in, and
 * booting the viewer.
 *
 * Style: matches the dark theme defined in viewer/index.html
 * (`--bg`, `--panel`, `--accent`, etc). No frameworks; functional factory
 * returning the container + control methods, consistent with the rest of
 * viewer/ui/*.
 */

export interface SplashConfig {
  readonly seed: string;
  readonly mapWidth: number;
  readonly mapHeight: number;
  readonly cityCount: number;
  readonly townCount: number;
  readonly villageCount: number;
  readonly hamletCount: number;
  /** Years of silent burn-in to run before the viewer opens. 0 ⇒ skip. */
  readonly burninYears: number;
}

export interface SplashDefaults extends SplashConfig {}

export interface SplashControls {
  readonly container: HTMLElement;
  show(): void;
  hide(): void;
  /** Render a progress overlay (replaces the form). Call repeatedly to update. */
  showProgress(current: number, total: number): void;
  /** Show an error inside the splash card (does not hide the form). */
  showError(message: string): void;
  /** Detach the splash from the DOM entirely. */
  destroy(): void;
}

export interface CreateSplashOpts {
  readonly host: HTMLElement;
  readonly defaults: SplashDefaults;
  readonly onStart: (config: SplashConfig) => void;
}

interface FieldSpec {
  readonly key: keyof Omit<SplashConfig, 'seed'>;
  readonly label: string;
  readonly min: number;
  readonly max: number;
  readonly step?: number;
}

const NUMBER_FIELDS: readonly FieldSpec[] = [
  { key: 'mapWidth', label: 'Map width (hexes)', min: 8, max: 500, step: 1 },
  { key: 'mapHeight', label: 'Map height (hexes)', min: 8, max: 500, step: 1 },
  { key: 'cityCount', label: 'Cities', min: 0, max: 200, step: 1 },
  { key: 'townCount', label: 'Towns', min: 0, max: 500, step: 1 },
  { key: 'villageCount', label: 'Villages', min: 0, max: 2000, step: 1 },
  { key: 'hamletCount', label: 'Hamlets', min: 0, max: 2000, step: 1 },
  { key: 'burninYears', label: 'Pre-burn-in years', min: 0, max: 10, step: 1 },
];

export const createSplash = (opts: CreateSplashOpts): SplashControls => {
  const { host, defaults, onStart } = opts;

  const container = document.createElement('div');
  container.id = 'splash';
  container.setAttribute('role', 'dialog');
  container.setAttribute('aria-label', 'New session');

  const card = document.createElement('div');
  card.className = 'splash-card';
  container.appendChild(card);

  const title = document.createElement('h1');
  title.textContent = 'Ecogame — new session';
  card.appendChild(title);

  const subtitle = document.createElement('p');
  subtitle.className = 'splash-subtitle';
  subtitle.textContent =
    'Choose the world parameters. The simulation runs silently for the chosen number of years before the map opens.';
  card.appendChild(subtitle);

  const form = document.createElement('form');
  form.className = 'splash-form';
  form.addEventListener('submit', (e) => {
    e.preventDefault();
  });
  card.appendChild(form);

  // Seed (text input).
  const seedField = createField(form, 'Seed', 'splash-seed');
  const seedInput = document.createElement('input');
  seedInput.type = 'text';
  seedInput.id = 'splash-seed';
  seedInput.value = defaults.seed;
  seedInput.autocomplete = 'off';
  seedInput.spellcheck = false;
  seedField.appendChild(seedInput);

  // Numeric inputs.
  const numberInputs = new Map<FieldSpec['key'], HTMLInputElement>();
  for (const spec of NUMBER_FIELDS) {
    const id = `splash-${spec.key}`;
    const field = createField(form, spec.label, id);
    const input = document.createElement('input');
    input.type = 'number';
    input.id = id;
    input.min = String(spec.min);
    input.max = String(spec.max);
    if (spec.step !== undefined) input.step = String(spec.step);
    input.value = String(defaults[spec.key]);
    input.autocomplete = 'off';
    field.appendChild(input);
    numberInputs.set(spec.key, input);
  }

  // Error slot — sits between form and actions; hidden until populated.
  const errorEl = document.createElement('div');
  errorEl.className = 'splash-error';
  errorEl.style.display = 'none';
  card.appendChild(errorEl);

  // Actions.
  const actions = document.createElement('div');
  actions.className = 'splash-actions';
  card.appendChild(actions);

  const startBtn = document.createElement('button');
  startBtn.type = 'button';
  startBtn.className = 'splash-start';
  startBtn.textContent = 'Start';
  actions.appendChild(startBtn);

  // Progress block — replaces the form once burn-in begins.
  const progress = document.createElement('div');
  progress.className = 'splash-progress';
  progress.style.display = 'none';
  card.appendChild(progress);

  const progressLabel = document.createElement('div');
  progressLabel.className = 'splash-progress-label';
  progress.appendChild(progressLabel);

  const progressBarOuter = document.createElement('div');
  progressBarOuter.className = 'splash-progress-bar';
  progress.appendChild(progressBarOuter);

  const progressBarInner = document.createElement('div');
  progressBarInner.className = 'splash-progress-bar-inner';
  progressBarOuter.appendChild(progressBarInner);

  // Wire start.
  const readConfig = (): SplashConfig | { error: string } => {
    const seed = seedInput.value.trim();
    if (seed === '') return { error: 'Seed cannot be empty.' };

    const parse = (key: FieldSpec['key']): number | null => {
      const input = numberInputs.get(key);
      if (input === undefined) return null;
      const raw = input.value.trim();
      if (raw === '') return null;
      const n = Number(raw);
      if (!Number.isFinite(n)) return null;
      return Math.floor(n);
    };

    const out: Record<string, number | string> = { seed };
    for (const spec of NUMBER_FIELDS) {
      const n = parse(spec.key);
      if (n === null) return { error: `Invalid value for "${spec.label}".` };
      if (n < spec.min || n > spec.max) {
        return { error: `"${spec.label}" must be between ${spec.min} and ${spec.max}.` };
      }
      out[spec.key] = n;
    }
    return out as unknown as SplashConfig;
  };

  startBtn.addEventListener('click', () => {
    const cfg = readConfig();
    if ('error' in cfg) {
      errorEl.textContent = cfg.error;
      errorEl.style.display = 'block';
      return;
    }
    errorEl.style.display = 'none';
    onStart(cfg);
  });

  // Submit on Enter from inside the form.
  form.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      startBtn.click();
    }
  });

  host.appendChild(container);

  const show = (): void => {
    container.style.display = 'flex';
  };
  const hide = (): void => {
    container.style.display = 'none';
  };
  const showProgress = (current: number, total: number): void => {
    form.style.display = 'none';
    actions.style.display = 'none';
    errorEl.style.display = 'none';
    progress.style.display = 'block';
    const pct = total > 0 ? Math.min(100, (current / total) * 100) : 100;
    progressLabel.textContent =
      total > 0 ? `Burning in ${current}/${total} days…` : 'Building world…';
    progressBarInner.style.width = `${pct.toFixed(1)}%`;
  };
  const showError = (message: string): void => {
    errorEl.textContent = message;
    errorEl.style.display = 'block';
    // If we were in progress mode, return to the form so the user can retry.
    form.style.display = '';
    actions.style.display = '';
    progress.style.display = 'none';
  };
  const destroy = (): void => {
    container.remove();
  };

  return { container, show, hide, showProgress, showError, destroy };
};

const createField = (form: HTMLElement, labelText: string, forId: string): HTMLLabelElement => {
  const label = document.createElement('label');
  label.className = 'splash-field';
  label.htmlFor = forId;
  const span = document.createElement('span');
  span.className = 'splash-field-label';
  span.textContent = labelText;
  label.appendChild(span);
  form.appendChild(label);
  return label;
};
