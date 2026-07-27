"""Extract the brain (cortical surface) from the SWI / VEN_BOLD volume.

Why SWI: it is the only near-3D brain acquisition in this dataset
(0.60 x 0.60 x 1.50 mm, 101 slices). Every other brain series is 5 mm thick
slices, which cannot produce a usable surface.

No neural network is needed here. On SWI the skull is a dark shell that
already separates brain from scalp, so threshold + morphology is enough - the
morphological opening severs the few remaining bridges, and a constrained
dilation puts the gyral detail back.
"""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import nibabel as nib
from scipy import ndimage
from skimage.filters import threshold_multiotsu

sys.path.insert(0, str(Path(__file__).parent))
import common as C

ROOT = Path(__file__).resolve().parents[2]
NIFTI = ROOT / "raw files" / "nifti brain mri"
BUILD = Path(__file__).resolve().parents[1] / "build"
BUILD.mkdir(exist_ok=True)

SWI = NIFTI / "DICOM_VEN_BOLD_(SWI)_20231007121641_702000.nii.gz"
ISO = 0.8  # mm

def main():
    print(f"loading {SWI.name}")
    data, affine = C.load(SWI)
    vol, aff = C.resample_iso(data, affine, ISO)
    print(f"  resampled {data.shape} -> {vol.shape} at {ISO} mm isotropic")
    nib.save(nib.Nifti1Image(vol, aff), BUILD / "swi_iso.nii.gz")

    th = threshold_multiotsu(vol, classes=4)
    t_head, t_brain = float(th[0]), float(th[1])
    print(f"  otsu thresholds: head>{t_head:.0f}  brain>{t_brain:.0f}")

    raw = vol > t_brain
    print(f"  raw threshold mask: {raw.sum()/1e6:.2f} M voxels")

    # Sever scalp/orbit bridges, keep the biggest blob = brain.
    core = ndimage.binary_erosion(raw, C.ball(4))
    core = C.largest_cc(core)
    print(f"  eroded core:        {core.sum()/1e6:.2f} M voxels")

    # Grow back into the thresholded tissue to recover gyri, but only a bounded
    # distance so it cannot flood through the skull into the scalp.
    envelope = ndimage.binary_dilation(core, C.ball(4), mask=raw)
    envelope = ndimage.binary_closing(envelope, C.ball(4))
    envelope = C.fill_holes_3d(envelope)
    envelope = C.largest_cc(envelope)
    print(f"  brain envelope:     {envelope.sum()/1e6:.2f} M voxels "
          f"({envelope.sum() * ISO**3 / 1000:.0f} cm3)")

    # The envelope is a smooth bag around the brain - it bridges over every
    # sulcus. CSF is dark on SWI, so re-thresholding *inside* the envelope
    # carves the sulci back open and gives a real gyral surface.
    #
    # The cut is set as a percentile of the tissue actually inside the
    # envelope rather than a fixed number, so it adapts to scan brightness.
    # p13 was chosen by sweeping: lower leaves the surface bald, higher starts
    # eroding the cortex into disconnected crumbs.
    t_cortex = float(np.percentile(vol[envelope], 13))
    print(f"  cortical threshold: >{t_cortex:.0f}")
    tissue = envelope & (vol > t_cortex)
    tissue = C.largest_cc(tissue)
    tissue = C.drop_small(tissue, 200)
    # NB: deliberately no binary_closing / fill_holes here - either one reseals
    # the sulci that the threshold just opened.
    print(f"  cortical surface:   {tissue.sum()/1e6:.2f} M voxels "
          f"({tissue.sum() * ISO**3 / 1000:.0f} cm3)")

    nib.save(nib.Nifti1Image(envelope.astype(np.uint8), aff), BUILD / "brain_envelope.nii.gz")
    nib.save(nib.Nifti1Image(tissue.astype(np.uint8), aff), BUILD / "brain_mask.nii.gz")

    C.overlay_slices(vol, [(envelope, (60, 130, 255)), (tissue, (255, 70, 70))],
                     BUILD / "qc_brain_slices.png", n=6, axis=2)

    for tag, mask, ps, sm in (("envelope", envelope, 0.9, 12), ("detailed", tissue, 0.6, 4)):
        v, f = C.mesh_from_mask(mask, aff, presmooth=ps)
        v = C.taubin_smooth(v, f, iterations=sm)
        print(f"  mesh[{tag}]: {len(v)} verts / {len(f)} tris")
        C.render([(v, f, (236, 219, 210))], BUILD / f"qc_brain_{tag}.png")
    print(f"  wrote QC images to {BUILD}")


if __name__ == "__main__":
    main()
