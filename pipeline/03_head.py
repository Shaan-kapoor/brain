"""Outer head surface (scalp + face) from the SWI volume.

Two meshes come out of this:

  head.glb              - defaced, safe to publish
  head_identifiable.glb - the real face, git-ignored

A 3D face reconstructed from MRI is biometric data: it can be matched back to
a photograph of the person. The defaced version flattens everything in front
of the frontal lobe and below eye level, which removes nose, eyes, mouth and
chin while leaving the skull vault shape intact.
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

BUILD = Path(__file__).resolve().parents[1] / "build"
ISO = 0.8


def main():
    vol = np.asarray(nib.load(BUILD / "swi_iso.nii.gz").dataobj).astype(np.float32)
    aff = nib.load(BUILD / "swi_iso.nii.gz").affine
    brain = np.asarray(nib.load(BUILD / "brain_mask.nii.gz").dataobj) > 0

    # Outer silhouette: smooth hard so skin/fat/muscle merge into one solid.
    sm = ndimage.gaussian_filter(vol, 2.0 / ISO)
    head = sm > threshold_otsu(sm) * 0.42
    head = ndimage.binary_closing(head, C.ball(4))
    head = C.fill_holes_3d(head)
    head = C.largest_cc(head)
    print(f"  head mask: {head.sum()/1e6:.2f} M voxels")

    # world coordinates of every voxel index (nibabel affines are RAS+)
    idx = np.indices(head.shape).reshape(3, -1)
    world = (aff[:3, :3] @ idx + aff[:3, 3:4]).reshape(3, *head.shape)
    Y, Z = world[1], world[2]

    by, bz = world[1][brain], world[2][brain]
    y_front = by.max()      # anterior edge of the frontal lobe
    z_top = bz.max()        # vertex
    face = (Y > y_front - 5.0) & (Z < z_top - 45.0)
    print(f"  deface region: anterior of y={y_front-5:.0f} mm and below z={z_top-45:.0f} mm")

    defaced = head & ~face
    defaced = C.largest_cc(defaced)

    for tag, mask in (("head_identifiable", head), ("head", defaced)):
        nib.save(nib.Nifti1Image(mask.astype(np.uint8), aff), BUILD / f"{tag}_mask.nii.gz")
        v, f = C.mesh_from_mask(mask, aff, presmooth=1.2)
        v = C.taubin_smooth(v, f, iterations=14)
        print(f"  mesh[{tag}]: {len(v)} verts / {len(f)} tris")
        C.render([(v, f, (222, 196, 178))], BUILD / f"qc_{tag}.png")
    print(f"  wrote QC images to {BUILD}")


if __name__ == "__main__":
    main()
