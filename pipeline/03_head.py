"""Outer head surface (scalp + face) from the SWI volume.

By default the face is removed: everything in front of the frontal lobe and
below eye level is flattened away, leaving the skull vault and the back of the
head intact. That defaced mesh is the only one the viewer ever loads.

A 3D face reconstructed from MRI is biometric data - it can be matched back to
a photograph - so the unmodified version is opt-in. Pass --keep-face to write
`head_identifiable_mask.nii.gz` alongside it. That file stays in build/, is
git-ignored, and is never exported to web/models.
"""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import nibabel as nib
from scipy import ndimage
from skimage.filters import threshold_otsu

sys.path.insert(0, str(Path(__file__).parent))
import common as C

ROOT = Path(__file__).resolve().parents[2]
NIFTI = ROOT / "raw files" / "nifti brain mri"
BUILD = Path(__file__).resolve().parents[1] / "build"
ISO = 0.8

# Neither brain series covers the whole head on its own:
#   SWI    - full width (233 mm), but its FOV cuts through the face and jaw
#   T1 sag - the entire face profile and chin, but only 144 mm wide (27 slices)
# Both come from the same 12:16 session, so they share a coordinate frame and
# their head masks can simply be unioned. The SWI supplies the sides and vault,
# the sagittal T1 supplies the face.
SWI_ISO = BUILD / "swi_iso.nii.gz"
T1SAG = NIFTI / "DICOM_T1Sag_SE_20231007121641_502000.nii.gz"


def silhouette(vol, iso):
    """Solid outer skin surface: smooth hard so skin/fat/muscle merge."""
    sm = ndimage.gaussian_filter(vol, 2.0 / iso)
    m = sm > threshold_otsu(sm) * 0.42
    m = ndimage.binary_closing(m, C.ball(4))
    m = C.fill_holes_3d(m)
    return C.largest_cc(m)


def main():
    swi_img = nib.load(SWI_ISO)
    swi_v = np.asarray(swi_img.dataobj).astype(np.float32)
    brain_src = np.asarray(nib.load(BUILD / "brain_mask.nii.gz").dataobj) > 0

    t1_v, t1_aff0 = C.load(T1SAG)

    aff, shape = C.union_grid(
        [(swi_v.shape, swi_img.affine), (t1_v.shape, t1_aff0)], swi_img.affine, ISO)
    print(f"  fused grid {shape} at {ISO} mm")

    a = C.resample_to(swi_v, swi_img.affine, aff, shape)
    b = C.resample_to(t1_v, t1_aff0, aff, shape)
    head_a, head_b = silhouette(a, ISO), silhouette(b, ISO)
    print(f"  SWI silhouette {head_a.sum()/1e6:.2f} M vox · "
          f"T1-sag silhouette {head_b.sum()/1e6:.2f} M vox")

    head = head_a | head_b
    head = ndimage.binary_closing(head, C.ball(3))
    head = C.fill_holes_3d(head)
    head = C.largest_cc(head)
    print(f"  fused head mask: {head.sum()/1e6:.2f} M voxels")

    vol = np.maximum(a, b)
    brain = C.resample_to(brain_src.astype(np.float32), swi_img.affine,
                          aff, shape, order=0) > 0.5

    if "--keep-face" in sys.argv:
        # Opt-in only, and it stops here: build/ is git-ignored and 05_export
        # never reads this file, so the real face cannot reach the web build.
        nib.save(nib.Nifti1Image(head.astype(np.uint8), aff),
                 BUILD / "head_identifiable_mask.nii.gz")
        print("  --keep-face: wrote head_identifiable_mask.nii.gz (local only)")

    # world coordinates of every voxel index (nibabel affines are RAS+)
    idx = np.indices(head.shape).reshape(3, -1)
    world = (aff[:3, :3] @ idx + aff[:3, 3:4]).reshape(3, *head.shape)
    Y, Z = world[1], world[2]
    y_front, z_top = world[1][brain].max(), world[2][brain].max()
    face = (Y > y_front - 5.0) & (Z < z_top - 45.0)
    print(f"  defacing: anterior of y={y_front-5:.0f} mm, below z={z_top-45:.0f} mm")
    head = C.largest_cc(head & ~face)

    nib.save(nib.Nifti1Image(head.astype(np.uint8), aff), BUILD / "head_mask.nii.gz")
    v, f = C.mesh_from_mask(head, aff, presmooth=1.2)
    v = C.taubin_smooth(v, f, iterations=14)
    print(f"  mesh: {len(v)} verts / {len(f)} tris")
    C.render([(v, f, (222, 196, 178))], BUILD / "qc_head.png")
    print(f"  wrote QC images to {BUILD}")


if __name__ == "__main__":
    main()
