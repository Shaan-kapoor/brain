"""Extract the arterial tree from the 3D time-of-flight MR angiogram.

Source: s3DI_MC, 0.34 x 0.34 x 0.75 mm, 276 slices - the highest resolution
volume in the whole dataset. It covers the neck up to the skull base, so this
gives the carotids, the vertebrals and the bottom of the circle of Willis.

TOF works by making flowing blood far brighter than stationary tissue, so no
network is needed: a high percentile threshold plus a shape filter is enough.
The one confounder is subcutaneous fat, which is also bright on TOF - it is
rejected here by keeping only components that run a long way head-to-foot,
which fat blobs never do and arteries always do.
"""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import nibabel as nib
from scipy import ndimage

sys.path.insert(0, str(Path(__file__).parent))
import common as C

ROOT = Path(__file__).resolve().parents[2]
NIFTI = ROOT / "raw files" / "nifti brain mri"
BUILD = Path(__file__).resolve().parents[1] / "build"
BUILD.mkdir(exist_ok=True)

MRA = NIFTI / "DICOM_s3DI_MC_20231007091140_902000.nii.gz"
ISO = 0.6            # mm - arteries are 2-6 mm across, so this is ample
PCT = 99.2           # brightness percentile that isolates flowing blood
MIN_VOXELS = 400     # kill speckle
MIN_Z_EXTENT = 25.0  # mm a component must span craniocaudally to count
MIN_DEPTH_MM = 14.0  # how far under the skin a voxel must sit
MAX_RADIUS_MM = 5.0  # arteries are thin tubes; fat slabs are not
MIN_LINEARITY = 0.62  # PCA elongation: tubes are linear, fat clumps are not
MAX_FLATNESS = 0.16   # second PCA axis vs first: rejects flat fat slabs


def body_envelope(vol, iso):
    """Solid outer silhouette of the head and neck.

    Thresholding raw tissue gives a speckled mask - muscle and bone fall below
    the cut and leave dark channels running out to the air, which destroys the
    distance transform. Smoothing hard first makes the interior solid, so what
    comes back really is 'inside the body'.
    """
    from skimage.filters import threshold_otsu
    sm = ndimage.gaussian_filter(vol, 3.0 / iso)
    body = sm > threshold_otsu(sm) * 0.40
    body = ndimage.binary_closing(body, C.ball(4))
    body = C.fill_holes_3d(body)
    return C.largest_cc(body)


def skin_depth(body, iso):
    """Distance (mm) from every voxel to the outside air.

    Computed on a half-resolution copy: the exact distance does not matter,
    only whether it clears ~1 cm, and the full-res EDT would need ~0.4 GB.
    """
    small = body[::2, ::2, ::2]
    d = ndimage.distance_transform_edt(small, sampling=iso * 2).astype(np.float32)
    return ndimage.zoom(d, np.array(body.shape) / np.array(small.shape), order=1)


def main():
    print(f"loading {MRA.name}")
    data, affine = C.load(MRA)
    vol, aff = C.resample_iso(data, affine, ISO)
    print(f"  resampled {data.shape} -> {vol.shape} at {ISO} mm isotropic")

    # Body mask -> how deep under the skin each voxel is. Subcutaneous fat is
    # as bright as flowing blood on TOF, but it only ever sits in a shallow
    # rim, so a depth test separates the two cleanly.
    body = body_envelope(vol, ISO)
    depth = skin_depth(body, ISO)
    deep = depth > MIN_DEPTH_MM
    print(f"  body envelope {body.sum()/1e6:.1f} M vox; {deep.sum()/1e6:.1f} M vox deeper "
          f"than {MIN_DEPTH_MM:.0f} mm")
    C.overlay_slices(vol, [(body, (60, 200, 255)), (deep, (255, 200, 60))],
                     BUILD / "qc_arteries_depth.png", n=6, axis=2)
    nib.save(nib.Nifti1Image(body.astype(np.uint8), aff), BUILD / "neck_body_mask.nii.gz")

    t = float(np.percentile(vol[vol > 0], PCT))
    print(f"  bright-blood threshold: >{t:.0f}")
    mask = (vol > t) & deep
    print(f"  bright AND deep:    {mask.sum()/1e3:.0f} k voxels")

    mask = C.drop_small(mask, MIN_VOXELS)
    lab, n = ndimage.label(mask)
    print(f"  {n} candidate components after size filter")

    # Keep long, thin, craniocaudally-running structures: real arteries.
    radius = ndimage.distance_transform_edt(mask, sampling=ISO).astype(np.float32)
    zdir = np.argmax(np.abs(aff[:3, :3][2]))     # index axis most aligned with +z
    step = abs(aff[2, zdir]) or ISO
    objs = ndimage.find_objects(lab)
    maxrad = ndimage.maximum(radius, lab, index=np.arange(1, n + 1))
    keep = np.zeros(n + 1, bool)
    for i, sl in enumerate(objs, start=1):
        if sl is None:
            continue
        extent = (sl[zdir].stop - sl[zdir].start) * step
        if extent < MIN_Z_EXTENT or maxrad[i - 1] > MAX_RADIUS_MM:
            continue
        # Elongation: covariance of the voxel cloud. A tube puts almost all of
        # its variance on one axis; a clump of fat spreads it over three.
        pts = np.argwhere(lab[sl] == i).astype(np.float32) * ISO
        pts -= pts.mean(0)
        ev = np.linalg.eigvalsh(np.cov(pts.T))
        linearity = ev[-1] / max(ev.sum(), 1e-6)
        # A flat slab of fat is elongated too, but along *two* axes. Demanding
        # the second axis be far smaller than the first keeps only tubes.
        flatness = ev[-2] / max(ev[-1], 1e-6)
        if linearity >= MIN_LINEARITY and flatness <= MAX_FLATNESS:
            keep[i] = True
    vessels = keep[lab]
    print(f"  kept {keep.sum()} vessel components -> {vessels.sum()/1e3:.0f} k voxels")

    vessels = ndimage.binary_closing(vessels, C.ball(1))
    nib.save(nib.Nifti1Image(vessels.astype(np.uint8), aff), BUILD / "arteries_mask.nii.gz")

    C.overlay_slices(vol, [(vessels, (255, 60, 60))], BUILD / "qc_arteries_slices.png",
                     n=6, axis=2)

    v, f = C.mesh_from_mask(vessels, aff, presmooth=0.7)
    v = C.taubin_smooth(v, f, iterations=8)
    print(f"  mesh: {len(v)} verts / {len(f)} tris")
    C.render([(v, f, (226, 72, 72))], BUILD / "qc_arteries.png")
    print(f"  wrote QC images to {BUILD}")


if __name__ == "__main__":
    main()
