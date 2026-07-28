<div align="center">

<img src="web/icons/icon-192.png" width="92" alt="">

# Shaan's Brain

**I turned a hospital MRI into something you can hold, rotate, and take apart.**

[![Live site](https://img.shields.io/badge/live-brain.aihq.in-4cc9e0?style=for-the-badge&logoColor=white)](https://brain.aihq.in)
[![Read the story](https://img.shields.io/badge/read-how_it_was_made-6b7c88?style=for-the-badge)](https://brain.aihq.in/docs/)

![three.js](https://img.shields.io/badge/three.js-r180-000000?logo=threedotjs&logoColor=white)
![Python](https://img.shields.io/badge/Python-3.13-3776AB?logo=python&logoColor=white)
![ANTs](https://img.shields.io/badge/registration-ANTs_SyN-8a63d2)
![No build step](https://img.shields.io/badge/build_step-none-4cc9e0)
![Runs offline](https://img.shields.io/badge/runs-offline-4cc9e0)

<br>

<img src="web/docs/gif/tour.gif" width="640" alt="Rotating tour of the model">

<br><br>

| 2,430 | 20 | 95.4% | 1,173 cm³ | 60 fps |
|:--:|:--:|:--:|:--:|:--:|
| DICOM files in | structures out | of the brain named | measured volume | with everything on |

</div>

---

## There is a disc in a drawer in my house with my brain on it

Not a picture of my brain. My actual brain, sampled every 0.6 of a millimetre,
sitting in 2,430 files that nothing on my laptop could open.

I had the scan in October 2023. I looked at maybe four of the images at the
time, understood none of them, and put the disc away. Two years later I found
it again and got curious about a specific question: **could I build a real 3D
model out of this?**

Here is the thing I had wrong at the start. I assumed the 3D model was already
in there somewhere, and I just needed the right software to open it.

It is not. A DICOM file holds flat, grey, two-dimensional slices. Thirty
photographs of a head, stacked. There is no surface, no mesh, no geometry, no
shape. **Nothing three-dimensional exists in those files at all.** Every
gyrus and fold you can rotate on that website above was computed into
existence: a threshold decides which voxels are brain, marching cubes wraps a
skin around them, and a smoothing pass makes it look like tissue instead of
Lego.

I did not find this model. I generated it, and I got a lot of it wrong on the
way.

This is the whole story, including the parts where I confidently produced
completely incorrect numbers.

---

## Contents

- [What I started with](#what-i-started-with)
- [Step 1: Finding a series that could actually work](#step-1-finding-a-series-that-could-actually-work)
- [Step 2: Generating a brain out of grey slices](#step-2-generating-a-brain-out-of-grey-slices)
- [Step 3: Carving the folds back open](#step-3-carving-the-folds-back-open)
- [Step 4: The arteries](#step-4-the-arteries)
- [Step 5: Two scans, two coordinate systems](#step-5-two-scans-two-coordinate-systems)
- [Step 6: The head](#step-6-the-head)
- [Step 7: Naming every part](#step-7-naming-every-part)
- [Step 8: Faking the light properly](#step-8-faking-the-light-properly)
- [The viewer](#the-viewer)
- [Making it fast](#making-it-fast)
- [Everything that went wrong](#everything-that-went-wrong)
- [Running it yourself](#running-it-yourself)
- [What the numbers actually mean](#what-the-numbers-actually-mean)

---

## What I started with

A Philips Achieva 1.5 T scanner produced two studies on the same morning. One
of my neck at 09:11, which quietly included a 3D angiogram of the arteries
running up to my head, and one of my brain at 12:16. I converted all 2,430
files with `dcm2niix` and worked from the NIfTI output.

Then I hit the problem that shaped everything after it.

A clinical brain scan is not built for this. Every tutorial online assumes a 3D
T1 MPRAGE: 1 mm isotropic, 180 or more slices, because that is what FreeSurfer
and the rest of the neuroimaging world runs on. Hospitals skip it. Radiologists
read slices, not volumes, so they order thick slices that look sharp on a
screen.

Every brain series in my scan is **5 mm thick with a 0.5 mm gap**. Thirty
slices for an entire head. You cannot build a surface from that. It is like
being asked to sculpt someone's face from thirty photographs taken 5 mm apart.

So the first job was not modelling anything. It was finding out whether the
scan contained a single series with enough depth to be worth trying.

## Step 1: Finding a series that could actually work

I ignored the series descriptions and measured the real voxel geometry of all
72 of them. Two jumped out.

| Series | In-plane | Slice thickness | Slices | Verdict |
|---|---|---|---|---|
| FLAIR, T1, T2 | 0.24 to 0.44 mm | **5.0 mm** | 30 | gorgeous in-plane, useless in depth |
| **SWI / VEN_BOLD** | 0.60 mm | **1.5 mm** | **101** | the only near-3D brain volume |
| **s3DI_MC (angiogram)** | 0.34 mm | **0.75 mm** | **276** | sharpest volume in the dataset |

The susceptibility-weighted series is the reason this project exists at all. It
gets acquired as a thin-slice 3D gradient echo to look for microbleeds. Nobody
intends it as an anatomical volume. But at 0.6 by 0.6 by 1.5 mm it was the one
brain series with enough depth resolution to mesh, and it had been sitting on
that disc the whole time.

The angiogram is sharper still, but time-of-flight imaging deliberately
suppresses everything that is not moving, so it contains blood and almost
nothing else.

## Step 2: Generating a brain out of grey slices

I assumed I would need a neural network for brain extraction and started
looking at which one to install. I did not need one, because of a lucky quirk
of the contrast: on SWI the skull is a dark shell that already separates brain
from scalp.

<details>
<summary><b>The five steps, in order</b></summary>

<br>

1. **Resample to 0.8 mm isotropic.** Marching cubes on an uneven grid produces
   visible terracing along the thick axis, and resampling first is what kills it.
2. **Multi-Otsu with four classes.** The second boundary separates brain tissue
   from CSF and bone.
3. **Erode hard**, then keep only the largest connected blob. The erosion snaps
   the few remaining bridges through the eye sockets and skull base, and whatever
   survives is unambiguously the brain.
4. **Grow it back** into the thresholded tissue, but bounded, so it reclaims real
   tissue without flooding through the skull into the scalp.
5. **Close and fill.**

</details>

![Brain mask drawn over the SWI slices](web/docs/pipeline/seg-brain-overlay.png)

Blue is the smooth envelope, red is the final surface. The contour hugs the
temporal lobes and cerebellum, which is exactly where threshold methods usually
fall apart.

The envelope came out at **1348 cm³**, a completely plausible adult brain. That
number was the first moment this stopped feeling like a stunt and started
feeling like it might actually work.

## Step 3: Carving the folds back open

The mask from step 2 is a smooth bag. It bridges straight over every fold, so
the first mesh I generated looked like a peeled potato. Recognisably a brain.
Completely bald.

The fix uses the same contrast trick a second time. **CSF is dark on SWI**, and
every sulcus is full of CSF, so re-thresholding *inside* the envelope carves
the folds back open.

Picking that threshold mattered more than I expected, so I swept it and looked
at every single result:

| Cut | Volume | What it looked like |
|---|---|---|
| p8 | 1241 cm³ | still bald |
| p10 | 1214 cm³ | a hint of texture |
| **p13** | **1173 cm³** | **real gyri, surface still intact** |
| p16 | 1132 cm³ | good relief, cortex getting thin |
| p20 | 1078 cm³ | falling apart into crumbs |

![The cortical surface](web/docs/pipeline/seg-brain-mesh.png)

> **The hour I lost here.** Out of pure habit I followed the threshold with
> `binary_closing` and `fill_holes`. Both reseal the exact folds the threshold
> had just opened. The volume barely moved, 2.61 M voxels against 2.63 M, so
> every number I printed looked fine while the render was obviously wrong.
> There is a comment in the code now telling future me not to put them back.

## Step 4: The arteries

Time-of-flight angiography makes flowing blood far brighter than everything
around it, so a high threshold finds the arteries immediately. It also finds
subcutaneous fat, which is just as bright, and there is a lot of fat in a neck.

![First attempt, arteries buried in fat](web/docs/pipeline/seg-arteries-overlay.png)

The small bright dots deep in the middle are the real arteries. Everything
tracing the outline of the neck is fat. Three filters separate them.

**How deep it sits.** Fat lives in a shallow rim just under the skin. The
carotids and vertebrals run 25 to 40 mm deep. So I build a solid silhouette of
the neck, compute distance from the outside air, and demand at least 14 mm of
it.

This took two attempts. My first silhouette was a plain tissue threshold, which
comes out speckled, because muscle and bone fall below the cut and leave dark
channels running all the way out to the air. That wrecks the distance
transform. Only 1.7 M of 19 M voxels came back as deep, and the filter
cheerfully deleted the arteries along with the fat.

**How elongated it is.** PCA on each blob's voxel cloud. A tube puts nearly all
of its variance on one axis.

**How flat it is.** This one caught me out. A slab of fat is elongated too,
just along *two* axes instead of one, so it sails straight through the
elongation test. Demanding the second principal axis be under 16% of the first
is what finally cleared the last stubborn clumps.

![The clean arterial tree](web/docs/pipeline/seg-arteries-mesh.png)

Both carotids with their bifurcations, both siphons curling at the base of the
skull, both vertebral arteries. 10.2 cm³ of vessel, and honestly my favourite
object in the whole project.

## Step 5: Two scans, two coordinate systems

The brain comes from the 12:16 study and the arteries from the 09:11 one. Three
hours apart means I got off the table and was repositioned, so identical
scanner coordinates absolutely do not mean identical anatomy. Rendered together
in raw scanner space, my carotid siphons floated a couple of centimetres away
from the skull base they are supposed to hug.

So the angiogram gets rigidly registered onto the SWI with ANTs, restricted to
the slab where the two overlap so the non-shared neck and vertex cannot drag
the fit off course.

Then a second problem appeared. Warping straight into the SWI grid cropped the
carotids at the edge of the head field of view and threw away most of their
length, 58 k voxels down to 14 k. The output now goes into a union grid: SWI
orientation, so the arteries land in the brain's frame, extended far enough
down to keep the whole neck.

![Arteries registered onto the brain](web/docs/pipeline/seg-registration.png)

## Step 6: The head

Neither series covers a whole head. The SWI is 233 mm wide but its field of
view slices straight through the face. The sagittal T1 has the entire profile,
nose and chin included, but is only 144 mm across. They come from the same
session, so they already share a coordinate frame, and the pipeline unions the
two silhouettes.

![The head surface](web/docs/pipeline/seg-head-mesh.png)

The head is **defaced** by default. A 3D face reconstructed from MRI is
biometric data and can be matched against a photograph, so the unmodified
version is opt-in, writes only into a git-ignored folder, and never becomes a
mesh.

## Step 7: Naming every part

This is the step that turns a nice-looking blob into something you can learn
from.

I warp the **Harvard-Oxford atlases** onto my scan using ANTs SyN registration
and let the labels ride along. Doing it this way means every named region
traces back to a published atlas instead of to a boundary I drew by eye.

![Atlas labels on the slices](web/docs/pipeline/seg-atlas-overlay.png)

> **The cortex problem.** My first version used only the subcortical atlas, and
> when I switched the layers on, the result covered a small fraction of the
> brain. The entire cerebral cortex was unlabelled, which is to say most of it.
> Harvard-Oxford ships as two separate atlases and I had warped one.

The second version warps the cortical atlas too: 48 regions grouped into lobes
by an ordered set of matching rules. Order matters. "Temporal Occipital
Fusiform Cortex" has to be matched before the plain "occipital" rule or it ends
up in the wrong lobe. The script prints anything it fails to assign, which is
how I caught "Parietal Opercular Cortex" quietly slipping through.

The **cerebellum** has no Harvard-Oxford label at all, which surprised me. I
derive it as the one large unlabelled blob left inside the brain mask once
everything else is accounted for.

**Twenty parts, covering 95.4% of the brain by volume.** Every measured volume
lands in a normal adult range: brain 1173 cm³, white matter 295 cm³, cerebellum
106 cm³, ventricles 11.1 cm³, brainstem 27.9 cm³.

## Step 8: Faking the light properly

A single-colour organic surface renders flat and plasticky. Screen-space
ambient occlusion would fix it, at the cost of a postprocessing pass and
several more dependencies.

So instead I compute ambient occlusion **from the volume itself** and bake it
into the vertex colours. Blur the binary mask, then sample it at every vertex.
Deep in a fold you are walled in on all sides, so the blurred value is high. On
top of a ridge it is low. That maps directly onto how dark the crevice should
be, costs a single convolution, and needs nothing at runtime beyond a colour
attribute.

This one change did more for how the model looks than everything else combined.

> **One detail worth writing down.** Scanner space is RAS and glTF is Y-up, so
> vertices get mapped `(x, y, z)` to `(x, z, -y)`. That is a right-handed
> transform with determinant +1. A left-handed one would silently mirror the
> model and swap my left and right hemispheres, which is the kind of bug you do
> not notice until it really matters.

## The viewer

three.js, no build step, no CDN. Everything is vendored, so it runs offline.

**Minimal** is the default: the model, a centred bar, the compass, nothing
else. Click any structure and a leader line runs from the exact point you
touched out to a card telling you what it is.

**Explore** brings in a symmetric pair of panels, layers left and detail right.

![Switching views in explore mode](web/docs/gif/explore.gif)

Layers are chips, not switches. Click to toggle, double-click to isolate, hover
to light it up in 3D. A row of Views sets a whole scene in one click.

![Cross-section sweeping through the brain](web/docs/gif/section.gif)

<div align="center">
<img src="web/docs/gif/mobile.gif" width="260" alt="The viewer on a phone">
</div>

On a phone the panels become bottom sheets you can swipe down to dismiss, and
parts load only when you ask for them, because twenty meshes resident at once
is how you get a mobile browser to kill your tab.

## Making it fast

`npm run bench` drives the viewer on a real GPU and reports frame times, draw
calls and picking cost.

| Scene | Before | After |
|---|---|---|
| Everything on | 28.6 fps | **59.9 fps** |
| Everything, close-up | 14.5 fps | **48.3 fps** |
| Raycast per pick | 43.4 ms | **0.427 ms** |
| First render | 27.8 MB | **10.8 MB** |

Measured with twenty parts and 1.4 M triangles on screen, roughly double the
geometry of the before column. **Not one triangle was removed.**

<details>
<summary><b>What actually mattered</b></summary>

<br>

**Picking was the worst offender by miles.** Hover raycasting was brute-force
testing every triangle of every visible mesh on every single pointer move.
1.3 M triangles, 43 ms per event, on an input that fires faster than the screen
refreshes. A BVH made it about a hundred times faster.

**Everything was permanently flagged transparent**, even at full opacity. That
dumped every nested shell into the sorted blend pass with no early-Z rejection.

**Clearcoat and sheen get dropped below 50% opacity.** A second specular
highlight you cannot possibly see through a 22%-opaque surface is wasted cost.

**Progressive loading.** The whole model used to download before anything
appeared. Now the visible pair loads in parallel and the rest streams in behind
you.

</details>

## Everything that went wrong

### The cortex went hollow

I switched materials to `FrontSide` so the GPU could cull back faces. Free
performance, obviously. It benchmarked beautifully. It also did this:

![Backface culling punching holes through the cortex](web/docs/ui/bug-hollow.png)

These meshes come from marching cubes on a **non-watertight** mask, and their
triangle winding is mixed. Culling deleted every inward-facing triangle,
punching holes straight through my cortex. Measuring it afterwards was
illuminating: the head is 99% correctly wound and watertight and rendered
perfectly. The brain is neither.

### Evans' index, three wrong answers in a row

Evans' index is a ratio of ventricle width to skull width, normally a single
caliper measurement a radiologist makes on one chosen slice. Automating it
produced three confident, plausible, completely wrong numbers before I got one
I trusted.

| Attempt | Result | Why it was wrong |
|---|---|---|
| 1 | 0.325 | Used "dark means CSF" on SWI. But *veins* are the darkest thing there, so it traced blood vessels. |
| 2 | 0.607 | Maximised the *ratio* across slices, which just finds a degenerate denominator. Reported 7.9 mm ventricles in a 13.1 mm skull. |
| 3 | 0.313 | Picked the slice by widest frontal horn, but the horns it found were in the posterior fossa. It measured the fourth ventricle. |
| **4** | **0.194** | Atlas identifies the *lateral* ventricles, T2 intensity gives the boundary. |

Any of the first three would have read as a real finding.

> The only reason I caught them is that I rendered the exact slice each
> measurement came from and looked at it. **A number from an automated pipeline
> is worth nothing without a picture of what it measured.** That is the single
> most useful thing this project taught me.

<details>
<summary><b>Two shorter ones</b></summary>

<br>

**Everything rendered as a black silhouette.** Geometry loaded, shape was
right, every mesh pure black. The GLB files had no normal attribute, so every
lit material had nothing to shade with.

**The leader lines were invisible.** My first callout pushed its label away
from the surface along the surface normal. That looks perfect in profile and
collapses to exactly zero screen length whenever the normal points at the
camera. Which is most of the time, because you tend to click the thing facing
you.

</details>

## Running it yourself

```bash
npm install     # three.js and three-mesh-bvh
npm run serve   # http://localhost:8080
```

It has to be served over http. ES modules and `fetch()` do not work from
`file://`.

**Controls:** drag to orbit, scroll to zoom, click a structure to read about
it, double-click to focus, `E` toggles Explore, `Esc` clears.

### Rebuilding the model from a scan

The DICOM is deliberately not in this repo. Point the scripts at a folder of
`dcm2niix` output and run them in order:

```bash
python pipeline/01_brain.py            # brain mask and cortical surface
python pipeline/02_arteries.py         # arterial tree from the angiogram
python pipeline/02b_align_arteries.py  # register the angiogram onto the brain
python pipeline/03_head.py             # head surface
python pipeline/04_deep.py             # atlas registration, named structures
python pipeline/05_export.py           # AO bake, decimate, write GLB
```

Needs `numpy scipy scikit-image nibabel trimesh fast-simplification antspyx nilearn`.

Every script drops a QC image into `build/`. **Look at those, not just the
console output.** Almost every mistake in this project produced perfectly
reasonable numbers and an obviously wrong picture.

### Deploying

Static files, so any host works. Cloudflare Pages: connect the repo, empty
build command, output directory `web`.

## What the numbers actually mean

Not every part of this model is the same kind of thing, and the difference
matters if you are reading the volumes.

**Measured from the scan.** The brain surface, the arteries, the head. Every
vertex traces back to voxel intensities in the DICOM.

**Positioned from the scan, shaped by an atlas.** The lobes, white matter, all
the deep nuclei. These are Harvard-Oxford structures elastically warped onto my
anatomy. Their *location* comes from my scan; their *shape* is largely
inherited from the template. Lobe boundaries especially are a convention, not
something visible in the tissue.

**Worked out by subtraction.** The cerebellum is whatever the atlases did not
label. At 105.9 cm³ against a typical 120 to 160 cm³, it is probably
under-segmented.

**Chosen, not measured.** Every colour, and the smoothing. This is a smoothed
likeness rather than a millimetre-exact cast.

And the brain volume itself is threshold-dependent. It moves between 1078 and
1241 cm³ across reasonable choices of that cortical cut, which is worth
remembering before comparing it against anything.

---

## What it is like to look at it

I have been staring at this thing for weeks now and it still does something
strange to me.

The folds are not generic. They are not a stock model of a brain, or an average
of a thousand brains, or an artist's impression. That particular ridge above
the left temporal lobe is shaped that way because of how my skull grew. The
sulcus that runs slightly deeper on one side than the other is mine. Every
crease came out of an intensity threshold applied to my own tissue at 0.6
millimetres, and none of it existed as geometry until I computed it.

And the object doing the looking is the object being looked at. The frontal
lobe deciding this is interesting is rendered right there, translucent, forty
centimetres from my eyes. You can click it and read what it does. It does not
stop being odd.

The technical version of that same feeling: a hospital handed me 2,430 files of
grey slices, made for a radiologist to scroll through once and forget. The
three-dimensional shape was never in there. It had to be inferred, thresholded,
meshed, smoothed, named, and checked against an atlas, and at four separate
points along the way I produced numbers that looked completely reasonable and
were completely wrong. What saved every one of those was the same boring habit:
render it, and look at it.

The scan cost a morning in a hospital gown. The model cost a few weeks of
evenings. I would do it again.

<div align="center">
<br>

**[Go and rotate it →](https://brain.aihq.in)**

</div>
