/**
 * A note holds fields. A note type owns N card templates. Each template that
 * renders a non-empty front produces one card. Every stock and custom Anki type
 * is just templates over that one rule (PLAN.md §3.5).
 *
 * The six below are the "native kinds" — users never see these templates, they
 * see a fixed editor per kind. Imported note types land in the same table with
 * their own templates and CSS, and go through the same renderer.
 */

export interface CardTemplate {
  name: string
  qfmt: string
  afmt: string
  /**
   * Anki's per-template **deck override**: this template's cards go to a named
   * deck instead of the note's. Null means follow the note, which is every
   * template we ship. Imports bring their own.
   */
  deckOverride?: string | null
}

export interface NoteType {
  id: string
  name: string
  fields: string[]
  templates: CardTemplate[]
  /** Per-note-type CSS. Empty for natives; imports bring their own. Untrusted. */
  css: string
  /**
   * `standard` generates one card per template. `cloze` and `occlusion` generate
   * one card per ordinal from a single template — cloze scans every field for
   * `{{c<N>::…}}`, occlusion reads the shape list in `ordField`.
   */
  /**
   * `simulation` is the one kind whose card is not HTML.
   *
   * Its fields carry a model name and numbers; the answer is rendered by a real
   * React component outside the sandboxed `CardFrame`. That is only safe
   * because nothing authored by a user or a model is ever executed — the
   * simulation is ours, and the note only chooses which one and with what
   * values. See `simulation/types.ts`.
   */
  kind: 'standard' | 'cloze' | 'occlusion' | 'simulation'
  /** Occlusion only: the field holding the shape JSON. */
  ordField?: string
  /** Natives are replaced on upgrade; imports are never touched. */
  builtin?: boolean
  /**
   * Which field the browser sorts and shows. An index, because Anki's `sortf`
   * is one and a rename must not break it.
   */
  sortField?: number
  /** Per-field settings, by field index. See `FieldConfig`. */
  fieldConfig?: FieldConfig[]
  /**
   * Anki note-type fields we do not model — `latexPre`, `latexPost`, `latexsvg`,
   * `bqfmt`/`bafmt`, `originalStockKind`. Carried opaque so a round-trip through
   * us does not silently degrade somebody's deck (CARDS.md §7).
   */
  ankiExtra?: Record<string, unknown>
}

const ANSWER = '{{FrontSide}}\n<hr id="answer">\n'

