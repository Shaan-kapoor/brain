"""Named internal structures, by registering labelled atlases onto the scan.

Two Harvard-Oxford atlases are warped on with ANTs SyN:

  sub-maxprob-thr25-1mm   white matter, deep grey nuclei, ventricles, brainstem
  cort-maxprob-thr25-1mm  48 cortical regions, grouped here into lobes

Together with the cerebellum (derived as the labelled-nothing remainder) they
account for essentially the whole brain, which the subcortical atlas alone
does not - it leaves the entire cortex unnamed.

Rather than inventing region boundaries, every named part traces back to a
published atlas. Cross-modality note: the atlas template is T1-weighted and
this scan is SWI, so registration is driven by mutual information on
brain-extracted volumes. Always eyeball build/qc_deep_slices.png.
"""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import nibabel as nib
from scipy import ndimage

sys.path.insert(0, str(Path(__file__).parent))
import common as C

BUILD = Path(__file__).resolve().parents[1] / "build"
ISO = 0.8

# Harvard-Oxford subcortical label -> (output name, colour)
SUBCORTICAL = {
    "Left Cerebral White Matter":  ("white_matter", (226, 226, 232)),
    "Right Cerebral White Matter": ("white_matter", (226, 226, 232)),
    "Left Lateral Ventricle":      ("ventricles", (90, 170, 255)),
    "Right Lateral Ventricle":     ("ventricles", (90, 170, 255)),
    "Brain-Stem":                  ("brainstem", (240, 180, 90)),
    "Left Thalamus":               ("thalamus", (250, 130, 160)),
    "Right Thalamus":              ("thalamus", (250, 130, 160)),
    "Left Hippocampus":            ("hippocampus", (150, 220, 130)),
    "Right Hippocampus":           ("hippocampus", (150, 220, 130)),
    "Left Caudate":                ("caudate", (200, 150, 250)),
    "Right Caudate":               ("caudate", (200, 150, 250)),
    "Left Putamen":                ("putamen", (255, 200, 90)),
    "Right Putamen":               ("putamen", (255, 200, 90)),
    "Left Pallidum":               ("pallidum", (255, 150, 80)),
    "Right Pallidum":              ("pallidum", (255, 150, 80)),
    "Left Amygdala":               ("amygdala", (250, 110, 110)),
    "Right Amygdala":              ("amygdala", (250, 110, 110)),
    "Left Accumbens":              ("accumbens", (255, 120, 200)),
    "Right Accumbens":             ("accumbens", (255, 120, 200)),
}

# Cortical region name -> lobe. Ordered: the first matching fragment wins, so
# the compound names ("temporal occipital fusiform") must precede the plain
# ones ("occipital") or they would be filed under the wrong lobe.
LOBE_RULES = [
    ("insular", "insula"),
    ("cingulate", "cingulate"),          # also catches paracingulate
    ("temporal occipital fusiform", "temporal"),
    ("temporooccipital", "temporal"),
    ("occipital fusiform", "occipital"),
    ("parietal opercular", "parietal"),
    ("central opercular", "frontal"),
    ("frontal operculum", "frontal"),
    ("precuneous", "parietal"),
    ("postcentral", "parietal"),
    ("superior parietal", "parietal"),
    ("supramarginal", "parietal"),
    ("angular", "parietal"),
    ("precentral", "frontal"),
    ("juxtapositional", "frontal"),
    ("subcallosal", "frontal"),
    ("frontal", "frontal"),
    ("parahippocampal", "temporal"),
    ("heschl", "temporal"),
    ("planum", "temporal"),
    ("temporal", "temporal"),
    ("lateral occipital", "occipital"),
    ("intracalcarine", "occipital"),
    ("supracalcarine", "occipital"),
    ("cuneal", "occipital"),
    ("lingual", "occipital"),
    ("occipital", "occipital"),
]

LOBE_COLOURS = {
    "frontal":   (104, 160, 255),
    "parietal":  (110, 220, 190),
    "temporal":  (255, 170, 100),
    "occipital": (215, 140, 250),
    "insula":    (250, 210, 110),
    "cingulate": (250, 130, 150),
}


def lobe_of(name):
    n = name.lower()
    for frag, lobe in LOBE_RULES:
        if frag in n:
            return lobe
    return None


def warp_atlas(ants, fixed, moving, atlas_img, transforms, out_path):
    lab_img = ants.image_read(str(atlas_img))
    warped = ants.apply_transforms(fixed=fixed, moving=lab_img,
                                   transformlist=transforms,
                                   interpolator="genericLabel")
    lab = warped.numpy().astype(np.int32)
    nib.save(nib.Nifti1Image(lab, nib.load(out_path[1]).affine), out_path[0])
    return lab


