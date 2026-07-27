"""Turn every mask into a decimated, web-ready GLB plus a manifest.

Coordinate handling
-------------------
Masks live in scanner RAS millimetres (x=right, y=anterior, z=superior).
glTF/three.js wants Y-up, so vertices are mapped

    (x, y, z)_RAS  ->  (x, z, -y)_gl

which is a right-handed transform (determinant +1). That matters: a
left-handed mapping would silently mirror the model and swap the patient's
left and right hemispheres.

Everything is then recentred on the brain centroid so the viewer can orbit
about a sensible pivot, and scaled to metres-ish units for three.js.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
import nibabel as nib
import trimesh

sys.path.insert(0, str(Path(__file__).parent))
import common as C

REPO = Path(__file__).resolve().parents[1]
BUILD = REPO / "build"
MODELS = REPO / "web" / "models"
MODELS.mkdir(parents=True, exist_ok=True)

# mask file, output name, label, colour, triangle budget, smoothing, group
PARTS = [
    ("brain_mask.nii.gz",       "brain",       "Brain surface",
     "#e8d3c6", 260_000, 4,  "brain",  True),
    ("arteries_aligned_mask.nii.gz", "arteries", "Arteries (carotid + vertebral)",
     "#d64545", 160_000, 8,  "vessels", True),
    ("head_mask.nii.gz",        "head",        "Head and scalp (defaced)",
     "#d9b9a4",  90_000, 14, "surface", False),
    ("deep_cerebellum_mask.nii.gz",  "cerebellum",  "Cerebellum",
     "#82c8eb",  60_000, 10, "deep", False),
    ("deep_ventricles_mask.nii.gz",  "ventricles",  "Lateral ventricles",
     "#5aa9e6",  40_000, 10, "deep", False),
    ("deep_brainstem_mask.nii.gz",   "brainstem",   "Brainstem",
     "#f0b45a",  30_000, 10, "deep", False),
    ("deep_thalamus_mask.nii.gz",    "thalamus",    "Thalamus",
     "#fa82a0",  20_000, 10, "deep", False),
    ("deep_hippocampus_mask.nii.gz", "hippocampus", "Hippocampus",
     "#96dc82",  20_000, 10, "deep", False),
    ("deep_caudate_mask.nii.gz",     "caudate",     "Caudate nucleus",
     "#c896fa",  20_000, 10, "deep", False),
    ("deep_putamen_mask.nii.gz",     "putamen",     "Putamen",
     "#ffc85a",  20_000, 10, "deep", False),
    ("deep_amygdala_mask.nii.gz",    "amygdala",    "Amygdala",
     "#fa6e6e",  16_000, 10, "deep", False),
]

RAS_TO_GL = np.array([[1, 0, 0], [0, 0, 1], [0, -1, 0]], float)


def main():
    # pivot = centroid of the brain, in RAS mm
    bm = nib.load(BUILD / "brain_mask.nii.gz")
    brain = np.asarray(bm.dataobj) > 0
    idx = np.argwhere(brain).mean(0)
    pivot = bm.affine[:3, :3] @ idx + bm.affine[:3, 3]
    print(f"pivot (RAS mm): {np.round(pivot, 1)}")

    manifest, qc = [], []
    for fname, name, label, colour, budget, smooth, group, default_on in PARTS:
        path = BUILD / fname
        if not path.exists():
            print(f"  - {name}: {fname} missing, skipped")
            continue
        img = nib.load(path)
        mask = np.asarray(img.dataobj) > 0
        if mask.sum() == 0:
            print(f"  - {name}: empty mask, skipped")
            continue

        v, f = C.mesh_from_mask(mask, img.affine, presmooth=0.8)
        v = C.taubin_smooth(v, f, iterations=smooth)
        before = len(f)
        v, f = C.decimate(v, f, budget)

        vol_cm3 = mask.sum() * abs(np.linalg.det(img.affine[:3, :3])) / 1000.0
        if group in ("brain", "deep", "vessels", "surface"):
            qc.append((v, f, tuple(int(colour[i:i + 2], 16) for i in (1, 3, 5))))

        gl = (v - pivot) @ RAS_TO_GL.T
        mesh = trimesh.Trimesh(vertices=gl, faces=f, process=False)
        mesh.fix_normals()
        out = MODELS / f"{name}.glb"
        # include_normals matters: a GLB without a NORMAL attribute renders as
        # a black silhouette under any lit material.
        mesh.export(out, include_normals=True)
        size_kb = out.stat().st_size / 1024
        print(f"  {name:<12} {before:>7} -> {len(f):>7} tris  {size_kb:7.0f} KB  {vol_cm3:7.1f} cm3")

        manifest.append({
            "name": name, "label": label, "file": f"models/{name}.glb",
            "color": colour, "group": group, "defaultVisible": default_on,
            "triangles": int(len(f)), "volume_cm3": round(float(vol_cm3), 1),
        })

    (REPO / "web" / "manifest.json").write_text(json.dumps({
        "subject": "self-scan, Philips Achieva 1.5T, 2023-10-07",
        "units": "millimetres, recentred on brain centroid",
        "parts": manifest,
    }, indent=2))
    print(f"\nwrote {len(manifest)} parts + manifest.json")

    if qc:
        C.render(qc, BUILD / "qc_combined.png")
        print(f"wrote {BUILD/'qc_combined.png'}")


if __name__ == "__main__":
    main()
