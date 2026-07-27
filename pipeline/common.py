"""Shared helpers for the brain reconstruction pipeline.

Everything works in scanner world coordinates (millimetres) so that meshes
derived from different series - the SWI brain volume and the TOF angiogram
were acquired in separate studies - land in the same space automatically.
"""
from __future__ import annotations

import numpy as np
import nibabel as nib
import scipy.sparse as sp
from scipy import ndimage
from skimage import measure

# --------------------------------------------------------------------------
# volumes
# --------------------------------------------------------------------------

def load(path):
    """Return (data float32, affine)."""
    img = nib.load(str(path))
    return np.asarray(img.dataobj).astype(np.float32), img.affine


def resample_iso(data, affine, iso, order=1):
    """Resample onto an isotropic grid of `iso` mm, keeping world position.

    Marching cubes on an anisotropic grid produces visible terracing along the
    thick axis; resampling first is what removes it.
    """
    dirs = affine[:3, :3]
    zooms = np.linalg.norm(dirs, axis=0)
    unit = dirs / zooms
    new_affine = np.eye(4)
    new_affine[:3, :3] = unit * iso
    new_affine[:3, 3] = affine[:3, 3]
    new_shape = np.ceil(np.array(data.shape) * zooms / iso).astype(int)

    # output index -> world -> input index
    mat = np.linalg.inv(affine) @ new_affine
    out = ndimage.affine_transform(
        data, mat[:3, :3], offset=mat[:3, 3], output_shape=tuple(new_shape),
        order=order, mode="constant", cval=0.0, prefilter=order > 1,
    )
    return out.astype(np.float32), new_affine


def ball(radius):
    r = int(radius)
    z, y, x = np.ogrid[-r:r + 1, -r:r + 1, -r:r + 1]
    return (x * x + y * y + z * z) <= r * r


def largest_cc(mask):
    lab, n = ndimage.label(mask)
    if n == 0:
        return mask
    counts = np.bincount(lab.ravel())
    counts[0] = 0
    return lab == counts.argmax()


def drop_small(mask, min_voxels):
    """Remove connected components smaller than `min_voxels`."""
    lab, n = ndimage.label(mask)
    if n == 0:
        return mask
    counts = np.bincount(lab.ravel())
    keep = np.zeros(counts.size, bool)
    keep[counts >= min_voxels] = True
    keep[0] = False
    return keep[lab]


def fill_holes_3d(mask):
    return ndimage.binary_fill_holes(mask)


# --------------------------------------------------------------------------
# meshing
# --------------------------------------------------------------------------

def mesh_from_mask(mask, affine, presmooth=1.0, level=0.5, step=1):
    """Marching cubes on a lightly blurred mask -> (verts_world_mm, faces).

    Blurring the binary mask before extraction is what turns voxel staircases
    into a smooth isosurface; it costs a little detail and buys a lot of looks.
    """
    vol = mask.astype(np.float32)
    if presmooth > 0:
        vol = ndimage.gaussian_filter(vol, presmooth)
    verts, faces, _, _ = measure.marching_cubes(vol, level=level, step_size=step)
    world = verts @ affine[:3, :3].T + affine[:3, 3]
    return world.astype(np.float32), faces.astype(np.int64)


def _adjacency(n_verts, faces):
    e = np.vstack([faces[:, [0, 1]], faces[:, [1, 2]], faces[:, [2, 0]]])
    e = np.vstack([e, e[:, ::-1]])
    data = np.ones(len(e), np.float32)
    A = sp.coo_matrix((data, (e[:, 0], e[:, 1])), shape=(n_verts, n_verts)).tocsr()
    A.data[:] = 1.0
    deg = np.asarray(A.sum(1)).ravel()
    deg[deg == 0] = 1.0
    return A, deg


def taubin_smooth(verts, faces, iterations=20, lam=0.5, mu=-0.53):
    """Taubin lambda/mu smoothing - smooths without the shrinkage that plain
    Laplacian smoothing causes (which would visibly thin the gyri)."""
    A, deg = _adjacency(len(verts), faces)
    v = verts.astype(np.float64).copy()
    for i in range(iterations):
        w = lam if i % 2 == 0 else mu
        v += w * ((A @ v) / deg[:, None] - v)
    return v.astype(np.float32)


def decimate(verts, faces, target_tris):
    """Quadric decimation down to roughly `target_tris` triangles."""
    import fast_simplification
    if len(faces) <= target_tris:
        return verts, faces
    reduction = 1.0 - (target_tris / len(faces))
    v, f = fast_simplification.simplify(
        verts.astype(np.float32), faces.astype(np.int32), float(reduction)
    )
    return np.asarray(v, np.float32), np.asarray(f, np.int64)


def vertex_normals(verts, faces):
    fn = np.cross(verts[faces[:, 1]] - verts[faces[:, 0]],
                  verts[faces[:, 2]] - verts[faces[:, 0]])
    vn = np.zeros_like(verts)
    for k in range(3):
        np.add.at(vn, faces[:, k], fn)
    n = np.linalg.norm(vn, axis=1, keepdims=True)
    n[n == 0] = 1.0
    return vn / n