def main():
    import ants
    from nilearn import datasets

    sw = nib.load(BUILD / "swi_iso.nii.gz")
    vol = np.asarray(sw.dataobj).astype(np.float32)
    aff = sw.affine
    envelope = np.asarray(nib.load(BUILD / "brain_envelope.nii.gz").dataobj) > 0
    brain = np.asarray(nib.load(BUILD / "brain_mask.nii.gz").dataobj) > 0

    sub = vol * envelope
    sub = sub / (np.percentile(sub[envelope], 99) or 1.0)
    nib.save(nib.Nifti1Image(sub.astype(np.float32), aff), BUILD / "swi_brain.nii.gz")
    fixed = ants.image_read(str(BUILD / "swi_brain.nii.gz"))

    print("fetching atlases ...")
    ho_sub = datasets.fetch_atlas_harvard_oxford("sub-maxprob-thr25-1mm")
    ho_cort = datasets.fetch_atlas_harvard_oxford("cort-maxprob-thr25-1mm")
    sub_labels, cort_labels = list(ho_sub.labels), list(ho_cort.labels)
    print(f"  subcortical: {len(sub_labels)} labels, cortical: {len(cort_labels)} labels")

    cache_s, cache_c = BUILD / "deep_labels.nii.gz", BUILD / "cort_labels.nii.gz"
    if cache_s.exists() and cache_c.exists() and "--force" not in sys.argv:
        lab_s = np.asarray(nib.load(cache_s).dataobj).astype(np.int32)
        lab_c = np.asarray(nib.load(cache_c).dataobj).astype(np.int32)
        print("  reusing cached registration; pass --force to redo")
    else:
        mni = datasets.load_mni152_template(resolution=1)
        nib.save(mni, BUILD / "mni.nii.gz")
        for img, p in ((ho_sub.maps, BUILD / "atlas_sub.nii.gz"),
                       (ho_cort.maps, BUILD / "atlas_cort.nii.gz")):
            nib.save(img if hasattr(img, "get_fdata") else nib.load(img), p)
        moving = ants.image_read(str(BUILD / "mni.nii.gz"))
        print("registering atlas -> subject (SyN, a few minutes) ...")
        reg = ants.registration(fixed=fixed, moving=moving, type_of_transform="SyN",
                                aff_metric="mattes", syn_metric="mattes")
        t = reg["fwdtransforms"]
        lab_s = warp_atlas(ants, fixed, moving, BUILD / "atlas_sub.nii.gz", t,
                           (cache_s, BUILD / "swi_iso.nii.gz"))
        lab_c = warp_atlas(ants, fixed, moving, BUILD / "atlas_cort.nii.gz", t,
                           (cache_c, BUILD / "swi_iso.nii.gz"))

    groups = {}

    # ---- cortex, grouped into lobes -------------------------------------
    unmapped = []
    lobe_masks = {k: np.zeros(vol.shape, bool) for k in LOBE_COLOURS}
    for i, name in enumerate(cort_labels):
        if i == 0 or not name:
            continue
        lobe = lobe_of(name)
        if lobe is None:
            unmapped.append(name)
            continue
        lobe_masks[lobe] |= (lab_c == i)
    if unmapped:
        print(f"  ! cortical labels not assigned to a lobe: {unmapped}")
    for lobe, m in lobe_masks.items():
        if m.sum():
            groups[f"lobe_{lobe}"] = (m & brain, LOBE_COLOURS[lobe])

    # ---- subcortical -----------------------------------------------------
    for i, name in enumerate(sub_labels):
        if name not in SUBCORTICAL:
            continue
        out, colour = SUBCORTICAL[name]
        m = (lab_s == i)
        if m.sum() == 0:
            print(f"  ! {name}: empty after warp")
            continue
        prev = groups.get(out, (np.zeros(vol.shape, bool), colour))[0]
        groups[out] = (prev | m, colour)

    # White matter and cortex overlap at their border; the cortical atlas is
    # the more specific statement, so let it win.
    cortex_all = np.zeros(vol.shape, bool)
    for k, (m, _) in groups.items():
        if k.startswith("lobe_"):
            cortex_all |= m
    if "white_matter" in groups:
        wm, c = groups["white_matter"]
        groups["white_matter"] = (wm & ~cortex_all, c)

    # ---- cerebellum: the large unlabelled remainder ----------------------
    labelled = cortex_all.copy()
    for k, (m, _) in groups.items():
        labelled |= m
    leftover = brain & ~labelled
    core = C.largest_cc(ndimage.binary_erosion(leftover, C.ball(3)))
    cereb = C.fill_holes_3d(ndimage.binary_dilation(core, C.ball(3), mask=leftover))
    groups["cerebellum"] = (cereb, (130, 200, 235))

    # ---- write out -------------------------------------------------------
    overlays, covered = [], np.zeros(vol.shape, bool)
    print()
    for out, (m, colour) in sorted(groups.items()):
        m = C.drop_small(ndimage.binary_closing(m, C.ball(1)), 60)
        covered |= m
        print(f"  {out:<16} {m.sum():>8} vox  {m.sum() * ISO**3 / 1000:7.1f} cm3")
        nib.save(nib.Nifti1Image(m.astype(np.uint8), aff), BUILD / f"deep_{out}_mask.nii.gz")
        overlays.append((m, colour))

    pct = 100.0 * (covered & brain).sum() / brain.sum()
    print(f"\n  brain coverage by named structures: {pct:.1f}%")

    C.overlay_slices(vol, overlays, BUILD / "qc_deep_slices.png", n=6, axis=2)
    parts = []
    for out, (m, colour) in groups.items():
        v, f = C.mesh_from_mask(m, aff, presmooth=0.8)
        if len(f):
            parts.append((C.taubin_smooth(v, f, iterations=8), f, colour))
    if parts:
        C.render(parts, BUILD / "qc_deep.png")
    print(f"  wrote QC images to {BUILD}")


if __name__ == "__main__":
    main()
