"""Bring the angiogram into the same anatomical space as the brain.

The brain comes from the 12:16 BRAIN study and the arteries from the 09:11
C-SPINE study. Three hours apart means the subject got off the table and was
repositioned, so identical scanner coordinates do NOT mean identical anatomy -
without this step the carotid siphons sit centimetres away from the skull base
they are supposed to hug.

Fix: rigidly register the angiogram to the SWI over the slab where the two
overlap, then carry the artery mask through the same transform.
"""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import nibabel as nib

sys.path.insert(0, str(Path(__file__).parent))
import common as C

BUILD = Path(__file__).resolve().parents[1] / "build"
ROOT = Path(__file__).resolve().parents[2]
MRA = ROOT / "raw files" / "nifti brain mri" / "DICOM_s3DI_MC_20231007091140_902000.nii.gz"
ISO = 0.6


union_grid = C.union_grid


def main():
    import ants

    swi = nib.load(BUILD / "swi_iso.nii.gz")
    swi_v = np.asarray(swi.dataobj).astype(np.float32)

    data, affine = C.load(MRA)
    mra_v, mra_aff = C.resample_iso(data, affine, ISO)

    # z extent of each volume in world mm
    def zrange(shape, aff):
        idx = np.array(np.meshgrid(*[[0, s - 1] for s in shape], indexing="ij")).reshape(3, -1)
        w = aff[:3, :3] @ idx + aff[:3, 3:4]
        return w[2].min(), w[2].max()

    sz, mz = zrange(swi_v.shape, swi.affine), zrange(mra_v.shape, mra_aff)
    lo, hi = max(sz[0], mz[0]), min(sz[1], mz[1])
    print(f"  SWI z {sz[0]:.0f}..{sz[1]:.0f}   MRA z {mz[0]:.0f}..{mz[1]:.0f}   overlap {lo:.0f}..{hi:.0f}")

    # Restrict both to the overlapping slab so the non-shared neck / vertex
    # cannot drag the registration off.
    def zmask(vol, aff):
        idx = np.indices(vol.shape).reshape(3, -1)
        z = (aff[:3, :3] @ idx + aff[:3, 3:4])[2].reshape(vol.shape)
        return ((z >= lo) & (z <= hi)).astype(np.float32)

    f_v = swi_v * zmask(swi_v, swi.affine)
    m_v = mra_v * zmask(mra_v, mra_aff)
    f_v = f_v / (np.percentile(f_v[f_v > 0], 99) or 1)
    m_v = m_v / (np.percentile(m_v[m_v > 0], 99) or 1)

    nib.save(nib.Nifti1Image(f_v, swi.affine), BUILD / "_align_fixed.nii.gz")
    nib.save(nib.Nifti1Image(m_v, mra_aff), BUILD / "_align_moving.nii.gz")
    fixed = ants.image_read(str(BUILD / "_align_fixed.nii.gz"))
    moving = ants.image_read(str(BUILD / "_align_moving.nii.gz"))

    print("  registering angiogram -> SWI (rigid) ...")
    reg = ants.registration(fixed=fixed, moving=moving, type_of_transform="Rigid",
                            aff_metric="mattes")

    # Output grid: SWI orientation (so the arteries end up in the brain's
    # anatomical frame) but extended to cover the angiogram's full reach down
    # the neck. Warping straight into the SWI grid would crop the carotids at
    # the edge of the head FOV and throw away most of their length.
    ref_aff, ref_shape = union_grid(
        [(swi_v.shape, swi.affine), (mra_v.shape, mra_aff)], swi.affine, ISO)
    print(f"  output grid {ref_shape} at {ISO} mm")
    nib.save(nib.Nifti1Image(np.zeros(ref_shape, np.float32), ref_aff),
             BUILD / "_align_ref.nii.gz")
    ref = ants.image_read(str(BUILD / "_align_ref.nii.gz"))

    art = nib.load(BUILD / "arteries_mask.nii.gz")
    nib.save(nib.Nifti1Image(np.asarray(art.dataobj).astype(np.float32), art.affine),
             BUILD / "_align_artmask.nii.gz")
    am = ants.image_read(str(BUILD / "_align_artmask.nii.gz"))
    warped = ants.apply_transforms(fixed=ref, moving=am,
                                   transformlist=reg["fwdtransforms"],
                                   interpolator="nearestNeighbor")
    out = warped.numpy() > 0.5
    print(f"  arteries after warp: {out.sum()/1e3:.0f} k voxels (was "
          f"{(np.asarray(art.dataobj) > 0).sum()/1e3:.0f} k)")
    nib.save(nib.Nifti1Image(out.astype(np.uint8), ref_aff),
             BUILD / "arteries_aligned_mask.nii.gz")

    brain = np.asarray(nib.load(BUILD / "brain_mask.nii.gz").dataobj) > 0
    bv, bf = C.mesh_from_mask(brain, swi.affine, presmooth=0.9)
    av, af = C.mesh_from_mask(out, ref_aff, presmooth=0.7)
    C.render([(bv, bf, (150, 140, 135)), (av, af, (235, 60, 60))],
             BUILD / "qc_align.png")
    print(f"  wrote QC to {BUILD}")


if __name__ == "__main__":
    main()
