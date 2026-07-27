"""Named internal structures, by registering a labelled atlas onto the scan.

This is the step that makes the model *clickable by anatomy* rather than just
a single blob. Rather than inventing region boundaries, an established atlas
(Harvard-Oxford, distributed with FSL/nilearn) is warped onto this brain with
ANTs SyN, and the labels come along for the ride. That keeps the anatomy
honest: every named part traces back to a published atlas, not to a guess.

Cross-modality note: the atlas template is T1-weighted and this scan is SWI,
so registration is driven by mutual information on brain-extracted volumes.
Always eyeball build/qc_deep_slices.png before trusting the labels.
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

# Harvard-Oxford subcortical label name -> (output name, colour)
WANTED = {
    "Left Lateral Ventricle":  ("ventricles", (90, 170, 255)),
    "Right Lateral Ventricle": ("ventricles", (90, 170, 255)),
    "Brain-Stem":              ("brainstem", (240, 180, 90)),
    "Left Thalamus":           ("thalamus", (250, 130, 160)),
    "Right Thalamus":          ("thalamus", (250, 130, 160)),
    "Left Hippocampus":        ("hippocampus", (150, 220, 130)),
    "Right Hippocampus":       ("hippocampus", (150, 220, 130)),
    "Left Caudate":            ("caudate", (200, 150, 250)),
    "Right Caudate":           ("caudate", (200, 150, 250)),
    "Left Putamen":            ("putamen", (255, 200, 90)),
    "Right Putamen":           ("putamen", (255, 200, 90)),
    "Left Amygdala":           ("amygdala", (250, 110, 110)),
    "Right Amygdala":          ("amygdala", (250, 110, 110)),
}


def main():
    import ants
    from nilearn import datasets

    sw = nib.load(BUILD / "swi_iso.nii.gz")
    vol = np.asarray(sw.dataobj).astype(np.float32)
    aff = sw.affine
    brain = np.asarray(nib.load(BUILD / "brain_envelope.nii.gz").dataobj) > 0

    # Brain-extracted, intensity-normalised subject volume = registration target
    sub = vol * brain
    sub = sub / (np.percentile(sub[brain], 99) or 1.0)
    nib.save(nib.Nifti1Image(sub.astype(np.float32), aff), BUILD / "swi_brain.nii.gz")
    fixed = ants.image_read(str(BUILD / "swi_brain.nii.gz"))

    print("fetching atlas ...")
    ho = datasets.fetch_atlas_harvard_oxford("sub-maxprob-thr25-1mm")
    labels = list(ho.labels)
    print(f"  atlas: {len(labels)} labels")

    cached = BUILD / "deep_labels.nii.gz"
    if cached.exists() and "--force" not in sys.argv:
        # SyN takes several minutes; reuse it unless explicitly asked not to.
        lab = np.asarray(nib.load(cached).dataobj).astype(np.int32)
        print(f"  reusing cached registration ({cached.name}); pass --force to redo")
    else:
        mni = datasets.load_mni152_template(resolution=1)
        atlas_img = ho.maps if hasattr(ho.maps, "get_fdata") else nib.load(ho.maps)
        nib.save(mni, BUILD / "mni.nii.gz")
        nib.save(atlas_img, BUILD / "atlas_labels.nii.gz")
        moving = ants.image_read(str(BUILD / "mni.nii.gz"))
        lab_img = ants.image_read(str(BUILD / "atlas_labels.nii.gz"))

        print("registering atlas -> subject (SyN, this takes a few minutes) ...")
        reg = ants.registration(fixed=fixed, moving=moving, type_of_transform="SyN",
                                aff_metric="mattes", syn_metric="mattes")
        warped = ants.apply_transforms(fixed=fixed, moving=lab_img,
                                       transformlist=reg["fwdtransforms"],
                                       interpolator="genericLabel")
        lab = warped.numpy().astype(np.int32)
        nib.save(nib.Nifti1Image(lab, aff), cached)
        warped_t1 = ants.apply_transforms(fixed=fixed, moving=moving,
                                          transformlist=reg["fwdtransforms"])
        nib.save(nib.Nifti1Image(warped_t1.numpy(), aff), BUILD / "mni_in_subject.nii.gz")
    print(f"  labels in subject space: {np.count_nonzero(lab)/1e3:.0f} k voxels")

    groups, overlays = {}, []
    for i, name in enumerate(labels):
        if name not in WANTED:
            continue
        out, colour = WANTED[name]
        m = (lab == i)
        if m.sum() == 0:
            print(f"  ! {name}: empty after warp")
            continue
        groups.setdefault(out, (np.zeros_like(m), colour))
        groups[out] = (groups[out][0] | m, colour)

    # Harvard-Oxford subcortical has no cerebellum label, but it does label
    # everything else inside the brain (cerebral cortex, cerebral white matter,
    # ventricles, subcortical nuclei, brainstem). So the one large unlabelled
    # blob left inside the brain mask is the cerebellum. Eroding first drops
    # the thin unlabelled CSF rim that hugs the whole surface.
    brain_tissue = np.asarray(nib.load(BUILD / "brain_mask.nii.gz").dataobj) > 0
    leftover = brain_tissue & (lab == 0)
    core = C.largest_cc(ndimage.binary_erosion(leftover, C.ball(3)))
    cereb = ndimage.binary_dilation(core, C.ball(3), mask=leftover)
    cereb = C.fill_holes_3d(cereb)
    groups["cerebellum"] = (cereb, (130, 200, 235))
    print(f"  cerebellum derived: {cereb.sum() * ISO**3 / 1000:.1f} cm3 "
          f"(normal adult is roughly 120-160 cm3)")

    for out, (m, colour) in groups.items():
        m = ndimage.binary_closing(m, C.ball(1))
        m = C.drop_small(m, 60)
        vol_cm3 = m.sum() * ISO ** 3 / 1000
        print(f"  {out:<12} {m.sum():>7} vox  {vol_cm3:6.1f} cm3")
        nib.save(nib.Nifti1Image(m.astype(np.uint8), aff), BUILD / f"deep_{out}_mask.nii.gz")
        overlays.append((m, colour))

    C.overlay_slices(vol, overlays, BUILD / "qc_deep_slices.png", n=6, axis=2)

    parts = []
    for out, (m, colour) in groups.items():
        v, f = C.mesh_from_mask(m, aff, presmooth=0.8)
        if len(f):
            v = C.taubin_smooth(v, f, iterations=10)
            parts.append((v, f, colour))
    if parts:
        C.render(parts, BUILD / "qc_deep.png")
    print(f"  wrote QC images to {BUILD}")


if __name__ == "__main__":
    main()