export const BUILTIN_NOTE_TYPES: NoteType[] = [
  {
    id: 'basic',
    name: 'Basic',
    fields: ['Front', 'Back'],
    kind: 'standard',
    css: '',
    builtin: true,
    templates: [{ name: 'Card 1', qfmt: '{{Front}}', afmt: `${ANSWER}{{Back}}` }],
  },
  {
    id: 'basic-reversed',
    name: 'Basic (and reversed card)',
    fields: ['Front', 'Back'],
    kind: 'standard',
    css: '',
    builtin: true,
    templates: [
      { name: 'Card 1', qfmt: '{{Front}}', afmt: `${ANSWER}{{Back}}` },
      { name: 'Card 2', qfmt: '{{Back}}', afmt: `${ANSWER}{{Front}}` },
    ],
  },
  {
    id: 'basic-optional-reversed',
    name: 'Basic (optional reversed card)',
    fields: ['Front', 'Back', 'Add Reverse'],
    kind: 'standard',
    css: '',
    builtin: true,
    templates: [
      { name: 'Card 1', qfmt: '{{Front}}', afmt: `${ANSWER}{{Back}}` },
      // The conditional is the whole point: card 2 exists only while the third
      // field is filled. Emptying it stops generating, it does not rewrite.
      {
        name: 'Card 2',
        qfmt: '{{#Add Reverse}}{{Back}}{{/Add Reverse}}',
        afmt: `${ANSWER}{{Front}}`,
      },
    ],
  },
  {
    id: 'basic-type-in',
    name: 'Basic (type in the answer)',
    fields: ['Front', 'Back'],
    kind: 'standard',
    css: '',
    builtin: true,
    templates: [
      { name: 'Card 1', qfmt: '{{Front}}\n{{type:Back}}', afmt: `${ANSWER}{{type:Back}}` },
    ],
  },
  {
    id: 'cloze',
    name: 'Cloze',
    fields: ['Text', 'Back Extra'],
    kind: 'cloze',
    // No ordField: cloze ordinals come from every field (see generatedOrds).
    css: '',
    builtin: true,
    templates: [
      {
        name: 'Cloze',
        qfmt: '{{cloze:Text}}',
        afmt: '{{cloze:Text}}{{#Back Extra}}<div class="extra">{{Back Extra}}</div>{{/Back Extra}}',
      },
    ],
  },
  {
    id: 'simulation',
    name: 'Simulation',
    // `Model` names one of `SIM_MODELS`; `Parameters` and `Change` are JSON
    // objects of numbers; `Target` names the output being predicted. The
    // templates below are only ever used for the *question* — the answer side
    // is a component, not markup.
    fields: ['Prompt', 'Model', 'Parameters', 'Change', 'Target', 'Notes'],
    kind: 'simulation',
    css: '',
    builtin: true,
    templates: [
      {
        name: 'Simulation',
        qfmt: '<div class="sim-prompt">{{Prompt}}</div>',
        afmt: '<div class="sim-prompt">{{Prompt}}</div>'
          + '{{#Notes}}<div class="extra">{{Notes}}</div>{{/Notes}}',
      },
    ],
  },
  {
    id: 'image-occlusion',
    name: 'Image Occlusion',
    fields: ['Occlusion', 'Image', 'Header', 'Back Extra', 'Comments'],
    kind: 'occlusion',
    ordField: 'Occlusion',
    css: '',
    builtin: true,
    templates: [
      {
        // No {{FrontSide}} here — the overlay has to re-render in back mode to
        // uncover the asked region, so the back rebuilds it rather than echoing.
        name: 'Image Occlusion',
        qfmt: '{{#Header}}<div class="io-header">{{Header}}</div>{{/Header}}{{occlusion:Occlusion}}',
        afmt:
          '{{#Header}}<div class="io-header">{{Header}}</div>{{/Header}}{{occlusion:Occlusion}}' +
          '{{#Back Extra}}<div class="extra">{{Back Extra}}</div>{{/Back Extra}}',
      },
    ],
  },
]

export const builtinNoteType = (id: string): NoteType | undefined =>
  BUILTIN_NOTE_TYPES.find((t) => t.id === id)

// ── note type management (CARDS.md §7) ────────────────────────────────────

/**
 * Per-field settings. Anki keeps a dozen of these; we carry the ones that
 * change what the editor does, and the rest ride along in `ankiExtra`.
 */
export interface FieldConfig {
  /** Keep this field's value when the add screen clears for the next note. */
  sticky?: boolean
  rtl?: boolean
  description?: string
}

/** Field settings by index, padded to the note type's field count. */
export const fieldConfigOf = (nt: NoteType, i: number): FieldConfig => nt.fieldConfig?.[i] ?? {}

/**
 * Every `{{…Name}}` reference to a field, renamed in one template.
 *
 * Renaming the field without this detaches every template that used it, which
 * is the difference between "renamed a field" and "silently emptied 4,000
 * cards". Special names (`FrontSide`, `Tags`, a `{{c1}}` cloze section) live in
 * the same syntax, so the match is on the trailing name only and the filters in
 * front of it are preserved.
 */