# --------------------------------------------------------------------------
# quick-look rendering (depth-sorted point splat; no GPU / GL needed)
# --------------------------------------------------------------------------

_VIEWS = {
    "left":  ((0, 1, 0), (0, 0, 1), (-1, 0, 0)),
    "front": ((1, 0, 0), (0, 0, 1), (0, -1, 0)),
    "top":   ((1, 0, 0), (0, 1, 0), (0, 0, 1)),
    "obl":   ((0.75, 0.66, 0), (-0.3, 0.34, 0.89), (0.6, -0.67, 0.44)),
}


def render(parts, path, size=430, views=("left", "front", "top", "obl"), bg=12):
    """parts: list of (verts, faces, (r,g,b)). Writes a montage PNG."""
    from PIL import Image

    allv = np.vstack([p[0] for p in parts])
    centre = (allv.max(0) + allv.min(0)) / 2
    extent = (allv.max(0) - allv.min(0)).max() * 0.56

    tiles = []
    for name in views:
        rx, ry, rz = (np.array(v, float) for v in _VIEWS[name])
        rx, ry, rz = rx / np.linalg.norm(rx), ry / np.linalg.norm(ry), rz / np.linalg.norm(rz)
        img = np.full((size, size, 3), bg, np.uint8)
        zbuf = np.full(size * size, -1e9)
        for verts, faces, colour in parts:
            n = vertex_normals(verts, faces)
            p = verts - centre
            u = (p @ rx) / extent * (size / 2) + size / 2
            v = -(p @ ry) / extent * (size / 2) + size / 2
            d = p @ rz
            xi, yi = np.round(u).astype(int), np.round(v).astype(int)
            ok = (xi >= 0) & (xi < size) & (yi >= 0) & (yi < size)
            if not ok.any():
                continue
            xi, yi, d = xi[ok], yi[ok], d[ok]
            nn = n[ok]
            # abs(): marching-cubes winding can point inward, and for a closed
            # surface the unsigned dot product shades correctly either way.
            lam = np.abs(nn @ rz) * 0.72 + np.abs(nn @ ((rx + ry + rz * 2) / 2.6)) * 0.34
            shade = np.clip(0.22 + lam, 0, 1)[:, None] * np.array(colour, float)
            # splat a 3x3 block per vertex so the point cloud reads as a surface
            offs = [(dx, dy) for dx in (-1, 0, 1) for dy in (-1, 0, 1)]
            xi = np.concatenate([xi + dx for dx, _ in offs])
            yi = np.concatenate([yi + dy for _, dy in offs])
            d = np.tile(d, len(offs))
            shade = np.tile(shade, (len(offs), 1))
            ok2 = (xi >= 0) & (xi < size) & (yi >= 0) & (yi < size)
            xi, yi, d, shade = xi[ok2], yi[ok2], d[ok2], shade[ok2]
            order = np.argsort(d)                      # far -> near, near wins
            flat = yi[order] * size + xi[order]
            keep = d[order] > zbuf[flat]
            flat, sh = flat[keep], shade[order][keep]
            img.reshape(-1, 3)[flat] = np.clip(sh, 0, 255).astype(np.uint8)
            zbuf[flat] = d[order][keep]
        tiles.append(Image.fromarray(img))

    sheet = Image.new("RGB", (size * len(tiles), size), (bg, bg, bg))
    for i, t in enumerate(tiles):
        sheet.paste(t, (i * size, 0))
    sheet.save(str(path))
    return path


def overlay_slices(vol, masks, path, n=6, axis=2, size=330):
    """Contour-style QC: mask boundaries drawn over the greyscale volume.

    This, not the 3D preview, is how you actually judge a segmentation.
    """
    from PIL import Image

    lo, hi = np.percentile(vol, [1, 99.5])
    tiles = []
    idx = np.linspace(0.18, 0.82, n) * (vol.shape[axis] - 1)
    for i in idx.astype(int):
        sl = np.take(vol, i, axis=axis)
        g = np.clip((sl - lo) / (hi - lo + 1e-6), 0, 1)
        rgb = np.repeat((g * 255).astype(np.uint8)[..., None], 3, 2)
        for mask, colour in masks:
            m = np.take(mask, i, axis=axis)
            edge = m ^ ndimage.binary_erosion(m, np.ones((3, 3), bool))
            rgb[edge] = colour
        im = Image.fromarray(rgb).rotate(90, expand=True)
        im.thumbnail((size, size))
        tiles.append(im)
    cols = min(3, len(tiles))
    rows = (len(tiles) + cols - 1) // cols
    w = max(t.width for t in tiles); h = max(t.height for t in tiles)
    sheet = Image.new("RGB", (cols * w, rows * h), (0, 0, 0))
    for i, t in enumerate(tiles):
        sheet.paste(t, ((i % cols) * w, (i // cols) * h))
    sheet.save(str(path))
    return path
