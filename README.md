# brain

An interactive 3D model of my own brain, reconstructed from a diagnostic MRI
taken on 2023-10-07 (Philips Achieva 1.5 T), and a small web viewer for it.

![The viewer](docs/viewer-brain.png)

| Deep structures | Cross-section |
|---|---|
| ![deep](docs/viewer-deep.png) | ![section](docs/viewer-section.png) |

## What is in the model

| Part | Source series | Method |
|---|---|---|
| Brain surface | SWI / VEN_BOLD, 0.60 × 0.60 × 1.50 mm | threshold + morphology |
| Arteries | 3D TOF MRA, 0.34 × 0.34 × 0.75 mm | bright-blood threshold + shape filters |
| Cerebellum | derived | brain minus all atlas-labelled cerebrum |
| Ventricles, brainstem, thalamus, hippocampus, caudate, putamen, amygdala | SWI | Harvard-Oxford atlas warped on with ANTs SyN |
| Head / scalp | SWI | outer silhouette, **defaced** |

Reported volumes land in normal adult ranges (brain 1173 cm³, ventricles
11 cm³, thalamus 14 cm³, brainstem 28 cm³), which is the main sanity check
that the segmentation is not wildly off.

## Running the viewer

```bash
npm install     # three.js only
npm run serve   # http://localhost:8080
```

It must be served over http — ES modules and `fetch()` do not work from
`file://`.

**Controls:** drag to orbit, scroll to zoom, click a structure to identify it,
click a layer row to toggle it. `＋ place pin` then click the model to drop a
labelled marker; `export` downloads `pins.json`, which you can drop back into
`web/` to make the pins permanent. The cross-section buttons cut a sagittal,
axial or coronal plane through everything at once.

## Rebuilding from the raw scan

The DICOM is deliberately **not** in this repo (see below). Point the scripts
at a folder of dcm2niix output and run them in order:

```bash
python pipeline/01_brain.py           # brain mask + cortical surface
python pipeline/02_arteries.py        # arterial tree from the angiogram
python pipeline/02b_align_arteries.py # rigid registration onto the brain scan
python pipeline/03_head.py            # scalp surface + defaced variant
python pipeline/04_deep.py            # atlas registration -> named structures
python pipeline/05_export.py          # decimate + write GLB and manifest.json
```

Requires `numpy scipy scikit-image nibabel trimesh fast-simplification antspyx nilearn`.
Every script writes a QC image into `build/` — look at those, not just the
console output. `04_deep.py` caches its registration; pass `--force` to redo it.

### Two things worth knowing

**The brain and the arteries come from different studies.** The angiogram was
acquired at 09:11 and the brain scan at 12:16, with the subject repositioned in
between, so identical scanner coordinates do not mean identical anatomy.
`02b_align_arteries.py` rigidly registers one onto the other; without it the
carotid siphons float centimetres away from the skull base.

**There is no 3D T1 in this scan.** Clinical brain protocols use 5 mm slices,
which cannot make a surface. The SWI series happens to be 1.5 mm and is the
only reason any of this works. The cortical detail here is therefore softer
than a FreeSurfer reconstruction from a research MPRAGE — that is a limit of
the source data, not of the pipeline.

## Privacy

The source DICOM carries full patient identifiers (name, ID, date of birth,
institution) and lives **outside this repository** on purpose, with `.gitignore`
as a second line of defence.

A 3D face reconstructed from MRI is biometric data — it can be matched against
a photograph. `03_head.py` therefore writes two meshes: `head.glb`, which has
the face flattened away and is what the viewer loads, and
`head_identifiable.glb`, which is git-ignored and never leaves the machine.

Not a diagnostic tool. Nothing here has been read by a radiologist.