export function renameFieldRefs(tmpl: string, from: string, to: string): string {
  return tmpl.replace(/\{\{([^{}]*)\}\}/g, (whole, inner: string) => {
    const raw = String(inner).trim()
    const sigil = /^[#^/]/.test(raw) ? raw[0]! : ''
    const rest = sigil ? raw.slice(1).trim() : raw
    const parts = rest.split(':')
    if ((parts[parts.length - 1] ?? '').trim() !== from) return whole
    parts[parts.length - 1] = to
    return `{{${sigil}${parts.join(':')}}}`
  })
}

/** Rename a field on a note type, templates and all. Notes are remapped by the repo. */
export function renameField(nt: NoteType, from: string, to: string): NoteType {
  const name = to.trim()
  if (!name) throw new Error('A field needs a name')
  if (name !== from && nt.fields.includes(name)) throw new Error(`“${name}” is already a field here`)
  return {
    ...nt,
    fields: nt.fields.map((f) => (f === from ? name : f)),
    templates: nt.templates.map((t) => ({
      ...t,
      qfmt: renameFieldRefs(t.qfmt, from, name),
      afmt: renameFieldRefs(t.afmt, from, name),
    })),
    ordField: nt.ordField === from ? name : nt.ordField,
  }
}

export function addField(nt: NoteType, name: string): NoteType {
  const clean = name.trim()
  if (!clean) throw new Error('A field needs a name')
  if (nt.fields.includes(clean)) throw new Error(`“${clean}” is already a field here`)
  return { ...nt, fields: [...nt.fields, clean], fieldConfig: [...(nt.fieldConfig ?? []), {}] }
}

/**
 * Remove a field. Template references to it are left alone deliberately: they
 * render empty, which is Anki's behaviour, and a `{{#Gone}}` section that stops
 * generating its card is information rather than a bug.
 */
export function removeField(nt: NoteType, name: string): NoteType {
  if (nt.fields.length <= 1) throw new Error('A note type needs at least one field')
  const at = nt.fields.indexOf(name)
  if (at < 0) return nt
  const fields = nt.fields.filter((f) => f !== name)
  return {
    ...nt,
    fields,
    fieldConfig: (nt.fieldConfig ?? []).filter((_, i) => i !== at),
    // The sort field is an index, so removing anything before it shifts it.
    sortField: Math.min(Math.max(0, (nt.sortField ?? 0) - (at < (nt.sortField ?? 0) ? 1 : 0)), fields.length - 1),
    ordField: nt.ordField === name ? undefined : nt.ordField,
  }
}

/** Move a field to a new index. Field *order* is what the first field means. */
export function moveField(nt: NoteType, name: string, to: number): NoteType {
  const from = nt.fields.indexOf(name)
  const at = Math.min(Math.max(0, to), nt.fields.length - 1)
  if (from < 0 || from === at) return nt
  const fields = [...nt.fields]
  const cfg = [...(nt.fieldConfig ?? [])]
  fields.splice(at, 0, ...fields.splice(from, 1))
  cfg.splice(at, 0, ...cfg.splice(from, 1))
  const sort = nt.sortField ?? 0
  return {
    ...nt,
    fields,
    fieldConfig: cfg,
    // Follow the field the user was sorting by, wherever it landed.
    sortField: sort === from ? at : sort > from && sort <= at ? sort - 1 : sort < from && sort >= at ? sort + 1 : sort,
  }
}

/**
 * Remap a note's fields onto another note type.
 *
 * `map` is keyed by *target* field name, valued by the source field it takes
 * its content from — that direction is the one a person can check, because the
 * question being answered is "what goes in this box". Anything unmapped starts
 * empty; nothing is silently concatenated.
 */
export function mapFields(
  to: NoteType,
  fields: Record<string, string>,
  map: Record<string, string | null>,
): Record<string, string> {
  return Object.fromEntries(
    to.fields.map((name) => {
      const src = name in map ? map[name] : name
      return [name, (src && fields[src]) || '']
    }),
  )
}

/**
 * The default field map between two types: same name wins, then same position.
 *
 * Position is the fallback Anki uses, and it is right far more often than an
 * empty box — a two-field type renamed "Term/Definition" still means Front/Back.
 */
export function defaultFieldMap(from: NoteType, to: NoteType): Record<string, string | null> {
  return Object.fromEntries(
    to.fields.map((name, i) => [
      name,
      from.fields.includes(name) ? name : (from.fields[i] ?? null),
    ]),
  )
}
