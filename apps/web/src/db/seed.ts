/**
 * Demo content, sized to exercise the renderer rather than to look full: one
 * note of every native kind that does not need a picture, so the study loop has
 * a cloze, a reversed pair, a type-in and some LaTeX to render on first run.
 *
 * ponytail: FMA ids here are illustrative — verify them against the actual
 * BodyParts3D IS-A/PART-OF trees when the 3D phase lands (see ASSETS-3D.md).
 */
type SeedNote = {
  deck: string
  type: string
  fields: Record<string, string>
  fma?: string
  tags?: string[]
}

const basic = (deck: string, Front: string, Back: string, extra: Partial<SeedNote> = {}): SeedNote =>
  ({ deck, type: 'basic', fields: { Front, Back }, ...extra })

export const SEED = {
  decks: [
    { id: 'anatomy', parent_id: null, name: 'Anatomy' },
    { id: 'thorax', parent_id: 'anatomy', name: 'Thorax' },
    { id: 'heart', parent_id: 'thorax', name: 'Heart', retention_target: 0.92 },
    // A real daily intake limit, so first run shows the deck holding cards back
    // rather than dumping everything it has — the behaviour that keeps a 20k
    // imported deck usable.
    { id: 'neuro', parent_id: 'anatomy', name: 'Neuroanatomy', new_per_day: 2 },
    { id: 'pharm', parent_id: null, name: 'Pharmacology' },
  ] as { id: string; parent_id: string | null; name: string; retention_target?: number; new_per_day?: number }[],

  notes: <SeedNote[]>[
    basic('heart', 'Which valve prevents backflow into the left atrium?',
      'The mitral (left atrioventricular) valve — two cusps, between the left atrium and left ventricle.',
      { fma: 'FMA:7235', tags: ['valves'] }),
    basic('heart', 'Which valve sits between the right atrium and right ventricle?',
      'The tricuspid valve — three cusps.', { fma: 'FMA:7234', tags: ['valves'] }),
    basic('heart', 'Closure of which valve produces the A2 component of the second heart sound?',
      'The aortic valve. A2 precedes P2 (pulmonary) in normal physiological splitting.',
      { fma: 'FMA:7236', tags: ['valves'] }),
    basic('heart', 'Why is the left ventricular wall roughly three times thicker than the right?',
      'It pumps against systemic vascular resistance (~120/80 mmHg) rather than pulmonary (~25/8 mmHg).',
      { fma: 'FMA:7101', tags: ['chambers'] }),

    {
      deck: 'heart', type: 'cloze', fma: 'FMA:9477', tags: ['conduction'],
      fields: {
        Text: 'The {{c1::sinoatrial node}} lies in the wall of the {{c2::right atrium}}, near the opening of the superior vena cava.',
        'Back Extra': 'Primary pacemaker, 60–100 bpm.',
      },
    },
    {
      deck: 'heart', type: 'cloze', tags: ['physiology'],
      fields: {
        Text: 'Stroke volume is {{c1::end-diastolic volume minus end-systolic volume::a subtraction}}, about {{c2::70}} mL at rest.',
        'Back Extra': '',
      },
    },
    {
      // Maths on a card: KaTeX renders these to static HTML before the frame
      // ever sees them, because the frame runs no JavaScript.
      deck: 'heart', type: 'basic', tags: ['physiology'],
      fields: {
        Front: 'State the equation for cardiac output.',
        Back: '\\[ CO = SV \\times HR \\]<p>At rest: \\(70\\,\\text{mL} \\times 70\\,\\text{min}^{-1} \\approx 4.9\\,\\text{L/min}\\)</p>',
      },
    },

    basic('thorax', 'How many lobes does the right lung have, and why does it differ from the left?',
      'Three — superior, middle, inferior. The left has two, making room for the cardiac notch.',
      { tags: ['lungs'] }),
    basic('thorax', 'What is the costodiaphragmatic recess?',
      'The pleural space below the inferior lung border where costal and diaphragmatic pleura meet. Fluid collects here first on an erect film.',
      { tags: ['pleura'] }),

    basic('neuro', 'Which cranial nerve is the only one to exit the brainstem dorsally?',
      'CN IV, the trochlear nerve. It is also the longest intracranial course.',
      { tags: ['cranial-nerves'] }),
    {
      deck: 'neuro', type: 'basic-type-in', tags: ['cranial-nerves'],
      fields: {
        Front: 'A patient cannot abduct the right eye. Name the muscle that has failed.',
        Back: 'lateral rectus',
      },
    },
    {
      deck: 'neuro', type: 'basic-reversed', tags: ['cranial-nerves'],
      fields: { Front: 'CN VII', Back: 'Facial nerve' },
    },

    basic('pharm', 'How many half-lives to reach ~97% of steady state on a constant infusion?',
      'Five. Each half-life closes half the remaining gap: 50, 75, 87.5, 93.75, 96.9%.',
      { tags: ['pk'] }),
    {
      deck: 'pharm', type: 'basic-optional-reversed', tags: ['pk'],
      fields: {
        Front: 'What does a loading dose depend on?',
        Back: 'Volume of distribution (maintenance dose depends on clearance)',
        // Filled, so this note generates two cards. Empty it in the editor and
        // the second one disappears; refill it and its history comes back.
        'Add Reverse': 'y',
      },
    },
  ],
}
