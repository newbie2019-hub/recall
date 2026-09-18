# 3D anatomy assets — sources, licensing, pipeline

Verdict on BodyParts3D: **yes, use it.** It is the right spine for the medical
vertical. Details below, plus four other sources worth pulling in.

---

## 1. Licensing — read this before downloading anything

**The live DBCLS license page states CC BY 4.0:**

> "BodyParts3D, © The Database Center for Life Science licensed under CC
> Attribution 4.0 International"
> — <https://dbarchive.biosciencedbc.jp/en/bodyparts3d/lic.html>

**But the per-release README (Release 3.0, 2013) still says CC BY-SA 2.1 Japan**,
and third-party mirrors repeat the old text. DBCLS relicensed; the mirrors did not
catch up.

Why this matters: **ShareAlike would force every mesh you convert, decimate or
re-bundle to be published under the same license.** CC BY 4.0 does not — you
attribute, and that is the whole obligation. That is the difference between "we
can ship optimized GLBs in our app" and "we must open-source our asset pipeline
output."

**Practical rules:**
1. Download from the **official DBCLS endpoint**, not a mirror. The license that
   binds you is the one on the page you got the files from.
2. Save a **dated PDF/screenshot of `lic.html`** into the repo alongside the
   assets. If the wording ever changes again you can show what you relied on.
3. Ship the **current attribution string** visibly in the 3D viewer UI.
4. The license page also says to contact DBCLS for uses not covered by it. They
   respond — **email them once, keep the reply.** One email now is cheaper than
   an argument later.
5. *This is a reading of a license page, not legal advice.* For a commercial
   marketplace, have someone qualified confirm it.

---

## 2. What you can actually download

| Source | Content | Format | Size | License |
|---|---|---|---|---|
| [DBCLS official](https://dbarchive.biosciencedbc.jp/en/bodyparts3d/download.html) | v4.0, IS-A tree and PART-OF tree | OBJ | 136 MB / 62 MB, **at 99% polygon reduction** | CC BY 4.0 per site |
| [`olivercase/body_parts_3d_api`](https://github.com/olivercase/body_parts_3d_api) | v4.3, **3,210 full-resolution meshes**, downloader + verifier, named subsets | OBJ via Git LFS | large | MIT code; restates the **old** SA text for meshes |
| [`ashemag/human-atlas`](https://github.com/ashemag/human-atlas) | 2,234 meshes already decimated, batched and web-ready | web bundle | **~33 MB** | MIT code |
| [`Kevin-Mattheus-Moerman/BodyParts3D`](https://github.com/Kevin-Mattheus-Moerman/BodyParts3D) | plain clone of the model files | OBJ | — | mirror |

The official archive only publishes the **99%-reduced** meshes. If a cardiology
deck needs a detailed heart, full resolution comes from the 4.3 set.

---

## 3. The thing that makes this scale: FMA IDs

BodyParts3D parts are keyed to **Foundational Model of Anatomy** concepts, and
the download page ships the **IS-A tree** and **PART-OF tree** as separate files.

Consequences, and this is the most important design point on the page:

- **A card references an `fma_id`, never a mesh filename.** Meshes are a rendering
  detail; the concept is the content. Re-decimate, switch source, add a better
  brain atlas — cards keep working.
- **The PART-OF tree generates nested decks for free.** "Cardiovascular system" →
  subdecks → structures, straight out of the ontology. That is thousands of
  well-organized cards with no authoring.
- **It is the join key across every other source below**, and across languages.

Store `fma_id` on the card from day one, even before the 3D viewer exists.

---

## 4. Other sources worth including

| Source | License | What it adds | Priority |
|---|---|---|---|
| [Open Anatomy / SPL](https://www.openanatomy.org/atlas-pages/) (Brigham & Women's) | open access, **verify per atlas** | MRI-derived atlases: **SPL/NAC brain with 300+ structures**, head & neck, inner ear, abdomen. Already renders via three.js | **High** — BodyParts3D's brain is only ~64 meshes. Neuroanatomy is where medical students suffer most, so this is the highest-value addition |
| [NIH 3D](https://3d.nih.gov/) | CC or public domain | Pathology, anatomical variants, organs, molecular models. STL / VRML / X3D / Blender | **Medium** — pathology decks, which no flashcard app has |
| [Z-Anatomy](https://github.com/Z-Anatomy) | **CC BY-SA** | BodyParts3D-derived with far better labelling, multilingual names, Blender source | **Labels only.** SA is contagious — mine it for naming/translations, do not bake its geometry into your bundles |
| [AnatomyTOOL Open3Dmodel](https://anatomytool.org/open3dmodel) | index, filterable | Discovery layer over many licensed collections | Low — use to find things |
| Smithsonian 3D / Scan the World | CC0 | Some skeletal material, mostly cultural | Low |

**Recommended combination:** BodyParts3D as the whole-body spine (CC BY 4.0,
FMA-keyed) + Open Anatomy for brain and head/neck + NIH 3D for pathology.
Z-Anatomy for naming only.

---

## 5. Asset pipeline

```
OBJ (BodyParts3D 4.3, full-res)
  → decimate per target LOD
  → merge by system, keep per-mesh submesh IDs for picking
  → glTF/GLB + Draco or Meshopt compression
  → one GLB per system layer, plus per-deck subset bundles
```

- No textures in BodyParts3D — meshes only. That keeps GLBs small; no KTX2 needed.
- Keep **per-structure picking** working through the merge (human-atlas does this
  with per-structure GPU textures driving visibility and selection).
- Build it as a **repeatable script**, not a one-off. You will re-run it when a
  deck needs higher detail on one organ.

### Named subsets solve the offline problem

`body_parts_3d_api` ships built-in groups — brain (64), heart (3), lungs (18),
gut (61), spine (24), vagus nerve (2). Map these directly onto **per-deck asset
bundles**:

> A cardiology deck downloads 3 heart meshes, not a 33 MB whole body.

This is exactly the per-deck offline opt-in already in `PLAN.md §0`, and it turns
the 3D feature from an offline liability into a non-issue. **Never ship the whole
atlas as a prerequisite for one deck.**

---

## 6. What this changes in the plan

- 3D is **cheaper and lower-risk** than assumed: permissive license, FMA ontology,
  a web-ready reference implementation on your exact stack, and subsets that fit
  the offline model.
- The FMA-ID decision is **not deferrable** — it belongs in the Phase 0 schema
  even though the 3D phase is post-launch. Adding a column now is free;
  retrofitting every card later is not.
- Worth reconsidering the deferral. The ontology-generated nested decks alone
  (thousands of structured cards, no authoring) are a content moat on day one.
