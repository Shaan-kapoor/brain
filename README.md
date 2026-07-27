# brain

An interactive 3D model of my own brain, reconstructed from a diagnostic MRI
taken on 2023-10-07 (Philips Achieva 1.5 T), and a small web viewer for it.

![The viewer](docs/viewer-brain.png)

| Deep structures | Cross-section |
|---|---|
| ![deep](docs/viewer-deep.png) | ![section](docs/viewer-section.png) |

## What is in the model

Twenty separately selectable parts, covering **95.4% of the brain by volume**:

| Part | Source series | Method |
|---|---|---|
| Brain surface | SWI / VEN_BOLD, 0.60 × 0.60 × 1.50 mm | threshold + morphology |
| Frontal, parietal, temporal, occipital lobes, cingulate, insula | SWI | Harvard-Oxford **cortical** atlas (48 regions) grouped into lobes |
| Cerebral white matter | SWI | Harvard-Oxford subcortical |
| Ventricles, brainstem, thalamus, caudate, putamen, pallidum, hippocampus, amygdala, accumbens | SWI | Harvard-Oxford subcortical |
| Cerebellum | derived | brain minus everything the atlases label |
| Arteries | 3D TOF MRA, 0.34 × 0.34 × 0.75 mm | bright-blood threshold + shape filters |
| Head / scalp | SWI + T1 sagittal | fused outer silhouette, **defaced** |

The subcortical atlas alone leaves the entire cortex — most of the brain —
unnamed, which is why the cortical atlas is warped on as well.

## What is measured and what is inferred

Worth being precise about, because the parts are not equally trustworthy.

**Measured from the scan.** The brain surface, the arteries and the head. Every
vertex traces back to voxel intensities in the DICOM.

**Positioned from the scan, shaped by an atlas.** Every named region — the
lobes, white matter, and all the deep nuclei — are Harvard-Oxford atlas
structures elastically warped onto this brain. Their *location* is inferred
from this anatomy; their *shape* is substantially inherited from the template.
The volumes quoted for them are therefore closer to "the atlas's structure
after warping" than to an independent measurement of this subject. Treat them
as well-placed labels, not as morphometry. Lobe boundaries in particular are a
convention, not a visible feature of the tissue.

**Derived by subtraction.** The cerebellum is whatever the atlas did not label
inside the brain mask. At 105.7 cm³ against a normal 120–160 cm³ it is
probably under-segmented.

**Invented outright.** Every colour. And the smoothing: Taubin smoothing plus
the pre-mesh blur genuinely move the surface, so this is a smoothed likeness,
not a millimetre-exact cast.

The measured volumes do land in normal adult ranges (brain 1173 cm³,
ventricles 11 cm³, brainstem 28 cm³), which is the main sanity check that the
segmentation is not wildly off.

## Running the viewer

```bash
npm install     # three.js only
npm run serve   # http://localhost:8080
```

It must be served over http — ES modules and `fetch()` do not work from
`file://`.

**Controls:** drag to orbit, scroll to zoom (you can fly right inside the
brain), click a structure to draw a leader line out to a card explaining what
it does, double-click it to focus.

**Layers** are chips rather than switches. Click one to toggle it,
double-click to isolate it, hover to highlight it in 3D. The **Views** row at
the top sets whole scenes in one click — *Whole brain*, *Lobes*, *Deep*,
*Vessels*, *Everything*, *Clear* — because arranging twenty chips by hand to
reach a sensible view is tedious and the useful combinations are predictable.
*Deep* also fades the cortex automatically, since the structures it shows are
otherwise hidden inside it.

`L / R brain` explains hemispheric specialisation. The cross-section buttons
cut a sagittal, axial or coronal plane through everything at once.

### Performance

`npm run bench` drives the viewer with a real GPU and reports frame times,
draw calls and picking cost. Measured on an AMD Radeon integrated GPU at
1600×950:

| Scene | Before | After |
|---|---|---|
| Brain only | 59.9 fps | 59.9 fps (vsync cap) |
| Default (brain + arteries) | 59.9 fps | 59.9 fps (vsync cap) |
| Lobes | — | 59.9 fps |
| Deep | — | 59.9 fps |
| Everything on | 28.6 fps | **59.9 fps** |
| Everything, close-up | 14.5 fps | **48.3 fps** |
| Raycast per pick | 43.4 ms | **0.427 ms** |

"After" is measured with twenty parts and 1.4 M triangles on screen — roughly
double the geometry of the "before" column, which had eleven.

Not one triangle was removed. The wins came from:

- **A BVH for picking** (`three-mesh-bvh`). Hover raycasting was testing every
  triangle of every visible mesh on every `pointermove` — 1.3 M triangles per
  event. Raycasts are also now coalesced to one per frame and skipped entirely
  mid-drag.
- **Only marking materials `transparent` when they actually are.** Everything
  was permanently in the sorted blend pass, giving up early-Z across eleven
  nested shells. Opaque parts now render opaque.
- **Dropping clearcoat and sheen once a shell goes below 50% opacity.** A
  second specular lobe you cannot see through a 22%-opaque surface is pure
  cost; and `MeshStandardMaterial` for the scalp, which is a full-screen
  near-transparent shell.
- **Adaptive resolution.** Framebuffer scale steps down to 0.72 when frame
  time is sustained above 24 ms and recovers when it drops. Pixels only —
  geometry and materials are never touched.

**One optimisation was tried and reverted.** Switching to `FrontSide` to let
the GPU cull backfaces looked like free performance and measured well (60 fps
with everything on, 42 fps close-up). It also punched visible holes straight
through the cortex: these meshes come from marching cubes on a non-watertight
mask, their triangle winding is mixed, and `trimesh.fix_normals()` cannot
orient a mesh that is not watertight. `side` is pinned to `DoubleSide` with a
comment saying so. Making the meshes watertight and consistently oriented in
the pipeline would unlock it properly — that is the real fix, not a renderer
flag.

### About the descriptions

The functional summaries in `web/anatomy.json` are standard textbook
neuroanatomy, written to be readable rather than exhaustive — they describe
what each structure characteristically does, not what this particular brain
does. The hemispheres card deliberately includes the "left-brained /
right-brained personality" myth, because functional lateralisation is real and
the personality claim built on top of it is not.

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

**No single series covers the whole head.** The SWI is 233 mm wide but its
field of view cuts straight through the face; the sagittal T1 has the entire
face profile and chin but is only 144 mm across. `03_head.py` unions the two
silhouettes — same session, so they already share a coordinate frame. The
profile is faithful; front-on, the face is squared off at the edges of the
sagittal slab, and its 5.3 mm slice spacing shows as fine terracing across the
cheeks. Neither is fixable without a scan that was acquired for the purpose.

## Privacy

The source DICOM carries full patient identifiers (name, ID, date of birth,
institution) and lives **outside this repository** on purpose, with `.gitignore`
as a second line of defence.

A 3D face reconstructed from MRI is biometric data — it can be matched against
a photograph. **The head model is therefore defaced by default**: everything in
front of the frontal lobe and below eye level is flattened away, leaving the
vault and the back of the head. That is the only head mesh the viewer loads and
the only one in this repo.

The unmodified version is opt-in via `python pipeline/03_head.py --keep-face`,
which writes `build/head_identifiable_mask.nii.gz`. That path is git-ignored,
`05_export.py` never reads it, and no `.glb` is produced from it — so the real
face cannot reach the web build by accident.

Not a diagnostic tool. Nothing here has been read by a radiologist.
