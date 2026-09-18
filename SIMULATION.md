# Physiological simulation — free options

"Blood pumping" spans four very different costs. Pick the lowest tier that
teaches the thing; they compose, so you can ship tier 1 and add tier 3 later.

---

## Tier 1 — Canned animation · *do this first*

A looping beating heart, breathing lungs, peristalsis — **glTF morph targets or
skeletal animation baked into the GLB.**

- Zero runtime compute, zero dependencies, works offline, plays on mobile.
- Covers most of the study value of "show me blood pumping".
- Authored once in Blender against the BodyParts3D meshes.

**Do not reach for a physics engine to animate a loop.** If the card is "watch
the ventricles contract", this is the whole feature.

---

## Tier 2 — Small ODEs in JavaScript · *the sweet spot for learning*

Real interactivity, tens of lines each, runs in the browser, fully offline, no
dependency. This is where the genuinely good cards come from — not *watch* the
heart, but *change a parameter and predict what happens*.

| Model | Teaches | Size |
|---|---|---|
| **2-element Windkessel** (RC circuit) | aortic pressure decay, systolic/diastolic, compliance, afterload | ~10 lines |
| **Frank–Starling curve** | preload vs. stroke volume | algebraic, trivial |
| **Hodgkin–Huxley** | neuronal action potential, ion channel gating | ~40 lines |
| **FitzHugh–Nagumo** | excitable-cell dynamics, cardiac AP intuition | ~20 lines |
| **Two-compartment PK** | drug distribution, half-life, loading dose | ~15 lines |

Forward Euler at a small timestep is accurate enough for teaching; use RK4 if a
curve looks wrong. No solver library needed.

**Card design this unlocks:** *"Afterload doubles. Predict the change in stroke
volume."* → student answers → the sim runs and shows the actual curve → FSRS
schedules it. No other flashcard app can do this.

**Free model source:** the [Physiome Model Repository](https://models.cellml.org/electrophysiology)
holds hundreds of curated, published cell models in **CellML**, units included.
Authored and edited with [OpenCOR](https://opencor.ws/). Transpile the simple
ones to JS by hand — most are a handful of ODEs.

---

## Tier 3 — Pulse Physiology Engine · *for clinical scenarios*

[Pulse](https://pulse.kitware.com/) (Kitware, forked from BioGears) is the real
thing: **Apache 2.0**, closed-loop whole-body model, 20+ systems — cardiovascular,
respiratory, renal, endocrine, nervous, GI — plus **PK/PD drug effects**.
Hemorrhage, tension pneumothorax, drug administration, ventilator settings.

**The catch:** it is C++. Runs 5–10× real time, and initialization takes *several
minutes* unless you load a pre-computed state. The C# API targets WebGL via Unity
— **there is no official JavaScript/WASM module.** Dropping it into a React app
is not a thing you can do.

**The clean resolution — pre-compute, don't embed:**

```
Laravel queued job → run Pulse for scenario X → export time-series
  → store as a deck asset (JSON/CSV)  → client plays it back offline
```

The *simulation* is online and server-side; the *playback* is offline and free.
Same split as AI card generation in Phase 10. A scenario becomes a deck asset that
students scrub through, with cards keyed to moments in the trace.

Do this only once scenario-based cards are a proven want. It is a phase, not an
afternoon.

---

## Tier 4 — Real recordings instead of simulation · *cheapest high-value win*

For "read this rhythm strip", **real waveforms beat simulated ones** and cost
nothing to produce.

[**PhysioNet**](https://physionet.org/) — 50+ open databases, 4 TB of ECG, EEG,
EMG, PPG, arterial blood pressure and respiration recordings. Open databases are
**ODC-BY** (attribution only); *some* databases are credentialed-access — check
per database, and use only the open ones.

Also on PhysioNet: [ECG waveform generator](https://physionet.org/content/ecgwavegen/)
(synthetic ECG, MATLAB/Octave — port the algorithm, it is small) and ECG-Kit.

**Arrhythmia recognition decks built from real PhysioNet strips are a killer
medical feature and need no simulation engine at all.**

---

## Not recommended

| Tool | Why not |
|---|---|
| [openCARP](https://opencarp.org/) | Cardiac EP simulator, but **free for academic purposes** — not a permissive commercial license |
| SimVascular | Blood-flow CFD; research-grade, hours per run, not interactive |
| Chaste | BSD and excellent, but a C++ tissue-simulation library — same embedding problem as Pulse with less payoff here |

---

## Recommendation

1. **Tier 1 + Tier 4 in the 3D phase.** Baked animations plus real PhysioNet
   waveforms. Both offline, both nearly free, both immediately useful.
2. **Tier 2 as its own small phase.** ~1 week for a sim card kind plus three or
   four models. The highest learning-value-per-line in the whole plan, and it is
   plain TypeScript in `packages/core`, so React Native gets it for free.
3. **Tier 3 only on demand.** Apache 2.0 means it stays available; pre-computed
   traces mean you never have to embed it.

**Licensing:** Pulse Apache 2.0 ✓ · CellML/Physiome models — per-model, mostly
open ✓ · PhysioNet open databases ODC-BY ✓ (credentialed ones ✗) · openCARP
academic-only ✗.
